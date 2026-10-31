// Web settings page (/settings) and admin site (/admin): login, per-session settings API, admin tools.
import crypto from 'node:crypto';
import path from 'node:path';
import { BOT_NAME, MAX_SESSIONS, DEFAULT_MODE, ROOT_DIR, jidNum, safeId, sessions, sha, sleep, state } from './config.js';
import { destroySession } from './session.js';
import { getMode, getSetting, setSetting } from './storage.js';
import { syncCallbot } from './callbot.js';
import { checkWebPassword, hasWebPassword, sendWebPassword, webPasswordVersion } from './webpass.js';
import { say } from './card.js';
import { addChannel, adminBoost, adminRemove, boostSummary, removeChannel, setPaused } from './boost.js';
import { BRAND_KEYS, BRAND_LIMITS, checkLogo, cleanBrandText } from './brand.js';
import { PROTECTED, isHostSession, analytics, bannedList, commandUsage, disabledCmds, getMaintenance, setBanned, setCmdsDisabled, setMaintenance } from './control.js';
import { registry } from '../commands/index.js';
import { getPremium, grantPremium, isPremium, notifyPremium, parseDays, premiumGrantedText, premiumRemovedText, premiumView, revokePremium } from './premium.js';

const SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex'); // set WEB_SECRET so logins survive a restart
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_ENABLED = ADMIN_PASSWORD.length >= 10;
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
const TEXT_KEYS = ['statusEmojis', 'callMsg', ...BRAND_KEYS];
export function readSettings(sid) {
  const s = { mode: getMode(sid) };
  for (const k of BOOLS) s[k] = !!getSetting(sid, k, false);
  s.statusEmojis = (getSetting(sid, 'statusEmojis', null) || []).join(' ');
  s.callMsg = getSetting(sid, 'callMsg', null) || '';
  for (const k of BRAND_KEYS) s[k] = getSetting(sid, k, null) || '';
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
// Call answering options are for the host owner's own number only (see isHostSession). Call reject stays open to everybody.
const HOST_KEYS = ['autoAnswer', 'callStream', 'callLoop', 'callMsg'];
function assertHostKeys(rec, patch) {
  if (isHostSession(rec?.phone) || !patch || typeof patch !== 'object') return;
  const bad = HOST_KEYS.some((k) => k in patch && (k === 'callMsg' ? String(patch[k] ?? '').trim() !== '' : patch[k] === true));
  if (bad) throw new HttpError(403, 'Auto answer, real call answering and the caller message are only for the bot host owner\'s number. Call reject is available.');
}
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

const auditLog = [];
function audit(action, detail = '') {
  auditLog.unshift({ at: new Date().toISOString(), action, detail });
  auditLog.length = Math.min(auditLog.length, 100);
  console.log(`[admin] ${action} ${detail}`);
}


/* ---------- bulk actions: slow on purpose, one number at a time ---------- */
const bulk = { running: false, label: '', done: 0, total: 0 };
const cleanNotice = (t) => {
  const text = String(t || '').trim().slice(0, 1000);
  if (!text) throw new HttpError(400, 'Write the message first.');
  return text;
};
const sendNotice = (sock, text) => say(sock, `${jidNum(sock.user?.id)}@s.whatsapp.net`, `📢 *${BOT_NAME} notice*\n\n${text}`);
const BULK_JOBS = {
  restart: { label: 'Restarting', gap: 800, run: async (id, r) => { if (!r.sock) throw new Error('offline'); r.sock.end(undefined); } },
  password: { label: 'Sending web passwords', gap: 1500, run: async (id, r) => { if (!r.sock) throw new Error('offline'); await sendWebPassword(r.sock, id); } },
  notice: { label: 'Sending the notice', gap: 1500, run: async (id, r, text) => { if (!r.sock) throw new Error('offline'); await sendNotice(r.sock, text); } },
  premium: { label: 'Telling numbers about premium', gap: 1500, run: async (id, r, days) => { if (!r.sock) throw new Error('offline'); await notifyPremium(r.sock, premiumGrantedText(getPremium(id), Number(days))); } },
  unpremium: { label: 'Telling numbers about premium', gap: 1500, run: async (id, r) => { if (!r.sock) throw new Error('offline'); await notifyPremium(r.sock, premiumRemovedText()); } },
  delete: { label: 'Unlinking', gap: 300, run: async (id) => { await unlink(id); } },
};
async function runBulk(action, ids, text) {
  const job = BULK_JOBS[action];
  Object.assign(bulk, { running: true, label: job.label, done: 0, total: ids.length });
  let ok = 0, failed = 0;
  for (const id of ids) {
    const r = sessions.get(id);
    try { if (!r) throw new Error('gone'); await job.run(id, r, text); ok++; } catch { failed++; }
    bulk.done++;
    await sleep(job.gap);
  }
  bulk.running = false;
  audit(`bulk ${action}`, `${ok} done, ${failed} skipped (offline or gone)`);
}
// "all" means every linked number. A list is checked: only real session ids, no duplicates, at most 200.
function pickTargets(input, allowUnlinked) {
  if (input === 'all') return [...sessions].filter(([, r]) => isLinked(r)).map(([id]) => id);
  if (!Array.isArray(input)) return [];
  return [...new Set(input)].filter((id) => safeId(id) && sessions.has(id) && (allowUnlinked || isLinked(sessions.get(id)))).slice(0, 200);
}

export function mountWeb(app) {
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
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
  app.get('/settings', (_q, res) => res.sendFile(path.join(ROOT_DIR, 'views', 'settings.html')));
  app.get('/admin', (_q, res) => res.sendFile(path.join(ROOT_DIR, 'views', 'admin.html')));

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

  app.get('/api/me', userAuth, (req, res) => res.json({ phone: req.rec.phone, host: isHostSession(req.rec.phone), status: req.rec.status, callService: !!state.callbotAvailable, premium: premiumView(req.sid), settings: readSettings(req.sid) }));
  app.patch('/api/me/settings', guard, userAuth, wrap(async (req, res) => {
    assertHostKeys(req.rec, req.body);
    if (hasBrandKeys(req.body) && !isPremium(req.sid)) throw new HttpError(403, 'Custom name, footer and logo are 👑 premium features. Contact the bot owner to get premium.');
    parseSettings(req.body); // validate everything before the (slow) logo check
    await checkBrandPatch(req.body);
    applySettings(req.sid, req.body);
    res.json({ ok: true, settings: readSettings(req.sid) });
  }));
  /* ----- channel support (premium): add / remove a channel; the pool is the numbers that opted in ----- */
  app.get('/api/me/boost', userAuth, (req, res) => res.json(boostSummary(req.sid)));
  app.post('/api/me/boost', guard, userAuth, wrap(async (req, res) => {
    if (!isPremium(req.sid)) throw new HttpError(403, 'Channel support is a 👑 premium feature. Contact the bot owner to get premium.');
    try { res.json({ ok: true, ...(await addChannel(req.sid, String(req.body?.link || '').slice(0, 300), String(req.body?.emojis || '').slice(0, 60))) }); }
    catch (err) { throw new HttpError(400, err?.message || 'Could not add the channel.'); }
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
    if (p?.t !== 'a') return res.status(401).json({ error: 'Please log in again.' });
    next();
  };
  const target = (req) => {
    if (!safeId(req.params.id) || !sessions.get(req.params.id)) throw new HttpError(404, 'Session not found.');
    return sessions.get(req.params.id);
  };

  app.post('/api/admin/login', guard, wrap((req, res) => {
    if (!ADMIN_ENABLED) throw new HttpError(503, 'The admin site is off. Set ADMIN_PASSWORD (10+ characters) on the server.');
    const key = `admin:${req.ip}`;
    const wait = blockedFor(key);
    if (wait) { res.set('Retry-After', String(wait)); throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`); }
    const okUser = crypto.timingSafeEqual(sha(String(req.body?.user || '')), sha(ADMIN_USER));
    const okPass = crypto.timingSafeEqual(sha(String(req.body?.password || '')), sha(ADMIN_PASSWORD));
    if (!(okUser && okPass)) { addFail(key); audit('failed login', req.ip); throw new HttpError(401, 'The username or password is not right.'); }
    fails.delete(key);
    putCookie(req, res, 'rio_a', sign({ t: 'a', exp: Date.now() + ADMIN_TTL_S * 1000 }), ADMIN_TTL_S);
    audit('login', req.ip);
    res.json({ ok: true });
  }));
  app.post('/api/admin/logout', guard, (req, res) => { putCookie(req, res, 'rio_a', '', 0); res.json({ ok: true }); });

  app.get('/api/admin/overview', adminAuth, (_req, res) => {
    const list = [...sessions].map(([id, r]) => ({
      id, phone: mask(r.phone), linked: isLinked(r), status: r.status, mode: getMode(id), webPassword: hasWebPassword(id),
      features: BOOLS.filter((k) => getSetting(id, k, false)).length, premium: getPremium(id).active, premiumDays: getPremium(id).daysLeft,
    }));
    res.json({
      bot: BOT_NAME, uptimeSeconds: Math.round(process.uptime()), maxSessions: MAX_SESSIONS, storage: state.mongoCol ? 'MongoDB' : 'Files',
      callService: !!state.callbotAvailable, connected: list.filter((s) => s.status === 'connected').length, premiumCount: list.filter((s) => s.premium).length,
      boost: adminBoost(mask), pairingOpen: isPairingOpen(), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version,
      defaultMode: DEFAULT_MODE, bulk: bulk.running ? { label: bulk.label, done: bulk.done, total: bulk.total } : null,
      sessions: list.sort((a, b) => Number(b.linked) - Number(a.linked)), audit: auditLog.slice(0, 40),
    });
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
  const cmdView = () => {
    const off = disabledCmds(), use = commandUsage();
    return { maintenance: getMaintenance(), banned: bannedList().map((n, i) => ({ i, m: mask(n) })), protected: [...PROTECTED], commands: [...new Set(registry.values())].map((c) => ({ name: c.name, aliases: c.aliases || [], owner: !!c.owner, premium: !!c.premium, disabled: off.has(c.name) && !PROTECTED.has(c.name), uses: use[c.name]?.n || 0, errors: use[c.name]?.e || 0 })).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  app.get('/api/admin/commands', adminAuth, (_req, res) => res.json(cmdView()));
  app.post('/api/admin/commands/toggle', guard, adminAuth, wrap((req, res) => {
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => String(n).toLowerCase().slice(0, 40)).filter((n) => registry.has(n)).slice(0, 300);
    if (!names.length) throw new HttpError(400, 'Pick at least one command.');
    setCmdsDisabled(names.map((n) => registry.get(n).name), !!req.body?.disabled);
    audit(req.body?.disabled ? 'switched commands off' : 'switched commands on', names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6}` : ''));
    res.json({ ok: true, ...cmdView() });
  }));
  app.post('/api/admin/maintenance', guard, adminAuth, wrap((req, res) => {
    setMaintenance(!!req.body?.on, req.body?.text);
    audit(req.body?.on ? 'maintenance ON' : 'maintenance off'); res.json({ ok: true, ...cmdView() });
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
    res.json({ phone: mask(r.phone), host: isHostSession(r.phone), status: r.status, linked: isLinked(r), error: r.error || null, retries: r.retries || 0, webPassword: hasWebPassword(req.params.id), premium: premiumView(req.params.id), settings: readSettings(req.params.id) });
  }));
  app.patch('/api/admin/session/:id/settings', guard, adminAuth, wrap(async (req, res) => {
    if (hasConsentKey(req.body)) throw new HttpError(400, 'Only the number owner can change this option.');
    assertHostKeys(target(req), req.body); parseSettings(req.body); await checkBrandPatch(req.body); applySettings(req.params.id, req.body);
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
  app.delete('/api/admin/boost/:id', guard, adminAuth, wrap((req, res) => {
    try { adminRemove(String(req.params.id).slice(0, 20)); } catch (err) { throw new HttpError(404, err?.message || 'Channel not found.'); }
    audit('removed a support channel');
    res.json({ ok: true, boost: adminBoost(mask) });
  }));

  /* ----- admin: act on many sessions at once ----- */
  app.post('/api/admin/bulk', guard, adminAuth, wrap((req, res) => {
    const { action } = req.body || {};
    const ids = pickTargets(req.body?.ids, action === 'delete');
    if (!ids.length) throw new HttpError(400, 'No numbers selected.');
    if (action === 'settings') { // instant, nothing is sent to WhatsApp
      if (hasConsentKey(req.body.patch)) throw new HttpError(400, 'Only the number owner can change this option.');
      if (HOST_KEYS.some((k) => k in (req.body.patch || {}))) throw new HttpError(400, 'Call answering options are only for the host owner\'s own number, not for bulk changes.');
      if (hasBrandKeys(req.body.patch)) throw new HttpError(400, 'Name, footer and logo are set per number, not in bulk.');
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
    const text = action === 'notice' ? cleanNotice(req.body?.text) : '';
    runBulk(action, ids, text); // runs in the background, one number at a time, so WhatsApp is never hit with a burst
    res.json({ ok: true, queued: ids.length });
  }));
  if (!ADMIN_ENABLED) console.log('Admin site is off (set ADMIN_PASSWORD with 10+ characters to turn it on).');
  if (!process.env.WEB_SECRET) console.warn('WEB_SECRET is not set: web logins will end on every restart. Set a long random value.');
}
