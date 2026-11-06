// Remembers WHICH group messages happened (id + author + time, never the text) so that .delfrom can delete "this message and everything after it".
// Why: WhatsApp gives a bot no way to ask "what are the messages after this one", so the bot writes them down as they arrive.
// Only messages seen while the bot was running are known. Memory only (nothing on disk), 24 hours, at most GROUPLOG_MAX messages per group.

const MAX_PER_GROUP = Math.max(50, Number(process.env.GROUPLOG_MAX || 1000));
const MAX_GROUPS = 300;
const TTL_MS = 24 * 60 * 60 * 1000;
const groups = new Map(); // "session|group" -> Map(messageId -> { id, fromMe, participant, ts, seq, at })
let seq = 0;

const SKIP = ['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage'];
const REVOKE = (t) => t === 0 || t === 'REVOKE';
const tsOf = (msg) => {
  const t = msg.messageTimestamp;
  const n = typeof t?.toNumber === 'function' ? t.toNumber() : Number(t || 0);
  return n || Math.floor(Date.now() / 1000);
};
const peel = (m) => { // ephemeral / view-once wrappers
  let x = m || {};
  for (let i = 0; i < 4; i++) { const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message; if (!inner) break; x = inner; }
  return x;
};

export function groupLogSeen(sid, msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid?.endsWith('@g.us') || !msg.key.id || !msg.message) return; // group events without content (joins, renames ...) cannot be deleted
  const gk = `${sid}|${jid}`;
  const m = peel(msg.message);
  const proto = m.protocolMessage;
  if (proto && REVOKE(proto.type) && proto.key?.id) { groups.get(gk)?.delete(proto.key.id); return; } // somebody already deleted it
  if (SKIP.some((k) => m[k] || msg.message[k])) return;
  let g = groups.get(gk);
  if (!g) {
    if (groups.size >= MAX_GROUPS) groups.delete(groups.keys().next().value);
    g = new Map();
    groups.set(gk, g);
  }
  if (g.has(msg.key.id)) return;
  g.set(msg.key.id, { id: msg.key.id, fromMe: Boolean(msg.key.fromMe), participant: msg.key.participant || '', ts: tsOf(msg), seq: ++seq, at: Date.now() });
  if (g.size > MAX_PER_GROUP) g.delete(g.keys().next().value);
}

// { found, list }: found = false when the message is not remembered. list = that message and every later one, oldest first.
export function messagesFrom(sid, jid, targetId) {
  const g = groups.get(`${sid}|${jid}`);
  const target = g?.get(targetId);
  if (!target) return { found: false, list: [] };
  const list = [...g.values()].filter((e) => e.ts > target.ts || (e.ts === target.ts && e.seq >= target.seq)).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return { found: true, list };
}

export function groupLogForget(sid, jid, ids) {
  const g = groups.get(`${sid}|${jid}`);
  if (g) for (const id of ids) g.delete(id);
}
export const groupLogSize = (sid, jid) => groups.get(`${sid}|${jid}`)?.size || 0;
export const _resetGroupLog = () => { groups.clear(); };

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, g] of groups) {
    for (const [id, e] of g) if (e.at < cutoff) g.delete(id);
    if (!g.size) groups.delete(k);
  }
}, 10 * 60 * 1000).unref();
