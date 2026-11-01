import { isJidGroup, downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { TIMEZONE, jidNum, logger, sleep } from './config.js';
import { getText, unwrapMessage } from './text.js';
import { getSetting } from './storage.js';
import { react } from './card.js';


/* ---------- status tools (auto view / react / save) and view-once recovery ---------- */
export const DEFAULT_STATUS_EMOJIS = ['❤️', '🔥', '😍', '👏', '💯', '🥰'];
export const STATUS_TOGGLES = {
  statusseen: ['statusSeen', 'Auto status view'], autoseen: ['statusSeen', 'Auto status view'],
  statusreact: ['statusReact', 'Auto status react'], autoreact: ['statusReact', 'Auto status react'],
  statussave: ['statusSave', 'Auto status save'], autosave: ['statusSave', 'Auto status save'],
  viewonce: ['viewOnce', 'View-once recovery'], antiviewonce: ['viewOnce', 'View-once recovery']
};
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const handledIds = new Map(); // message id -> time, so one message is never processed twice
function firstTime(id) {
  if (handledIds.has(id)) return false;
  handledIds.set(id, Date.now());
  return true;
}
setInterval(() => { // O(n) cleanup once a minute instead of on every incoming message
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, t] of handledIds) if (t < cutoff) handledIds.delete(k);
}, 60 * 1000).unref();
export function extractEmojis(text) {
  const found = String(text || '').match(/(?:\p{Regional_Indicator}{2})|(?:[#*0-9]️?⃣)|(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/gu);
  return [...new Set(found || [])].slice(0, 20);
}

// Finds image / video / audio inside any wrapper (ephemeral, view-once ...). `viewOnce` tells if it was a view-once message.
export function findMedia(message) {
  let m = message || {}, viewOnce = false;
  for (let i = 0; i < 6; i++) {
    const vo = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
    const inner = vo || m.ephemeralMessage?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    if (vo) viewOnce = true;
    m = inner;
  }
  for (const kind of ['image', 'video', 'audio']) {
    const part = m[`${kind}Message`];
    if (part) return { kind, part, viewOnce: viewOnce || !!part.viewOnce };
  }
  return { kind: null, part: null, viewOnce, text: m.conversation || m.extendedTextMessage?.text || '' };
}

export async function downloadPart(sock, target, part) {
  if (Number(part?.fileLength || 0) > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  if (buf.length > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  return buf;
}
export async function sendMedia(sock, to, kind, part, buf, caption, extra = {}) {
  if (kind === 'image') return sock.sendMessage(to, { image: buf, caption, ...extra });
  if (kind === 'video') return sock.sendMessage(to, { video: buf, mimetype: part.mimetype || 'video/mp4', caption, ...extra });
  await sock.sendMessage(to, { audio: buf, mimetype: part.mimetype || 'audio/ogg; codecs=opus', ptt: !!part.ptt });
  if (caption) await sock.sendMessage(to, { text: caption, ...extra });
}

export const statusDebug = new Map(); // sid -> what happened with the latest status (shown in .autostatus)
function noteStatus(sid, patch) {
  statusDebug.set(sid, { ...(statusDebug.get(sid) || {}), ...patch });
  if (statusDebug.size > 200) statusDebug.delete(statusDebug.keys().next().value); // never grows without limit
}

export async function handleStatus(sock, msg, sid) {
  if (!msg.message || msg.key.fromMe) return;
  const seen = getSetting(sid, 'statusSeen', false), react = getSetting(sid, 'statusReact', false), save = getSetting(sid, 'statusSave', false);
  const raw = msg.message;
  const poster = msg.key.participant || msg.participant;
  if (!poster || raw.protocolMessage || raw.reactionMessage) return;
  if (!firstTime(`st:${msg.key.id}`)) return;
  const ts = Number(msg.messageTimestamp || 0);
  const age = ts ? Date.now() / 1000 - ts : 0;
  const steps = [];
  noteStatus(sid, { at: Date.now(), from: jidNum(poster), steps, error: null, on: { seen, react, save } });
  if (!seen && !react && !save) { steps.push('all status switches are OFF'); return; }
  if (age > 24 * 3600) { steps.push('older than 24h, skipped'); return; }
  const me = jidNormalizedUser(sock.user?.id);
  // newer WhatsApp versions may give a @lid id: also pass the phone-number id when WhatsApp tells us
  const alt = msg.key.participantAlt || msg.key.participantPn || null;
  const audience = [...new Set([poster, alt, me].filter(Boolean))];

  if (seen || react) {
    try { await sock.readMessages([msg.key]); steps.push('viewed'); }
    catch (err) { console.error('Status view error:', err?.message || err); steps.push('view failed'); noteStatus(sid, { error: `view: ${err?.message || err}` }); }
  }
  if (react) {
    if (age >= 30 * 60) steps.push('too old to react (over 30 min)');
    else {
      const list = getSetting(sid, 'statusEmojis', null);
      const pool = Array.isArray(list) && list.length ? list : DEFAULT_STATUS_EMOJIS;
      const emoji = pool[Math.floor(Math.random() * pool.length)];
      await sleep(1500 + Math.random() * 3500); // a short human-like pause
      let done = false, lastErr = null;
      for (const jids of [audience, [poster, me]]) { // second try with the plain list
        try { await sock.sendMessage('status@broadcast', { react: { text: emoji, key: msg.key } }, { statusJidList: jids }); done = true; break; }
        catch (err) { lastErr = err; }
      }
      if (done) steps.push(`reacted ${emoji}`);
      else { console.error('Status react error:', lastErr?.message || lastErr); steps.push('react failed'); noteStatus(sid, { error: `react: ${lastErr?.message || lastErr}` }); }
    }
  }
  if (save) {
    if (age >= 6 * 3600) steps.push('too old to save (over 6h)');
    else {
      const head = `📥 *Status* from @${jidNum(poster)}${msg.pushName ? ` (${msg.pushName})` : ''}`;
      const found = findMedia(raw);
      try {
        if (found.kind) {
          const buf = await downloadPart(sock, msg, found.part);
          await sendMedia(sock, me, found.kind, found.part, buf, `${head}${found.part.caption ? `\n\n${found.part.caption}` : ''}`);
          steps.push('saved');
        } else if (found.text) {
          await sock.sendMessage(me, { text: `${head}\n\n${found.text}`, mentions: [poster] });
          steps.push('saved (text)');
        } else steps.push('nothing to save');
      } catch (err) { console.error('Status save error:', err?.message || err); steps.push('save failed'); noteStatus(sid, { error: `save: ${err?.message || err}` }); }
    }
  }
  console.log(`[status] ${jidNum(poster)}: ${steps.join(', ')}`);
}

// Sends a copy of every incoming view-once photo / video / voice note to the owner's own chat.
export async function handleViewOnce(sock, msg, sid) {
  if (!msg.message || msg.key.fromMe || !getSetting(sid, 'viewOnce', false)) return;
  const found = findMedia(msg.message);
  if (!found.kind || !found.viewOnce) return;
  if (!firstTime(`vo:${msg.key.id}`)) return;
  const from = msg.key.participant || msg.key.remoteJid;
  const where = isJidGroup(msg.key.remoteJid) ? 'a group' : 'private chat';
  const caption = `👁️ *View-once recovered*\n👤 @${jidNum(from)}${msg.pushName ? ` (${msg.pushName})` : ''}\n💬 ${where}${found.part.caption ? `\n\n${found.part.caption}` : ''}`;
  try {
    const buf = await downloadPart(sock, msg, found.part);
    await sendMedia(sock, jidNormalizedUser(sock.user?.id), found.kind, found.part, buf, caption);
  } catch (err) { console.error('View-once recovery error:', err?.message || err); }
}

/* ---------- silent .vv: the owner replies "vv" (or one of their vv emojis) to a view-once photo / video / voice note ---------- */
// The copy goes to the owner's own chat with the details. Nothing is sent, reacted or typed in the chat where the owner replied.
export const DEFAULT_VV_EMOJIS = ['😂', '👀'];
const norm = (e) => String(e).replace(/\uFE0F/g, '');
export const vvEmojis = (sid) => { const l = getSetting(sid, 'vvEmojis', null); return Array.isArray(l) && l.length ? l : DEFAULT_VV_EMOJIS; };

// Incoming view-once messages are remembered for a while (the message object only, not the file), so a later reply can still open them
// even when WhatsApp strips the media from the quoted copy.
const voCache = new Map(); // message id -> { msg, at }
export function rememberViewOnce(msg) {
  if (!msg?.message || msg.key?.fromMe) return;
  const f = findMedia(msg.message);
  if (!f.kind || !f.viewOnce || !msg.key?.id) return;
  voCache.set(msg.key.id, { msg, at: Date.now() });
  if (voCache.size > 400) voCache.delete(voCache.keys().next().value);
}
setInterval(() => { const cutoff = Date.now() - 24 * 3600 * 1000; for (const [k, v] of voCache) if (v.at < cutoff) voCache.delete(k); }, 10 * 60 * 1000).unref();

// 'text' for "vv" / ".vv", 'emoji' when the message is only one or more of the owner's vv emojis, otherwise null.
export function vvTrigger(text, emojis) {
  const t = String(text || '').trim();
  if (/^[.!#/]?vv$/i.test(t)) return 'text';
  const found = extractEmojis(t);
  if (!found.length) return null;
  let rest = t; for (const e of found) rest = rest.split(e).join('');
  if (rest.replace(/[\s\uFE0F\u200D]/g, '')) return null; // other text in the message: not a trigger
  const set = new Set(emojis.map(norm));
  return found.every((e) => set.has(norm(e))) ? 'emoji' : null;
}

const KIND_LABEL = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice note' };
const fmtTime = (ts) => (ts ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIMEZONE }).format(new Date(ts * 1000)) : 'unknown');

// Returns true when the message is a vv trigger on a view-once message (it is then fully handled here, silently, and the router must skip it).
// The work itself runs in the background so a slow download never holds up the other messages.
export function handleVvReply(sock, msg, sid) {
  if (!msg?.message || !msg.key?.fromMe) return false; // only the owner's own messages
  const trig = vvTrigger(getText(msg), vvEmojis(sid));
  if (!trig) return false;
  const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
  if (!ctx?.stanzaId || !ctx.quotedMessage) return false; // not a reply
  const jid = msg.key.remoteJid;
  const cached = voCache.get(ctx.stanzaId)?.msg;
  const found = findMedia(cached?.message || ctx.quotedMessage);
  if (!found.kind) return false; // replied to something that is not a photo / video / voice note: let the normal command handle ".vv"
  if (!found.viewOnce && trig === 'emoji') return false; // an emoji reply to a normal photo is just an emoji
  if (!firstTime(`vv:${msg.key.id}`)) return true;
  (async () => {
    try {
      const target = cached || { key: { remoteJid: ctx.remoteJid || jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage };
      const buf = await downloadPart(sock, target, found.part);
      const group = isJidGroup(jid);
      const from = ctx.participant || cached?.key?.participant || (group ? null : jid);
      let where = 'Private chat';
      if (group) { try { where = `Group: ${(await sock.groupMetadata(jid)).subject}`; } catch { where = 'Group'; } }
      const mentions = from && !String(from).endsWith('@g.us') ? [from] : [];
      const caption = [
        found.viewOnce ? '👁️ *View-once saved*' : '📥 *Media saved*',
        `${KIND_LABEL[found.kind]}${found.part.seconds ? ` · ${found.part.seconds}s` : ''}`,
        from ? `👤 @${jidNum(from)}${cached?.pushName ? ` (${cached.pushName})` : ''}` : '',
        `💬 ${where}`,
        `🕒 Sent: ${fmtTime(Number(cached?.messageTimestamp || 0))}`,
        found.part.caption ? `\n📝 ${found.part.caption}` : '',
      ].filter(Boolean).join('\n');
      await sendMedia(sock, jidNormalizedUser(sock.user?.id), found.kind, found.part, buf, caption, { mentions });
    } catch (err) { console.error('Silent vv error:', err?.message === 'TOO_BIG' ? 'file too big' : (err?.message || err)); } // silent: never answers in the chat
  })();
  return true;
}
