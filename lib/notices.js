// Notices: the host writes a news / update / warning in /admin and it shows on the pair site and / or the settings site.
// Stored like the other admin data (disk or MongoDB). Pictures are re-encoded with sharp, so only safe small WEBP files are kept.
import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import { getSetting, setSetting, settings } from './storage.js';
import { audit } from './audit.js';

const NS = '_notices';      // list + stats (small)
const IMG_NS = '_noticeimg'; // pictures (kept apart so every stats save does not rewrite them)
export const KINDS = ['news', 'update', 'warning', 'success', 'promo'];
const KIND_ICON = { news: '📰', update: '✨', warning: '⚠️', success: '✅', promo: '🎁' };
const SITES = ['pair', 'settings'];
const LAYOUTS = ['card', 'popup', 'banner'];
const TITLE_SIZES = ['m', 'l', 'xl', 'xxl'];
const TEXT_SIZES = ['s', 'm', 'l'];
const ALIGNS = ['left', 'center'];
const IMG_MODES = ['top', 'side', 'cover'];
const BTN_STYLES = ['solid', 'glass'];
export const LIMITS = { notices: 40, images: 24, title: 120, body: 800, label: 30, buttons: 3, imgBytes: 350 * 1024, whoPerNotice: 300, visitors: 4000 };

const now = () => Date.now();
const list = () => (Array.isArray(getSetting(NS, 'list', null)) ? getSetting(NS, 'list', []) : []);
const saveList = (l) => setSetting(NS, 'list', l);
function statsObj() { let s = getSetting(NS, 'stats', null); if (!s || typeof s !== 'object') { s = {}; setSetting(NS, 'stats', s); } return s; }
let dirty = false;
// Stats are changed in place (many views per second must not mean many disk writes) and saved every 30 s. flushSettings() on shutdown saves the rest.
setInterval(() => { if (dirty) { dirty = false; setSetting(NS, 'stats', statsObj()); } }, 30000).unref?.();

/* ---------- validation ---------- */
function cleanUrl(u) {
  const s = String(u || '').trim().slice(0, 500);
  if (/^\/(?!\/)[\w\-./?=&%#:+~]*$/.test(s)) return s; // a page on this site
  try { const x = new URL(s); if (x.protocol === 'https:' || x.protocol === 'http:') return x.href; } catch {}
  return null;
}
const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
const ts = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 4102444800000 ? Math.round(n) : 0; };
const text = (v, max) => String(v ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

export function cleanNotice(input, err) {
  if (!input || typeof input !== 'object') throw err(400, 'Nothing to save.');
  const title = text(input.title, LIMITS.title), body = text(input.body, LIMITS.body);
  if (!title && !body) throw err(400, 'Write a title or a message first.');
  const kind = pick(input.kind, KINDS, 'news');
  const audience = [...new Set((Array.isArray(input.audience) ? input.audience : []).filter((s) => SITES.includes(s)))];
  if (!audience.length) throw err(400, 'Choose where it shows: the pair site, the settings site, or both.');
  const buttons = [];
  for (const b of (Array.isArray(input.buttons) ? input.buttons : []).slice(0, LIMITS.buttons)) {
    const label = text(b?.label, LIMITS.label);
    if (!label && !b?.url) continue;
    const url = cleanUrl(b?.url);
    if (!label || !url) throw err(400, 'Each button needs a name and a link that starts with https:// (or / for a page on this site).');
    buttons.push({ label, url, style: pick(b?.style, BTN_STYLES, 'solid') });
  }
  const startAt = ts(input.startAt), endAt = ts(input.endAt);
  if (startAt && endAt && endAt <= startAt) throw err(400, 'The end time must be after the start time.');
  const image = typeof input.image === 'string' && /^[a-f0-9]{16}$/.test(input.image) && getSetting(IMG_NS, input.image, null) ? input.image : null;
  const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent || '')) ? String(input.accent).toLowerCase() : '';
  return {
    title, body, kind, icon: text(input.icon, 8) || KIND_ICON[kind], audience,
    layout: pick(input.layout, LAYOUTS, 'card'), titleSize: pick(input.titleSize, TITLE_SIZES, 'l'), textSize: pick(input.textSize, TEXT_SIZES, 'm'),
    align: pick(input.align, ALIGNS, 'left'), image, imageMode: pick(input.imageMode, IMG_MODES, 'top'), buttons, accent,
    pinned: input.pinned === true, enabled: input.enabled !== false, dismissible: input.dismissible !== false,
    startAt, endAt, countdownTo: ts(input.countdownTo),
  };
}

