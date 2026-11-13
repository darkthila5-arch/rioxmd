// Web settings page (/settings) and admin site (/admin): login, per-session settings API, admin tools.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { BOT_NAME, MAX_SESSIONS, DEFAULT_MODE, ROOT_DIR, SESSION_ROOT, jidNum, safeId, sessions, sha, sleep, state } from './config.js';
import { destroySession } from './session.js';
import { getMode, getSetting, setSetting } from './storage.js';
import { syncCallbot } from './callbot.js';
import { checkWebPassword, hasWebPassword, sendWebPassword, webPasswordVersion } from './webpass.js';
import { say } from './card.js';
import { addAdminChannel, addChannel, loadPoll, votePoll, stopPoll, adminBoost, adminCheck, adminRemove, adminSetAuto, boostSummary, reactToPost, removeChannel, setPaused, setWelcomeAll, adminSetPacks, setChannelPacks } from './boost.js';
const packsOf = (body) => (Array.isArray(body?.packs) ? body.packs.slice(0, 8).map((x) => String(x).slice(0, 20)) : []); // emoji pack ids chosen in the UI
import { BRAND_KEYS, BRAND_LIMITS, checkLogo, cleanBrandText } from './brand.js';
import { PROTECTED, WHO_RANK, accessOf, defaultAccess, setAccess, isHostSession, analytics, liveCounts, bannedList, commandUsage, disabledCmds, getMaintenance, getMenuStyle, setMenuStyle, MENU_STYLES, setBanned, setCmdsDisabled, setMaintenance, sessionLimit, setSessionLimit, getBtnStyle, setBtnStyle, BTN_STYLES } from './control.js';
import { registry } from '../commands/index.js';
import { EQ_CENTERS, EQ_LAYOUTS, EQ_MOTIONS, EQ_BLOB_STYLES, EQ_BLOB_SHAPES, PARTICLE_STYLES, EQ_MAX_S, EQ_MIN_S, EQ_STYLES, CSONG_USER_KEYS, CSONG_USER_OPTIONS, PREMIUM_MAX_S, clearCenterImage, getCenterImage, getCsong, hasCenterImage, setCenterImage, setCsong } from './csong.js';
const csongView = () => ({ ok: true, csong: getCsong(), styles: Object.keys(EQ_STYLES), layouts: EQ_LAYOUTS, centers: EQ_CENTERS, motions: EQ_MOTIONS, particleStyles: PARTICLE_STYLES, blobStyles: EQ_BLOB_STYLES, blobShapes: EQ_BLOB_SHAPES, min: EQ_MIN_S, max: EQ_MAX_S });
import { allAudit, audit, listAudit, recentAudit, trackIp } from './audit.js';
import { forgetKnown, guardView, recordFail, recordSuccess, unblock, waitFor } from './loginguard.js';
import { LATE_GRACE_MS, MAX_TEXT, addJob, cancelJob, dueJobs, listJobs, updateJob } from './broadcast.js';
import { MIN_PASS, createBackup, inspectBackup, restoreBackup } from './backup.js';
import { readLogs } from './logbuf.js';
import { adminPageHandler, parseAdminCode } from './adminpath.js';
import { premiumConfigView, resetPremiumConfig, savePremiumConfig } from './premiumpage.js';
import { mountNotices } from './notices.js';
import { ABOUT_MAX, BUILTIN_ABOUT, aboutAuto, aboutCached, aboutRefreshing, cleanAboutText, getDefaultAbout, readAbout, setAbout, warmAbout } from './about.js';
import { getDefaultCallMsg, getSessionCallImg, hasSessionCallImg, mountBotMedia, removeSessionCallImg, saveSessionCallImg, saveSessionCallImgFromLink } from './botmedia.js';
import { startSysmon, sysView } from './sysmon.js';
import { adminNewsAdd, adminNewsRemove, adminNewsUpdate, adminNewsView } from '../commands/news.js';
import { getPremium, grantPremium, isPremium, notifyPremium, parseDays, premiumGrantedText, premiumRemovedText, premiumView, revokePremium } from './premium.js';

const SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex'); // set WEB_SECRET so logins survive a restart
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_ENABLED = ADMIN_PASSWORD.length >= 10;
const { code: ADMIN_CODE, problem: ADMIN_CODE_PROBLEM } = parseAdminCode(process.env.ADMIN_CODE); // secret admin link: /admin/<ADMIN_CODE>
const USER_TTL_S = 12 * 3600, ADMIN_TTL_S = 4 * 3600;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- signed cookies ---------- */
const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const sign = (p) => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return `${body}.${hmac(body)}`; };
function verify(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
function putCookie(req, res, name, value, maxAge) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);
}

/* ---------- login throttling: 5 wrong attempts block a key for 10 minutes ---------- */
const fails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until <= now) fails.delete(k); }, 60000).unref();
const blockedFor = (key) => { const e = fails.get(key); return e && e.n >= 5 && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0; };
function addFail(key) {
  const now = Date.now(); let e = fails.get(key);
  if (!e || e.until <= now) e = { n: 0, until: now + 10 * 60 * 1000 };
  e.n++; fails.set(key, e);
}

/* ---------- settings: only these keys can be read or changed from the web ---------- */
export const BOOLS = ['statusSeen', 'statusReact', 'statusSave', 'viewOnce', 'callReject', 'autoAnswer', 'callLoop', 'callStream', 'autoRead', 'autoTyping', 'autoRecording', 'alwaysOnline', 'boostOptIn'];
const TEXT_KEYS = ['statusEmojis', 'callMsg', ...BRAND_KEYS, ...CSONG_USER_KEYS];
export function readSettings(sid) {
  const s = { mode: getMode(sid) };
  for (const k of BOOLS) s[k] = !!getSetting(sid, k, false);
  s.statusEmojis = (getSetting(sid, 'statusEmojis', null) || []).join(' ');
  s.callMsg = getSetting(sid, 'callMsg', null) || '';
  s.callMsgDefault = getDefaultCallMsg(); // what callers get when this number has no message of its own (the host's default)
  s.callHasImg = hasSessionCallImg(sid); // this number's own rejected-call picture
  for (const k of BRAND_KEYS) s[k] = getSetting(sid, k, null) || '';
  for (const k of CSONG_USER_KEYS) s[k] = String(getSetting(sid, k, null) ?? ''); // premium: this number's own .chsong look ('' = the host's default)
  s.csongHasImg = hasCenterImage(sid);
  return s;
}
// Checks a patch and turns it into [key, value] writes. Throws HttpError when anything is wrong, so nothing is half applied.
export function parseSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Nothing to change.');
  const writes = [];
  for (const [k, v] of Object.entries(patch)) {
    if (BOOLS.includes(k)) {
      if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid value.');
      if (k === 'callStream' && v) throw new HttpError(400, 'Real call answering needs a one-time device link. Send .callstream on in WhatsApp to turn it on.');
      writes.push([k, v]);
    } else if (k === 'mode') {
      if (v !== 'public' && v !== 'private') throw new HttpError(400, 'Mode must be public or private.');
      writes.push([k, v]);
    } else if (k === 'statusEmojis') {
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      const list = v.split(/\s+/).filter(Boolean).slice(0, 20).map((e) => e.slice(0, 8));
      writes.push([k, list.length ? list : null]);
    } else if (k === 'callMsg') {
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      writes.push([k, v.trim().slice(0, 500) || null]);
    } else if (k === 'brandName' || k === 'brandFooter') {
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      writes.push([k, cleanBrandText(v, BRAND_LIMITS[k]) || null]);
    } else if (k === 'brandLogo') {
      if (typeof v !== 'string' || v.length > BRAND_LIMITS.brandLogo) throw new HttpError(400, 'Invalid logo link.');
      writes.push([k, v.trim() || null]);
    } else if (CSONG_USER_KEYS.includes(k)) { // premium: the number's own .chsong look; '' = back to the host's default
      if (typeof v !== 'string') throw new HttpError(400, 'Invalid value.');
      if (k === 'csongEqSeconds') {
        const n = Math.round(Number(v));
        if (v.trim() && !(Number.isFinite(n) && n >= EQ_MIN_S && n <= EQ_MAX_S)) throw new HttpError(400, `Animation length must be ${EQ_MIN_S} to ${EQ_MAX_S} seconds.`);
        writes.push([k, v.trim() ? n : null]);
      } else {
        if (v && !CSONG_USER_OPTIONS[k].includes(v)) throw new HttpError(400, 'Invalid value.');
        writes.push([k, v || null]);
      }
    } else throw new HttpError(400, `Unknown setting: ${String(k).slice(0, 30)}`);
  }
  if (!writes.length) throw new HttpError(400, 'Nothing to change.');
  return writes;
}
function writeSettings(sid, writes) {
  for (const [k, v] of writes) setSetting(sid, k, v);
  const rec = sessions.get(sid);
  if (writes.some(([k]) => k === 'callStream' || k === 'callLoop') && state.callbotAvailable && rec?.sock) syncCallbot(sid, rec.sock).catch(() => {});
}
const hasConsentKey = (patch) => !!patch && typeof patch === 'object' && 'boostOptIn' in patch; // only the number's owner may switch this on
const hasCsongKeys = (patch) => !!patch && typeof patch === 'object' && Object.keys(patch).some((k) => CSONG_USER_KEYS.includes(k));
// "my own picture" in the middle needs a picture to be uploaded first
const checkCsongPatch = (sid, patch) => { if (patch?.csongEqCenter === 'custom' && !hasCenterImage(sid)) throw new HttpError(400, 'Choose and upload your picture first.'); };
const hasBrandKeys = (patch) => !!patch && typeof patch === 'object' && Object.keys(patch).some((k) => BRAND_KEYS.includes(k));
// A new logo link is downloaded once now, so the user gets a clear message instead of a logo that silently never shows.
async function checkBrandPatch(patch) {
  const url = typeof patch?.brandLogo === 'string' ? patch.brandLogo.trim() : '';
  if (!url) return;
  try { await checkLogo(url); } catch (err) { throw new HttpError(400, err?.message || 'The logo link does not work.'); }
}
function applySettings(sid, patch) { writeSettings(sid, parseSettings(patch)); }
function resetSettings(sid) { // back to the defaults (the saved call clips and the web password are not touched)
  for (const k of [...BOOLS, ...TEXT_KEYS, 'mode']) setSetting(sid, k, null);
  clearCenterImage(sid);
  removeSessionCallImg(sid).catch(() => {});
  const rec = sessions.get(sid);
  if (state.callbotAvailable && rec?.sock) syncCallbot(sid, rec.sock).catch(() => {});
}

