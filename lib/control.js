// Admin controls + analytics: switch commands off for everybody, maintenance mode, banned numbers, usage statistics.
// All values live in the settings store under the reserved id "_global", so they survive restarts (disk or MongoDB).
import { OWNER_NUMBER, jidNum } from './config.js';
import { getSetting, setSetting } from './storage.js';

// true when this linked number is the host owner's own number (or no OWNER_NUMBER is set, so nobody gets locked out)
export const isHostSession = (userId) => !OWNER_NUMBER || jidNum(userId) === OWNER_NUMBER;

const G = '_global';
const TZ = process.env.TIMEZONE || 'Asia/Colombo';
export const PROTECTED = new Set(); // every command can be switched off (the host admin can still run them)
const PREFIX = process.env.PREFIX || '.';
let resolveName = (n) => n;
export const setResolver = (fn) => { resolveName = fn; }; // alias -> main command name (set by the router)

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

/* ---------- hide switched-off commands from the menus ---------- */
const nameOffById = (id) => {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return false;
  const n = resolveName(id.slice(PREFIX.length).split(/\s/)[0].toLowerCase());
  return !!n && !PROTECTED.has(n) && disabledCmds().has(n);
};
export function filterCaption(text) {
  const off = disabledCmds();
  if (!off.size) return text;
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(│ ✦ )(.*)$/);
    if (!m) { out.push(line); continue; }
    const parts = m[2].split(/ (?:·|\/) /);
    const keep = parts.filter((x) => !nameOffById(x.split(/\s/)[0]));
    if (keep.length) out.push(m[1] + (keep.length === parts.length ? m[2] : keep.join(' · ')));
  }
  const clean = [];
  for (let i = 0; i < out.length; i++) { // drop sections that became empty
    if (out[i].startsWith('╭─❮') && out[i + 1]?.startsWith('╰─')) { i += out[i + 2] === '' ? 2 : 1; continue; }
    clean.push(out[i]);
  }
  return clean.join('\n');
}
export function filterButtons(buttons) {
  if (!disabledCmds().size) return buttons;
  const res = [];
  for (const b of buttons) {
    let j; try { j = JSON.parse(b.buttonParamsJson); } catch { res.push(b); continue; }
    if (b.name === 'quick_reply') { if (!nameOffById(j.id)) res.push(b); continue; }
    if (b.name === 'single_select' && Array.isArray(j.sections)) {
      const sections = j.sections.map((sec) => ({ ...sec, rows: (sec.rows || []).filter((r) => !nameOffById(r.id)) })).filter((sec) => sec.rows.length);
      if (sections.length) res.push({ ...b, buttonParamsJson: JSON.stringify({ ...j, sections }) });
      continue;
    }
    res.push(b);
  }
  return res;
}
