// Premium plan, per linked number. The admin gives a number N days (admin site), commands can require it with `premium: true`.
// Stored with the other per-session settings as  premium: { until: <epoch ms>, grantedAt, notified }.
// Nothing runs when it ends: isPremium() just compares the date, so it is always right (even after a restart).
// A small hourly check tells the user once, in their own chat, when their premium has ended.
import { BOT_NAME, PREFIX, OWNER_NUMBER, TIMEZONE, jidNum, sessions } from './config.js';
import { FOOTER_LINE } from './brand.js';
import { getSetting, setSetting } from './storage.js';
import { say } from './card.js';

const DAY = 24 * 60 * 60 * 1000;
export const MAX_PREMIUM_DAYS = 3650;

// "30" -> 30. Anything that is not a whole number from 1 to 3650 -> null.
export function parseDays(v) {
  const n = typeof v === 'string' && /^\s*\d{1,5}\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= MAX_PREMIUM_DAYS ? n : null;
}

export function getPremium(sid, now = Date.now()) {
  const until = Number(getSetting(sid, 'premium', null)?.until || 0);
  const active = until > now;
  return { active, expired: !active && until > 0, until: active ? until : 0, daysLeft: active ? Math.ceil((until - now) / DAY) : 0 };
}
export const isPremium = (sid) => getPremium(sid).active;

// Adds days. If the number is already premium the days are added after the current end date (nothing is lost).
export function grantPremium(sid, days, now = Date.now()) {
  const d = parseDays(days);
  if (!d) throw new Error('Days must be a whole number from 1 to 3650.');
  const cur = getPremium(sid, now);
  setSetting(sid, 'premium', { until: (cur.active ? cur.until : now) + d * DAY, grantedAt: now, notified: false });
  return getPremium(sid, now);
}
export function revokePremium(sid) { setSetting(sid, 'premium', null); }

// What the web pages get (dates as ISO text).
export function premiumView(sid) {
  const p = getPremium(sid);
  return { active: p.active, expired: p.expired, daysLeft: p.daysLeft, until: p.active ? new Date(p.until).toISOString() : null };
}

export const fmtDate = (ms) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: TIMEZONE }).format(new Date(ms));

/* ---------- messages (sent to the user's own chat) ---------- */
export const premiumGrantedText = (p, days) => [
  '╭━━━〔 👑 *PREMIUM ACTIVE* 〕━━━⬣',
  `┃ ➕ Added  : ${days} day${days === 1 ? '' : 's'}`,
  `┃ ⏳ Left   : ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`,
  `┃ 📅 Until  : ${fmtDate(p.until)}`,
  '╰━━━━━━━━━━━━━━━━━━━━⬣',
  '',
  `▸ Send *${PREFIX}premium* any time to see your plan.`,
  '',
  `${FOOTER_LINE}`
].join('\n');
export const premiumRemovedText = () => `👑 *Premium removed*\n\nYour number is on the free plan now.\n\n${FOOTER_LINE}`;
export const premiumEndedText = () => `👑 *Premium ended*\n\nYour premium days are over and premium commands are locked. Contact the bot owner to renew.\n\n${FOOTER_LINE}`;

// Best effort: a message that cannot be sent never breaks the action that caused it.
export async function notifyPremium(sock, text) {
  if (!sock) return false;
  try { await say(sock, `${jidNum(sock.user?.id)}@s.whatsapp.net`, text); return true; }
  catch (err) { console.error('Premium notice failed:', err?.message || err); return false; }
}

export function planText(sid) {
  const p = getPremium(sid);
  if (p.active) {
    return [
      '╭━━━〔 👑 *PREMIUM* 〕━━━⬣',
      '┃ ✅ Status : Active',
      `┃ ⏳ Left   : ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`,
      `┃ 📅 Until  : ${fmtDate(p.until)}`,
      '╰━━━━━━━━━━━━━━━━━━━━⬣'
    ].join('\n');
  }
  return [
    '╭━━━〔 👑 *PREMIUM* 〕━━━⬣',
    `┃ 🆓 Status : ${p.expired ? 'Ended (free plan)' : 'Free plan'}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `Premium unlocks extra commands. ${OWNER_NUMBER ? `Get it from the owner: https://wa.me/${OWNER_NUMBER}` : 'Contact the bot owner to get it.'}`
  ].join('\n');
}

/* ---------- hourly: tell people once when their premium has ended ---------- */
export async function sweepExpired() {
  const now = Date.now();
  for (const [sid, rec] of sessions) {
    const raw = getSetting(sid, 'premium', null);
    if (!raw?.until || raw.until > now || raw.notified || !rec?.sock || rec.status !== 'connected') continue;
    setSetting(sid, 'premium', { ...raw, notified: true }); // marked first, so a slow send can never message twice
    await notifyPremium(rec.sock, premiumEndedText());
    await new Promise((r) => setTimeout(r, 1500));
  }
}
if (!globalThis.__rioPremiumTimer) {
  globalThis.__rioPremiumTimer = true;
  setInterval(() => sweepExpired().catch((e) => console.error('Premium sweep error:', e?.message || e)), 60 * 60 * 1000).unref?.();
}
