// .leaderboard  -> the most active members of this group (counts their messages).
//   .leaderboard            all time          .leaderboard today
//   .leaderboard week       last 7 days       .leaderboard month   last 30 days
//   .leaderboard me         your own count    .leaderboard reset   (group admins) start again from zero
// Counting starts when this file is installed. It hooks into every connected number by itself, no other file needs to change.
// Counts are saved with the session settings, so they survive restarts.
import { PREFIX, TIMEZONE, jidNum, sessions } from '../lib/config.js';
import { getSetting, setSetting } from '../lib/storage.js';
import { adminGuard } from '../lib/groups.js';
import { say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const KEY = 'leaderboard'; // { [groupJid]: { since: ms, users: { [number]: { jid, name, n, d: { 'YYYY-MM-DD': count } } } } }
const KEEP_DAYS = 31;
const TOP = 10;
const SKIP = new Set(['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage', 'encReactionMessage']);

/* ---------- in-memory data, written to the settings store at most every 30 seconds ---------- */
const data = new Map();   // sessionId -> { [groupJid]: {...} }
const dirty = new Set();  // sessionIds with unsaved changes
const load = (sid) => { if (!data.has(sid)) data.set(sid, structuredClone(getSetting(sid, KEY, {}))); return data.get(sid); };
const flush = () => { for (const sid of dirty) setSetting(sid, KEY, data.get(sid)); dirty.clear(); };
setInterval(flush, 30 * 1000).unref();
process.once('beforeExit', flush);

/* ---------- date helpers ---------- */
const dayOf = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const lastDays = (n) => Array.from({ length: n }, (_, i) => dayOf(Date.now() - i * 86400000));

/* ---------- counting ---------- */
const seen = new Set(); // recent message ids, so a message that WhatsApp delivers twice is counted once
function count(sid, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us') || msg.key.fromMe || !msg.message) return;
  const kinds = Object.keys(unwrapMessage(msg.message));
  if (!kinds.some((k) => !SKIP.has(k))) return;
  const id = `${sid}:${msg.key.id}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 3000) seen.delete(seen.values().next().value);

  const alt = msg.key.participantAlt;
  const who = alt && !String(alt).endsWith('@lid') ? alt : msg.key.participant; // prefer the phone number over a LID
  if (!who) return;
  const num = jidNum(who);

  const groups = load(sid);
  const g = (groups[jid] ||= { since: Date.now(), users: {} });
  const u = (g.users[num] ||= { jid: who, name: '', n: 0, d: {} });
  u.jid = who;
  if (msg.pushName) u.name = msg.pushName;
  u.n += 1;
  const day = dayOf();
  u.d[day] = (u.d[day] || 0) + 1;
  if (Object.keys(u.d).length > KEEP_DAYS) { // forget the oldest days
    for (const k of Object.keys(u.d).sort().slice(0, Object.keys(u.d).length - KEEP_DAYS)) delete u.d[k];
  }
  dirty.add(sid);
}

// Attach to every connected number (a new socket appears after each reconnect, so this keeps checking).
const hooked = new WeakSet();
setInterval(() => {
  for (const [sid, rec] of sessions) {
    const sock = rec?.sock;
    if (!sock?.ev || hooked.has(sock)) continue;
    hooked.add(sock);
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) { try { count(sid, m); } catch (err) { console.error('Leaderboard count error:', err?.message || err); } }
    });
  }
}, 5 * 1000).unref();

/* ---------- command ---------- */
const PERIODS = {
  all: { label: 'All time', days: 0 }, today: { label: 'Today', days: 1 },
  week: { label: 'Last 7 days', days: 7 }, month: { label: 'Last 30 days', days: 30 },
};
const ALIASES = { alltime: 'all', total: 'all', day: 'today', daily: 'today', weekly: 'week', monthly: 'month' };
const MEDAL = ['🥇', '🥈', '🥉'];
const score = (u, days) => (days === 0 ? u.n : lastDays(days).reduce((s, d) => s + (u.d[d] || 0), 0));

export default [
  {
    name: 'leaderboard', aliases: ['lb', 'top', 'active', 'topmembers'],
    async run(c) {
      if (!c.jid.endsWith('@g.us')) return c.reply('👥 This command only works in groups.');
      const arg = (c.args[0] || 'all').toLowerCase();
      const groups = load(c.sessionId);

      if (arg === 'reset') {
        const g = await adminGuard(c, { botAdmin: false });
        if (!g) return;
        delete groups[c.jid]; dirty.add(c.sessionId); flush();
        return c.reply('✅ Leaderboard reset. Counting starts again from now.');
      }

      const g = groups[c.jid];
      if (!g || !Object.keys(g.users).length) return c.reply('📊 No messages counted yet. The leaderboard fills up as members chat. Try again in a bit.');

      if (arg === 'me') {
        const num = jidNum(c.msg.key.participantAlt && !String(c.msg.key.participantAlt).endsWith('@lid') ? c.msg.key.participantAlt : c.msg.key.participant);
        const me = g.users[num];
        if (!me) return c.reply('📊 I have not counted any messages from you yet.');
        const ranked = Object.entries(g.users).sort((a, b) => b[1].n - a[1].n);
        const pos = ranked.findIndex(([k]) => k === num) + 1;
        return c.reply(`📊 *Your stats*\n🏅 Rank: #${pos} of ${ranked.length}\n💬 All time: ${me.n}\n📅 Today: ${score(me, 1)}\n🗓️ Last 7 days: ${score(me, 7)}`);
      }

      const key = PERIODS[arg] ? arg : ALIASES[arg];
      if (!key) return c.reply(`Usage:\n${PREFIX}leaderboard · ${PREFIX}leaderboard today · week · month\n${PREFIX}leaderboard me\n${PREFIX}leaderboard reset (admins)`);
      const { label, days } = PERIODS[key];

      const rows = Object.values(g.users).map((u) => ({ u, s: score(u, days) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
      if (!rows.length) return c.reply(`📊 Nobody has sent a message yet (${label.toLowerCase()}).`);
      const total = rows.reduce((s, r) => s + r.s, 0);
      const top = rows.slice(0, TOP);
      const lines = top.map((r, i) => `${MEDAL[i] || `*${i + 1}.*`} @${jidNum(r.u.jid)}  —  *${r.s}* msgs`);
      const since = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: TIMEZONE }).format(new Date(g.since));
      const text = [
        `╭━━━〔 🏆 *LEADERBOARD* 〕━━━⬣`,
        `┃ 📅 ${label}`,
        `┃ 💬 ${total} messages · 👥 ${rows.length} active`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        '',
        ...lines,
        '',
        `_Counting since ${since}_`,
        `${PREFIX}leaderboard today / week / month / me`
      ].join('\n');
      return say(c.sock, c.jid, text, c.msg, { mentions: top.map((r) => r.u.jid) });
    },
  },
];