const statusOf = (n, t = now()) => (!n.enabled ? 'off' : n.startAt && t < n.startAt ? 'scheduled' : n.endAt && t >= n.endAt ? 'expired' : 'live');
const publicView = (n) => ({
  id: n.id, rev: n.rev, title: n.title, body: n.body, kind: n.kind, icon: n.icon, layout: n.layout, titleSize: n.titleSize, textSize: n.textSize, align: n.align,
  image: n.image ? `/notice-img/${n.image}` : null, imageMode: n.imageMode, buttons: n.buttons, accent: n.accent, pinned: n.pinned, dismissible: n.dismissible, countdownTo: n.countdownTo,
});
const order = (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt;

/* ---------- pictures ---------- */
const allImgs = () => settings[IMG_NS] || {};
function pruneImages(graceMs = 30 * 60 * 1000) { // pictures no notice uses (and older than the grace time, so a fresh upload survives until it is saved)
  const used = new Set(list().map((n) => n.image).filter(Boolean));
  for (const [id, v] of Object.entries(allImgs())) if (!used.has(id) && now() - (v?.at || 0) > graceMs) setSetting(IMG_NS, id, null);
}
const imageCount = () => Object.values(allImgs()).filter(Boolean).length;

async function encodeImage(buf) {
  const base = sharp(buf, { limitInputPixels: 40e6, failOn: 'error' }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true });
  let out;
  for (const q of [82, 68, 54, 42]) { out = await base.clone().webp({ quality: q }).toBuffer(); if (out.length <= LIMITS.imgBytes) return out; }
  throw new Error('That picture is too detailed to shrink enough. Use a simpler or smaller picture.');
}

/* ---------- stats ---------- */
const vkey = (key, id) => crypto.createHash('sha256').update(`${key}:${id}`).digest('hex').slice(0, 14);
function record(n, site, type, btn, key, who) {
  const all = statsObj();
  const s = (all[n.id] ||= { seen: 0, read: 0, closed: 0, clicks: [0, 0, 0], sv: [], rv: [], last: 0, who: {} });
  const h = vkey(key, n.id);
  const mark = (arr, field) => { if (arr.includes(h)) return false; arr.push(h); if (arr.length > LIMITS.visitors) arr.shift(); s[field]++; return true; };
  const t = now();
  mark(s.sv, 'seen'); s.last = t;
  if (type !== 'seen') mark(s.rv, 'read');
  if (type === 'click' && btn >= 0 && btn < 3) s.clicks[btn]++;
  if (type === 'close') s.closed++;
  if (site === 'settings' && who) {
    const w = (s.who[h] ||= { p: who, s: t, r: 0 });
    if (type !== 'seen' && !w.r) w.r = t;
    const keys = Object.keys(s.who);
    if (keys.length > LIMITS.whoPerNotice) delete s.who[keys.sort((a, b) => s.who[a].s - s.who[b].s)[0]];
  }
  dirty = true;
}

function adminView(n, linked) {
  const s = statsObj()[n.id] || { seen: 0, read: 0, closed: 0, clicks: [0, 0, 0], last: 0, who: {} };
  return {
    ...n, status: statusOf(n), imageUrl: n.image ? `/notice-img/${n.image}` : null,
    stats: { seen: s.seen, read: s.read, closed: s.closed, clicks: s.clicks, last: s.last, linked, who: Object.values(s.who || {}).sort((a, b) => b.s - a.s).slice(0, 100) },
  };
}

