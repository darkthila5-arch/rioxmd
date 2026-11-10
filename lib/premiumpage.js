// Public premium page:  /premium  (plans, price, features, "Contact owner" button, and a "check my premium days" box).
//   GET  /api/premium/info    plans / features / contact / note (admin-saved, else environment, else built-in)
//   POST /api/premium/status  { number }  ->  { active, daysLeft, until }
// What the page shows comes from the admin site (Admin > Premium page, saved, no redeploy) and, for anything the admin has not set,
// from these environment variables / the built-in list (all optional):
//   PREMIUM_PLANS     "30|1 Month|Rs. 500;90|3 Months|Rs. 1,200|Save 20%;365|1 Year|Rs. 4,000"   (days|name|price|small note, up to 6, split with ; )
//   PREMIUM_CONTACT   WhatsApp number people message to buy (digits, country code). Default: OWNER_NUMBER
//   PREMIUM_FEATURES  "Your own bot name;Bulk add;..."  (split with ; ). Default: the built-in list below
//   PREMIUM_NOTE      One line shown under the plans (for example how to pay)
// Privacy: the status check answers the same way for "not linked" and "free", so it cannot be used to find out who uses the bot.
// It is rate limited per IP and needs the same x-rio header as the other POST routes.
import path from 'node:path';
import { BOT_NAME, OWNER_NUMBER, ROOT_DIR, sessions } from './config.js';
import { getPremium } from './premium.js';
import { getSetting, setSetting } from './storage.js';

const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '94').replace(/\D/g, '');
const DEFAULT_FEATURES = [
  'Your own bot name, footer text and logo on every reply',
  'Bulk add many numbers to a group (.gadd)',
  'Download anyone’s profile picture (.getdp)',
  'Channel support: your channel gets reactions from other numbers',
  'Animated equalizer thumbnails for channel songs',
];

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);

// "30|1 Month|Rs. 500|note;90|..." -> [{ days, name, price, note }]  (bad rows are skipped)
export function parsePlans(raw) {
  const out = [];
  for (const row of String(raw || '').split(/[;\n]+/)) {
    const [d, name, price, note] = row.split('|').map((x) => x.trim());
    const days = /^\d{1,4}$/.test(d || '') ? Number(d) : 0;
    if (!days || days > 3650 || !name) continue;
    out.push({ days, name: clean(name, 40), price: clean(price, 30), note: clean(note, 80) });
    if (out.length >= 6) break;
  }
  return out;
}

export function parseList(raw, fallback = []) {
  const list = String(raw || '').split(/[;\n]+/).map((x) => clean(x, 120)).filter(Boolean).slice(0, 12);
  return list.length ? list : fallback;
}

// "94771234567", "+94 77 123 4567" or "0771234567" -> "94771234567"; anything else -> null
export function normalizeNumber(input, cc = DEFAULT_CC) {
  let n = String(input || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(n) && cc) n = cc + n.slice(1);
  return n.length >= 8 && n.length <= 15 ? n : null;
}

export function premiumFor(number) {
  for (const [sid, rec] of sessions) {
    if (String(rec?.phone || '').replace(/\D/g, '') !== number) continue;
    const p = getPremium(sid);
    if (p.active) return p;
  }
  return null;
}

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), e = hits.get(req.ip);
    if (!e || e.reset <= now) { hits.set(req.ip, { count: 1, reset: now + windowMs }); return next(); }
    if (++e.count > max) { res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000))); return res.status(429).json({ error: 'Too many checks. Please wait a few minutes and try again.' }); }
    next();
  };
}

/* ---------- what the page shows: admin-saved values first, then the environment, then the built-in list ---------- */
const GLOBAL = '_global', KEY = 'premiumPage';
export const LIMITS = { plans: 6, features: 12, name: 40, price: 30, note: 80, feature: 120, pageNote: 200 };

function envConfig() {
  return {
    plans: parsePlans(process.env.PREMIUM_PLANS),
    features: parseList(process.env.PREMIUM_FEATURES, DEFAULT_FEATURES),
    contact: String(process.env.PREMIUM_CONTACT || OWNER_NUMBER || '').replace(/\D/g, ''),
    note: clean(process.env.PREMIUM_NOTE, LIMITS.pageNote),
  };
}

