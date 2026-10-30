// Targets the host (OWNER_NUMBER) sets with .autojoin / .autofollow, and the helpers behind .followall / .creact.
// CONSENT RULE: nothing here touches a number unless its owner switched on "Support other channels" (boostOptIn) on /settings.
// Numbers that did not opt in only get a message with the link, and decide for themselves.
import { sleep } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { pool } from './boost.js';
import { say } from './card.js';
import { jidNum } from './config.js';

const G = '_global';
const GAP_MS = Number(process.env.BOOST_GAP_MS ?? 4000);
const MAX_PER_RUN = Number(process.env.BOOST_MAX_ACTIONS || 30);
const gap = () => (GAP_MS ? sleep(GAP_MS + Math.floor(Math.random() * GAP_MS)) : Promise.resolve());

export const groupCode = (t) => String(t || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]{10,})/i)?.[1] || null;
export const channelCode = (t) => String(t || '').match(/whatsapp\.com\/channel\/([\w-]{10,})/i)?.[1] || null;
export const postId = (t) => String(t || '').match(/whatsapp\.com\/channel\/[\w-]{10,}\/(\d+)/i)?.[1] || null;

export const getTargets = () => ({ group: getSetting(G, 'autoJoinGroup', null), channel: getSetting(G, 'autoFollowChannel', null) });
export const setTarget = (kind, value) => setSetting(G, kind === 'group' ? 'autoJoinGroup' : 'autoFollowChannel', value);

const done = (sid) => getSetting(sid, 'welcomeDone', {}) || {};
const markDone = (sid, key) => setSetting(sid, 'welcomeDone', { ...done(sid), [key]: Date.now() });

// Called once after a brand-new link. Opted-in numbers join / follow by themselves; everyone else just gets the link.
export async function applyWelcome(sock, sid) {
  const { group, channel } = getTargets();
  if (!group && !channel) return;
  const me = `${jidNum(sock.user?.id)}@s.whatsapp.net`;
  const optedIn = getSetting(sid, 'boostOptIn', false) === true;
  const lines = [];
  if (group) {
    if (optedIn && !done(sid)[`g:${group}`]) {
      try { await sock.groupAcceptInvite(group); markDone(sid, `g:${group}`); lines.push('✅ You joined our group.'); }
      catch (e) { lines.push(`👥 Join our group: https://chat.whatsapp.com/${group}`); }
      await gap();
    } else if (!optedIn) lines.push(`👥 Join our group: https://chat.whatsapp.com/${group}`);
  }
  if (channel) {
    if (optedIn && !done(sid)[`c:${channel}`]) {
      try { const meta = await sock.newsletterMetadata('invite', channel); await sock.newsletterFollow(meta.id); markDone(sid, `c:${channel}`); lines.push('✅ You now follow our channel.'); }
      catch (e) { lines.push(`📣 Follow our channel: https://whatsapp.com/channel/${channel}`); }
    } else if (!optedIn) lines.push(`📣 Follow our channel: https://whatsapp.com/channel/${channel}`);
  }
  if (lines.length) await say(sock, me, lines.join('\n'));
}

// Runs an action on every connected number that opted in, spaced out and capped. Returns { ok, failed, total, skipped }.
export async function forPool(action) {
  const members = [...pool()];
  const run = members.slice(0, MAX_PER_RUN);
  let ok = 0, failed = 0;
  for (const [sid, sock] of run) {
    try { await action(sock, sid); ok++; } catch (err) { failed++; console.error(`Pool action failed (${sid.slice(0, 6)}):`, err?.message || err); }
    await gap();
  }
  return { ok, failed, total: members.length, skipped: members.length - run.length };
}
