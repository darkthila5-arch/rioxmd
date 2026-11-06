// .tempmail            make (or show) your temporary email address
// .tempmail inbox      list the mails that arrived
// .tempmail read <n>   read mail number n from the inbox
// .tempmail new        throw the old address away and make a new one
// .walink <number> [message]   make a wa.me chat link (0771234567 and 94771234567 both work)
// Uses mail.tm (free, no API key). Use .tempmail only in a PRIVATE chat: the inbox is shown in the chat.
import crypto from 'node:crypto';
import { PREFIX, USE_BUTTONS, jidNum } from '../lib/config.js';
import { FOOTER_TEXT } from '../lib/brand.js';
import { copyBtn, qr, sendRich } from '../lib/menu.js';

// mail.tm and mail.gw are the same service with the same API. If one does not answer (blocked host, down, busy) the other is tried.
const APIS = ['https://api.mail.tm', 'https://api.mail.gw'];
const TIMEOUT_MS = 12000;
const KEEP_MS = 2 * 60 * 60e3;      // forget the address in memory after 2 hours without use
const NEW_COOLDOWN_MS = 15e3;       // between two new addresses of the same person
const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '94').replace(/\D/g, '') || '94'; // used when a number starts with 0

const boxes = new Map(); // sender -> { address, password, token, at, created, list: [mail ids of the last inbox] }
setInterval(() => { const t = Date.now(); for (const [k, v] of boxes) if (t - v.at > KEEP_MS) boxes.delete(k); }, 10 * 60e3).unref();

const members = (r) => (Array.isArray(r) ? r : r?.['hydra:member'] || r?.member || []); // plain list or hydra list