/* ---------- routes ---------- */
// deps: { adminAuth, guard, wrap, HttpError, userSid(req) -> session id or null, phoneOf(sid) -> masked number, linkedCount() }
export function mountNotices(app, deps) {
  const { adminAuth, guard, wrap, HttpError, userSid, phoneOf, linkedCount } = deps;
  const err = (status, msg) => new HttpError(status, msg);
  const adminList = () => ({ notices: [...list()].sort(order).map((n) => adminView(n, linkedCount())), images: imageCount(), limits: LIMITS });

  // small per-IP limit for the public endpoints
  const hits = new Map();
  setInterval(() => { const t = now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, 60000).unref?.();
  const limited = (req, res, next) => {
    const t = now(), e = hits.get(req.ip);
    if (!e || e.reset <= t) { hits.set(req.ip, { n: 1, reset: t + 60000 }); return next(); }
    if (++e.n > 180) return res.status(429).json({ error: 'Too many requests.' });
    next();
  };

  // what visitors see
  app.get('/api/notices', limited, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const site = req.query.site === 'settings' ? 'settings' : 'pair';
    if (site === 'settings' && !userSid(req)) return res.json({ notices: [] }); // the settings notices are for logged-in users only
    res.json({ notices: list().filter((n) => statusOf(n) === 'live' && n.audience.includes(site)).sort(order).map(publicView) });
  });
  app.get('/notice-img/:id', (req, res) => {
    const v = /^[a-f0-9]{16}$/.test(req.params.id) ? getSetting(IMG_NS, req.params.id, null) : null;
    if (!v) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(v.b, 'base64'));
  });
  // seen / read / click / close. The pair site sends a random visitor id; the settings site is identified by the login cookie.
  app.post('/api/notices/event', limited, wrap((req, res) => {
    if (req.get('x-rio') !== '1') throw err(403, 'Bad request.');
    const { id, type, btn } = req.body || {};
    const site = req.body?.site === 'settings' ? 'settings' : 'pair';
    const n = list().find((x) => x.id === id);
    if (!n || statusOf(n) !== 'live' || !n.audience.includes(site) || !['seen', 'read', 'click', 'close'].includes(type)) return res.json({ ok: true });
    let key, who = '';
    if (site === 'settings') { const sid = userSid(req); if (!sid) return res.json({ ok: true }); key = sid; who = phoneOf(sid); }
    else { key = String(req.body?.vid || ''); if (!/^[a-z0-9]{10,40}$/.test(key)) return res.json({ ok: true }); }
    record(n, site, type, Number.isInteger(btn) ? btn : -1, key, who);
    res.json({ ok: true });
  }));

  // admin
  app.get('/api/admin/notices', adminAuth, (_req, res) => res.json(adminList()));
  app.post('/api/admin/notices', guard, adminAuth, wrap((req, res) => {
    const clean = cleanNotice(req.body, err);
    const l = list(), t = now();
    const i = typeof req.body?.id === 'string' ? l.findIndex((n) => n.id === req.body.id) : -1;
    if (i < 0 && l.length >= LIMITS.notices) throw err(400, `You can keep up to ${LIMITS.notices} notices. Delete an old one first.`);
    let saved;
    if (i >= 0) {
      const old = l[i];
      const changed = JSON.stringify([old.title, old.body, old.image, old.buttons]) !== JSON.stringify([clean.title, clean.body, clean.image, clean.buttons]);
      saved = { ...clean, id: old.id, createdAt: old.createdAt, updatedAt: t, rev: changed ? (old.rev || 1) + 1 : (old.rev || 1) }; // a new rev shows a closed notice again
      l[i] = saved;
    } else { saved = { ...clean, id: crypto.randomBytes(6).toString('hex'), createdAt: t, updatedAt: t, rev: 1 }; l.push(saved); }
    saveList(l); pruneImages();
    audit(i >= 0 ? 'edited a notice' : 'added a notice', `${saved.title || saved.body}`.slice(0, 80));
    res.json({ ok: true, id: saved.id, ...adminList() });
  }));
  app.post('/api/admin/notices/:id/enabled', guard, adminAuth, wrap((req, res) => {
    const l = list(), n = l.find((x) => x.id === req.params.id);
    if (!n) throw err(404, 'Notice not found.');
    n.enabled = req.body?.on !== false; n.updatedAt = now(); saveList(l);
    audit(n.enabled ? 'switched a notice on' : 'switched a notice off', (n.title || n.body).slice(0, 60));
    res.json({ ok: true, ...adminList() });
  }));
  app.post('/api/admin/notices/:id/reset-stats', guard, adminAuth, wrap((req, res) => {
    if (!list().some((x) => x.id === req.params.id)) throw err(404, 'Notice not found.');
    delete statsObj()[req.params.id]; dirty = true;
    audit('reset notice stats', req.params.id);
    res.json({ ok: true, ...adminList() });
  }));
  app.delete('/api/admin/notices/:id', guard, adminAuth, wrap((req, res) => {
    const l = list(), n = l.find((x) => x.id === req.params.id);
    if (!n) throw err(404, 'Notice not found.');
    saveList(l.filter((x) => x !== n)); delete statsObj()[n.id]; dirty = true; pruneImages(0);
    audit('deleted a notice', (n.title || n.body).slice(0, 60));
    res.json({ ok: true, ...adminList() });
  }));
  // The browser sends the picture as the raw request body (Content-Type image/*). The global JSON parser ignores that type.
  app.post('/api/admin/notice-image', guard, adminAuth, express.raw({ type: 'image/*', limit: '8mb' }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw err(400, 'Choose a picture first.');
    pruneImages();
    if (imageCount() >= LIMITS.images) throw err(400, `Up to ${LIMITS.images} pictures are kept. Delete a notice you no longer need first.`);
    let out; try { out = await encodeImage(req.body); } catch (e) { throw err(400, /too detailed/.test(e.message) ? e.message : 'That file is not a picture this site can read. Use a JPG, PNG, WEBP or GIF.'); }
    const id = crypto.randomBytes(8).toString('hex');
    setSetting(IMG_NS, id, { t: 'image/webp', b: out.toString('base64'), at: now() });
    res.json({ ok: true, id, url: `/notice-img/${id}`, kb: Math.round(out.length / 1024) });
  }));
}
