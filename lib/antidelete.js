// Anti-delete: when someone deletes a message "for everyone", the linked number gets the original back.
//   .antidelete owner   deleted messages are sent to your OWN chat (private, recommended)
//   .antidelete chat    deleted messages are re-posted in the same chat (everybody sees them)
//   .antidelete off
// Only messages received while it is switched on are known. They are kept in MEMORY for 1 hour (nothing is written to disk).
// Small media (<= 3 MB, up to a 48 MB total budget) is downloaded when it arrives, because WhatsApp may remove the file after a delete.
// View-once messages are never kept here (they have their own switch: .viewonce).
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { TIMEZONE, jidNum, logger } from './config.js';
import { unwrapMessage } from './text.js';
import { getSetting } from './storage.js';

export const MODES = ['off', 'owner', 'chat'];
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const MEDIA_BUDGET = 48 * 1024 * 1024;
const MEDIA_WAIT_MS = 8000;

const store = new Map(); // "session:messageId" -> { msg, at, buf, pending }
let mediaBytes = 0;

export function antiDeleteMode(sid) {
  const v = getSetting(sid, 'antiDelete', 'off');
  return MODES.includes(v) ? v : 'off';
}

const MEDIA_KINDS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker', documentMessage: 'document' };
const LABELS = {
  contactMessage: '👤 Contact', contactsArrayMessage: '👥 Contacts', locationMessage: '📍 Location', liveLocationMessage: '📍 Live location',
  pollCreationMessage: '📊 Poll', pollCreationMessageV2: '📊 Poll', pollCreationMessageV3: '📊 Poll'
};

// What is inside a message: { text, kind, part, label } or null when there is nothing worth keeping.
export function describe(message) {
  const raw = message || {};
  const wrapped = raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension || raw.ephemeralMessage?.message?.viewOnceMessage;
  if (wrapped) return null; // view-once: never stored
  const m = unwrapMessage(raw);
  if (m.protocolMessage || m.reactionMessage || m.pollUpdateMessage || m.keepInChatMessage || m.editedMessage) return null;
  for (const [key, kind] of Object.entries(MEDIA_KINDS)) {
    if (m[key]) {
      if (m[key].viewOnce) return null;
      return { kind, part: m[key], text: m[key].caption || '', fileName: m[key].fileName || '' };
    }
  }
  const text = m.conversation || m.extendedTextMessage?.text;
  if (text) return { kind: 'text', text };
  for (const [key, label] of Object.entries(LABELS)) if (m[key]) return { kind: 'other', label, text: m[key].displayName || m[key].name || '' };
  return null;
}

function evict(id) {
  const e = store.get(id);
  if (e?.buf) mediaBytes -= e.buf.length;
  store.delete(id);
}
function trim() {
  while (store.size > MAX_ENTRIES || mediaBytes > MEDIA_BUDGET) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    evict(oldest);
  }
}
setInterval(() => { const cutoff = Date.now() - TTL_MS; for (const [k, e] of [...store]) if (e.at < cutoff) evict(k); }, 5 * 60 * 1000).unref();

async function fetchMedia(sock, msg) {
  return downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
}

// Called for every incoming message of a session. Cheap when the feature is off.
export function rememberIncoming(sock, sid, msg) {
  if (antiDeleteMode(sid) === 'off') return;
  const key = msg?.key;
  if (!key?.id || key.fromMe || !msg.message) return;
  const jid = key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  const info = describe(msg.message);
  if (!info) return;
  const id = `${sid}:${key.id}`;
  const entry = { msg, info, at: Date.now(), buf: null, pending: null };
  store.set(id, entry);
  if (info.kind !== 'text' && info.kind !== 'other' && Number(info.part?.fileLength || 0) <= MAX_MEDIA_BYTES) {
    entry.pending = fetchMedia(sock, msg).then((buf) => {
      if (buf?.length && buf.length <= MAX_MEDIA_BYTES && store.get(id) === entry) { entry.buf = buf; mediaBytes += buf.length; trim(); }
    }).catch(() => {}).finally(() => { entry.pending = null; });
  }
  trim();
}

