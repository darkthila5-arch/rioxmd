// .setwelcomeimg  -> a picture that is sent WITH the welcome message of this group (the text becomes the picture caption).
//   .setwelcomeimg            reply to a picture (or send a picture with this as the caption)  = save it
//   .setwelcomeimg show       see the saved picture        .setwelcomeimg off / remove   = back to text only
// The picture is shrunk (max 900 px, JPEG) and saved in the group settings, so it survives restarts and redeploys.
// The welcome message itself (.welcome on / set <text>) must be ON, this command only adds the picture.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { PREFIX, logger } from '../lib/config.js';
import { adminGuard, getGroupCfg, setGroupCfg } from '../lib/groups.js';
import { unwrapMessage } from '../lib/text.js';
import { getSetting } from '../lib/storage.js';

const MAX_IN = 15 * 1024 * 1024;   // biggest picture we accept
const MAX_GROUPS = 25;             // groups per number that may keep a picture (keeps the settings file small)

const pickImage = (m) => {
  if (!m) return null;
  if (m.imageMessage) return m.imageMessage;
  if (m.documentMessage && /^image\//i.test(m.documentMessage.mimetype || '')) return m.documentMessage;
  return null;
};

export default [
  {
    name: 'setwelcomeimg', aliases: ['welcomeimg', 'setwelcomeimage'], react: '🖼️',
    async run(c) {
      const { sock, msg, jid, sessionId, args, reply } = c;
      const g = await adminGuard(c, { botAdmin: false }); // also checks that this is a group and the sender is an admin
      if (!g) return;
      const sub = (args[0] || '').toLowerCase();
      const cfg = getGroupCfg(sessionId, jid);

      if (['off', 'remove', 'delete', 'reset'].includes(sub)) {
        if (!cfg.welcomeImg) return reply('🖼️ This group has no welcome picture.');
        setGroupCfg(sessionId, jid, { welcomeImg: '' });
        return reply('✅ Welcome picture removed. The welcome message is text only again.');
      }
      if (sub === 'show') {
        if (!cfg.welcomeImg) return reply(`🖼️ No welcome picture yet.\nReply to a picture with ${PREFIX}setwelcomeimg`);
        return sock.sendMessage(jid, { image: Buffer.from(cfg.welcomeImg, 'base64'), caption: '🖼️ This is the welcome picture of this group.' }, { quoted: msg });
      }

      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const own = pickImage(unwrapMessage(msg.message));
      const part = pickImage(quoted) || own;
      if (!part) {
        return reply([
          `🖼️ *Welcome picture* is ${cfg.welcomeImg ? '✅ SET' : '❌ not set'}`,
          '',
          `Reply to a picture with ${PREFIX}setwelcomeimg`,
          `(or send the picture with ${PREFIX}setwelcomeimg as the caption)`,
          `${PREFIX}setwelcomeimg show · ${PREFIX}setwelcomeimg off`,
          '',
          `_The welcome message must be on: ${PREFIX}welcome on_`,
        ].join('\n'));
      }

      const withImg = Object.values(getSetting(sessionId, 'groups', {})).filter((x) => x?.welcomeImg).length;
      if (!cfg.welcomeImg && withImg >= MAX_GROUPS) return reply(`⚠️ This number already keeps welcome pictures for ${MAX_GROUPS} groups. Remove one with ${PREFIX}setwelcomeimg off in another group first.`);

      const target = quoted && pickImage(quoted)
        ? { key: { remoteJid: ctx.remoteJid || jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted }
        : msg;
      let buf;
      try { buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }); }
      catch (err) { console.error('setwelcomeimg download error:', err?.message || err); return reply('❌ Could not open that picture (it may have expired). Send it again.'); }
      if (buf.length > MAX_IN) return reply('❌ That picture is too big (over 15 MB).');

      let small;
      try {
        const sharp = (await import('sharp')).default;
        small = await sharp(buf).rotate().resize(900, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      } catch (err) { console.error('setwelcomeimg convert error:', err?.message || err); return reply('❌ I could not read that picture. Use a normal JPG / PNG photo.'); }

      setGroupCfg(sessionId, jid, { welcomeImg: small.toString('base64') });
      const note = cfg.welcome ? '' : `\n⚠️ The welcome message is OFF. Turn it on with ${PREFIX}welcome on`;
      return reply(`✅ Welcome picture saved (${Math.round(small.length / 1024)} KB). New members get it together with the welcome text.${note}`);
    },
  },
];
