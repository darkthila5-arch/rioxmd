// Group helpers: per-group settings, admin checks, welcome / goodbye messages and the anti-link filter.
// Used by commands/admin.js, commands/groupctl.js and (the two handlers at the bottom) lib/session.js.
import { jidNum } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { getText } from './text.js';
import { say } from './card.js';

export const DEFAULT_WELCOME = '👋 Welcome {user} to *{group}*!\nYou are member #{count}. Please read the group description.';
export const DEFAULT_GOODBYE = '🚪 {user} left *{group}*. Goodbye!';

const DEFAULT_CFG = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '', antilink: 'off', warns: {} };

/* ---------- per-group settings (saved with the session settings, so they survive restarts) ---------- */
export function getGroupCfg(sessionId, jid) {
  const all = getSetting(sessionId, 'groups', {});
  return { ...DEFAULT_CFG, ...(all[jid] || {}), warns: { ...(all[jid]?.warns || {}) } };
}
export function setGroupCfg(sessionId, jid, patch) {
  const all = { ...getSetting(sessionId, 'groups', {}) };
  all[jid] = { ...getGroupCfg(sessionId, jid), ...patch };
  setSetting(sessionId, 'groups', all);
  return all[jid];
}

/* ---------- identity helpers (WhatsApp may use either a phone JID or a LID for the same person) ---------- */
const idsOf = (x) => {
  if (!x) return [];
  if (typeof x === 'string') return [jidNum(x)];
  return [x.id, x.jid, x.lid, x.phoneNumber].filter(Boolean).map(jidNum);
};
const botIds = (sock) => [sock.user?.id, sock.user?.lid, sock.user?.jid].filter(Boolean).map(jidNum);
const senderIds = (msg) => [msg.key.participant, msg.key.participantAlt].filter(Boolean).map(jidNum);
const isAdminP = (p) => p?.admin === 'admin' || p?.admin === 'superadmin';

const metaCache = new Map(); // jid -> { meta, at }  (used by the anti-link filter so it does not ask WhatsApp for every message)
setInterval(() => { // drop groups nobody wrote in for a while, so the cache cannot grow forever
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of metaCache) if (v.at < cutoff) metaCache.delete(k);
}, 5 * 60 * 1000).unref();
async function getMeta(sock, jid, fresh = false) {
  const c = metaCache.get(jid);
  if (!fresh && c && Date.now() - c.at < 60 * 1000) return c.meta;
  const meta = await sock.groupMetadata(jid);
  metaCache.set(jid, { meta, at: Date.now() });
  return meta;
}

// Checks that the command is used in a group by an admin (or the bot owner) and, by default, that the bot is an admin too.
// Replies with the reason and returns null when the check fails; returns { meta, botIsAdmin, isGroupAdmin } when it passes.
export async function adminGuard(c, { botAdmin = true } = {}) {
  if (!c.jid.endsWith('@g.us')) { await c.reply('👥 This command only works in groups.'); return null; }
  let meta;
  try { meta = await getMeta(c.sock, c.jid, true); }
  catch (err) { await c.reply(`❌ Could not read the group info: ${err?.message || err}`); return null; }

  const me = botIds(c.sock);
  const sender = new Set(senderIds(c.msg));
  const botIsAdmin = meta.participants.some((p) => isAdminP(p) && idsOf(p).some((n) => me.includes(n)));
  const senderIsAdmin = meta.participants.some((p) => isAdminP(p) && idsOf(p).some((n) => sender.has(n)));
  const isGroupAdmin = senderIsAdmin || c.isOwner;

  if (!isGroupAdmin) { await c.reply('🚫 Only group admins can use this command.'); return null; }
  if (botAdmin && !botIsAdmin) { await c.reply('⚠️ Make me a group admin first, then try again.'); return null; }
  return { meta, botIsAdmin, isGroupAdmin };
}

/* ---------- welcome / goodbye ---------- */
const fill = (tpl, { user, meta }) => tpl
  .replaceAll('{user}', `@${jidNum(user)}`)
  .replaceAll('{group}', meta.subject || 'the group')
  .replaceAll('{count}', String(meta.participants?.length ?? ''))
  .replaceAll('{desc}', meta.desc || '');

// Called from the 'group-participants.update' event.
export async function handleGroupParticipants(sock, update, sessionId) {
  const { id: jid, action } = update || {};
  if (!jid || !['add', 'remove'].includes(action)) return;
  const cfg = getGroupCfg(sessionId, jid);
  const kind = action === 'add' ? 'welcome' : 'goodbye';
  if (!cfg[kind]) return;
  const meta = await getMeta(sock, jid, true).catch(() => null);
  if (!meta) return;
  const tpl = cfg[`${kind}Msg`] || (kind === 'welcome' ? DEFAULT_WELCOME : DEFAULT_GOODBYE);
  const me = botIds(sock);
  for (const p of update.participants || []) {
    const user = typeof p === 'string' ? p : (p.id || p.jid || p.phoneNumber);
    if (!user || idsOf(p).some((n) => me.includes(n))) continue; // never greet the bot itself
    try { await say(sock, jid, fill(tpl, { user, meta }), undefined, { mentions: [user] }); }
    catch (err) { console.error(`${kind} message error:`, err?.message || err); }
  }
}

/* ---------- anti-link ---------- */
const WA_LINK = /chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i;
const ANY_LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|me|lk|xyz|info|link|gg|tv|co|app|site|online)\b\S*/i;

// Called for every incoming message. Deletes links if anti-link is on and the sender is not an admin.
export async function handleAntiLink(sock, msg, sessionId) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us') || msg.key.fromMe || !msg.message) return;
  const mode = getGroupCfg(sessionId, jid).antilink;
  if (mode === 'off') return;
  const text = getText(msg);
  if (!text || !(mode === 'all' ? ANY_LINK : WA_LINK).test(text)) return;

  const meta = await getMeta(sock, jid).catch(() => null);
  if (!meta) return;
  const me = botIds(sock);
  if (!meta.participants.some((p) => isAdminP(p) && idsOf(p).some((n) => me.includes(n)))) return; // cannot delete without admin rights
  const sender = senderIds(msg);
  if (meta.participants.some((p) => isAdminP(p) && idsOf(p).some((n) => sender.includes(n)))) return; // admins are never affected

  try {
    await sock.sendMessage(jid, { delete: msg.key });
    const who = msg.key.participant;
    if (who) await say(sock, jid, `🚫 Links are not allowed here, @${jidNum(who)}.\n\nලින්ක් දාන්න පුළුවන් ඇඩ්මින්ලට විතරයි බං ... ඕන නම් ඇඩ්මින් කෙනෙක්ට ලින්ක් එක දියන් දාන්න කියලා 🤝😒`, undefined, { mentions: [who] });
  } catch (err) { console.error('Anti-link error:', err?.message || err); }
}