export function getPremiumConfig() {
  const env = envConfig();
  const raw = getSetting(GLOBAL, KEY, null);
  const s = raw && typeof raw === 'object' ? raw : {};
  const plans = Array.isArray(s.plans) ? s.plans.map((p) => ({ days: Number(p.days) || 0, name: clean(p.name, LIMITS.name), price: clean(p.price, LIMITS.price), note: clean(p.note, LIMITS.note) })).filter((p) => p.days && p.name).slice(0, LIMITS.plans) : env.plans;
  const features = Array.isArray(s.features) && s.features.length ? s.features.map((f) => clean(f, LIMITS.feature)).filter(Boolean).slice(0, LIMITS.features) : env.features;
  const contact = String(s.contact || '').replace(/\D/g, '') || env.contact;
  const note = typeof s.note === 'string' ? clean(s.note, LIMITS.pageNote) : env.note;
  return { plans, features, contact, note, saved: !!raw };
}

// Checks what the admin typed. Throws Error(message) for the first problem (the admin site shows it).
export function cleanPremiumInput(b = {}) {
  if (!Array.isArray(b.plans)) throw new Error('Plans must be a list.');
  if (b.plans.length > LIMITS.plans) throw new Error(`At most ${LIMITS.plans} plans.`);
  const plans = b.plans.map((p, i) => {
    const days = typeof p?.days === 'string' && /^\s*\d{1,4}\s*$/.test(p.days) ? Number(p.days) : p?.days;
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error(`Plan ${i + 1}: days must be a whole number from 1 to 3650.`);
    const name = clean(p?.name, LIMITS.name);
    if (!name) throw new Error(`Plan ${i + 1}: give it a name (for example "1 Month").`);
    return { days, name, price: clean(p?.price, LIMITS.price), note: clean(p?.note, LIMITS.note) };
  });
  const rawFeatures = Array.isArray(b.features) ? b.features : String(b.features || '').split(/\n+/);
  const features = rawFeatures.map((f) => clean(f, LIMITS.feature)).filter(Boolean);
  if (features.length > LIMITS.features) throw new Error(`At most ${LIMITS.features} lines in "What you get".`);
  const contact = String(b.contact || '').replace(/[^\d]/g, '');
  if (String(b.contact || '').trim() && (contact.length < 8 || contact.length > 15)) throw new Error('Contact number: digits with country code, for example 94771234567.');
  const note = clean(b.note, LIMITS.pageNote);
  return { plans, ...(features.length ? { features } : {}), ...(contact ? { contact } : {}), note };
}

export function savePremiumConfig(b) { setSetting(GLOBAL, KEY, cleanPremiumInput(b)); return premiumConfigView(); }
export function resetPremiumConfig() { setSetting(GLOBAL, KEY, null); return premiumConfigView(); }

// For the admin site: what the page shows now, plus the defaults it falls back to.
export function premiumConfigView() {
  const env = envConfig();
  return { ok: true, ...getPremiumConfig(), defaults: { plans: env.plans, features: env.features, contact: env.contact, note: env.note }, limits: LIMITS };
}

export function mountPremiumPage(app) {
  const checkLimit = limiter(12, 10 * 60 * 1000);

  app.get('/premium', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'public', 'premium.html')));

  app.get('/api/premium/info', (_req, res) => {
    res.set('Cache-Control', 'no-store'); // an admin change shows at once
    const c = getPremiumConfig();
    res.json({ ok: true, bot: BOT_NAME, plans: c.plans, features: c.features, contact: c.contact, note: c.note });
  });

  app.post('/api/premium/status', checkLimit, (req, res) => {
    if (req.get('x-rio') !== '1') return res.status(403).json({ error: 'Bad request.' });
    res.set('Cache-Control', 'no-store');
    const number = normalizeNumber(req.body?.number);
    if (!number) return res.status(400).json({ error: 'Enter your number with country code, digits only (for example 94771234567).' });
    const p = premiumFor(number);
    if (!p) return res.json({ ok: true, active: false });
    res.json({ ok: true, active: true, daysLeft: p.daysLeft, until: new Date(p.until).toISOString() });
  });
}
