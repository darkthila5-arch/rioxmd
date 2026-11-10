// Public premium page:  /premium  (plans, price, features, "Contact owner" button, and a "check my premium days" box).
//   GET  /api/premium/info    plans / features / contact, all from environment variables (below)
//   POST /api/premium/status  { number }  ->  { active, daysLeft, until }
// Settings (all optional):
//   PREMIUM_PLANS     "30|1 Month|Rs. 500;90|3 Months|Rs. 1,200|Save 20%;365|1 Year|Rs. 4,000"   (days|name|price|small note, up to 6, split with ; )
//   PREMIUM_CONTACT   WhatsApp number people message to buy (digits, country code). Default: OWNER_NUMBER
//   PREMIUM_FEATURES  "Your own bot name;Bulk add;..."  (split with ; ). Default: the built-in list below
//   PREMIUM_NOTE      One line shown under the plans (for example how to pay)
// Privacy: the status check answers the same way for "not linked" and "free", so it cannot be used to find out who uses the bot.
// It is rate limited per IP and needs the same x-rio header as the other POST routes.
import path from 'node:path';
import { BOT_NAME, OWNER_NUMBER, ROOT_DIR, sessions } from './config.js';
import { getPremium } from './premium.js';

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

export function mountPremiumPage(app) {
  const plans = parsePlans(process.env.PREMIUM_PLANS);
  const features = parseList(process.env.PREMIUM_FEATURES, DEFAULT_FEATURES);
  const contact = String(process.env.PREMIUM_CONTACT || OWNER_NUMBER || '').replace(/\D/g, '');
  const note = clean(process.env.PREMIUM_NOTE, 200);
  const checkLimit = limiter(12, 10 * 60 * 1000);

  app.get('/premium', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'public', 'premium.html')));

  app.get('/api/premium/info', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, bot: BOT_NAME, plans, features, contact, note });
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
