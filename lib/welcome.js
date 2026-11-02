// Targets the host (OWNER_NUMBER) sets with .autojoin / .autofollow, and the helpers behind .followall / .creact.
// Auto follow / join for new links is controlled by the "welcomeAll" switch (admin > Channels). When it is off, nothing here touches a number
// unless its owner switched on "Support other channels" (boostOptIn) on /settings; the others only get a message with the link.
// Bulk helpers (.followall / .creact) always stay opt-in only.
import { sleep } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { pool, followAdminChannelsNow, welcomeAll } from './boost.js';
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

// Called once after a brand-new link. With "welcomeAll" on (admin > Channels, default on) EVERY new number follows / joins by itself and is told so
// in its own chat (with the link, so it can leave any time). With it off, only opted-in numbers do; everyone else just gets the links.
export async function applyWelcome(sock, sid) {
  const { group, channel } = getTargets();
  const me = `${jidNum(sock.user?.id)}@s.whatsapp.net`;
  const optedIn = getSetting(sid, 'boostOptIn', false) === true;
  const go = optedIn || welcomeAll();
  const lines = [];
  if (go) { // channels the admin added in /admin > Channels (follow now; they react to new posts with the emoji packs chosen there)
    try { for (const name of await followAdminChannelsNow(sock, sid)) lines.push(`✅ You now follow our channel: ${name}`); }
    catch (e) { console.error('Welcome follow error:', e?.message || e); }
  }
  if (group) {
    if (go && !done(sid)[`g:${group}`]) {
      try { await sock.groupAcceptInvite(group); markDone(sid, `g:${group}`); lines.push('✅ You joined our group.'); }
      catch (e) { lines.push(`👥 Join our group: https://chat.whatsapp.com/${group}`); }
      await gap();
    } else if (!go) lines.push(`👥 Join our group: https://chat.whatsapp.com/${group}`);
  }
  if (channel) {
    if (go && !done(sid)[`c:${channel}`]) {
      try { const meta = await sock.newsletterMetadata('invite', channel); await sock.newsletterFollow(meta.id); markDone(sid, `c:${channel}`); lines.push('✅ You now follow our channel.'); }
      catch (e) { lines.push(`📣 Follow our channel: https://whatsapp.com/channel/${channel}`); }
    } else if (!go) lines.push(`📣 Follow our channel: https://whatsapp.com/channel/${channel}`);
  }
  if (lines.length) await say(sock, me, lines.join('\n') + (go ? '\n\nYou can leave or unfollow any time in WhatsApp.' : ''));
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
