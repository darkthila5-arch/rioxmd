// Channel support pool (premium feature, opt-in).
// A premium user adds a WhatsApp channel on the /settings page. Linked numbers whose OWNER switched on
// "Support other channels" (setting boostOptIn, off by default, only the owner can change it) follow that channel and
// react to its new posts. Numbers that did not opt in are never touched. Opting out, removing the channel or the premium
// ending makes the helper numbers unfollow again.
//
// Safety: actions are spread out (BOOST_GAP_MS +- jitter), capped per sweep (BOOST_MAX_ACTIONS) and a channel's first check
// only remembers the existing posts. This is still automation on WhatsApp accounts, so keep the numbers small and expect
// that WhatsApp can limit accounts that follow / react a lot.
//
// Jobs live with the other settings under the reserved id "_global" (MongoDB or SESSION_DIR), so they survive restarts.
import crypto from 'node:crypto';
import { sessions, sleep } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { getPremium } from './premium.js';

const G = '_global', KEY = 'boostJobs';
export const MAX_CHANNELS_PER_USER = Number(process.env.BOOST_MAX_CHANNELS || 1);
const POLL_MS = Math.max(1, Number(process.env.BOOST_POLL_MIN || 2)) * 60 * 1000;
const GAP_MS = Number(process.env.BOOST_GAP_MS ?? 4000);        // pause between two actions (random extra up to the same amount)
const MAX_ACTIONS = Number(process.env.BOOST_MAX_ACTIONS || 30); // follow / unfollow / react calls per sweep
const PENDING_MAX_AGE = 30 * 60 * 1000;                           // a post nobody reacted to within 30 min is dropped
export const DEFAULT_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏'];

const jobs = () => getSetting(G, KEY, []) || [];
const save = (list) => setSetting(G, KEY, list);
const gap = () => (GAP_MS ? sleep(GAP_MS + Math.floor(Math.random() * GAP_MS)) : Promise.resolve());
const connected = (rec) => !!rec?.sock && rec.status === 'connected';
const optedIn = (sid) => getSetting(sid, 'boostOptIn', false) === true;

// Connected numbers that agreed to support other channels: Map sid -> sock.
export function pool() {
  const m = new Map();
  for (const [sid, rec] of sessions) if (connected(rec) && optedIn(sid)) m.set(sid, rec.sock);
  return m;
}

export function cleanEmojis(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/\s+/)).map((e) => String(e).trim()).filter((e) => e && e.length <= 8 && /\p{Extended_Pictographic}/u.test(e));
  return [...new Set(list)].slice(0, 6);
}

/* ---------- used by the web routes ---------- */
export function boostSummary(sid) {
  const mine = jobs().filter((j) => j.owner === sid && j.status === 'active');
  return {
    optIn: optedIn(sid), poolSize: pool().size, max: MAX_CHANNELS_PER_USER, defaultEmojis: DEFAULT_EMOJIS,
    jobs: mine.map((j) => ({ id: j.id, name: j.name || j.jid, emojis: j.emojis, followers: Object.keys(j.followed || {}).length })),
  };
}

export async function addChannel(sid, link, emojisInput) {
  if (!getPremium(sid).active) throw new Error('Channel support is a 👑 premium feature.');
  const rec = sessions.get(sid);
  if (!connected(rec)) throw new Error('Your bot is offline right now. Try again in a minute.');
  const code = String(link || '').match(/whatsapp\.com\/channel\/([\w-]{10,})/i)?.[1] || String(link || '').trim().match(/^(0029V[\w-]{10,})$/)?.[1];
  if (!code) throw new Error('Send a WhatsApp channel link like https://whatsapp.com/channel/0029Va...');
  const list = jobs();
  if (list.filter((j) => j.owner === sid && j.status === 'active').length >= MAX_CHANNELS_PER_USER) throw new Error(`You can add up to ${MAX_CHANNELS_PER_USER} channel${MAX_CHANNELS_PER_USER === 1 ? '' : 's'}. Remove one first.`);
  let meta;
  try { meta = await rec.sock.newsletterMetadata('invite', code); } catch { throw new Error('That channel could not be found. Check the link.'); }
  if (!meta?.id) throw new Error('That channel could not be found. Check the link.');
  if (list.some((j) => j.jid === meta.id && j.status === 'active')) throw new Error('That channel is already added.');
  const emojis = cleanEmojis(emojisInput);
  list.push({
    id: crypto.randomBytes(6).toString('hex'), owner: sid, jid: meta.id, name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
    emojis: emojis.length ? emojis : DEFAULT_EMOJIS, status: 'active', followed: {}, last: 0, seeded: false, pending: [], created: Date.now(),
  });
  save(list);
  return boostSummary(sid);
}

