// Live log buffer for the admin "Logs" tab: keeps the last console lines in memory (never written to disk).
// Phone numbers and connection strings are hidden when the lines are read, so the admin site never shows them.
import util from 'node:util';

const MAX = 600;
const buf = [];
let seq = 0;

const hide = (s) => String(s)
  .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@')
  .replace(/(x-api-key|api[_-]?key|secret|password|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***')
  .replace(/\b(\d{4})\d{3,9}(\d{2})\b/g, (_m, a, b) => `${a}•••${b}`); // 9-15 digit numbers: keep the first 4 and last 2

export function pushLog(level, args) {
  let text;
  try { text = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 2, breakLength: 120 }))).join(' '); } catch { text = '[unprintable]'; }
  buf.push({ seq: ++seq, t: Date.now(), level, text: text.slice(0, 2000) });
  if (buf.length > MAX) buf.shift();
}

// since: only lines newer than this sequence number. level: 'all' | 'warn' (warnings + errors) | 'error'.
export function readLogs({ since = 0, level = 'all', q = '', limit = 300 } = {}) {
  const needle = String(q || '').toLowerCase().slice(0, 80);
  const rank = { log: 0, info: 0, warn: 1, error: 2 };
  const min = level === 'error' ? 2 : level === 'warn' ? 1 : 0;
  const out = [];
  for (const e of buf) {
    if (e.seq <= since || rank[e.level] < min) continue;
    const text = hide(e.text);
    if (needle && !text.toLowerCase().includes(needle)) continue;
    out.push({ seq: e.seq, t: e.t, level: e.level === 'info' ? 'log' : e.level, text });
  }
  return { last: seq, lines: out.slice(-Math.min(Math.max(1, limit), 600)), counts: logCounts() };
}

export function logCounts() {
  let warn = 0, error = 0;
  for (const e of buf) { if (e.level === 'warn') warn++; else if (e.level === 'error') error++; }
  return { total: buf.length, warn, error };
}
