// .pair: anyone can ask the bot for a pair code to link their OWN number as a new bot.
//   .pair 94771234567     (any chat)
//   .pair                 (private chat: uses the number of the person chatting)
// The code is sent with a "Copy Code" button. After linking, the new bot greets the user in their own chat
// and sends the web settings password (the normal flow in lib/session.js).
// session.js / web.js are imported lazily inside run(): importing them at the top would create an import cycle
// (session.js -> router.js -> commands/index.js -> this file -> session.js) that never finishes loading.
import crypto from 'node:crypto';
import { FOOTER_TEXT } from '../lib/brand.js';
import { MAX_SESSIONS, PREFIX, USE_BUTTONS, jidNum, sessions, sleep } from '../lib/config.js';
import { copyBtn, sendRich } from '../lib/menu.js';

const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '94').replace(/\D/g, ''); // for numbers typed like 0771234567
const PER_USER_GAP_MS = 60 * 1000;      // one request per minute per chat
const PER_USER_HOURLY = 5;              // and 5 per hour (stops people spamming codes at strangers)
const PER_NUMBER_GAP_MS = 2 * 60 * 1000; // the same target number at most once per 2 minutes
const lastByChat = new Map();           // chat jid -> [timestamps]
const lastByNumber = new Map();         // phone -> timestamp

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, arr] of lastByChat) { const keep = arr.filter((t) => t > cutoff); if (keep.length) lastByChat.set(k, keep); else lastByChat.delete(k); }
  for (const [k, t] of lastByNumber) if (t < Date.now() - PER_NUMBER_GAP_MS) lastByNumber.delete(k);
}, 5 * 60 * 1000).unref();

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d) && DEFAULT_CC) d = DEFAULT_CC + d.slice(1); // 0771234567 -> 94771234567
  return d;
}

export default [
  {
    name: 'pair', aliases: ['getpair', 'paircode', 'linkbot'], react: '🔗',
    async run({ sock, msg, jid, args, reply }) {
      const { startSession, destroySession } = await import('../lib/session.js');
      const { isPairingOpen } = await import('../lib/web.js');

      // number: typed after the command, or (private chat only) the person we are talking to
      let phone = normalizePhone(args.join(''));
      if (!phone && jid.endsWith('@s.whatsapp.net')) phone = normalizePhone(jidNum(jid));
      if (phone.length < 8 || phone.length > 15) {
        return reply(`🔗 *Get a pair code*\n\nSend your number with the country code, digits only:\n*${PREFIX}pair 94771234567*\n\nYou will get a code to link your own number as a bot.`);
      }

      const now = Date.now();
      const hist = (lastByChat.get(jid) || []).filter((t) => now - t < 60 * 60 * 1000);
      if (hist.length && now - hist[hist.length - 1] < PER_USER_GAP_MS) return reply('⏳ Please wait a minute before asking for another code.');
      if (hist.length >= PER_USER_HOURLY) return reply('⏳ Too many pair requests from this chat. Try again later.');
      if (now - (lastByNumber.get(phone) || 0) < PER_NUMBER_GAP_MS) return reply('⏳ A code was just made for this number. Use it, or wait 2 minutes and try again.');

      if (!isPairingOpen()) return reply('⏸️ New links are paused right now. Please try again later.');
      if (sessions.size >= MAX_SESSIONS) return reply('🈵 The server is full right now. Please try again later.');
      for (const [sid, r] of sessions) { // one session per number (same rules as the pairing website)
        if (r.phone !== phone) continue;
        if (r.status === 'connected') return reply('✅ This number is already linked to the bot.');
        if (r.state?.creds?.registered) return reply('✅ This number is already linked and is reconnecting. Try again in a minute.');
        destroySession(sid); // abandoned, unfinished attempt
      }

      hist.push(now); lastByChat.set(jid, hist); lastByNumber.set(phone, now);
      await reply('⏳ Making your pair code…');

      const id = crypto.randomBytes(12).toString('hex');
      let record;
      try { record = await startSession(id, phone); }
      catch (err) { destroySession(id); console.error('.pair start error:', err?.message || err); return reply('❌ Could not start a session. Try again in a moment.'); }

      for (let i = 0; i < 30 && !record.pairCode && record.status !== 'pair_error' && !record.removed; i++) await sleep(1000);
      const code = record.pairCode;
      if (!code) {
        const why = record.error || 'Could not generate a pair code. Check the number and try again.';
        destroySession(id);
        return reply(`❌ ${why}`);
      }

      const text = [
        '🔗 *Your pair code*',
        '',
        `📱 Number : +${phone}`,
        '',
        '1. Open WhatsApp on that phone',
        '2. *Settings → Linked devices → Link a device*',
        '3. Tap *Link with phone number instead*',
        '4. Paste the code below',
        '',
        `*${code}*`,
        '',
        '⏱️ The code works for about 5 minutes. After linking, the bot messages you in your own chat.',
      ].join('\n');
      if (USE_BUTTONS) {
        try { return await sendRich(sock, jid, { caption: text, buttons: [copyBtn('📋 Copy Code', code)], footer: FOOTER_TEXT, image: null }, msg); }
        catch (err) { console.error('.pair button send failed:', err?.message || err); }
      }
      return reply(text);
    },
  },
];