const timeText = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: TIMEZONE, hour12: false, dateStyle: 'medium', timeStyle: 'medium' });

async function chatTitle(sock, jid) {
  if (!jid.endsWith('@g.us')) return 'Private chat';
  try {
    const meta = await Promise.race([sock.groupMetadata(jid), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
    return `Group: ${meta?.subject || jid}`;
  } catch { return 'Group'; }
}

// Called when a "delete for everyone" arrives. Returns true when it was a delete notice (even if nothing was stored).
export async function handleRevoke(sock, sid, msg) {
  const proto = unwrapMessage(msg?.message).protocolMessage;
  if (!proto || !(proto.type === 0 || proto.type === 'REVOKE')) return false;
  const mode = antiDeleteMode(sid);
  if (mode === 'off') return true;
  const id = `${sid}:${proto.key?.id}`;
  const entry = store.get(id);
  if (!entry) return true;
  evict(id); // reported only once
  if (entry.pending) await Promise.race([entry.pending, new Promise((r) => setTimeout(r, MEDIA_WAIT_MS))]);

  const orig = entry.msg, info = entry.info, chat = orig.key.remoteJid;
  const senderJid = orig.key.participantAlt || orig.key.participant || orig.key.remoteJidAlt || chat;
  const phone = String(senderJid).endsWith('@lid') ? '' : `+${jidNum(senderJid)}`;
  const target = mode === 'chat' ? chat : jidNormalizedUser(sock.user.id);

  let buf = entry.buf;
  if (!buf && info.part) { try { buf = await fetchMedia(sock, orig); } catch { buf = null; } }

  const header = [
    '🗑️ *Deleted message*',
    `👤 ${orig.pushName || 'Unknown'}${phone ? ` (${phone})` : ''}`,
    `💬 ${await chatTitle(sock, chat)}`,
    `🕒 Sent: ${timeText(entry.at)}`
  ];
  const body = info.kind === 'text' ? ['', info.text]
    : info.kind === 'other' ? ['', `${info.label}${info.text ? `: ${info.text}` : ''}`]
      : ['', `📎 ${info.kind}${info.fileName ? `: ${info.fileName}` : ''}${info.text ? `\n${info.text}` : ''}${buf ? '' : '\n_(the file could not be recovered)_'}`];
  await sock.sendMessage(target, { text: [...header, ...body].join('\n') });

  if (buf && info.part) {
    const mime = info.part.mimetype;
    if (info.kind === 'image') await sock.sendMessage(target, { image: buf });
    else if (info.kind === 'video') await sock.sendMessage(target, { video: buf, mimetype: mime });
    else if (info.kind === 'audio') await sock.sendMessage(target, { audio: buf, mimetype: mime || 'audio/ogg; codecs=opus', ptt: !!info.part.ptt });
    else if (info.kind === 'sticker') await sock.sendMessage(target, { sticker: buf });
    else if (info.kind === 'document') await sock.sendMessage(target, { document: buf, mimetype: mime || 'application/octet-stream', fileName: info.fileName || 'file' });
  }
  return true;
}

// The one hook used by lib/session.js.
export function antiDeleteSeen(sock, sid, msg) {
  try {
    if (msg?.message?.protocolMessage || unwrapMessage(msg?.message).protocolMessage) {
      handleRevoke(sock, sid, msg).catch((err) => console.error('Anti-delete error:', err?.message || err));
    } else {
      rememberIncoming(sock, sid, msg);
    }
  } catch (err) { console.error('Anti-delete error:', err?.message || err); }
}

export function clearAntiDelete(sid) {
  for (const k of [...store.keys()]) if (!sid || k.startsWith(`${sid}:`)) evict(k);
}