/* ---------- admin: see every channel, pause everything, remove any channel ---------- */
export const isPaused = () => getSetting(G, 'boostPaused', false) === true;
export const setPaused = (v) => setSetting(G, 'boostPaused', !!v);
export function adminBoost(mask = (x) => x) {
  return {
    paused: isPaused(), poolSize: pool().size,
    jobs: jobs().map((j) => ({
      id: j.id, name: j.name || j.jid, owner: mask(sessions.get(j.owner)?.phone || ''), status: j.status,
      followers: Object.keys(j.followed || {}).length, emojis: j.emojis, premium: getPremium(j.owner).active,
    })),
  };
}
export function adminRemove(id) {
  const list = jobs();
  const job = list.find((j) => j.id === id && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  job.status = 'removing';
  save(list);
}

export function removeChannel(sid, id) {
  const list = jobs();
  const job = list.find((j) => j.id === id && j.owner === sid && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  job.status = 'removing'; // helper numbers unfollow in the next sweeps, then the job disappears
  save(list);
  return boostSummary(sid);
}

/* ---------- reading the channel's newest posts ---------- */
// Baileys changed these signatures between versions, so a few forms are tried; the first that returns posts wins.
const warned = new Set();
export async function fetchLatest(sock, jid) {
  const tries = [() => sock.newsletterFetchMessages('jid', jid, 8), () => sock.newsletterFetchMessages(jid, 8, 0)];
  let last;
  for (const t of tries) {
    try {
      const res = await t();
      const arr = Array.isArray(res) ? res : res?.messages || res?.data || [];
      const ids = arr.map((m) => Number(m?.server_id ?? m?.serverId ?? m?.key?.server_id ?? m?.attrs?.server_id ?? m?.id)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      if (ids.length) return ids;
      last = res;
    } catch (err) { last = err; }
  }
  if (!warned.has(jid)) { warned.add(jid); console.error(`Boost: could not read posts of ${jid}. Last result:`, last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)); }
  return [];
}

/* ---------- the worker ---------- */
let running = false;
export async function sweep() {
  if (running || isPaused()) return; // paused by the admin: nothing is followed, unfollowed or reacted to
  running = true;
  try {
    let list = jobs(), actions = 0, dirty = false;
    const members = pool();
    for (const job of list) {
      if (job.status === 'active' && !getPremium(job.owner).active) { job.status = 'removing'; dirty = true; } // premium ended
      job.followed ||= {}; job.pending ||= [];

      // 1. unfollow: channel removed, premium ended, or the number opted out
      for (const sid of Object.keys(job.followed)) {
        if (job.status === 'active' && members.has(sid)) continue;
        const rec = sessions.get(sid);
        if (!rec) { delete job.followed[sid]; dirty = true; continue; } // number is gone for good
        if (!connected(rec)) continue;                                  // offline: do it when it is back
        if (actions >= MAX_ACTIONS) break;
        try { await rec.sock.newsletterUnfollow(job.jid); } catch (err) { console.error('Boost unfollow:', err?.message || err); }
        delete job.followed[sid]; dirty = true; actions++; await gap();
      }
      if (job.status === 'removing') { if (!Object.keys(job.followed).length) job.gone = true; continue; }

      // 2. follow
      for (const [sid, sock] of members) {
        if (job.followed[sid]) continue;
        if (actions >= MAX_ACTIONS) break;
        try { await sock.newsletterFollow(job.jid); job.followed[sid] = Date.now(); dirty = true; }
        catch (err) {
          const msg = String(err?.message || err);
          if (/already|subscri/i.test(msg)) { job.followed[sid] = Date.now(); dirty = true; } else console.error(`Boost follow failed (${sid.slice(0, 6)}):`, msg);
        }
        actions++; await gap();
      }

      // 3. look for new posts (the first look only remembers what is already there)
      const reader = [...Object.keys(job.followed)].map((s) => members.get(s)).find(Boolean) || members.values().next().value;
      if (reader) {
        const ids = await fetchLatest(reader, job.jid);
        if (ids.length) {
          if (!job.seeded) { job.last = ids.at(-1); job.seeded = true; dirty = true; }
          else {
            const fresh = ids.filter((n) => n > job.last).slice(-3);
            for (const id of fresh) job.pending.push({ id, at: Date.now(), done: {} });
            if (fresh.length) { job.last = ids.at(-1); dirty = true; }
          }
        }
      }

      // 4. react (every follower once per post)
      job.pending = job.pending.filter((p) => Date.now() - p.at < PENDING_MAX_AGE);
      for (const post of job.pending) {
        for (const sid of Object.keys(job.followed)) {
          if (post.done[sid] || !members.has(sid)) continue;
          if (actions >= MAX_ACTIONS) break;
          const emoji = job.emojis[crypto.randomInt(job.emojis.length)];
          try { await members.get(sid).newsletterReactMessage(job.jid, String(post.id), emoji); }
          catch (err) { console.error(`Boost react failed (${sid.slice(0, 6)}):`, err?.message || err); }
          post.done[sid] = 1; dirty = true; actions++; await gap(); // marked even on failure: no endless retries
        }
      }
      job.pending = job.pending.filter((p) => Object.keys(job.followed).some((sid) => !p.done[sid] && members.has(sid)));
    }
    list = list.filter((j) => !j.gone);
    if (dirty || list.length !== jobs().length) save(list);
  } catch (err) { console.error('Boost sweep error:', err?.message || err); }
  finally { running = false; }
}

if (!globalThis.__rioBoostTimer && process.env.BOOST_DISABLED !== 'true') {
  globalThis.__rioBoostTimer = true;
  setInterval(() => sweep(), POLL_MS).unref?.();
}