/* ---------- admin-wide switches (kept in the same settings store under a reserved id) ---------- */
const GLOBAL = '_global';
export const isPairingOpen = () => getSetting(GLOBAL, 'pairingOpen', true) !== false;

async function unlink(sid) {
  const rec = sessions.get(sid);
  try { await Promise.race([rec?.sock?.logout(), sleep(5000)]); } catch {}
  destroySession(sid);
}
const mask = (p) => (p && p.length > 6 ? `${p.slice(0, 4)}${'•'.repeat(p.length - 6)}${p.slice(-2)}` : p || '');
// Call answering options are for the host owner's own number only (see isHostSession). Call reject, its message and its picture stay open to everybody.
const HOST_KEYS = ['autoAnswer', 'callStream', 'callLoop'];
function assertHostKeys(rec, patch) {
  if (isHostSession(rec?.phone) || !patch || typeof patch !== 'object') return;
  const bad = HOST_KEYS.some((k) => k in patch && patch[k] === true);
  if (bad) throw new HttpError(403, 'Auto answer and real call answering are only for the bot host owner\'s number. Call reject, its message and its picture are available.');
}
const adminEpoch = () => Number(getSetting(GLOBAL, 'adminEpoch', 0)) || 0; // bumped on logout: every admin cookie issued before that stops working
const isLinked = (r) => r.status === 'connected' || !!r.state?.creds?.registered;

/* online history: one sample a minute, last 24 h, memory only */
const history = [];
const sampleHistory = () => {
  let on = 0, linked = 0;
  for (const r of sessions.values()) { if (isLinked(r)) linked++; if (r.status === 'connected') on++; }
  history.push({ t: Date.now(), on, linked });
  if (history.length > 1440) history.shift();
};
setTimeout(sampleHistory, 5000).unref?.();
setInterval(sampleHistory, 60000).unref?.();



/* ---------- bulk actions: slow on purpose, one number at a time ---------- */
const bulk = { running: false, label: '', done: 0, total: 0 };
const cleanNotice = (t) => {
  const text = String(t || '').trim().slice(0, 1000);
  if (!text) throw new HttpError(400, 'Write the message first.');
  return text;
};
// WhatsApp "About" (bio): one line, max 139 characters (rules in lib/about.js).
const cleanAbout = (t) => { try { return cleanAboutText(t); } catch (e) { throw new HttpError(400, e.message); } };
const sendNotice = (sock, text) => say(sock, `${jidNum(sock.user?.id)}@s.whatsapp.net`, `📢 *${BOT_NAME} notice*\n\n${text}`);
const BULK_JOBS = {
  restart: { label: 'Restarting', gap: 800, run: async (id, r) => { if (!r.sock) throw new Error('offline'); r.sock.end(undefined); } },
  password: { label: 'Sending web passwords', gap: 1500, run: async (id, r) => { if (!r.sock) throw new Error('offline'); await sendWebPassword(r.sock, id); } },
  notice: { label: 'Sending the notice', gap: 1500, run: async (id, r, text) => { if (!r.sock) throw new Error('offline'); await sendNotice(r.sock, text); } },
  premium: { label: 'Telling numbers about premium', gap: 1500, run: async (id, r, days) => { if (!r.sock) throw new Error('offline'); await notifyPremium(r.sock, premiumGrantedText(getPremium(id), Number(days))); } },
  unpremium: { label: 'Telling numbers about premium', gap: 1500, run: async (id, r) => { if (!r.sock) throw new Error('offline'); await notifyPremium(r.sock, premiumRemovedText()); } },
  about: { label: 'Changing the About', gap: 3000, run: async (id, r, text) => { if (!r.sock || r.status !== 'connected') throw new Error('offline'); await setAbout(r.sock, id, text); } },
  delete: { label: 'Unlinking', gap: 300, run: async (id) => { await unlink(id); } },
};
async function runBulk(action, ids, text) {
  const job = BULK_JOBS[action];
  Object.assign(bulk, { running: true, label: job.label, done: 0, total: ids.length });
  let ok = 0, failed = 0, error = '';
  for (const id of ids) {
    const r = sessions.get(id);
    try { if (!r) throw new Error('gone'); await job.run(id, r, text); ok++; } catch (e) { failed++; error ||= String(e?.message || e).slice(0, 100); }
    bulk.done++;
    await sleep(job.gap);
  }
  bulk.running = false;
  bulk.last = { action, label: job.label, ok, failed, error, at: Date.now() }; // shown to the admin when it ends
  audit(`bulk ${action}`, `${ok} done, ${failed} skipped (offline or gone)`);
  return { ok, failed };
}
// "all" means every linked number. A list is checked: only real session ids, no duplicates, at most 200.
function pickTargets(input, allowUnlinked) {
  if (input === 'all') return [...sessions].filter(([, r]) => isLinked(r)).map(([id]) => id);
  if (!Array.isArray(input)) return [];
  return [...new Set(input)].filter((id) => safeId(id) && sessions.has(id) && (allowUnlinked || isLinked(sessions.get(id)))).slice(0, 200);
}

