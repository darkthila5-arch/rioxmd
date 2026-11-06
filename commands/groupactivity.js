// .inactive [days]  -> members who wrote NOTHING in the last N days (default 7, up to 30)      (group admins)
// .listonline       -> members who are online right now                                          (group admins)
//
// .active already exists: it is an alias of .leaderboard (most active members), so it is not defined here again.
//
// .inactive uses the counts of commands/leaderboard.js (read from the saved group data, no second counter is needed).
//   - Counting starts when the leaderboard file was installed, so "inactive" is only reliable after that many days.
//   - Members the bot never saw writing are listed as inactive too.
//   - Nothing is deleted or kicked. Add the word `tag` to mention them:  .inactive 14 tag
//
// .listonline asks WhatsApp for the presence of every member for a few seconds. WhatsApp only answers for members whose
// privacy setting lets this number see their "online" status, so the result is a minimum, never a full list.
// While it runs the bot account shows as online for a moment (unless "always online" is already on).
import { PREFIX, TIMEZONE, jidNum, sleep } from '../lib/config.js';
import { getSetting } from '../lib/storage.js';
import { adminGuard } from '../lib/groups.js';
import { say } from '../lib/card.js';

const KEEP_DAYS = 30;          // the leaderboard keeps 31 days of daily counts
const SHOW_MAX = 40;           // names shown in one message
const ONLINE_MAX = 200;        // members checked by .listonline
const ONLINE_GAP_MS = 60;      // pause between two presence requests (keeps WhatsApp calm)
const ONLINE_WAIT_MS = 6000;   // wait for the answers after the last request
const ONLINE_COOLDOWN_MS = 60 * 1000;

const dayOf = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const dateText = (t) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: TIMEZONE }).format(new Date(t));

// every id a member can have (phone JID, LID ...) as plain numbers
const idsOf = (p) => [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(jidNum);
const isPhoneJid = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));
const phoneOf = (p) => [p?.phoneNumber, p?.jid, p?.id].find(isPhoneJid);
const botIds = (sock) => [sock.user?.id, sock.user?.lid, sock.user?.jid].filter(Boolean).map(jidNum);
const isAdminP = (p) => p?.admin === 'admin' || p?.admin === 'superadmin';
const mentionJid = (p) => phoneOf(p) || p.id;
const label = (p, rec) => {
  const ph = phoneOf(p);
  return ph ? `+${jidNum(ph)}${rec?.name ? ` (${rec.name})` : ''}` : (rec?.name || 'member (hidden number)');
};
const onlyGroup = async (c) => (c.jid.endsWith('@g.us') ? true : (await c.reply('👥 This command only works in groups.'), false));

/* ---------------- .inactive ---------------- */
async function inactive(c) {
  if (!(await onlyGroup(c))) return;
  const g = await adminGuard(c, { botAdmin: false });
  if (!g) return;

  const tag = c.args.some((a) => a.toLowerCase() === 'tag');
  const numArg = c.args.find((a) => /^\d+$/.test(a));
  const days = Math.min(KEEP_DAYS, Math.max(1, Number(numArg || 7)));

  const rec = getSetting(c.sessionId, 'leaderboard', {})[c.jid];
  if (!rec?.users || !Object.keys(rec.users).length) {
    return c.reply(`📊 I have not counted any messages in this group yet, so I cannot tell who is inactive.\nTry again after members have chatted for a few days.`);
  }
  const recent = new Set(Array.from({ length: days }, (_, i) => dayOf(Date.now() - i * 86400000)));
  const me = botIds(c.sock);

  const quiet = [];
  for (const p of g.meta.participants) {
    const ids = idsOf(p);
    if (ids.some((n) => me.includes(n))) continue;
    const users = ids.map((n) => rec.users[n]).filter(Boolean); // the same person can be stored under a phone number or a LID
    const wrote = users.some((u) => Object.keys(u.d || {}).some((d) => recent.has(d)));
    if (wrote) continue;
    const last = users.flatMap((u) => Object.keys(u.d || {})).sort().pop() || null;
    quiet.push({ p, name: users.find((u) => u.name)?.name || '', last });
  }

  const total = g.meta.participants.length;
  if (!quiet.length) return c.reply(`✅ Everybody in this group wrote something in the last ${days} day${days > 1 ? 's' : ''}. 🎉`);

  quiet.sort((a, b) => (a.last || '').localeCompare(b.last || '')); // the quietest first (never seen = first)
  const shown = quiet.slice(0, SHOW_MAX);
  const lines = shown.map((q, i) => `${i + 1}. ${isAdminP(q.p) ? '👮 ' : ''}${tag ? `@${jidNum(mentionJid(q.p))}` : label(q.p, q)} — ${q.last ? `last seen writing ${q.last}` : 'never seen writing'}`);
  const ageDays = Math.floor((Date.now() - (rec.since || Date.now())) / 86400000);
  const warn = ageDays < days ? `\n⚠️ I only started counting ${ageDays} day${ageDays === 1 ? '' : 's'} ago (${dateText(rec.since)}), so some of these may just not have been seen yet.` : '';

  const text = [
    '╭━━━〔 😴 *INACTIVE MEMBERS* 〕━━━⬣',
    `┃ 📅 No message in the last ${days} day${days > 1 ? 's' : ''}`,
    `┃ 👥 ${quiet.length} of ${total} members`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    ...lines,
    ...(quiet.length > shown.length ? ['', `_…and ${quiet.length - shown.length} more_`] : []),
    '',
    `_Counting since ${dateText(rec.since)}._${warn}`,
    `${PREFIX}inactive <days> · add *tag* to mention them`,
  ].join('\n');
  return say(c.sock, c.jid, text, c.msg, tag ? { mentions: shown.map((q) => mentionJid(q.p)) } : {});
}