async function call(api, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(api + path, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429) throw new Error('busy');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function makeBoxOn(api) {
  const domain = members(await call(api, '/domains')).find((d) => d?.domain && d.isActive !== false)?.domain;
  if (!domain) throw new Error('no domain');
  const address = `${crypto.randomBytes(5).toString('hex')}@${domain}`;
  const password = crypto.randomBytes(12).toString('base64url');
  await call(api, '/accounts', { method: 'POST', body: { address, password } });
  const tok = await call(api, '/token', { method: 'POST', body: { address, password } });
  if (!tok?.token) throw new Error('no token');
  return { api, address, password, token: tok.token, at: Date.now(), created: Date.now(), list: [] };
}

async function makeBox() {
  let last;
  for (const api of APIS) {
    try { return await makeBoxOn(api); }
    catch (err) { last = err; console.error(`tempmail: ${api} failed:`, err?.message || err, err?.cause?.code || ''); }
  }
  throw last || new Error('no service');
}

// Sends the text with tappable buttons when BUTTONS=on (copy / inbox / read / new), plain text otherwise or when the button send fails.
async function send({ sock, jid, msg, reply }, text, buttons) {
  if (USE_BUTTONS && buttons?.length) {
    try { return await sendRich(sock, jid, { caption: text, buttons, footer: FOOTER_TEXT, image: null }, msg); }
    catch (err) { console.error('tempmail button send failed:', err?.message || err); }
  }
  return reply(text);
}

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function inboxText(address, mails) {
  if (!mails.length) return `📭 *Inbox is empty*\n${address}\n\nSend a mail to this address, then use ${PREFIX}tempmail inbox again.`;
  const lines = mails.slice(0, 10).map((m, i) => `*${i + 1}.* ${clip(m.subject || '(no subject)', 60)}\n    from: ${clip(m.from?.address || m.from?.name, 40)}\n    ${clip(m.intro, 80)}`);
  return `📬 *Inbox* (${mails.length})\n${address}\n\n${lines.join('\n\n')}\n\nRead one: *${PREFIX}tempmail read <number>*`;
}

// "0771234567" -> 94771234567 ; "+94 77 123 4567" -> 94771234567 ; returns null when it does not look like a phone number.
export function normalizeNumber(input, cc = DEFAULT_CC) {
  let d = String(input || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length >= 9 && d.length <= 11) d = cc + d.slice(1);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export const waLink = (num, text = '') => `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export default [
  {
    name: 'tempmail', aliases: ['tmail', 'tempemail'], react: '📧',
    async run({ sock, args, jid, msg, reply }) {
      const out = { sock, jid, msg, reply };
      const addrButtons = (box) => [copyBtn('📋 Copy Address', box.address), qr('📬 Inbox', `${PREFIX}tempmail inbox`), qr('🔄 New Address', `${PREFIX}tempmail new`)];
      if (jid.endsWith('@g.us')) return reply(`📧 Please use ${PREFIX}tempmail in a *private chat* with the bot, the inbox would be visible to the whole group.`);
      const who = jidNum(msg?.key?.participant || jid);
      const sub = String(args[0] || '').toLowerCase();
      try {
        let box = boxes.get(who);

        if (sub === 'new' || sub === 'delete' || sub === 'del') {
          if (sub !== 'new') { boxes.delete(who); return reply('🗑️ Forgotten. Your old address is no longer used by the bot.'); }
          if (box && Date.now() - box.created < NEW_COOLDOWN_MS) return reply('⏳ Wait a few seconds before making another address.');
          boxes.delete(who); box = null;
        }

        if (!box) {
          box = await makeBox();
          boxes.set(who, box);
          return send(out, `📧 *Your temporary email*\n\n${box.address}\n\nUse it on any website, then tap *Inbox* (or send *${PREFIX}tempmail inbox*).\n(${PREFIX}tempmail new = new address)`, addrButtons(box));
        }
        box.at = Date.now();

        if (sub === 'inbox' || sub === 'check' || sub === 'i') {
          const mails = members(await call(box.api, '/messages', { token: box.token }));
          box.list = mails.slice(0, 10).map((m) => m.id);
          const btns = [qr('🔄 Refresh', `${PREFIX}tempmail inbox`), ...box.list.slice(0, 3).map((_, i) => qr(`📖 Read ${i + 1}`, `${PREFIX}tempmail read ${i + 1}`)), copyBtn('📋 Copy Address', box.address)];
          return send(out, inboxText(box.address, mails), btns);
        }

        if (sub === 'read' || sub === 'open') {
          const n = parseInt(args[1], 10);
          if (!box.list.length) return reply(`Check the inbox first: ${PREFIX}tempmail inbox`);
          if (!Number.isInteger(n) || n < 1 || n > box.list.length) return reply(`Use a number from 1 to ${box.list.length}: ${PREFIX}tempmail read 1`);
          const m = await call(box.api, `/messages/${box.list[n - 1]}`, { token: box.token });
          const body = (m?.text || String(m?.html?.[0] || '').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
          return send(out, `📨 *${clip(m?.subject || '(no subject)', 100)}*\nfrom: ${m?.from?.address || '-'}\n\n${body.slice(0, 3000) || '(empty)'}`, [qr('📬 Back to Inbox', `${PREFIX}tempmail inbox`), qr('🔄 New Address', `${PREFIX}tempmail new`)]);
        }

        return send(out, `📧 *Your temporary email*\n\n${box.address}\n\n${PREFIX}tempmail inbox · ${PREFIX}tempmail read <n> · ${PREFIX}tempmail new`, addrButtons(box));
      } catch (err) {
        if (String(err?.message).includes('401')) { boxes.delete(who); return reply(`⚠️ Your mailbox expired. Send ${PREFIX}tempmail to make a new one.`); }
        console.error('tempmail failed:', err?.message || err);
        return reply(err?.message === 'busy' ? '⏳ The mail service is busy, try again in a minute.' : `❌ The mail service did not answer. Try again in a moment.\n(${String(err?.cause?.code || err?.message || 'unknown').slice(0, 60)})`);
      }
    },
  },
  {
    name: 'walink', aliases: ['wame', 'chatlink'], react: '🔗',
    async run({ args, jid, msg, reply }) {
      let num = normalizeNumber(args[0]);
      let rest = args.slice(1);
      if (!num && !args.length) { // no number: link to the person who sent the command (private chat only, groups would give the group id)
        const own = jid.endsWith('@s.whatsapp.net') ? jidNum(jid) : '';
        num = own ? normalizeNumber(own) : null;
      } else if (!num) {
        return reply(`❌ That does not look like a phone number.\nExample: ${PREFIX}walink 0771234567 Hello`);
      }
      if (!num) return reply(`🔗 Usage: ${PREFIX}walink <number> [message]\nExample: ${PREFIX}walink 0771234567 Hello there`);
      const link = waLink(num, rest.join(' ').slice(0, 500));
      return reply(`🔗 *WhatsApp chat link*\n\n${link}`);
    },
  },
];
