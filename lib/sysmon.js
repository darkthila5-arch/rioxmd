// Live server numbers for the admin "Server" tab: CPU, memory, event-loop lag, load, disk. A sample is taken every 2 seconds
// and the last 5 minutes are kept in memory. On Render/Docker the real limits come from the container (cgroup v2 or v1), not
// from the big host machine that os.totalmem() / os.cpus() would show. Nothing here is written to disk.
import fs from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const SAMPLE_MS = 2000;
const KEEP = 150; // 150 samples x 2 s = 5 minutes

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const num = (s) => { const n = Number(String(s ?? '').trim()); return s != null && String(s).trim() !== '' && Number.isFinite(n) ? n : null; };
const round = (n, d = 1) => { const k = 10 ** d; return Math.round(n * k) / k; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Total CPU seconds this container has used, and how many cores it may use (null = all of them).
function cgroupCpu() {
  const stat = read('/sys/fs/cgroup/cpu.stat'); // cgroup v2
  const u = stat && stat.match(/usage_usec\s+(\d+)/);
  if (u) {
    const [q, p] = (read('/sys/fs/cgroup/cpu.max') || '').trim().split(/\s+/);
    return { sec: Number(u[1]) / 1e6, cores: q && q !== 'max' && Number(p) > 0 ? Number(q) / Number(p) : null };
  }
  const ns = num(read('/sys/fs/cgroup/cpuacct/cpuacct.usage')) ?? num(read('/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage')); // cgroup v1
  if (ns != null) {
    const q = num(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), p = num(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    return { sec: ns / 1e9, cores: q > 0 && p > 0 ? q / p : null };
  }
  return null;
}

// Memory the container really holds ("working set": page cache that can be dropped is not counted) and its limit.
function cgroupMem() {
  const cur = num(read('/sys/fs/cgroup/memory.current'));
  if (cur != null) {
    const max = (read('/sys/fs/cgroup/memory.max') || '').trim();
    const file = Number(((read('/sys/fs/cgroup/memory.stat') || '').match(/^inactive_file\s+(\d+)/m) || [])[1] || 0);
    return { used: Math.max(0, cur - file), limit: max && max !== 'max' ? Number(max) : null };
  }
  const u1 = num(read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  if (u1 != null) {
    const lim = num(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    const file = Number(((read('/sys/fs/cgroup/memory/memory.stat') || '').match(/^total_inactive_file\s+(\d+)/m) || [])[1] || 0);
    return { used: Math.max(0, u1 - file), limit: lim && lim <= os.totalmem() ? lim : null }; // a limit above the machine's RAM means "no limit"
  }
  return null;
}

function hostMem() {
  const total = os.totalmem();
  const avail = Number(((read('/proc/meminfo') || '').match(/^MemAvailable:\s+(\d+)\s*kB/m) || [])[1]) * 1024;
  return { used: total - (avail > 0 ? avail : os.freemem()), limit: null };
}

const cpuTimes = () => { let idle = 0, total = 0; for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; } return { idle, total }; };

const RES = 20; // the histogram's timer fires every 20 ms, and every value contains that wait, so it is taken off again
const loop = monitorEventLoopDelay({ resolution: RES });
let prev = null, last = null, history = [], timer = null, disk = null, diskAt = 0, diskDir = '/';

function takeSample() {
  const now = Date.now();
  const cg = cgroupCpu();
  const cores = cg?.cores || os.cpus().length || 1;
  const proc = process.cpuUsage();
  const hostCpu = cpuTimes();
  const cur = { now, cg: cg?.sec ?? null, proc: (proc.user + proc.system) / 1e6, hostCpu };
  let cpu = 0, procCpu = 0;
  if (prev) {
    const dt = Math.max((now - prev.now) / 1000, 0.001);
    if (cur.cg != null && prev.cg != null) cpu = ((cur.cg - prev.cg) / dt / cores) * 100;
    else { const dTotal = hostCpu.total - prev.hostCpu.total; cpu = dTotal > 0 ? (1 - (hostCpu.idle - prev.hostCpu.idle) / dTotal) * 100 : 0; }
    procCpu = ((cur.proc - prev.proc) / dt / cores) * 100;
  }
  prev = cur;

  const m = cgroupMem() || hostMem();
  const total = m.limit || os.totalmem();
  const mu = process.memoryUsage();
  const lagMean = loop.count ? Math.max(0, loop.mean / 1e6 - RES) : 0, lagP99 = loop.count ? Math.max(0, loop.percentile(99) / 1e6 - RES) : 0;
  loop.reset();

  last = {
    t: now,
    cpu: round(clamp(cpu, 0, 100)), proc: round(clamp(procCpu, 0, 100)), cores: round(cores, 2), container: !!cg,
    load: os.loadavg().map((v) => round(v, 2)),
    mem: { used: m.used, total, limited: !!m.limit, pct: round(clamp((m.used / total) * 100, 0, 100)), rss: mu.rss, heapUsed: mu.heapUsed, heapTotal: mu.heapTotal, external: mu.external },
    loop: { mean: round(lagMean, 1), p99: round(lagP99, 1) },
    uptime: Math.round(process.uptime()), osUptime: Math.round(os.uptime()), node: process.version, platform: `${os.type()} ${os.arch()}`,
    disk,
  };
  history.push({ t: now, cpu: last.cpu, mem: last.mem.pct, loop: last.loop.p99 });
  if (history.length > KEEP) history.splice(0, history.length - KEEP);

  if (now - diskAt > 30000) { // disk changes slowly: look every 30 s
    diskAt = now;
    fs.promises.statfs(diskDir).then((s) => { const total = s.blocks * s.bsize, free = s.bavail * s.bsize; disk = { total, used: total - free, pct: total ? round(((total - free) / total) * 100) : 0 }; }).catch(() => { disk = null; });
  }
  return last;
}

// dir = where the sessions are kept, so the disk numbers are those of the volume that matters.
export function startSysmon(dir = '/') {
  diskDir = dir;
  if (timer) return;
  loop.enable();
  takeSample();
  timer = setInterval(takeSample, SAMPLE_MS);
  timer.unref(); // never keeps the process alive
}
export function stopSysmon() { clearInterval(timer); timer = null; loop.disable(); }

export const sampleNow = takeSample; // used by the tests
export function sysView({ withHistory = false } = {}) { return { ...(last || takeSample()), sampleMs: SAMPLE_MS, ...(withHistory ? { history } : {}) }; }