export function mountWeb(app) {
  startSysmon(SESSION_ROOT); // samples CPU / memory every 2 s for the admin Server tab
  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => { // .then(): a plain (non-async) handler that throws is caught too and answered as JSON
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('Web route error:', err?.message || err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  });
  // Browsers cannot add a custom header cross-site without a CORS preflight, so this blocks cross-site form posts.
  const guard = (req, res, next) => (req.method !== 'GET' && req.get('x-rio') !== '1' ? res.status(403).json({ error: 'Bad request.' }) : next());

  app.use(['/settings', '/admin', '/api/web', '/api/me', '/api/admin'], (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/api/admin', trackIp); // audit entries remember the IP of the admin who made them
  app.get('/settings', (_q, res) => res.sendFile(path.join(ROOT_DIR, 'views', 'settings.html')));
  const sendAdminPage = (res) => res.sendFile(path.join(ROOT_DIR, 'views', 'admin.html'));
  app.get(['/admin', '/admin/:code'], adminPageHandler(ADMIN_CODE, sendAdminPage)); // with ADMIN_CODE set, only /admin/<code> shows the login; /admin goes to the pair site

  /* ----- user: login and own settings ----- */
  const userAuth = (req, res, next) => {
    const p = verify(readCookie(req, 'rio_u'));
    const rec = p?.t === 'u' ? sessions.get(p.sid) : null;
    if (!rec || !hasWebPassword(p.sid) || webPasswordVersion(p.sid) !== p.pv) return res.status(401).json({ error: 'Please log in again.' });
    req.sid = p.sid; req.rec = rec; next();
  };

  app.post('/api/web/login', guard, wrap(async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '').slice(0, 20);
    const password = String(req.body?.password || '');
    const keys = [`ip:${req.ip}`, `num:${phone}`];
    const wait = Math.max(...keys.map(blockedFor));
    if (wait) { res.set('Retry-After', String(wait)); throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`); }
    let sid = null;
    for (const [id, r] of sessions) if (phone && r.phone === phone && isLinked(r)) sid = id;
    if (!sid || !(await checkWebPassword(sid, password))) { keys.forEach(addFail); throw new HttpError(401, 'The number or password is not right.'); }
    fails.delete(keys[1]);
    putCookie(req, res, 'rio_u', sign({ t: 'u', sid, pv: webPasswordVersion(sid), exp: Date.now() + USER_TTL_S * 1000 }), USER_TTL_S);
    res.json({ ok: true });
  }));
  app.post('/api/web/logout', guard, (req, res) => { putCookie(req, res, 'rio_u', '', 0); res.json({ ok: true }); });

  app.get('/api/me', userAuth, (req, res) => res.json({ phone: req.rec.phone, host: isHostSession(req.rec.phone), status: req.rec.status, callService: !!state.callbotAvailable, premium: premiumView(req.sid), csongMax: PREMIUM_MAX_S, settings: readSettings(req.sid) }));
  app.patch('/api/me/settings', guard, userAuth, wrap(async (req, res) => {
    assertHostKeys(req.rec, req.body);
    if (hasBrandKeys(req.body) && !isPremium(req.sid)) throw new HttpError(403, 'Custom name, footer and logo are 👑 premium features. Contact the bot owner to get premium.');
    if (hasCsongKeys(req.body) && !isPremium(req.sid)) throw new HttpError(403, 'The channel song look is a 👑 premium feature. Contact the bot owner to get premium.');
    parseSettings(req.body); // validate everything before the (slow) logo check
    checkCsongPatch(req.sid, req.body);
    await checkBrandPatch(req.body);
    applySettings(req.sid, req.body);
    res.json({ ok: true, settings: readSettings(req.sid) });
  }));
  /* ----- premium: the number's own picture for the middle of the round .chsong animation (raw image upload, shrunk to a small square JPEG) ----- */
  app.get('/api/me/csong-image', userAuth, (req, res) => {
    const img = getCenterImage(req.sid);
    if (!img) return res.status(404).json({ error: 'No picture yet.' });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(img);
  });
  app.post('/api/me/csong-image', guard, userAuth, express.raw({ type: 'image/*', limit: '8mb' }), wrap(async (req, res) => {
    if (!isPremium(req.sid)) throw new HttpError(403, 'The channel song look is a 👑 premium feature. Contact the bot owner to get premium.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a picture first.');
    let size; try { size = await setCenterImage(req.body, req.sid); } catch (err) { throw new HttpError(400, /too detailed/.test(err?.message) ? err.message : 'That file is not a picture this site can read. Use a JPG, PNG, WEBP or GIF.'); }
    res.json({ ok: true, kb: Math.round(size / 1024), settings: readSettings(req.sid) });
  }));
  app.post('/api/me/csong-image/remove', guard, userAuth, wrap((req, res) => {
    clearCenterImage(req.sid);
    res.json({ ok: true, settings: readSettings(req.sid) });
  }));
  /* ----- every number: its own rejected-call picture (gallery upload or link; shrunk to a JPEG). Without one the host's picture is used. ----- */
  const callImgAt = new Map(); // sid -> last save time (a link download is slow, so no spamming)
  const callImgSlow = (sid) => { const t = Date.now(); if (t - (callImgAt.get(sid) || 0) < 4000) throw new HttpError(429, 'Please wait a few seconds before the next picture.'); callImgAt.set(sid, t); };
  app.get('/api/me/call-image', userAuth, wrap(async (req, res) => {
    const img = await getSessionCallImg(req.sid);
    if (!img) throw new HttpError(404, 'No picture yet.');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(img);
  }));
  app.post('/api/me/call-image', guard, userAuth, express.raw({ type: 'image/*', limit: '8mb' }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a picture first.');
    callImgSlow(req.sid);
    let size; try { size = await saveSessionCallImg(req.sid, req.body); } catch (err) { throw new HttpError(400, err?.message || 'That file is not a picture this site can read. Use a JPG, PNG, WEBP or GIF.'); }
    res.json({ ok: true, kb: Math.max(1, Math.round(size / 1024)), settings: readSettings(req.sid) });
  }));
  app.post('/api/me/call-image/link', guard, userAuth, wrap(async (req, res) => {
    const url = String(req.body?.url || '').trim().slice(0, 1000);
    if (!url) throw new HttpError(400, 'Paste a picture link first.');
    callImgSlow(req.sid);
    let size; try { size = await saveSessionCallImgFromLink(req.sid, url); } catch (err) { throw new HttpError(400, err?.message || 'Could not use that link.'); }
    res.json({ ok: true, kb: Math.max(1, Math.round(size / 1024)), settings: readSettings(req.sid) });
  }));
  app.post('/api/me/call-image/remove', guard, userAuth, wrap(async (req, res) => {
    await removeSessionCallImg(req.sid);
    res.json({ ok: true, settings: readSettings(req.sid) });
  }));
  /* ----- channel support (premium): add / remove a channel; the pool is the numbers that opted in ----- */
  app.get('/api/me/boost', userAuth, (req, res) => res.json(boostSummary(req.sid)));
  app.post('/api/me/boost', guard, userAuth, wrap(async (req, res) => {
    if (!isPremium(req.sid)) throw new HttpError(403, 'Channel support is a 👑 premium feature. Contact the bot owner to get premium.');
    try { res.json({ ok: true, ...(await addChannel(req.sid, String(req.body?.link || '').slice(0, 300), String(req.body?.emojis || '').slice(0, 60), packsOf(req.body))) }); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not add the channel.'); }
  }));
  app.post('/api/me/boost/:id/packs', guard, userAuth, wrap((req, res) => { // change the emoji packs of one of my channels
    try { res.json({ ok: true, ...setChannelPacks(req.sid, String(req.params.id).slice(0, 20), packsOf(req.body), String(req.body?.emojis || '').slice(0, 60)) }); }
    catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
  }));
  app.delete('/api/me/boost/:id', guard, userAuth, wrap((req, res) => {
    try { res.json({ ok: true, ...removeChannel(req.sid, String(req.params.id).slice(0, 20)) }); }
    catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
  }));
  app.post('/api/me/reset', guard, userAuth, wrap((req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirmation is missing.');
    resetSettings(req.sid);
    res.json({ ok: true, settings: readSettings(req.sid) });
  }));
  app.post('/api/me/password', guard, userAuth, wrap(async (req, res) => {
    if (!req.rec.sock) throw new HttpError(409, 'Your bot is offline right now, so the password cannot be sent. Try again in a minute.');
    await sendWebPassword(req.rec.sock, req.sid);
    putCookie(req, res, 'rio_u', '', 0); // the old password is gone, so this login ends too
    res.json({ ok: true });
  }));
  app.post('/api/me/unlink', guard, userAuth, wrap(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirmation is missing.');
    await unlink(req.sid);
    putCookie(req, res, 'rio_u', '', 0);
    res.json({ ok: true });
  }));

  /* ----- admin ----- */
  const adminAuth = (req, res, next) => {
    const p = ADMIN_ENABLED ? verify(readCookie(req, 'rio_a')) : null;
    if (p?.t !== 'a' || p.ep !== adminEpoch()) return res.status(401).json({ error: 'Please log in again.' });
    next();
  };
  const target = (req) => {
    if (!safeId(req.params.id) || !sessions.get(req.params.id)) throw new HttpError(404, 'Session not found.');
    return sessions.get(req.params.id);
  };

  // Notices (shown on the pair and settings sites; written in /admin → Notices). The settings site knows a visitor by the login cookie.
  const userSid = (req) => {
    const p = verify(readCookie(req, 'rio_u'));
    return p?.t === 'u' && sessions.get(p.sid) && hasWebPassword(p.sid) && webPasswordVersion(p.sid) === p.pv ? p.sid : null;
  };
  mountBotMedia(app, { adminAuth, guard, wrap, HttpError, audit }); // /admin → Bot media
  mountNotices(app, { adminAuth, guard, wrap, HttpError, userSid, phoneOf: (sid) => mask(sessions.get(sid)?.phone), linkedCount: () => [...sessions.values()].filter(isLinked).length });

  app.post('/api/admin/login', guard, wrap((req, res) => {
    if (!ADMIN_ENABLED) throw new HttpError(503, 'The admin site is off. Set ADMIN_PASSWORD (10+ characters) on the server.');
    const wait = waitFor(req.ip);
    if (wait) { res.set('Retry-After', String(wait)); throw new HttpError(429, `Too many wrong attempts from this address. Try again in ${wait >= 3600 ? `${Math.ceil(wait / 3600)} hour(s)` : `${Math.ceil(wait / 60)} minute(s)`}.`); }
    const okUser = crypto.timingSafeEqual(sha(String(req.body?.user || '')), sha(ADMIN_USER));
    const okPass = crypto.timingSafeEqual(sha(String(req.body?.password || '')), sha(ADMIN_PASSWORD));
    const ua = req.get('user-agent');
    if (!(okUser && okPass)) {
      const locked = recordFail(req.ip, ua, req.body?.user);
      if (locked) { audit('admin login locked', `${Math.round(locked / 60000)} min after repeated wrong passwords`); throw new HttpError(429, `Too many wrong attempts. This address is locked for ${locked >= 3600000 ? `${Math.round(locked / 3600000)} hour(s)` : `${Math.round(locked / 60000)} minute(s)`}.`); }
      throw new HttpError(401, 'The username or password is not right.');
    }
    const fresh = recordSuccess(req.ip, ua);
    putCookie(req, res, 'rio_a', sign({ t: 'a', ep: adminEpoch(), exp: Date.now() + ADMIN_TTL_S * 1000 }), ADMIN_TTL_S);
    audit(fresh ? 'login from a NEW address' : 'login');
    res.json({ ok: true });
  }));
  app.post('/api/admin/logout', guard, (req, res) => {
    const p = ADMIN_ENABLED ? verify(readCookie(req, 'rio_a')) : null;
    if (p?.t === 'a' && p.ep === adminEpoch()) { // only a real admin session can end sessions (nobody else can log the admin out)
      setSetting(GLOBAL, 'adminEpoch', adminEpoch() + 1);
      audit('logout', 'all admin sessions ended');
    }
    putCookie(req, res, 'rio_a', '', 0);
    res.json({ ok: true });
  });

  app.get('/api/admin/overview', adminAuth, (_req, res) => {
    const list = [...sessions].map(([id, r]) => ({
      id, phone: mask(r.phone), linked: isLinked(r), status: r.status, mode: getMode(id), webPassword: hasWebPassword(id),
      features: BOOLS.filter((k) => getSetting(id, k, false)).length, premium: getPremium(id).active, premiumDays: getPremium(id).daysLeft,
      cmdLimit: sessionLimit(id).only ? sessionLimit(id).allowed.length : null, // how many commands this number may use (null = no limit)
      about: aboutCached(id)?.known ? aboutCached(id).text : null, // null = not read yet
    }));
    warmAbout(list.filter((x) => x.status === 'connected' && x.about === null).map((x) => x.id)).catch(() => {}); // fills in the background, shown on the next refresh
    res.json({
      bot: BOT_NAME, uptimeSeconds: Math.round(process.uptime()), maxSessions: MAX_SESSIONS, storage: state.mongoCol ? 'MongoDB' : 'Files',
      callService: !!state.callbotAvailable, connected: list.filter((s) => s.status === 'connected').length, premiumCount: list.filter((s) => s.premium).length,
      boost: adminBoost(mask), pairingOpen: isPairingOpen(), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version,
      defaultMode: DEFAULT_MODE, bulk: bulk.running ? { label: bulk.label, done: bulk.done, total: bulk.total } : null, lastBulk: bulk.last || null,
      sessions: list.sort((a, b) => Number(b.linked) - Number(a.linked)), audit: recentAudit(40),
    });
  });
  // Live CPU / memory / event loop / disk. ?history=1 also sends the last 5 minutes so the graphs are full as soon as the tab opens.
  app.get('/api/admin/system', adminAuth, (req, res) => {
    const list = [...sessions.values()];
    res.json({ ...sysView({ withHistory: req.query.history === '1' }), sessions: { connected: list.filter((r) => r.status === 'connected').length, total: list.length, max: MAX_SESSIONS }, cmds: liveCounts(), now: Date.now() });
  });
  // The list shows masked numbers, so a typed number cannot be matched in the browser. The match is done here; only ids come back.
  app.get('/api/admin/find', adminAuth, (req, res) => {
    const d = String(req.query.q || '').replace(/\D/g, '').slice(0, 15);
    if (d.length < 4) return res.json({ ids: [] });
    res.json({ ids: [...sessions].filter(([, r]) => String(r.phone || '').includes(d)).map(([id]) => id).slice(0, 200) });
  });
  app.get('/api/admin/insights', adminAuth, (_req, res) => {
    const total = [...sessions.values()].filter(isLinked).length;
    const features = {};
    for (const k of BOOLS) features[k] = 0;
    const modes = { public: 0, private: 0 };
    for (const [id, r] of sessions) {
      if (!isLinked(r)) continue;
      for (const k of BOOLS) if (getSetting(id, k, false)) features[k]++;
      modes[getMode(id) === 'private' ? 'private' : 'public']++;
    }
    res.json({ total, features, modes, history: history.slice(-288) });
  });
  /* ----- admin: commands on/off, maintenance, bans, analytics ----- */
  // Command categories for the admin Commands tab (same groups as .menu / .momenu). A command not listed here shows under "📦 OTHER".
  const CMD_CATS = [
    ['⚙️ GENERAL', 'menu alive ping runtime about owner status pair'],
    ['📥 DOWNLOAD', 'tt tts ttdl ttmp3 fb ig tw pin song video ytdl dl apk apkget lyrics'],
    ['📰 NEWS', 'news hiru derana itn swarna sirasa'],
    ['🌍 UTILITIES', 'weather imdb currency translate define wiki short ss'],
    ['🎨 MEDIA', 'tosticker toasticker toimg tovideo emojimix sticker media tomp3 topdf ocr readqr'],
    ['👥 GROUP', 'groupinfo grouphelp gsettings admins rules tagadmins warnlist poll kick add promote demote warn resetwarn tagall hidetag del delfrom group mute unmute antilink welcome goodbye lockinfo unlockinfo requests approveall rejectall setname setdesc setgpp link revoke ephemeral'],
    ['🎉 FUN', 'funmenu joke fact quote 8ball dice coin rps pick rate ship truth dare wyr hug slap reverse mock clap calc password roast compliment pickup fortune iq slot riddle mathquiz answer guess fancy upside binary unbinary morse base64 b64 unb64 qr random time remind'],
    ['📲 STATUS & VIEW-ONCE', 'autostatus statusseen statusreact statusemoji statussave viewonce vv vvemoji save'],
    ['👑 OWNER COMMANDS', 'mode callreject broadcast forward block unblock join leave setbio setpp fulldp webpass premium chsong chid'],
    ['👑 PREMIUM', 'getdp gadd'],
    ['🩺 DOWNLOAD TOOLS (host)', 'ytcheck dlcheck'],
    ['📰 AUTO NEWS (host)', 'newson newsoff newsadd newsdel newslist support autojoin autofollow followall creact'],
    ['📞 CALL (host)', 'call callstream autoanswer setcallaudio setcallvideo setcallmsg callpreview delcallmedia addpack packs delpack callto ohelp'],
    ['🛠️ HOST OWNER', 'restart momenu ownermenu omenu'],
  ].map(([label, names]) => [label, new Set(names.split(' '))]);
  const OTHER_CAT = '📦 OTHER';
  const catOf = (c) => (CMD_CATS.find(([, set]) => set.has(c.name) || (c.aliases || []).some((a) => set.has(a))) || [OTHER_CAT])[0];
  const cmdView = () => {
    const off = disabledCmds(), use = commandUsage();
    return { cats: [...CMD_CATS.map(([l]) => l), OTHER_CAT], maintenance: getMaintenance(), menuStyle: getMenuStyle(), banned: bannedList().map((n, i) => ({ i, m: mask(n) })), protected: [...PROTECTED], commands: [...new Set(registry.values())].map((c) => ({ name: c.name, aliases: c.aliases || [], owner: accessOf(c).who !== 'all', who: accessOf(c).who, defWho: defaultAccess(c).who, premium: accessOf(c).premium, defPremium: defaultAccess(c).premium, custom: accessOf(c).custom, cat: catOf(c), disabled: off.has(c.name) && !PROTECTED.has(c.name), uses: use[c.name]?.n || 0, errors: use[c.name]?.e || 0 })).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  // Who can use a command (everyone / number owner / host admin) and whether it needs premium. Can only be made stricter than the built-in level.
  app.post('/api/admin/commands/access', guard, adminAuth, wrap((req, res) => {
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => String(n).toLowerCase().slice(0, 40)).filter((n) => registry.has(n)).slice(0, 300);
    if (!names.length) throw new HttpError(400, 'Pick at least one command.');
    const who = req.body?.who === undefined ? undefined : String(req.body.who);
    const premium = req.body?.premium === undefined ? undefined : req.body.premium === 'default' ? 'default' : !!req.body.premium;
    if (who !== undefined && who !== 'default' && !(who in WHO_RANK)) throw new HttpError(400, 'Invalid value.');
    const cmds = [...new Set(names.map((n) => registry.get(n)))];
    const refused = setAccess(cmds, who, premium);
    audit('changed command access', cmds.slice(0, 6).map((c) => c.name).join(', ') + (cmds.length > 6 ? ` +${cmds.length - 6}` : '') + `: ${who !== undefined ? `who=${who} ` : ''}${premium !== undefined ? `premium=${premium}` : ''}`.trim());
    if (refused.length === cmds.length) throw new HttpError(400, `Not allowed: ${refused.map((n) => '.' + n).join(', ')} cannot be made less strict than its built-in level.`);
    res.json({ ok: true, refused, ...cmdView() });
  }));
  app.get('/api/admin/commands', adminAuth, (_req, res) => res.json(cmdView()));
  app.post('/api/admin/commands/toggle', guard, adminAuth, wrap((req, res) => {
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => String(n).toLowerCase().slice(0, 40)).filter((n) => registry.has(n)).slice(0, 300);
    if (!names.length) throw new HttpError(400, 'Pick at least one command.');
    setCmdsDisabled(names.map((n) => registry.get(n).name), !!req.body?.disabled);
    audit(req.body?.disabled ? 'switched commands off' : 'switched commands on', names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6}` : ''));
    res.json({ ok: true, ...cmdView() });
  }));
  // Limit ONE number to certain commands: with "only" on, every command that is not in `allowed` is switched off for that number (its menu hides them too).
  app.get('/api/admin/session/:id/commands', adminAuth, wrap((req, res) => { target(req); res.json({ ok: true, ...sessionLimit(req.params.id) }); }));
  app.post('/api/admin/session/:id/commands', guard, adminAuth, wrap((req, res) => {
    const r = target(req), only = !!req.body?.only;
    const allowed = [...new Set((Array.isArray(req.body?.allowed) ? req.body.allowed : []).map((n) => String(n).toLowerCase().slice(0, 40)).filter((n) => registry.has(n)).map((n) => registry.get(n).name))].slice(0, 400);
    setSessionLimit(req.params.id, only, allowed);
    audit(only ? 'limited commands for a number' : 'removed the command limit of a number', `${mask(r.phone)}${only ? `: ${allowed.length} allowed` : ''}`);
    res.json({ ok: true, ...sessionLimit(req.params.id) });
  }));
  app.post('/api/admin/maintenance', guard, adminAuth, wrap((req, res) => {
    setMaintenance(!!req.body?.on, req.body?.text);
    audit(req.body?.on ? 'maintenance ON' : 'maintenance off'); res.json({ ok: true, ...cmdView() });
  }));
  app.post('/api/admin/menustyle', guard, adminAuth, wrap((req, res) => {
    const style = String(req.body?.style || '');
    if (!MENU_STYLES.includes(style)) throw new HttpError(400, 'Invalid menu style.');
    setMenuStyle(style);
    audit('changed menu style', style);
    res.json({ ok: true, ...cmdView() });
  }));
  app.get('/api/admin/btnstyle', adminAuth, (_req, res) => res.json({ style: getBtnStyle() }));
  app.post('/api/admin/btnstyle', guard, adminAuth, wrap((req, res) => {
    const style = String(req.body?.style || '');
    if (!BTN_STYLES.includes(style)) throw new HttpError(400, 'Invalid button style.');
    setBtnStyle(style);
    audit('changed button style', style);
    res.json({ ok: true, style: getBtnStyle() });
  }));
  app.post('/api/admin/ban', guard, adminAuth, wrap((req, res) => {
    const idx = Number.isInteger(req.body?.index) ? bannedList()[req.body.index] : null;
    const num = idx || req.body?.number, on = idx ? false : req.body?.on !== false;
    try { setBanned(num, on); } catch (e) { throw new HttpError(400, e.message); }
    audit(on ? 'banned a number' : 'unbanned a number', mask(String(num || '').replace(/\D/g, '')));
    res.json({ ok: true, ...cmdView() });
  }));
  app.get('/api/admin/analytics', adminAuth, (_req, res) => res.json(analytics((sid) => mask(sessions.get(sid)?.phone))));
  app.get('/api/admin/session/:id', adminAuth, wrap((req, res) => {
    const r = target(req);
    res.json({ phone: mask(r.phone), host: isHostSession(r.phone), status: r.status, linked: isLinked(r), error: r.error || null, retries: r.retries || 0, webPassword: hasWebPassword(req.params.id), premium: premiumView(req.params.id), about: aboutCached(req.params.id)?.known ? aboutCached(req.params.id).text : null, settings: readSettings(req.params.id) });
  }));
  app.get('/api/admin/session/:id/about', adminAuth, wrap(async (req, res) => { target(req); const a = await readAbout(req.params.id, { force: true }); res.json({ ok: true, about: a.known ? a.text : null }); }));
  app.patch('/api/admin/session/:id/settings', guard, adminAuth, wrap(async (req, res) => {
    if (hasConsentKey(req.body)) throw new HttpError(400, 'Only the number owner can change this option.');
    assertHostKeys(target(req), req.body); parseSettings(req.body); checkCsongPatch(req.params.id, req.body); await checkBrandPatch(req.body); applySettings(req.params.id, req.body);
    audit('changed settings', `${mask(sessions.get(req.params.id)?.phone)}: ${Object.keys(req.body).join(', ')}`);
    res.json({ ok: true, settings: readSettings(req.params.id) });
  }));
  app.post('/api/admin/session/:id/reset', guard, adminAuth, wrap((req, res) => {
    const r = target(req); resetSettings(req.params.id);
    audit('reset settings', mask(r.phone)); res.json({ ok: true, settings: readSettings(req.params.id) });
  }));
  app.post('/api/admin/session/:id/restart', guard, adminAuth, wrap((req, res) => {
    const r = target(req);
    try { r.sock?.end(undefined); } catch {} // the normal reconnect logic brings it back
    audit('restarted', mask(r.phone)); res.json({ ok: true });
  }));
  app.post('/api/admin/session/:id/password', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    if (!r.sock) throw new HttpError(409, 'This session is offline, so the password cannot be sent.');
    await sendWebPassword(r.sock, req.params.id);
    audit('reset web password', mask(r.phone)); res.json({ ok: true });
  }));
  app.post('/api/admin/session/:id/notice', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    const text = cleanNotice(req.body?.text);
    if (!r.sock) throw new HttpError(409, 'This session is offline, so the message cannot be sent.');
    await sendNotice(r.sock, text);
    audit('sent notice', mask(r.phone)); res.json({ ok: true });
  }));
  app.post('/api/admin/session/:id/about', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    const text = cleanAbout(req.body?.text);
    if (!r.sock || r.status !== 'connected') throw new HttpError(409, 'This session is offline, so the About cannot be changed.');
    try { await setAbout(r.sock, req.params.id, text); }
    catch (err) { console.error('About change failed:', err?.message || err); throw new HttpError(502, `WhatsApp did not accept the change${err?.message ? ` (${String(err.message).slice(0, 80)})` : ''}. Try again in a moment.`); }
    audit('changed About', `${mask(r.phone)}: ${text.slice(0, 60)}`);
    const back = await readAbout(req.params.id, { force: true }); // read it back from WhatsApp to be sure
    res.json({ ok: true, about: back.known ? back.text : text, confirmed: back.known && back.text === text });
  }));
  // Bot media → About: the default text for newly linked numbers + what every number shows now
  const aboutView = () => ({
    ok: true, max: ABOUT_MAX, builtin: BUILTIN_ABOUT, text: String(getSetting(GLOBAL, 'botmedia_about', '') || ''), effective: getDefaultAbout(), auto: aboutAuto(), refreshing: aboutRefreshing(),
    numbers: [...sessions].filter(([, r]) => isLinked(r)).map(([id, r]) => ({ id, phone: mask(r.phone), online: r.status === 'connected', about: aboutCached(id)?.known ? aboutCached(id).text : null })),
  });
  app.get('/api/admin/about', adminAuth, (_req, res) => {
    warmAbout([...sessions].filter(([, r]) => r.status === 'connected').map(([id]) => id)).catch(() => {}); // only numbers that have not been read yet (cached ones are skipped)
    res.json(aboutView());
  });
  app.post('/api/admin/about/default', guard, adminAuth, wrap((req, res) => {
    const raw = String(req.body?.text ?? '').trim();
    if (raw) cleanAbout(raw); // must be valid, an empty text means "back to the built-in one"
    setSetting(GLOBAL, 'botmedia_about', raw ? cleanAbout(raw) : null);
    if (req.body?.auto !== undefined) setSetting(GLOBAL, 'botmedia_aboutAuto', req.body.auto !== false);
    audit('default About', `${aboutAuto() ? 'on' : 'off'}: ${getDefaultAbout().slice(0, 60)}`);
    res.json(aboutView());
  }));
  app.post('/api/admin/about/refresh', guard, adminAuth, wrap((_req, res) => {
    if (!aboutRefreshing()) warmAbout([...sessions].filter(([, r]) => r.status === 'connected').map(([id]) => id), { force: true }).catch(() => {});
    res.json({ ...aboutView(), refreshing: true });
  }));
  app.post('/api/admin/session/:id/premium', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req), id = req.params.id;
    if (req.body?.action === 'revoke') {
      revokePremium(id);
      audit('removed premium', mask(r.phone));
      await notifyPremium(r.sock, premiumRemovedText());
      return res.json({ ok: true, premium: premiumView(id) });
    }
    if (req.body?.action !== 'grant') throw new HttpError(400, 'Unknown action.');
    const days = parseDays(req.body?.days);
    if (!days) throw new HttpError(400, 'Days must be a whole number from 1 to 3650.');
    const p = grantPremium(id, days);
    audit('gave premium', `${mask(r.phone)}: +${days} day(s), ${p.daysLeft} left`);
    await notifyPremium(r.sock, premiumGrantedText(p, days));
    res.json({ ok: true, premium: premiumView(id) });
  }));
  app.post('/api/admin/session/:id/delete', guard, adminAuth, wrap(async (req, res) => {
    const r = target(req);
    audit('deleted session', mask(r.phone));
    await unlink(req.params.id);
    res.json({ ok: true });
  }));

  /* ----- admin: turn new links on or off ----- */
  app.post('/api/admin/pairing', guard, adminAuth, wrap((req, res) => {
    if (typeof req.body?.open !== 'boolean') throw new HttpError(400, 'Invalid value.');
    setSetting(GLOBAL, 'pairingOpen', req.body.open);
    audit(req.body.open ? 'opened new links' : 'paused new links');
    res.json({ ok: true, pairingOpen: isPairingOpen() });
  }));

  /* ----- admin: channel support (pause everything, remove a channel; consent switches stay with the number owners) ----- */
  app.post('/api/admin/boost/pause', guard, adminAuth, wrap((req, res) => {
    if (typeof req.body?.paused !== 'boolean') throw new HttpError(400, 'Invalid value.');
    setPaused(req.body.paused);
    audit(req.body.paused ? 'paused channel support' : 'resumed channel support');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.post('/api/admin/boost', guard, adminAuth, wrap(async (req, res) => {
    const scope = req.body?.scope === 'optin' ? 'optin' : 'all';
    try { await addAdminChannel(String(req.body?.link || '').slice(0, 300), String(req.body?.emojis || '').slice(0, 60), scope, req.body?.autoReact !== false, packsOf(req.body)); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not add the channel.'); }
    audit('added a support channel', scope === 'all' ? 'all online numbers' : 'opted-in numbers');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  /* ----- admin: the public /premium page (plans, prices, what you get, contact, note). Saved here = no redeploy needed ----- */
  app.get('/api/admin/premiumpage', adminAuth, (_req, res) => res.json(premiumConfigView()));
  app.post('/api/admin/premiumpage', guard, adminAuth, wrap((req, res) => {
    let view;
    try { view = savePremiumConfig(req.body || {}); } catch (err) { throw new HttpError(400, err?.message || 'Could not save.'); }
    audit('changed the premium page', `${view.plans.length} plan(s)${view.plans.length ? `: ${view.plans.map((p) => `${p.name} ${p.price}`.trim()).join(', ').slice(0, 120)}` : ''}`);
    res.json(view);
  }));
  app.post('/api/admin/premiumpage/reset', guard, adminAuth, wrap((_req, res) => {
    const view = resetPremiumConfig();
    audit('premium page back to the default', 'plans, list, contact and note come from the environment again');
    res.json(view);
  }));
  /* ----- admin: how the .chsong thumbnail looks (normal picture or picture with an animated equalizer) ----- */
  app.get('/api/admin/csong', adminAuth, (_req, res) => res.json(csongView()));
  app.post('/api/admin/csong', guard, adminAuth, wrap((req, res) => {
    const b = req.body || {};
    if (b.mode !== undefined && !['normal', 'equalizer'].includes(b.mode)) throw new HttpError(400, 'Mode must be normal or equalizer.');
    try { setCsong({ mode: b.mode, seconds: b.seconds, style: b.style, layout: b.layout, center: b.center, motion: b.motion, particles: b.particles, particleStyle: b.particleStyle, blobStyle: b.blobStyle, blobShape: b.blobShape }); } catch (err) { throw new HttpError(400, err?.message || 'Could not save.'); }
    audit('changed the .chsong thumbnail', `${getCsong().mode} / ${getCsong().layout} / centre: ${getCsong().center} / ${getCsong().motion} / particles: ${getCsong().particles ? getCsong().particleStyle : 'off'}`);
    res.json(csongView());
  }));
  // the host's own picture for the middle of the round layout: the browser sends the raw file (Content-Type image/*), it is shrunk to a small square JPEG
  app.get('/api/admin/csong-image', adminAuth, (_req, res) => {
    const img = getCenterImage();
    if (!img) return res.status(404).json({ error: 'No picture yet.' });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(img);
  });
  app.post('/api/admin/csong-image', guard, adminAuth, express.raw({ type: 'image/*', limit: '8mb' }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a picture first.');
    let size; try { size = await setCenterImage(req.body); } catch { throw new HttpError(400, 'That file is not a picture this site can read. Use a JPG, PNG, WEBP or GIF.'); }
    audit('uploaded the .chsong centre picture', `${Math.round(size / 1024)} KB`);
    res.json({ ...csongView(), kb: Math.round(size / 1024) });
  }));
  app.post('/api/admin/csong-image/remove', guard, adminAuth, wrap((_req, res) => {
    clearCenterImage();
    audit('removed the .chsong centre picture', '');
    res.json(csongView());
  }));
  app.post('/api/admin/boost/welcome', guard, adminAuth, wrap((req, res) => { // auto follow / join for every newly linked number
    setWelcomeAll(req.body?.on !== false);
    audit(req.body?.on !== false ? 'turned on auto follow for new links (everyone)' : 'turned off auto follow for new links (opt-in only)');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.get('/api/admin/boost', adminAuth, (_req, res) => res.json({ ok: true, boost: adminBoost(mask) }));
  app.post('/api/admin/boost/react', guard, adminAuth, wrap(async (req, res) => {
    const scope = req.body?.scope === 'optin' ? 'optin' : 'all';
    try { await reactToPost(String(req.body?.link || '').slice(0, 300), String(req.body?.emojis || '').slice(0, 60), scope, req.body?.follow !== false, packsOf(req.body)); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not start the reactions.'); }
    audit('reacted to a channel post', scope === 'all' ? 'all online numbers' : 'opted-in numbers');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.post('/api/admin/boost/poll/load', guard, adminAuth, wrap(async (req, res) => { // read the options of a channel poll post
    try { const poll = await loadPoll(String(req.body?.link || '').slice(0, 300)); res.json({ ok: true, poll: { channel: poll.channel, postId: poll.postId, question: poll.question || '', options: poll.options || [], unreadable: !!poll.unreadable, diag: poll.diag || '', tally: poll.tally || null }, online: poll.online, optin: poll.optin, counts: poll.counts }); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not read the poll.'); }
  }));
  app.post('/api/admin/boost/poll/vote', guard, adminAuth, wrap(async (req, res) => {
    const scope = req.body?.scope === 'optin' ? 'optin' : 'all';
    try { await votePoll(String(req.body?.link || '').slice(0, 300), req.body?.option, req.body?.count, scope, req.body?.follow !== false, String(req.body?.optionText || '').slice(0, 100), ['change', 'remove'].includes(req.body?.action) ? req.body.action : 'vote', req.body?.anyNumber === true); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not start the voting.'); }
    audit(`${req.body?.action === 'remove' ? 'removed votes on' : req.body?.action === 'change' ? 'changed votes on' : 'voted on'} a channel poll`, `${Math.floor(Number(req.body?.count)) || 1} number(s), ${scope === 'all' ? 'all online numbers' : 'opted-in numbers'}`);
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.post('/api/admin/boost/poll/stop', guard, adminAuth, wrap((_req, res) => {
    try { stopPoll(); } catch (err) { throw new HttpError(400, err?.message || 'Nothing to stop.'); }
    audit('stopped a channel poll vote');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.get('/api/admin/boost/:id/check', adminAuth, wrap(async (req, res) => {
    try { res.json({ ok: true, report: await adminCheck(String(req.params.id).slice(0, 20)) }); }
    catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
  }));
  app.post('/api/admin/boost/:id/packs', guard, adminAuth, wrap((req, res) => {
    try { adminSetPacks(String(req.params.id).slice(0, 20), packsOf(req.body), String(req.body?.emojis || '').slice(0, 60)); } catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
    audit('changed the emoji packs of a channel');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.post('/api/admin/boost/:id/auto', guard, adminAuth, wrap((req, res) => {
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'Invalid value.');
    try { adminSetAuto(String(req.params.id).slice(0, 20), req.body.on); } catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
    audit(req.body.on ? 'turned on auto react for a channel' : 'turned off auto react for a channel');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));
  app.delete('/api/admin/boost/:id', guard, adminAuth, wrap((req, res) => {
    try { adminRemove(String(req.params.id).slice(0, 20)); } catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
    audit('removed a support channel');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));

  /* ----- admin: full audit history (stored, searchable) ----- */
  app.get('/api/admin/audit', adminAuth, (req, res) => res.json(listAudit({ q: String(req.query.q || ''), offset: req.query.offset, limit: req.query.limit })));
  app.get('/api/admin/audit/export', adminAuth, (_req, res) => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`; // a leading = + - @ would run as a formula in Excel
    const rows = [['time', 'action', 'detail', 'ip'].join(','), ...allAudit().map((e) => [q(e.at), q(e.action), q(e.detail), q(e.ip)].join(','))];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rio-audit-${new Date().toISOString().slice(0, 10)}.csv"` }).send(rows.join('\n'));
  });

  /* ----- admin: live logs and errors ----- */
  app.get('/api/admin/logs', adminAuth, (req, res) => {
    const level = ['all', 'warn', 'error'].includes(req.query.level) ? req.query.level : 'all';
    res.json(readLogs({ since: Number(req.query.since) || 0, level, q: String(req.query.q || ''), limit: Number(req.query.limit) || 300 }));
  });

  /* ----- admin: login protection (locked addresses, login history) ----- */
  const cleanIp = (v) => { const ip = String(v || '').replace(/^::ffff:/, '').slice(0, 60); if (!/^[0-9a-fA-F:.]+$/.test(ip)) throw new HttpError(400, 'Invalid address.'); return ip; };
  app.get('/api/admin/security', adminAuth, (req, res) => res.json({ you: String(req.ip || '').replace(/^::ffff:/, ''), ...guardView() }));
  app.post('/api/admin/security/unblock', guard, adminAuth, wrap((req, res) => {
    const ip = cleanIp(req.body?.ip);
    unblock(ip); audit('unblocked an address', ip);
    res.json({ ok: true, ...guardView() });
  }));
  app.post('/api/admin/security/forget', guard, adminAuth, wrap((req, res) => {
    const ip = cleanIp(req.body?.ip);
    forgetKnown(ip); audit('removed a trusted address', ip);
    res.json({ ok: true, ...guardView() });
  }));

  /* ----- admin: broadcast (now or scheduled) ----- */
  const jobView = () => listJobs().map((j) => ({ id: j.id, text: j.text, at: j.at, target: j.target, status: j.status, result: j.result }));
  let ticking = false;
  async function tick() {
    if (ticking || bulk.running || state.shuttingDown) return;
    ticking = true;
    try {
      for (const j of dueJobs()) {
        if (Date.now() - j.at > LATE_GRACE_MS) { updateJob(j.id, { status: 'missed', result: 'The server was off at that time, so it was not sent.' }); continue; }
        if (bulk.running) break; // another bulk job is running: try again on the next tick
        const ids = pickTargets('all').filter((id) => j.target !== 'online' || sessions.get(id)?.status === 'connected');
        if (!ids.length) { updateJob(j.id, { status: 'failed', result: 'No numbers to send to.' }); continue; }
        updateJob(j.id, { status: 'running', result: `Sending to ${ids.length} number(s)…` });
        try {
          const r = await runBulk('notice', ids, j.text);
          updateJob(j.id, { status: 'done', result: `${r.ok} sent, ${r.failed} skipped (offline or gone).` });
        } catch (e) { updateJob(j.id, { status: 'failed', result: String(e?.message || e).slice(0, 120) }); }
      }
    } finally { ticking = false; }
  }
  setInterval(() => tick().catch(() => {}), 20000).unref();
  setTimeout(() => tick().catch(() => {}), 15000).unref();

  app.get('/api/admin/broadcast', adminAuth, (_req, res) => res.json({ jobs: jobView(), max: MAX_TEXT, now: Date.now(), running: bulk.running ? bulk.label : null }));
  app.post('/api/admin/broadcast', guard, adminAuth, wrap(async (req, res) => {
    const text = cleanNotice(req.body?.text);
    const now = Date.now();
    let at = req.body?.at == null ? now : Number(req.body.at);
    if (!Number.isFinite(at) || at < now - 60000 || at > now + 366 * 86400000) throw new HttpError(400, 'Pick a time between now and one year from now.');
    if (at < now + 5000) at = now;
    const target = req.body?.target === 'online' ? 'online' : 'all';
    let job;
    try { job = addJob({ text, at, target }); } catch (e) { throw new HttpError(400, e.message); }
    audit(at === now ? 'broadcast now' : 'scheduled a broadcast', `${target === 'online' ? 'online numbers' : 'all linked numbers'}${at === now ? '' : `, ${new Date(at).toISOString()}`}`);
    if (at === now) tick().catch(() => {});
    res.json({ ok: true, instant: at === now, jobs: jobView() });
  }));
  app.delete('/api/admin/broadcast/:id', guard, adminAuth, wrap((req, res) => {
    if (!cancelJob(String(req.params.id).slice(0, 20))) throw new HttpError(404, 'That message is not waiting any more.');
    audit('cancelled a scheduled broadcast');
    res.json({ ok: true, jobs: jobView() });
  }));

  /* ----- admin: auto news for groups / channels (days, sources, footer) ----- */
  const newsBody = (b = {}) => ({ sources: b.sources, footer: b.footer, custom: b.custom, days: b.days });
  const FOOTER_NAME = { bot: 'bot footer', channel: 'channel name', both: 'bot footer + channel name', custom: 'custom footer' };
  app.get('/api/admin/news', adminAuth, (_req, res) => res.json(adminNewsView()));
  app.post('/api/admin/news', guard, adminAuth, wrap(async (req, res) => {
    let r;
    try { r = await adminNewsAdd({ link: req.body?.link, sid: req.body?.sid, ...newsBody(req.body) }); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not add it.'); }
    const e = r.entry;
    audit(r.renewed ? 'renewed auto news' : 'added auto news', `${e.name || e.jid} · ${e.sources.join(', ')} · ${e.days ? `${e.days} days` : 'no end date'} · footer: ${FOOTER_NAME[e.footer.mode]}`);
    res.json({ ...adminNewsView(), renewed: r.renewed, notified: r.notified, notifyError: r.notifyError });
  }));
  app.patch('/api/admin/news/:id', guard, adminAuth, wrap((req, res) => {
    let e;
    try { e = adminNewsUpdate(String(req.params.id).slice(0, 160), newsBody(req.body)); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not save.'); }
    audit('changed auto news', `${e.name || e.jid} · ${e.sources.join(', ')} · ${e.days ? `${e.days} days from today` : 'no end date'} · footer: ${FOOTER_NAME[e.footer.mode]}`);
    res.json(adminNewsView());
  }));
  app.delete('/api/admin/news/:id', guard, adminAuth, wrap((req, res) => {
    const e = adminNewsRemove(String(req.params.id).slice(0, 160));
    if (!e) throw new HttpError(404, 'That chat is not in the list any more.');
    audit('removed auto news', e.name || e.jid);
    res.json(adminNewsView());
  }));

  /* ----- admin: backup and restore (one encrypted file) ----- */
  const rawFile = express.raw({ type: () => true, limit: '80mb' }); // only runs after adminAuth, so nobody else can send big bodies
  const passFrom = (req) => { try { return decodeURIComponent(String(req.get('x-rio-pass') || '')); } catch { return ''; } };
  let backupBusy = false;
  const exclusive = async (fn) => { if (backupBusy) throw new HttpError(409, 'A backup or restore is already running.'); backupBusy = true; try { return await fn(); } finally { backupBusy = false; } };
  app.post('/api/admin/backup', guard, adminAuth, wrap((req, res) => exclusive(async () => {
    const pass = String(req.body?.passphrase || '');
    if (pass.length < MIN_PASS) throw new HttpError(400, `The passphrase needs at least ${MIN_PASS} characters.`);
    let r; try { r = await createBackup(pass); } catch (e) { throw new HttpError(500, e?.message || 'Could not create the backup.'); }
    audit('exported a backup', `${r.sessions} number(s)`);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="rio-backup-${new Date().toISOString().slice(0, 10)}.riobak"`, 'X-Sessions': String(r.sessions) }).send(r.buffer);
  })));
  app.post('/api/admin/restore/check', guard, adminAuth, rawFile, wrap((req, res) => exclusive(async () => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a backup file first.');
    try { const { backup, ...info } = await inspectBackup(req.body, passFrom(req)); res.json({ ok: true, ...info, maxSessions: MAX_SESSIONS, linkedNow: sessions.size }); }
    catch (e) { throw new HttpError(400, e.message); }
  })));
  app.post('/api/admin/restore', guard, adminAuth, rawFile, wrap((req, res) => exclusive(async () => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a backup file first.');
    let r; try { r = await restoreBackup(req.body, passFrom(req), { restoreGlobal: req.get('x-rio-global') === '1' }); } catch (e) { throw new HttpError(400, e.message); }
    audit('restored a backup', `${r.imported} number(s) added, ${r.skipped.existing} already linked, ${r.skipped.full} over the limit, ${r.skipped.invalid} invalid${r.globalRestored ? ', global settings restored' : ''}`);
    res.json({ ok: true, ...r });
  })));

  /* ----- admin: act on many sessions at once ----- */
  app.post('/api/admin/bulk', guard, adminAuth, wrap((req, res) => {
    const { action } = req.body || {};
    const ids = pickTargets(req.body?.ids, action === 'delete');
    if (!ids.length) throw new HttpError(400, 'No numbers selected.');
    if (action === 'settings') { // instant, nothing is sent to WhatsApp
      if (hasConsentKey(req.body.patch)) throw new HttpError(400, 'Only the number owner can change this option.');
      if (HOST_KEYS.some((k) => k in (req.body.patch || {}))) throw new HttpError(400, 'Call answering options are only for the host owner\'s own number, not for bulk changes.');
      if (hasBrandKeys(req.body.patch)) throw new HttpError(400, 'Name, footer and logo are set per number, not in bulk.');
      if (hasCsongKeys(req.body.patch)) throw new HttpError(400, 'The channel song look is set per number, not in bulk.');
      const writes = parseSettings(req.body.patch);
      for (const id of ids) writeSettings(id, writes);
      audit('bulk settings', `${ids.length} number(s): ${writes.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('') : v}`).join(', ').slice(0, 80)}`);
      return res.json({ ok: true, done: ids.length });
    }
    if (action === 'reset') {
      for (const id of ids) resetSettings(id);
      audit('bulk reset settings', `${ids.length} number(s)`);
      return res.json({ ok: true, done: ids.length });
    }
    if (action === 'premium' || action === 'unpremium') { // the plan changes at once; the WhatsApp notices follow one by one in the background
      if (bulk.running) throw new HttpError(409, `Still working on: ${bulk.label}. Wait for it to finish.`);
      const days = action === 'premium' ? parseDays(req.body?.days) : 0;
      if (action === 'premium' && !days) throw new HttpError(400, 'Days must be a whole number from 1 to 3650.');
      for (const id of ids) { if (action === 'premium') grantPremium(id, days); else revokePremium(id); }
      audit(action === 'premium' ? 'bulk gave premium' : 'bulk removed premium', `${ids.length} number(s)${days ? `, +${days} day(s)` : ''}`);
      runBulk(action, ids, String(days));
      return res.json({ ok: true, queued: ids.length });
    }
    if (!BULK_JOBS[action]) throw new HttpError(400, 'Unknown action.');
    if (bulk.running) throw new HttpError(409, `Still working on: ${bulk.label}. Wait for it to finish.`);
    const text = action === 'notice' ? cleanNotice(req.body?.text) : action === 'about' ? cleanAbout(req.body?.text) : '';
    if (action === 'about') audit('bulk About change', `${ids.length} number(s): ${text.slice(0, 60)}`);
    runBulk(action, ids, text); // runs in the background, one number at a time, so WhatsApp is never hit with a burst
    res.json({ ok: true, queued: ids.length });
  }));
  if (!ADMIN_ENABLED) console.log('Admin site is off (set ADMIN_PASSWORD with 10+ characters to turn it on).');
  if (ADMIN_CODE_PROBLEM) console.warn(ADMIN_CODE_PROBLEM);
  else if (ADMIN_ENABLED && !ADMIN_CODE) console.warn('ADMIN_CODE is not set: anyone who opens /admin sees the admin login. Set ADMIN_CODE (for example 8+ random letters / digits) and open /admin/<code> instead.');
  if (!process.env.WEB_SECRET) console.warn('WEB_SECRET is not set: web logins will end on every restart. Set a long random value.');
}
