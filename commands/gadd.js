// .gadd (👑 premium, linked-number owner only): add many numbers to a group with this bot account.
//   In a private chat:   .gadd <group link> 94771234567, 94779876543, 0711112222
//   Inside the group:    .gadd 94771234567, 94779876543, 0711112222
// Add  "invite"  at the end to DM the group link to people whose privacy settings block adding.
// The bot account must be a member AND an admin of the group. Adds go one by one with a pause, because bursts get accounts restricted.
import { PREFIX, jidNum, sleep } from '../lib/config.js';
import { GAP_MAX_MS, GAP_MIN_MS, MAX_PER_HOUR, MAX_PER_RUN, buildSummary, classify, parseGroupCode, parseNumbers } from '../lib/bulkadd.js';

const DEFAULT_CC = (process.env.DEFAULT_COUNTRY_CODE || '94').replace(/\D/g, '');
const running = new Set();      // sessions that have a bulk add running right now
const hourly = new Map();       // sessionId -> { n, reset }
const pause = () => sleep(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));

const idsOf = (p) => [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(jidNum);
const isAdminP = (p) => p?.admin === 'admin' || p?.admin === 'superadmin';

function usage(p = PREFIX) {
  return [
    '╭━━━〔 ➕ *BULK ADD* 〕━━━⬣',
    '┃ 👑 Premium • add many numbers to a group',
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `*In inbox* (private chat with me):`,
    `${p}gadd <group link> 94771234567, 94779876543, 0711112222`,
    '',
    '*Inside the group:*',
    `${p}gadd 94771234567, 94779876543, 0711112222`,
    '',
    `• Separate numbers with commas. Country code needed (0771234567 is read as +${DEFAULT_CC}...).`,
    `• Up to ${MAX_PER_RUN} numbers per command, added slowly one by one (about 4 s each).`,
    '• This number must be a *member and admin* of the group.',
    '• Add the word *invite* at the end to send the group link by DM to people whose privacy blocks adding.',
  ].join('\n');
}

export default [
  {
    name: 'gadd', aliases: ['bulkadd', 'gmadd'], owner: true, premium: true, react: '➕',
    async run({ sock, jid, sessionId, args, reply }) {
      const raw = args.join(' ');
      if (!raw.trim()) return reply(usage());
      if (running.has(sessionId)) return reply('⏳ A bulk add is still running for this number. Wait for its report first.');

      // 1. which group
      const inGroup = jid.endsWith('@g.us');
      const code = parseGroupCode(raw);
      let groupJid = inGroup ? jid : null;
      if (code) {
        try { groupJid = (await sock.groupGetInviteInfo(code)).id; }
        catch { return reply('❌ That group link does not work (expired or revoked).'); }
      }
      if (!groupJid) return reply(`In a private chat, start with the group link:\n${PREFIX}gadd <group link> 94771234567, 94779876543`);

      // 2. which numbers
      const wantInvite = /(?:^|[\s,])(?:--?invite|invite)\s*$/i.test(raw);
      const parsed = parseNumbers(raw.replace(/(?:^|[\s,])(?:--?invite|invite)\s*$/i, ''), DEFAULT_CC);
      if (!parsed.numbers.length) return reply(`No valid numbers found.\n\n${usage()}`);
      const batch = parsed.numbers.slice(0, MAX_PER_RUN), rest = parsed.numbers.slice(MAX_PER_RUN);

      // 3. the bot must be in the group and be an admin
      let meta;
      try { meta = await sock.groupMetadata(groupJid); }
      catch { return reply(`❌ I am not in that group. Join it first with ${PREFIX}join <group link>, make me an admin, then try again.`); }
      const me = [sock.user?.id, sock.user?.lid, sock.user?.jid].filter(Boolean).map(jidNum);
      if (!meta.participants.some((p) => isAdminP(p) && idsOf(p).some((n) => me.includes(n)))) return reply('⚠️ Make this number a group *admin* first, then try again.');

      // 4. hourly limit
      const now = Date.now();
      let h = hourly.get(sessionId);
      if (!h || h.reset <= now) { h = { n: 0, reset: now + 3600000 }; hourly.set(sessionId, h); }
      if (h.n + batch.length > MAX_PER_HOUR) return reply(`🛑 Hourly limit reached (${MAX_PER_HOUR} adds per hour keeps this account safe). Try again in ${Math.ceil((h.reset - now) / 60000)} min.`);

      running.add(sessionId);
      const results = []; let stopped = '';
      try {
        // already members, and numbers that are not on WhatsApp, are sorted out without touching the group
        const members = new Set(meta.participants.flatMap(idsOf));
        const todo = [];
        for (const num of batch) { if (members.has(num)) results.push({ num, kind: 'already' }); else todo.push(num); }
        let target = new Map(todo.map((n) => [n, `${n}@s.whatsapp.net`]));
        try {
          const found = await sock.onWhatsApp(...todo.map((n) => `${n}@s.whatsapp.net`));
          const ok = new Map((found || []).filter((r) => r.exists).map((r) => [jidNum(r.jid), r.jid]));
          target = new Map();
          for (const num of todo) { if (ok.has(num)) target.set(num, ok.get(num)); else results.push({ num, kind: 'nowa' }); }
        } catch { /* lookup failed: just try them all */ }

        if (target.size) {
          const mins = Math.max(1, Math.round((target.size * ((GAP_MIN_MS + GAP_MAX_MS) / 2)) / 60000));
          await reply(`➕ Adding *${target.size}* number(s) to *${meta.subject}*.\nThis takes about ${mins} min because I add them slowly. I will send a report when done.`);
        }
        const needInvite = [];
        let first = true;
        for (const [num, user] of target) {
          if (!first) await pause();
          first = false; h.n++;
          try {
            const r = await sock.groupParticipantsUpdate(groupJid, [user], 'add');
            const kind = classify(r?.[0]?.status ?? '200');
            results.push({ num, kind });
            if (kind === 'privacy') needInvite.push(user);
          } catch (err) {
            const m = String(err?.message || err);
            console.error(`gadd error (${num}):`, m);
            if (/rate-overlimit|429|too many|spam/i.test(m)) { stopped = 'WhatsApp asked me to slow down. Wait at least an hour before adding more.'; results.push({ num, kind: 'failed' }); break; }
            if (/not-authorized|forbidden|403/i.test(m)) { stopped = 'I am not allowed to add people (am I still a group admin?).'; results.push({ num, kind: 'failed' }); break; }
            results.push({ num, kind: 'failed' });
          }
        }
        if (stopped) { const done = new Set(results.map((r) => r.num)); for (const num of target.keys()) if (!done.has(num)) rest.push(num); } // not tried: shown as "send these again"
        // people whose privacy blocks adding: optionally DM them the invite link
        if (wantInvite && needInvite.length) {
          let link = '';
          try { link = `https://chat.whatsapp.com/${await sock.groupInviteCode(groupJid)}`; } catch { /* no link: they stay in the privacy list */ }
          if (link) {
            for (const user of needInvite) {
              await pause();
              try {
                await sock.sendMessage(user, { text: `👋 You are invited to join *${meta.subject}*\n${link}` });
                const row = results.find((x) => `${x.num}@s.whatsapp.net` === user || jidNum(user) === x.num);
                if (row) row.kind = 'invited';
              } catch (err) { console.error('gadd invite error:', err?.message || err); }
            }
          }
        }
      } finally { running.delete(sessionId); }

      const rank = (k) => ['added', 'already', 'invited', 'privacy', 'left', 'blocked', 'nowa', 'failed'].indexOf(k);
      results.sort((a, b) => rank(a.kind) - rank(b.kind));
      console.log(`gadd ${sessionId}: ${results.map((r) => r.kind).join(',')}`);
      return reply(buildSummary(meta.subject, results, { invalid: parsed.invalid, rest, stopped }));
    },
  },
];
