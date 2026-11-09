// The WhatsApp "About" (bio) of the linked numbers.
//  - default text set once when a number is linked (host can change it / switch it off in /admin → Bot media → About)
//  - read the current About of a number (cached), so /admin can show it
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { sessions, sleep } from './config.js';
import { getSetting } from './storage.js';

export const BUILTIN_ABOUT = 'POWERED BY RIO X MD';
export const ABOUT_MAX = 139; // WhatsApp limit (same as the .setbio command)
const G = '_global';

// One line, no control / direction characters, 1..139 characters. Throws an Error with a readable message.
export function cleanAboutText(t) {
  const text = String(t ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Write the new About text first.');
  if ([...text].length > ABOUT_MAX) throw new Error(`The About can be at most ${ABOUT_MAX} characters (yours is ${[...text].length}).`);
  return text;
}

export const getDefaultAbout = () => { const v = String(getSetting(G, 'botmedia_about', '') || '').trim(); return v || BUILTIN_ABOUT; };
export const aboutAuto = () => getSetting(G, 'botmedia_aboutAuto', true) !== false; // on unless the host switched it off

/* ---------- what each number currently shows (memory only) ---------- */
const cache = new Map(); // sid -> { text: string | null, at, known: boolean }
const TTL = 10 * 60 * 1000;
export const aboutCached = (sid) => cache.get(sid) || null;
export const forgetAbout = (sid) => cache.delete(sid);

export async function setAbout(sock, sid, text) {
  await sock.updateProfileStatus(text);
  cache.set(sid, { text, at: Date.now(), known: true });
}

// Reads the number's own About from WhatsApp. Never throws: on failure the old value stays and known is false if there was none.
export async function readAbout(sid, { force = false } = {}) {
  const old = cache.get(sid);
  if (!force && old?.known && Date.now() - old.at < TTL) return old;
  const rec = sessions.get(sid);
  if (!rec?.sock || rec.status !== 'connected' || !rec.sock.user?.id || typeof rec.sock.fetchStatus !== 'function') return old || { text: null, at: 0, known: false };
  try {
    const list = await rec.sock.fetchStatus(jidNormalizedUser(rec.sock.user.id));
    const item = Array.isArray(list) ? list[0] : null;
    if (!item?.status || item.status.status === undefined) throw new Error('no answer');
    const entry = { text: item.status.status || '', at: Date.now(), known: true };
    cache.set(sid, entry);
    return entry;
  } catch {
    return old || { text: null, at: 0, known: false };
  }
}

// Fills the cache for many numbers, one after another (a short pause between them), in the background.
let warming = false;
export const aboutRefreshing = () => warming;
export async function warmAbout(ids, { force = false } = {}) {
  if (warming) return;
  warming = true;
  try {
    for (const id of ids) {
      const old = cache.get(id);
      if (!force && old?.known && Date.now() - old.at < TTL) continue;
      if (sessions.get(id)?.status !== 'connected') continue;
      await readAbout(id, { force: true });
      await sleep(400);
    }
  } finally { warming = false; }
}

// Called once, right after a brand-new number was linked.
export async function applyDefaultAbout(sock, sid) {
  if (!aboutAuto()) return false;
  await setAbout(sock, sid, cleanAboutText(getDefaultAbout()));
  return true;
}
