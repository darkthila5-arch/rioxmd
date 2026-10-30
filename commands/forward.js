// .forward <target> [target2 ...]   (reply to any message)  - owner only
// Forwards the replied-to message (text, photo, video, audio, document, sticker ...) to other chats.
// A target can be: a group link, a channel link, a jid (...@g.us / ...@newsletter / ...@s.whatsapp.net),
// a phone number with country code, or the word "me" (your own chat). Up to 5 targets at a time.
import { PREFIX, jidNum, sleep } from '../lib/config.js';
import { unwrapMessage } from '../lib/text.js';

const MAX_TARGETS = 5;
const GAP_MS = 1500; // slow and steady: bulk forwarding is what gets numbers restricted
const VIEW_ONCE = /viewOnce/i;

async function resolveTarget(sock, raw, jid) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^(me|self|here)$/i.test(t)) return /^here$/i.test(t) ? jid : `${jidNum(sock.user?.id)}@s.whatsapp.net`;
  if (/@(g\.us|newsletter|s\.whatsapp\.net)$/.test(t)) return t;
  const ch = t.match(/whatsapp\.com\/channel\/([\w-]+)/i);
  if (ch) return (await sock.newsletterMetadata('invite', ch[1])).id;
  const gr = t.match(/chat\.whatsapp\.com\/([\w-]+)/i);
  if (gr) return (await sock.groupGetInviteInfo(gr[1])).id;
  const num = t.replace(/\D/g, '');
  if (num.length >= 8 && num.length <= 15 && /^\+?[\d\s-]+$/.test(t)) return `${num}@s.whatsapp.net`;
  return null;
}

const usage = () => [
  '📤 *Forward a message*',
  '',
  `Reply to a message with:`,
  `${PREFIX}forward <target> [target2 ...]`,
  '',
  'Target can be:',
  '▸ a group link or channel link',
  '▸ a jid (…@g.us / …@newsletter)',
  '▸ a number with country code (94771234567)',
  '▸ *me* (your own chat)',
  '',
  `Example: ${PREFIX}forward https://chat.whatsapp.com/xxxx 94771234567`,
  `Up to ${MAX_TARGETS} targets at once.`
].join('\n');

export default [
  {
    name: 'forward', aliases: ['fwd', 'fw'], owner: true, react: '📤',
    async run({ sock, msg, jid, args, reply }) {
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      if (!args.length || !ctx?.quotedMessage) return reply(usage());

      const quoted = unwrapMessage(ctx.quotedMessage);
      if (Object.keys(ctx.quotedMessage).concat(Object.keys(quoted)).some((k) => VIEW_ONCE.test(k)) || Object.values(quoted).some((v) => v?.viewOnce)) {
        return reply(`❌ View-once messages cannot be forwarded. Use ${PREFIX}vv to open it first.`);
      }
      const source = { key: { remoteJid: ctx.remoteJid || jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: ctx.quotedMessage };

      const wanted = [...new Set(args)].slice(0, MAX_TARGETS);
      const lines = [];
      let ok = 0;
      for (const raw of wanted) {
        let to = null;
        try { to = await resolveTarget(sock, raw, jid); } catch (err) { console.error('forward resolve error:', err?.message || err); }
        if (!to) { lines.push(`❌ ${raw.slice(0, 40)}: not a valid target`); continue; }
        try {
          await sock.sendMessage(to, { forward: source });
          ok += 1;
          lines.push(`✅ ${to.endsWith('@newsletter') ? '📢' : to.endsWith('@g.us') ? '👥' : '👤'} ${jidNum(to)}`);
        } catch (err) {
          console.error(`forward to ${to} failed:`, err?.message || err);
          lines.push(`❌ ${jidNum(to)}: could not send (not a member / not allowed / media expired)`);
        }
        await sleep(GAP_MS);
      }
      return reply(`📤 *Forwarded ${ok}/${wanted.length}*\n\n${lines.join('\n')}${args.length > MAX_TARGETS ? `\n\n⚠️ Only the first ${MAX_TARGETS} targets were used.` : ''}`);
    }
  }
];
