// Admin controls + analytics: switch commands off for everybody, maintenance mode, banned numbers, usage statistics.
// All values live in the settings store under the reserved id "_global", so they survive restarts (disk or MongoDB).
import { getSetting, setSetting } from './storage.js';

const G = '_global';
const TZ = process.env.TIMEZONE || 'Asia/Colombo';
export const PROTECTED = new Set(['menu', 'help', 'alive', 'ping']); // can never be switched off

/* ---------- switches ---------- */
const list = (k) => (Array.isArray(getSetting(G, k, [])) ? getSetting(G, k, []) : []);
export const disabledCmds = () => new Set(list('disabledCmds'));
export const isCmdDisabled = (cmd) => !PROTECTED.has(cmd.name) && disabledCmds().has(cmd.name);
export function setCmdsDisabled(names, off) {
  const cur = disabledCmds();
  for (const n of names) { if (PROTECTED.has(n)) continue; off ? cur.add(n) : cur.delete(n); }
  setSetting(G, 'disabledCmds', [...cur]);
}
export const getMaintenance = () => ({ on: getSetting(G, 'maintenance', false) === true, text: String(getSetting(G, 'maintenanceText', '') || '') });
export function setMaintenance(on, text) { setSetting(G, 'maintenance', !!on); if (text != null) setSetting(G, 'maintenanceText', String(text).trim().slice(0, 300)); }
export const bannedList = () => list('banned');
export const isBanned = (ids) => { const b = new Set(bannedList()); return [...ids].some((n) => b.has(n)); };
export function setBanned(num, on) {
  const n = String(num || '').replace(/\D/g, '');
  if (n.length < 8 || n.length > 16) throw new Error('Enter the number with country code, digits only.');
  const cur = new Set(bannedList()); on ? cur.add(n) : cur.delete(n);
  setSetting(G, 'banned', [...cur].slice(0, 500));
}

/* ---------- analytics ---------- */
let stats = getSetting(G, 'stats', null);
if (!stats || typeof stats !== 'object') stats = { cmds: {}, days: {}, hours: {}, nums: {}, since: Date.now() };
for (const k of ['cmds', 'days', 'hours', 'nums']) stats[k] ||= {};
let dirty = true;
const stamp = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 };
};
export function recordCommand(sid, name) {
  const { day, hour } = stamp();
  const c = (stats.cmds[name] ||= { n: 0, e: 0 }); c.n++;
  stats.days[day] = (stats.days[day] || 0) + 1;
  (stats.hours[day] ||= Array(24).fill(0))[hour]++;
  stats.nums[sid] = (stats.nums[sid] || 0) + 1;
  dirty = true;
}
export function recordError(name) { (stats.cmds[name] ||= { n: 0, e: 0 }).e++; dirty = true; }
export const commandUsage = () => stats.cmds;
export function analytics(phoneOf) {
  const { day } = stamp();
  const days = Object.keys(stats.days).sort().slice(-14).map((d) => ({ day: d, n: stats.days[d] }));
  const total = Object.values(stats.cmds).reduce((a, c) => a + c.n, 0);
  const errors = Object.values(stats.cmds).reduce((a, c) => a + c.e, 0);
  const top = Object.entries(stats.cmds).sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([name, c]) => ({ name, n: c.n, e: c.e }));
  const nums = Object.entries(stats.nums).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([sid, n]) => ({ phone: phoneOf(sid), n })).filter((x) => x.phone);
  return { since: stats.since, total, errors, today: stats.days[day] || 0, days, hours: stats.hours[day] || Array(24).fill(0), top, nums };
}
setInterval(() => { // save at most once a minute; also forget days older than 45
  const keep = Object.keys(stats.days).sort().slice(-45);
  for (const k of ['days', 'hours']) for (const d of Object.keys(stats[k])) if (!keep.includes(d)) delete stats[k][d];
  if (dirty) { dirty = false; setSetting(G, 'stats', stats); }
}, 60000).unref();
