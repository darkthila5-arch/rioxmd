// Admin login protection: progressive lockout per IP + a persistent login history (IP, browser, result).
//  - 5 wrong attempts lock that IP: 10 min, then 30 min, 2 h, 6 h, 24 h for each further round (strikes are forgotten after 24 h without trouble).
//  - If many wrong attempts arrive from many IPs at once, logins from IPs that never logged in successfully are slowed down for a while,
//    while IPs that logged in before keep working (so an attacker cannot lock the real admin out).
//  - The admin can see locked IPs and unblock one.
import { getSetting, setSetting } from './storage.js';

const G = '_global', LOG_KEY = 'loginLog', KNOWN_KEY = 'knownAdminIps', MAX_LOG = 300, MAX_KNOWN = 20;
const MAX_TRIES = 5;
const STEPS = [10, 30, 120, 360, 1440].map((m) => m * 60 * 1000);
const STRIKE_MEMORY = 24 * 3600 * 1000;
const WIDE_WINDOW = 15 * 60 * 1000, WIDE_LIMIT = 40, WIDE_LOCK = 5 * 60 * 1000;

const ips = new Map(); // ip -> { n, strikes, until, lastFail }
let wide = []; // timestamps of recent wrong attempts from anywhere
let wideUntil = 0;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ips) if (v.until <= now && now - v.lastFail > STRIKE_MEMORY) ips.delete(k);
  wide = wide.filter((t) => now - t < WIDE_WINDOW);
}, 60000).unref();

const clean = (ip) => String(ip || '').replace(/^::ffff:/, '').slice(0, 60);
const known = () => (Array.isArray(getSetting(G, KNOWN_KEY, null)) ? getSetting(G, KNOWN_KEY, []) : []);
const history = () => (Array.isArray(getSetting(G, LOG_KEY, null)) ? getSetting(G, LOG_KEY, []) : []);

function note(ip, ua, result, extra = '') {
  const l = history();
  l.unshift({ at: new Date().toISOString(), ip, ua: String(ua || '').slice(0, 120), result, extra: String(extra).slice(0, 80) });
  if (l.length > MAX_LOG) l.length = MAX_LOG;
  setSetting(G, LOG_KEY, l);
}

// Seconds the caller must wait (0 = may try).
export function waitFor(ipRaw) {
  const ip = clean(ipRaw), now = Date.now();
  const e = ips.get(ip);
  if (e && e.until > now) return Math.ceil((e.until - now) / 1000);
  if (wideUntil > now && !known().includes(ip)) return Math.ceil((wideUntil - now) / 1000);
  return 0;
}

export function recordFail(ipRaw, ua, userTried = '') {
  const ip = clean(ipRaw), now = Date.now();
  let e = ips.get(ip);
  if (!e) e = { n: 0, strikes: 0, until: 0, lastFail: now };
  if (now - e.lastFail > STRIKE_MEMORY) e.strikes = 0;
  e.lastFail = now; e.n++;
  let locked = 0;
  if (e.n >= MAX_TRIES) { locked = STEPS[Math.min(e.strikes, STEPS.length - 1)]; e.until = now + locked; e.strikes++; e.n = 0; }
  ips.set(ip, e);
  wide.push(now); wide = wide.filter((t) => now - t < WIDE_WINDOW);
  if (wide.length >= WIDE_LIMIT && wideUntil <= now) wideUntil = now + WIDE_LOCK;
  note(ip, ua, locked ? 'locked' : 'failed', locked ? `locked ${Math.round(locked / 60000)} min` : `user "${String(userTried).slice(0, 20)}"`);
  return locked;
}

// Returns true when this IP has never logged in successfully before (the caller can mention it in the audit log).
export function recordSuccess(ipRaw, ua) {
  const ip = clean(ipRaw);
  ips.delete(ip);
  const k = known(), isNew = !k.includes(ip);
  if (isNew) setSetting(G, KNOWN_KEY, [ip, ...k].slice(0, MAX_KNOWN));
  note(ip, ua, 'ok', isNew ? 'new IP' : '');
  return isNew;
}

export function guardView() {
  const now = Date.now();
  const locked = [...ips].filter(([, v]) => v.until > now).map(([ip, v]) => ({ ip, seconds: Math.ceil((v.until - now) / 1000), strikes: v.strikes }));
  return { locked, wideLock: wideUntil > now ? Math.ceil((wideUntil - now) / 1000) : 0, known: known(), log: history().slice(0, 100) };
}

export function unblock(ipRaw) {
  const ip = clean(ipRaw);
  const had = ips.has(ip);
  ips.delete(ip);
  return had;
}

export function forgetKnown(ipRaw) {
  const ip = clean(ipRaw);
  setSetting(G, KNOWN_KEY, known().filter((x) => x !== ip));
}