/* ---------------- .listonline ---------------- */
const busy = new Map(); // group jid -> time of the last run
const ONLINE_STATES = new Set(['available', 'composing', 'recording']);

async function listOnline(c) {
  if (!(await onlyGroup(c))) return;
  const g = await adminGuard(c, { botAdmin: false });
  if (!g) return;
  const { sock, jid, sessionId } = c;

  const last = busy.get(`${sessionId}:${jid}`) || 0;
  if (Date.now() - last < ONLINE_COOLDOWN_MS) return c.reply('⏳ I just checked this group. Try again in a minute.');
  busy.set(`${sessionId}:${jid}`, Date.now());

  const me = botIds(sock);
  const members = g.meta.participants.filter((p) => !idsOf(p).some((n) => me.includes(n)));
  const checked = members.slice(0, ONLINE_MAX);
  const byId = new Map(); // any id number -> member
  for (const p of checked) for (const n of idsOf(p)) byId.set(n, p);

  await c.reply(`🔎 Checking ${checked.length} member${checked.length === 1 ? '' : 's'}… this takes about ${Math.ceil((checked.length * ONLINE_GAP_MS + ONLINE_WAIT_MS) / 1000)} seconds.`);

  const online = new Map(); // member id -> { p, state }
  const onPresence = (u) => {
    for (const [j, v] of Object.entries(u?.presences || {})) {
      const p = byId.get(jidNum(j));
      if (p && ONLINE_STATES.has(v?.lastKnownPresence)) online.set(p.id, { p, state: v.lastKnownPresence });
    }
  };
  const keepOnline = getSetting(sessionId, 'alwaysOnline', false);
  sock.ev.on('presence.update', onPresence);
  try {
    if (!keepOnline) await sock.sendPresenceUpdate('available').catch(() => {}); // WhatsApp sends presence only to an account that is online
    for (const p of checked) {
      await sock.presenceSubscribe(phoneOf(p) || p.id).catch(() => {});
      await sleep(ONLINE_GAP_MS);
    }
    await sleep(ONLINE_WAIT_MS);
  } finally {
    sock.ev.off('presence.update', onPresence);
    if (!keepOnline) sock.sendPresenceUpdate('unavailable').catch(() => {});
  }

  const list = [...online.values()];
  const rows = list.slice(0, SHOW_MAX).map(({ p, state }, i) => `${i + 1}. ${isAdminP(p) ? '👮 ' : ''}@${jidNum(mentionJid(p))}${state === 'composing' ? ' ✍️ typing' : state === 'recording' ? ' 🎙️ recording' : ''}`);
  const text = [
    '╭━━━〔 🟢 *ONLINE NOW* 〕━━━⬣',
    `┃ 🟢 ${list.length} online · 👥 ${checked.length} checked${members.length > checked.length ? ` (of ${members.length})` : ''}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    ...(rows.length ? rows : ['_Nobody could be seen online right now._']),
    ...(list.length > rows.length ? ['', `_…and ${list.length - rows.length} more_`] : []),
    '',
    '_Members who hide their "online" status from me cannot be detected, so the real number can be higher._',
  ].join('\n');
  return say(sock, jid, text, c.msg, { mentions: list.slice(0, SHOW_MAX).map(({ p }) => mentionJid(p)) });
}

export default [
  { name: 'inactive', aliases: ['inactives', 'quietmembers'], react: '😴', run: inactive },
  { name: 'listonline', aliases: ['online', 'onlinelist'], react: '🟢', run: listOnline },
];
