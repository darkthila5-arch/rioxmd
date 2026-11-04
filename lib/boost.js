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
const POLL_MS = Math.max(1, Number(process.env.BOOST_POLL_MIN || 1)) * 60 * 1000; // backup check (the live path below reacts within seconds)
const LIVE_MIN_S = Number(process.env.BOOST_LIVE_MIN_S ?? 3), LIVE_MAX_S = Number(process.env.BOOST_LIVE_MAX_S ?? 20); // each number waits a random 3-20 s before reacting
const LIVE_MAX_AGE_S = 10 * 60; // a post older than 10 minutes that arrives live (history) is not reacted to
const GAP_MS = Number(process.env.BOOST_GAP_MS ?? 4000);        // pause between two actions (random extra up to the same amount)
const MAX_ACTIONS = Number(process.env.BOOST_MAX_ACTIONS || 30); // follow / unfollow / react calls per sweep
const PENDING_MAX_AGE = 30 * 60 * 1000;                           // a post nobody reacted to within 30 min is dropped
export const DEFAULT_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏'];

// Emoji packs: when a channel is added the host / user picks one or more packs and the numbers react ONLY with emojis of those packs.
// Note: a channel admin can limit the allowed reactions in the channel settings. If a channel only allows WhatsApp's default
// reactions, packs such as fruits are refused by WhatsApp for that channel (the react call fails, nothing else breaks).
export const EMOJI_PACKS = [
  { id: 'classic', name: 'Classic', icon: '👍', emojis: ['👍', '❤️', '😂', '😮', '🙏'] },
  { id: 'hearts', name: 'Hearts', icon: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💕'] },
  { id: 'faces', name: 'Faces', icon: '😍', emojis: ['😂', '😍', '😮', '🥰', '😎', '🤩', '😘', '🥳', '😭', '🤣'] },
  { id: 'fruits', name: 'Fruits', icon: '🍓', emojis: ['🍎', '🍌', '🍓', '🍉', '🍒', '🍍', '🥭', '🍇', '🍑', '🍊'] },
  { id: 'fire', name: 'Hype', icon: '🔥', emojis: ['🔥', '💯', '⚡', '🎉', '👏', '💥', '🚀', '✨'] },
  { id: 'hands', name: 'Hands', icon: '🙌', emojis: ['👍', '👏', '🙌', '🙏', '💪', '🤝', '👌', '✌️'] },
  { id: 'animals', name: 'Animals', icon: '🐶', emojis: ['🐶', '🐱', '🦁', '🐼', '🦋', '🐯', '🐵', '🐧'] },
  { id: 'flowers', name: 'Flowers', icon: '🌹', emojis: ['🌹', '🌸', '🌻', '🌺', '🌷', '🌈', '🌙', '⭐'] },
];
const PACK_IDS = new Set(EMOJI_PACKS.map((p) => p.id));
const PACK_EMOJI_SET = new Set(EMOJI_PACKS.flatMap((p) => p.emojis));
export const customOf = (j) => (j.emojis || []).filter((e) => !PACK_EMOJI_SET.has(e)); // emojis of a channel that do not come from a pack (typed by hand)
export const cleanPacks = (input) => [...new Set((Array.isArray(input) ? input : String(input || '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => PACK_IDS.has(x)))].slice(0, 8);
// packs (ids) + optional own emojis -> the final list a channel reacts with. Nothing chosen = the default list.
export function resolveEmojis(packIds, custom) {
  const fromPacks = cleanPacks(packIds).flatMap((id) => EMOJI_PACKS.find((p) => p.id === id).emojis);
  const all = [...new Set([...fromPacks, ...cleanEmojis(custom, 12)])];
  return all.length ? all : DEFAULT_EMOJIS;
}

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

// Every connected number (used by admin channels set to "all online numbers").
export function allConnected() {
  const m = new Map();
  for (const [sid, rec] of sessions) if (connected(rec)) m.set(sid, rec.sock);
  return m;
}

export function cleanEmojis(input, max = 6) {
  const list = (Array.isArray(input) ? input : String(input || '').split(/\s+/)).map((e) => String(e).trim()).filter((e) => e && e.length <= 8 && /\p{Extended_Pictographic}/u.test(e));
  return [...new Set(list)].slice(0, max);
}

/* ---------- used by the web routes ---------- */
export function boostSummary(sid) {
  const mine = jobs().filter((j) => j.owner === sid && j.status === 'active');
  return {
    optIn: optedIn(sid), poolSize: pool().size, max: MAX_CHANNELS_PER_USER, defaultEmojis: DEFAULT_EMOJIS, packs: EMOJI_PACKS,
    jobs: mine.map((j) => ({ id: j.id, name: j.name || j.jid, emojis: j.emojis, packs: j.packs || [], custom: customOf(j), followers: Object.keys(j.followed || {}).length })),
  };
}

export async function addChannel(sid, link, emojisInput, packsInput) {
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
  const packs = cleanPacks(packsInput);
  list.push({
    id: crypto.randomBytes(6).toString('hex'), owner: sid, jid: meta.id, name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
    packs, emojis: resolveEmojis(packs, emojisInput), status: 'active', followed: {}, last: 0, seeded: false, pending: [], created: Date.now(),
  });
  save(list);
  return boostSummary(sid);
}

/* ---------- admin: add a channel that the numbers follow and react to ---------- */
// scope 'all'   = every connected number follows + reacts (the admin decides, no premium needed)
// scope 'optin' = only numbers whose owner switched on "Support other channels"
export const MAX_ADMIN_CHANNELS = 20;
// Change the emoji packs of a channel that is already added (from the web). Only the reaction list changes, follow / post state stays.
function setPacks(job, packsInput, emojisInput) {
  job.packs = cleanPacks(packsInput);
  job.emojis = resolveEmojis(job.packs, emojisInput);
}
export function adminSetPacks(id, packsInput, emojisInput) {
  const list = jobs(), job = list.find((j) => j.id === id && j.admin && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  setPacks(job, packsInput, emojisInput); save(list);
}
export function setChannelPacks(sid, id, packsInput, emojisInput) {
  const list = jobs(), job = list.find((j) => j.id === id && j.owner === sid && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  setPacks(job, packsInput, emojisInput); save(list);
  return boostSummary(sid);
}

export async function addAdminChannel(link, emojisInput, scope = 'all', autoReact = true, packsInput = []) {
  const rec = [...sessions.values()].find(connected);
  if (!rec) throw new Error('No number is online right now, so the channel cannot be looked up. Try again in a minute.');
  const code = String(link || '').match(/whatsapp\.com\/channel\/([\w-]{10,})/i)?.[1] || String(link || '').trim().match(/^(0029V[\w-]{10,})$/)?.[1];
  if (!code) throw new Error('Send a WhatsApp channel link like https://whatsapp.com/channel/0029Va...');
  const list = jobs();
  if (list.filter((j) => j.admin && j.status === 'active').length >= MAX_ADMIN_CHANNELS) throw new Error(`You can add up to ${MAX_ADMIN_CHANNELS} admin channels. Remove one first.`);
  let meta;
  try { meta = await rec.sock.newsletterMetadata('invite', code); } catch { throw new Error('That channel could not be found. Check the link.'); }
  if (!meta?.id) throw new Error('That channel could not be found. Check the link.');
  if (list.some((j) => j.jid === meta.id && j.status === 'active')) throw new Error('That channel is already added.');
  const packs = cleanPacks(packsInput);
  list.push({
    id: crypto.randomBytes(6).toString('hex'), owner: '_admin', admin: true, scope: scope === 'optin' ? 'optin' : 'all', autoReact: autoReact !== false, jid: meta.id,
    name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
    packs, emojis: resolveEmojis(packs, emojisInput), status: 'active', followed: {}, last: 0, seeded: false, pending: [], created: Date.now(),
  });
  save(list);
  setTimeout(() => sweep(), 1500).unref?.(); // start following now instead of waiting for the next check
}

// "Check" button in /admin: shows exactly what WhatsApp / Baileys answers for this channel, so a problem can be seen instead of guessed.
export async function adminCheck(id) {
  const job = jobs().find((j) => j.id === id && j.admin && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  const members = job.scope === 'all' ? allConnected() : pool();
  const rep = { channel: job.name || job.jid, autoReact: job.autoReact !== false, paused: isPaused(), numbersOnline: members.size, following: Object.keys(job.followed || {}).length, lastSeenPost: job.last || null, diag: job.diag || null, tries: [] };
  const sock = members.values().next().value || [...sessions.values()].find(connected)?.sock;
  if (!sock) { rep.error = 'No number is online.'; return rep; }
  const cut = (v) => { try { return JSON.stringify(v)?.slice(0, 350); } catch { return String(v).slice(0, 350); } };
  const sig = [['(jid, 8, 0)', () => sock.newsletterFetchMessages(job.jid, 8, 0)], ["('jid', jid, 8)", () => sock.newsletterFetchMessages('jid', job.jid, 8)]];
  for (const [name, fn] of sig) {
    try { const res = await fn(); rep.tries.push({ call: name, ids: collectIds(res).slice(-5), raw: cut(res) }); }
    catch (err) { rep.tries.push({ call: name, error: String(err?.message || err).slice(0, 200) }); }
  }
  try { rep.liveUpdates = cut(await sock.subscribeNewsletterUpdates?.(job.jid)) ?? 'not available in this Baileys'; } catch (err) { rep.liveUpdates = `error: ${String(err?.message || err).slice(0, 200)}`; }
  return rep;
}

// Per channel: react to every new post automatically (on) or only follow it (off). Turning it back on starts from the newest post.
export function adminSetAuto(id, on) {
  const list = jobs();
  const job = list.find((j) => j.id === id && j.admin && j.status === 'active');
  if (!job) throw new Error('Channel not found.');
  job.autoReact = !!on;
  if (on) { job.seeded = false; job.pending = []; } // do not react to posts that appeared while it was off
  save(list);
}

// React to ONE post (link like https://whatsapp.com/channel/0029Va.../123) with every online number (or only the opted-in ones).
// Runs in the background, one number at a time with a pause between them; progress is shown in adminBoost().reactRun.
let reactRun = null; // { running, ok, failed, total, at, post }
export async function reactToPost(link, emojisInput, scope = 'all', follow = true, packsInput = []) {
  if (reactRun?.running) throw new Error('A post reaction is still running. Wait until it finishes.');
  if (isPaused()) throw new Error('Channel support is paused. Resume it on the Overview tab first.');
  const code = String(link || '').match(/whatsapp\.com\/channel\/([\w-]{10,})\/(\d+)/i);
  if (!code) throw new Error('Send a POST link like https://whatsapp.com/channel/0029Va.../123 (open the post in WhatsApp, copy its link).');
  const [, inv, postId] = code;
  const first = [...sessions.values()].find(connected);
  if (!first) throw new Error('No number is online right now. Try again in a minute.');
  let meta;
  try { meta = await first.sock.newsletterMetadata('invite', inv); } catch { throw new Error('That channel could not be found. Check the link.'); }
  if (!meta?.id) throw new Error('That channel could not be found. Check the link.');
  const members = scope === 'optin' ? pool() : allConnected();
  if (!members.size) throw new Error(scope === 'optin' ? 'No online number has switched on "Support other channels".' : 'No number is online right now.');
  const list = resolveEmojis(packsInput, emojisInput);
  const run = reactRun = { running: true, ok: 0, failed: 0, total: members.size, at: Date.now(), post: `${String(meta.name || '').slice(0, 40) || 'channel'} #${postId}` };
  (async () => {
    for (const [sid, sock] of members) {
      try {
        if (follow) { try { await sock.newsletterFollow(meta.id); } catch { /* already following (or it will fail below) */ } }
        await sock.newsletterReactMessage(meta.id, String(postId), list[crypto.randomInt(list.length)]);
        run.ok++;
      } catch (err) { run.failed++; console.error(`React to post failed (${sid.slice(0, 6)}):`, err?.message || err); }
      await gap();
    }
    run.running = false;
  })().catch((err) => { run.running = false; console.error('React to post error:', err?.message || err); });
  return { ...run };
}

/* ---------- vote on a channel poll ---------- */
// Admin pastes a poll POST link -> the page shows the poll options -> admin picks one option, how many numbers vote and which
// numbers -> that many numbers (random, each only once) vote for the option, one by one with a pause.
// NOTE: Baileys has no ready made "vote in a channel poll" function. sendPollVote() below builds the vote message by hand and is the
// ONLY place to change if WhatsApp / Baileys needs a different format. Start with 1 vote to test it on your Baileys version.
let pollRun = null; // { running, ok, failed, total, at, post, option }
const sha256 = (t) => crypto.createHash('sha256').update(Buffer.from(String(t), 'utf8')).digest();
function walk(x, test, depth = 0) { // first nested object / BinaryNode for which test() is true
  if (!x || typeof x !== 'object' || depth > 10 || x instanceof Uint8Array) return null;
  try { if (test(x)) return x; } catch { /* ignore */ }
  for (const k of Object.keys(x)) { const r = walk(x[k], test, depth + 1); if (r) return r; }
  return null;
}
const POLL_KEYS = ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV4', 'pollCreationMessageV5'];
function shape(x, depth = 0) { // short description of what WhatsApp answered (tags / attrs / sizes), for the admin page and the logs
  if (x == null || typeof x !== 'object') return String(x).slice(0, 40);
  if (x instanceof Uint8Array) return `bytes(${x.length})`;
  if (Array.isArray(x)) return depth > 5 ? '[…]' : `[${x.slice(0, 6).map((v) => shape(v, depth + 1)).join(',')}${x.length > 6 ? ',…' : ''}]`;
  if (x.tag) return `<${x.tag}${x.attrs?.server_id ? ` #${x.attrs.server_id}` : ''}>${depth > 5 ? '' : shape(x.content, depth + 1)}`;
  return depth > 5 ? '{…}' : `{${Object.keys(x).slice(0, 8).join(',')}}`;
}
async function readPoll(sock, chanJid, inv, postId) {
  const after = Math.max(0, Number(postId) - 1);
  const tries = [
    () => sock.newsletterFetchMessages('invite', inv, 10, after), () => sock.newsletterFetchMessages('jid', chanJid, 10, after),
    () => sock.newsletterFetchMessages(chanJid, 10, 0, after), () => sock.newsletterFetchMessages(chanJid, 10, 0),
  ];
  let proto = null; try { ({ proto } = await import('@whiskeysockets/baileys')); } catch { /* decoded objects still work */ }
  const diag = [];
  for (const [i, t] of tries.entries()) {
    let res; try { res = await t(); } catch (err) { diag.push(`#${i + 1} error: ${String(err?.message || err).slice(0, 80)}`); continue; }
    const post = walk(res, (n) => String(n?.attrs?.server_id ?? n?.server_id ?? '') === String(postId) && (n.tag === 'message' || n.content || n.message));
    if (!post) { diag.push(`#${i + 1} post not in answer: ${shape(res).slice(0, 160)}`); continue; }
    let poll = null;
    const decoded = walk(post, (n) => POLL_KEYS.some((k) => n[k]));
    if (decoded) poll = POLL_KEYS.map((k) => decoded[k]).find(Boolean);
    if (!poll && proto) {
      const plain = walk(post, (n) => n.tag === 'plaintext' && n.content);
      if (plain) { try { const m = proto.Message.decode(Buffer.from(plain.content)); poll = POLL_KEYS.map((k) => m[k]).find(Boolean); } catch { /* not a poll */ } }
    }
    if (poll?.options?.length) return { question: String(poll.name || '').slice(0, 300), options: poll.options.map((o) => String(o.optionName || '')).filter(Boolean) };
    diag.push(`#${i + 1} post found but no poll inside: ${shape(post).slice(0, 160)}`);
  }
  console.error(`Poll read failed for ${chanJid} #${postId}: ${diag.join(' | ').slice(0, 900)}`);
  return { unreadable: true, diag: diag.join(' | ').slice(0, 500) };
}
export async function loadPoll(link) {
  const code = String(link || '').match(/whatsapp\.com\/channel\/([\w-]{10,})\/(\d+)/i);
  if (!code) throw new Error('Send the POLL post link like https://whatsapp.com/channel/0029Va.../123 (open the poll in WhatsApp, copy its link).');
  const [, inv, postId] = code;
  const first = [...sessions.values()].find(connected);
  if (!first) throw new Error('No number is online right now. Try again in a minute.');
  let meta;
  try { meta = await first.sock.newsletterMetadata('invite', inv); } catch { throw new Error('That channel could not be found. Check the link.'); }
  if (!meta?.id) throw new Error('That channel could not be found. Check the link.');
  const poll = await readPoll(first.sock, meta.id, inv, postId);
  return { jid: meta.id, channel: String(meta.name || '').slice(0, 60) || 'channel', postId: String(postId), ...poll, online: allConnected().size, optin: pool().size };
}
export async function sendPollVote(sock, chanJid, postId, optionName) {
  const message = { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: chanJid, fromMe: false, id: String(postId) }, vote: { selectedOptions: [sha256(optionName)] }, senderTimestampMs: Date.now() } };
  const messageId = `3EB0${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  await sock.relayMessage(chanJid, message, { messageId, additionalAttributes: { server_id: String(postId) }, additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }] });
}
export async function votePoll(link, optionIndex, count, scope = 'all', follow = true, optionText = '') {
  if (pollRun?.running) throw new Error('A poll vote is still running. Wait until it finishes.');
  if (isPaused()) throw new Error('Channel support is paused. Resume it on the Overview tab first.');
  const poll = await loadPoll(link);
  let option;
  if (poll.unreadable) { // the options could not be read: the admin typed the option text exactly as it is in the poll
    option = String(optionText || '').trim().slice(0, 100);
    if (!option) throw new Error('Type the option text exactly as it is in the poll.');
  } else {
    const idx = Number(optionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) throw new Error('Pick one of the poll options.');
    option = poll.options[idx];
  }
  const members = scope === 'optin' ? pool() : allConnected();
  if (!members.size) throw new Error(scope === 'optin' ? 'No online number has switched on "Support other channels".' : 'No number is online right now.');
  const n = Math.min(members.size, Math.max(1, Math.floor(Number(count)) || 0));
  const chosen = [...members]; // random n numbers, every number votes at most once
  for (let i = chosen.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
  chosen.length = n;
  const run = pollRun = { running: true, ok: 0, failed: 0, total: n, at: Date.now(), post: `${poll.channel} #${poll.postId}`, option: option.slice(0, 60) };
  (async () => {
    for (const [sid, sock] of chosen) {
      try {
        if (follow) { try { await sock.newsletterFollow(poll.jid); } catch { /* already following */ } }
        await sendPollVote(sock, poll.jid, poll.postId, option);
        run.ok++;
      } catch (err) { run.failed++; console.error(`Poll vote failed (${sid.slice(0, 6)}):`, err?.message || err); }
      await gap();
    }
    run.running = false;
  })().catch((err) => { run.running = false; console.error('Poll vote error:', err?.message || err); });
  return { ...run };
}

/* ---------- auto follow / join for every new link ---------- */
// ON (default): a number that has just been linked follows the admin channels (scope "all") and the .autofollow / .autojoin targets by itself.
// OFF: only numbers whose owner switched on "Support other channels" are touched (the old rule); everybody else only gets the links.
export const welcomeAll = () => getSetting(G, 'welcomeAll', true) !== false;
export const setWelcomeAll = (v) => setSetting(G, 'welcomeAll', !!v);

// Called right after a number was linked: follow the admin channels now instead of waiting for the next sweep (the sweep would do it too).
// Returns the names of the channels followed. The react logic is unchanged: the number reacts to new posts with the emojis of that channel's packs.
export async function followAdminChannelsNow(sock, sid) {
  if (isPaused()) return [];
  const list = jobs(), names = [];
  let dirty = false;
  for (const job of list) {
    if (!job.admin || job.status !== 'active' || job.followed?.[sid]) continue;
    if (job.scope !== 'all' && !optedIn(sid)) continue;
    if (!welcomeAll() && !optedIn(sid)) continue;
    try { await sock.newsletterFollow(job.jid); }
    catch (err) { if (!/already|subscri/i.test(String(err?.message || err))) { console.error(`Welcome follow failed (${sid.slice(0, 6)}):`, err?.message || err); continue; } }
    job.followed ||= {}; job.followed[sid] = Date.now(); dirty = true;
    if (job.autoReact !== false) keepSubscribed(sid, sock, job.jid);
    names.push(job.name || 'our channel');
    await gap();
  }
  if (dirty) save(list);
  return names;
}

/* ---------- admin: see every channel, pause everything, remove any channel ---------- */
export const isPaused = () => getSetting(G, 'boostPaused', false) === true;
export const setPaused = (v) => setSetting(G, 'boostPaused', !!v);
export function adminBoost(mask = (x) => x) {
  return {
    paused: isPaused(), poolSize: pool().size, onlineSize: allConnected().size, reactRun: reactRun ? { ...reactRun } : null, pollRun: pollRun ? { ...pollRun } : null, packs: EMOJI_PACKS, welcomeAll: welcomeAll(),
    jobs: jobs().map((j) => ({
      id: j.id, name: j.name || j.jid, owner: j.admin ? '' : mask(sessions.get(j.owner)?.phone || ''), status: j.status,
      admin: !!j.admin, scope: j.scope || 'optin', autoReact: j.autoReact !== false, diag: j.diag || null,
      followers: Object.keys(j.followed || {}).length, emojis: j.emojis, packs: j.packs || [], custom: customOf(j), premium: j.admin ? true : getPremium(j.owner).active,
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
const warned = new Set(), okLogged = new Set(), fetchInfo = new Map(); // fetchInfo: channel jid -> short text of the last failed read (shown in /admin)
// Different Baileys versions return different shapes: a plain array, { messages: [...] }, a raw WhatsApp node
// ({ tag, attrs, content: [...] } with attrs.server_id on every <message>) or a GraphQL-like object. Walk the whole result and
// collect every server_id, whatever the shape.
function collectIds(x, out = [], depth = 0) {
  if (!x || typeof x !== 'object' || depth > 10) return out;
  if (Array.isArray(x)) { for (const i of x) collectIds(i, out, depth + 1); return out; }
  const n = Number(x.server_id ?? x.serverId ?? x.newsletter_server_id ?? x.attrs?.server_id ?? x.key?.server_id);
  if (Number.isFinite(n) && n > 0) out.push(n);
  for (const k of Object.keys(x)) if (k !== 'attrs' && x[k] && typeof x[k] === 'object') collectIds(x[k], out, depth + 1);
  return out;
}
export async function fetchLatest(sock, jid) {
  // Baileys changed this signature between versions: (type, key, count, after) and (jid, count, since, after). Both are tried.
  const tries = [() => sock.newsletterFetchMessages(jid, 8, 0), () => sock.newsletterFetchMessages('jid', jid, 8), () => sock.newsletterFetchMessages(jid, 8)];
  let last;
  for (const t of tries) {
    try {
      const res = await t();
      let ids = collectIds(res);
      if (!ids.length && Array.isArray(res)) ids = res.map((m) => Number(m?.id)).filter((n) => Number.isFinite(n) && n > 0); // plain list with only "id"
      ids = [...new Set(ids)].sort((a, b) => a - b);
      if (ids.length) {
        if (!okLogged.has(jid)) { okLogged.add(jid); console.log(`Boost: reading posts of ${jid} works (latest post #${ids.at(-1)}).`); }
        return ids;
      }
      last = res;
    } catch (err) { last = err; }
  }
  fetchInfo.set(jid, last instanceof Error ? `error: ${last.message}` : `unexpected result: ${JSON.stringify(last)}`);
  if (!warned.has(jid)) { warned.add(jid); console.error(`Boost: could not read posts of ${jid}. Last result:`, fetchInfo.get(jid).slice(0, 500)); }
  return [];
}

/* ---------- live: react as soon as a followed channel gets a new post ---------- */
// WhatsApp pushes new posts of followed channels to each linked number (messages.upsert with a @newsletter jid).
// session.js passes them here. Every number reacts by itself after a random pause, so the reactions are spread out.
const reacted = new Set(); // `${sid}|${channelJid}|${postId}`: a post is reacted to once per number (live path and backup check share this)
const markReacted = (k) => { reacted.add(k); if (reacted.size > 5000) for (const x of [...reacted].slice(0, 2500)) reacted.delete(x); };
const liveLogged = new Set();
const subscribedAt = new Map(); // `${sid}|${jid}` -> time of the last live-updates request

export async function handleChannelPost(sock, msg, sid) {
  const jid = msg?.key?.remoteJid;
  if (!jid || !jid.endsWith('@newsletter') || msg.key.fromMe || isPaused()) return;
  const postId = Number(msg.newsletter_server_id ?? msg.key?.server_id);
  if (!Number.isFinite(postId) || postId <= 0) return;
  const ts = Number(msg.messageTimestamp || 0);
  if (ts && Date.now() / 1000 - ts > LIVE_MAX_AGE_S) return; // old post delivered again: ignore
  const list = jobs();
  if (!liveLogged.has(jid) && list.some((j) => j.jid === jid)) { liveLogged.add(jid); console.log(`Boost: live post #${postId} of ${jid} received (live reactions work).`); }
  let dirty = false;
  for (const job of list) {
    if (job.jid !== jid || job.status !== 'active' || job.autoReact === false) continue;
    if (!job.admin && !getPremium(job.owner).active) continue;
    if (!job.admin && !job.followed?.[sid]) continue; // premium channels: only numbers that follow it through this feature react
    if (!(job.admin && job.scope === 'all') && !optedIn(sid)) continue;
    const key = `${sid}|${jid}|${postId}`;
    if (reacted.has(key)) continue;
    markReacted(key);
    if (postId > (job.last || 0)) { job.last = postId; dirty = true; } // the backup check will not queue this post again
    job.diag = { ...job.diag, liveAt: Date.now(), liveCount: (job.diag?.liveCount || 0) + 1 }; dirty = true;
    const emoji = job.emojis[crypto.randomInt(job.emojis.length)];
    const wait = (LIVE_MIN_S + Math.random() * Math.max(0, LIVE_MAX_S - LIVE_MIN_S)) * 1000;
    setTimeout(async () => {
      try { if (sessions.get(sid)?.sock === sock && !isPaused()) await sock.newsletterReactMessage(jid, String(postId), emoji); }
      catch (err) { console.error(`Live react failed (${sid.slice(0, 6)}):`, err?.message || err); }
    }, wait).unref?.();
  }
  if (dirty) save(list);
}

// Asks WhatsApp to keep sending live updates of a followed channel (best effort, renewed every 4 minutes).
async function keepSubscribed(sid, sock, jid) {
  const k = `${sid}|${jid}`;
  if (Date.now() - (subscribedAt.get(k) || 0) < 4 * 60 * 1000) return;
  subscribedAt.set(k, Date.now());
  try { await sock.subscribeNewsletterUpdates?.(jid); } catch { /* older Baileys or not allowed: the backup check still works */ }
}

/* ---------- the worker ---------- */
let running = false;
export async function sweep() {
  if (running || isPaused()) return; // paused by the admin: nothing is followed, unfollowed or reacted to
  running = true;
  try {
    let list = jobs(), actions = 0, dirty = false;
    const basePool = pool(), everyone = allConnected();
    for (const job of list) {
      const members = job.admin && job.scope === 'all' ? everyone : basePool; // admin channels can use every online number
      if (job.status === 'active' && !job.admin && !getPremium(job.owner).active) { job.status = 'removing'; dirty = true; } // premium ended (admin channels have no premium)
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
          if (/already|subscri/i.test(msg) || job.admin) { job.followed[sid] = Date.now(); dirty = true; } // admin channels: a follow error usually means "already following", so reacting is still tried
          if (!/already|subscri/i.test(msg)) { console.error(`Boost follow problem (${sid.slice(0, 6)}):`, msg); job.diag = { ...job.diag, followErr: msg.slice(0, 160) }; dirty = true; }
        }
        actions++; await gap();
      }

      if (job.status === 'active' && job.autoReact !== false) for (const sid of Object.keys(job.followed)) { const s = members.get(sid); if (s) keepSubscribed(sid, s, job.jid); }

      // 3. look for new posts (the first look only remembers what is already there)
      const reader = [...Object.keys(job.followed)].map((s) => members.get(s)).find(Boolean) || members.values().next().value;
      if (reader && job.autoReact !== false) { // autoReact off = only follow, never react to new posts
        const ids = await fetchLatest(reader, job.jid);
        job.diag = { ...job.diag, readAt: Date.now(), readOk: ids.length > 0, latest: ids.at(-1) || null, readInfo: ids.length ? undefined : fetchInfo.get(job.jid)?.slice(0, 300) }; dirty = true;
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
          const rk = `${sid}|${job.jid}|${post.id}`;
          if (reacted.has(rk)) { post.done[sid] = 1; dirty = true; continue; } // the live path already reacted
          if (actions >= MAX_ACTIONS) break;
          markReacted(rk);
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
