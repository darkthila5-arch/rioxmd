// Admin audit log: every admin action is stored (with the IP it came from) and survives restarts (disk or MongoDB).
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSetting, setSetting } from './storage.js';

const G = '_global', KEY = 'auditLog', MAX = 1000;
const als = new AsyncLocalStorage();
let list = null; // newest first
const load = () => (list ||= (Array.isArray(getSetting(G, KEY, null)) ? getSetting(G, KEY, []).slice(0, MAX) : []));

// Express middleware: remembers which IP made the request, so audit() can record it without every call passing it.
export const trackIp = (req, _res, next) => als.run({ ip: String(req.ip || '').replace(/^::ffff:/, '') }, next);

export function audit(action, detail = '', ip) {
  const entry = { at: new Date().toISOString(), action: String(action).slice(0, 80), detail: String(detail || '').slice(0, 300), ip: String(ip || als.getStore()?.ip || '').slice(0, 60) };
  const l = load();
  l.unshift(entry);
  if (l.length > MAX) l.length = MAX;
  setSetting(G, KEY, l);
  console.log(`[admin] ${entry.action} ${entry.detail}${entry.ip ? ` (ip ${entry.ip})` : ''}`);
}

export const recentAudit = (n = 40) => load().slice(0, n);

// q: text search in action / detail / ip. Returns one page plus the total number of matches.
export function listAudit({ q = '', offset = 0, limit = 50 } = {}) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 80);
  const all = needle ? load().filter((e) => `${e.action} ${e.detail} ${e.ip}`.toLowerCase().includes(needle)) : load();
  const o = Math.max(0, Number(offset) || 0), l = Math.min(200, Math.max(1, Number(limit) || 50));
  return { total: all.length, items: all.slice(o, o + l) };
}

export const allAudit = () => load().slice();
