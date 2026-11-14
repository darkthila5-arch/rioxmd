// Admin controls + analytics: switch commands off for everybody, maintenance mode, banned numbers, usage statistics.
// All values live in the settings store under the reserved id "_global", so they survive restarts (disk or MongoDB).
import { AsyncLocalStorage } from 'node:async_hooks';
import { OWNER_NUMBER, jidNum } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { getBtnStyle, setBtnStyle, BTN_STYLES } from './btnstyle.js';
export { getBtnStyle, setBtnStyle, BTN_STYLES };
import { getMsgStyle, setMsgStyle, MSG_STYLES } from './msgstyle.js';
export { getMsgStyle, setMsgStyle, MSG_STYLES };

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
/* ---------- commands for ONE number (set in /admin -> Commands -> "Commands for one number") ---------- */
// When the limit is on for a number, only the commands in its list work for that number; every other command is switched off for it
// (and hidden from its menu). The list is kept when the limit is switched off. The host admin is never limited.
const sessCtx = new AsyncLocalStorage(); // the router runs each command inside this, so the menu filters know which number is asking
export const runAsSession = (sid, fn) => sessCtx.run({ sid }, fn);
export const sessionLimit = (sid) => ({ only: getSetting(sid, 'cmdLimitOn', false) === true, allowed: Array.isArray(getSetting(sid, 'cmdLimitList', [])) ? getSetting(sid, 'cmdLimitList', []) : [] });
export const sessionAllowed = (sid) => { const l = sessionLimit(sid); return l.only ? new Set(l.allowed) : null; }; // null = no limit for this number
export const isCmdBlockedFor = (sid, cmd) => { const a = sessionAllowed(sid); return !!a && !a.has(cmd.name); };
export function setSessionLimit(sid, only, allowed) {
  setSetting(sid, 'cmdLimitOn', !!only);
  setSetting(sid, 'cmdLimitList', [...new Set(allowed)].slice(0, 400));
}
const currentLimit = () => { const sid = sessCtx.getStore()?.sid; return sid ? sessionAllowed(sid) : null; };

/* ---------- who can use a command / does it need premium (set in /admin -> Commands) ---------- */
// who: 'all' (anybody) | 'owner' (the owner of the number) | 'host' (only the host admin, OWNER_NUMBER).
// The admin can make a command STRICTER than its built-in level, never looser (a built-in owner command can never become public).
export const WHO_RANK = { all: 0, owner: 1, host: 2 };
export const defaultAccess = (cmd) => ({ who: cmd.adminOnly ? 'host' : cmd.owner ? 'owner' : 'all', premium: !!cmd.premium });
const accessMap = () => { const m = getSetting(G, 'cmdAccess', {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
export function accessOf(cmd) {
  const d = defaultAccess(cmd), o = accessMap()[cmd.name];
  if (!o) return { ...d, custom: false };
  const who = WHO_RANK[o.who] >= WHO_RANK[d.who] ? o.who : d.who;
  return { who, premium: typeof o.premium === 'boolean' ? o.premium : d.premium, custom: who !== d.who || (typeof o.premium === 'boolean' && o.premium !== d.premium) };
}
// cmds: command objects; who: 'default' | 'all' | 'owner' | 'host' | undefined (leave); premium: 'default' | true | false | undefined (leave).
// Returns the names that were refused because they would be looser than the built-in level.
export function setAccess(cmds, who, premium) {
  const map = { ...accessMap() }, refused = [];
  for (const cmd of cmds) {
    const d = defaultAccess(cmd), cur = { ...(map[cmd.name] || {}) };
    if (who === 'default') delete cur.who;
    else if (who in WHO_RANK) { if (WHO_RANK[who] < WHO_RANK[d.who]) { refused.push(cmd.name); continue; } cur.who = who; }
    if (premium === 'default') delete cur.premium;
    else if (typeof premium === 'boolean') cur.premium = premium;
    if (cur.who === d.who) delete cur.who;
    if (cur.premium === d.premium) delete cur.premium;
    if (Object.keys(cur).length) map[cmd.name] = cur; else delete map[cmd.name];
  }
  setSetting(G, 'cmdAccess', map);
  return refused;
}
export const getMaintenance = () => ({ on: getSetting(G, 'maintenance', false) === true, text: String(getSetting(G, 'maintenanceText', '') || '') });
export function setMaintenance(on, text) { setSetting(G, 'maintenance', !!on); if (text != null) setSetting(G, 'maintenanceText', String(text).trim().slice(0, 300)); }
/* ---------- menu style (set in /admin -> Commands -> Menu style): 'classic' = picture + text, 'carousel' = swipeable cards ---------- */
export const MENU_STYLES = ['classic', 'carousel'];
export const getMenuStyle = () => { const v = getSetting(G, 'menuStyle', 'classic'); return MENU_STYLES.includes(v) ? v : 'classic'; };
export function setMenuStyle(style) {
  if (!MENU_STYLES.includes(style)) throw new Error('Unknown menu style.');
  setSetting(G, 'menuStyle', style);
}
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
// Live counters for the admin Server tab: the all-time totals are kept in step with `stats`, "per minute" counts the last 60 seconds only (memory only).
let totalN = Object.values(stats.cmds).reduce((a, c) => a + (c.n || 0), 0), totalE = Object.values(stats.cmds).reduce((a, c) => a + (c.e || 0), 0);
const recent = [];
const stamp = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 };
};
export function recordCommand(sid, name) {
  const { day, hour } = stamp();
  const c = (stats.cmds[name] ||= { n: 0, e: 0 }); c.n++; totalN++;
  recent.push(Date.now()); if (recent.length > 3000) recent.shift();
  stats.days[day] = (stats.days[day] || 0) + 1;
  (stats.hours[day] ||= Array(24).fill(0))[hour]++;
  stats.nums[sid] = (stats.nums[sid] || 0) + 1;
  dirty = true;
}
export function recordError(name) { (stats.cmds[name] ||= { n: 0, e: 0 }).e++; totalE++; dirty = true; }
export function liveCounts() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  return { total: totalN, errors: totalE, today: stats.days[stamp().day] || 0, perMin: recent.length, since: stats.since };
}
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
  if (!n) return false;
  if (!PROTECTED.has(n) && disabledCmds().has(n)) return true;
  const lim = currentLimit(); // this number may only use some commands: hide the others
  return !!lim && !lim.has(n);
};
export function filterCaption(text) {
  const off = disabledCmds();
  if (!off.size && !currentLimit()) return text;
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
  if (!disabledCmds().size && !currentLimit()) return buttons;
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
