// More fun + small tools (all work offline, no external APIs). Send .funmenu to see them.
// Add a new command by adding one more object to this array.
import QRCode from 'qrcode';
import { PREFIX, TIMEZONE, jidNum } from '../lib/config.js';
import { say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ctxOf = (msg) => unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
const whoOf = (msg) => ctxOf(msg)?.mentionedJid?.[0] || ctxOf(msg)?.participant || null;
const tag = (jid) => `@${jidNum(jid)}`;
const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const ROASTS = [
  'You are the reason the "skip intro" button exists. 😜',
  'You bring everyone together... to talk about how late you are. ⏰',
  'Your WiFi password is probably "password" and you still forget it. 📶',
  'If laziness was a sport, you would send someone to compete for you. 🛋️',
  'You have the energy of a phone at 1% with no charger. 🔋',
  'You are proof that autocorrect cannot fix everything. 📱',
  'Your jokes load slower than free WiFi at the airport. 🐌',
  'You are the human version of "Read 10:42 PM". 👀'
];
const COMPLIMENTS = [
  'You make the whole group chat brighter. ☀️',
  'You have a great sense of humour. 😄',
  'You are the kind of friend everyone wishes they had. 🤝',
  'Your kindness is contagious. 💛',
  'You are smarter than you give yourself credit for. 🧠',
  'You light up every conversation you join. ✨',
  'You are a legend, and the group knows it. 👑',
  'You work harder than you let anyone see. 💪'
];
const PICKUPS = [
  'Are you WiFi? Because I am feeling a strong connection. 📶',
  'Are you a keyboard? Because you are just my type. ⌨️',
  'Is your name Google? Because you have everything I am searching for. 🔍',
  'Are you a charger? Because I would be lost without you. 🔌',
  'Do you believe in love at first text? 💬'
];
const FORTUNES = [
  'A pleasant surprise is waiting for you this week. 🎁',
  'Someone you have not spoken to in a while will message you soon. 📩',
  'Today is a good day to start the thing you keep postponing. 🚀',
  'Small steps today will become big wins soon. 🌱',
  'An old idea of yours will suddenly make sense. 💡',
  'Good news travels towards you. Keep your phone close. 📱',
  'Rest today. You earned it. 😴'
];
const RIDDLES = [
  ['What has keys but cannot open locks?', 'keyboard'],
  ['What gets wetter the more it dries?', 'towel'],
  ['What has hands but cannot clap?', 'clock'],
  ['What can you catch but not throw?', 'cold'],
  ['What has a head and a tail but no body?', 'coin'],
  ['The more you take, the more you leave behind. What am I?', 'footsteps'],
  ['What goes up but never comes down?', 'age'],
  ['What has many teeth but cannot bite?', 'comb'],
  ['I speak without a mouth and hear without ears. What am I?', 'echo'],
  ['What month has 28 days?', 'all']
];

// Pending question per chat for .riddle / .mathquiz / .guess (kept in memory only).
const pending = new Map(); // jid -> { answer, label, at }
const games = new Map();   // jid -> { n, tries, at }
setInterval(() => { const cut = Date.now() - 15 * 60 * 1000; for (const [k, v] of pending) if (v.at < cut) pending.delete(k); for (const [k, v] of games) if (v.at < cut) games.delete(k); }, 5 * 60 * 1000).unref();
const reminders = new Map(); // jid -> count of active reminders

/* ---------- text style helpers ---------- */
const mapAlpha = (t, upper, lower, digits) => [...t].map((ch) => {
  const c = ch.codePointAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(upper + c - 65);
  if (c >= 97 && c <= 122) return String.fromCodePoint(lower + c - 97);
  if (digits !== undefined && c >= 48 && c <= 57) return String.fromCodePoint(digits + c - 48);
  return ch;
}).join('');
const FLIP = { a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z', '?': '¿', '!': '¡', '.': '˙', ',': "'", '(': ')', ')': '(' };
const MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
const UNMORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

export default [
  {
    name: 'roast',
    async run({ sock, msg, jid, name }) {
      const who = whoOf(msg);
      if (!who) return say(sock, jid, `🔥 Mention or reply to someone: ${PREFIX}roast @user`, msg);
      return say(sock, jid, `🔥 *${name}* roasts ${tag(who)}:\n\n${pick(ROASTS)}\n\n_just for fun, no hard feelings_`, msg, { mentions: [who] });
    },
  },
  {
    name: 'compliment', aliases: ['praise'],
    async run({ sock, msg, jid, name }) {
      const who = whoOf(msg);
      if (!who) return say(sock, jid, `💛 Mention or reply to someone: ${PREFIX}compliment @user`, msg);
      return say(sock, jid, `💛 *${name}* to ${tag(who)}:\n\n${pick(COMPLIMENTS)}`, msg, { mentions: [who] });
    },
  },
  { name: 'pickup', aliases: ['pickupline'], async run({ reply }) { return reply(`😏 ${pick(PICKUPS)}`); } },
  { name: 'fortune', aliases: ['horoscope'], async run({ reply, name }) { return reply(`🔮 *Fortune for ${name}*\n\n${pick(FORTUNES)}`); } },
  {
    name: 'iq',
    async run({ sock, msg, jid, name }) {
      const who = whoOf(msg);
      const seed = `${who ? jidNum(who) : name}|${new Date().toISOString().slice(0, 10)}`;
      const iq = 70 + (hash(seed) % 91);
      const note = iq > 140 ? 'Genius level! 🧠' : iq > 115 ? 'Pretty sharp! 😎' : iq > 90 ? 'Perfectly average 🙂' : 'Needs more coffee ☕';
      return say(sock, jid, `🧠 *IQ TEST*\n${who ? tag(who) : `*${name}*`}'s IQ today: *${iq}*\n${note}\n\n_(just for fun, changes every day)_`, msg, { mentions: who ? [who] : [] });
    },
  },
  {
    name: 'slot', aliases: ['slots'],
    async run({ reply }) {
      const s = ['🍒', '🍋', '🍇', '🔔', '⭐', '7️⃣'];
      const r = [pick(s), pick(s), pick(s)];
      const verdict = r[0] === r[1] && r[1] === r[2] ? '🎉 JACKPOT! You win!' : r[0] === r[1] || r[1] === r[2] || r[0] === r[2] ? '🙂 Two match, so close!' : '😅 No luck, try again.';
      return reply(`🎰 *SLOT MACHINE*\n\n[ ${r.join(' | ')} ]\n\n${verdict}`);
    },
  },
  {
    name: 'riddle',
    async run({ jid, reply }) {
      const [q, a] = pick(RIDDLES);
      pending.set(jid, { answer: a, label: a, at: Date.now() });
      return reply(`🧩 *RIDDLE*\n${q}\n\nAnswer with ${PREFIX}answer <your guess>\nOr ${PREFIX}answer to reveal it.`);
    },
  },
  {
    name: 'mathquiz', aliases: ['mq'],
    async run({ jid, reply }) {
      let a = 2 + Math.floor(Math.random() * 40), b = 2 + Math.floor(Math.random() * 12);
      const op = pick(['+', '-', '×']);
      if (op === '-' && a < b) [a, b] = [b, a]; // keep answers positive
      const ans = op === '+' ? a + b : op === '-' ? a - b : a * b;
      pending.set(jid, { answer: String(ans), label: String(ans), at: Date.now() });
      return reply(`🧮 *MATH QUIZ*\n${a} ${op} ${b} = ?\n\nAnswer with ${PREFIX}answer <number>`);
    },
  },
  {
    name: 'answer', aliases: ['ans'],
    async run({ jid, args, reply, name }) {
      const p = pending.get(jid);
      if (!p) return reply(`❔ No question yet. Try ${PREFIX}riddle or ${PREFIX}mathquiz`);
      if (!args.length) { pending.delete(jid); return reply(`💡 The answer was: *${p.label}*`); }
      if (norm(args.join(' ')) === norm(p.answer)) { pending.delete(jid); return reply(`✅ Correct, *${name}*! The answer is *${p.label}* 🎉`); }
      return reply('❌ Not quite, try again! (or use ' + PREFIX + 'answer to reveal)');
    },
  },
  {
    name: 'guess',
    async run({ jid, args, reply, name }) {
      let g = games.get(jid);
      const n = parseInt(args[0], 10);
      if (!g) {
        g = { n: 1 + Math.floor(Math.random() * 100), tries: 0, at: Date.now() };
        games.set(jid, g);
        if (!Number.isInteger(n)) return reply(`🔢 I picked a number between 1 and 100.\nGuess with ${PREFIX}guess <number>`);
      }
      if (!Number.isInteger(n)) return reply(`🔢 Game running. Guesses so far: ${g.tries}\nUse ${PREFIX}guess <number>`);
      g.tries++; g.at = Date.now();
      if (n === g.n) { games.delete(jid); return reply(`🎉 *${name}* got it! The number was *${g.n}* (${g.tries} guesses).`); }
      return reply(n < g.n ? `📈 ${n} is too low.` : `📉 ${n} is too high.`);
    },
  },
  {
    name: 'random', aliases: ['rand', 'randnum'],
    async run({ args, reply }) {
      let a = parseInt(args[0], 10), b = parseInt(args[1], 10);
      if (!Number.isFinite(a)) { a = 1; b = 100; } else if (!Number.isFinite(b)) { b = a; a = 1; }
      if (a > b) [a, b] = [b, a];
      return reply(`🎯 Random number (${a}–${b}): *${a + Math.floor(Math.random() * (b - a + 1))}*`);
    },
  },
  {
    name: 'fancy', aliases: ['style'],
    async run({ args, reply }) {
      const t = args.join(' ').slice(0, 200);
      if (!t) return reply(`✨ Usage: ${PREFIX}fancy <text>`);
      return reply([
        `*Bold:* ${mapAlpha(t, 0x1D400, 0x1D41A, 0x1D7CE)}`,
        `*Bold italic:* ${mapAlpha(t, 0x1D468, 0x1D482)}`,
        `*Script:* ${mapAlpha(t, 0x1D4D0, 0x1D4EA)}`,
        `*Fraktur:* ${mapAlpha(t, 0x1D56C, 0x1D586)}`,
        `*Mono:* ${mapAlpha(t, 0x1D670, 0x1D68A, 0x1D7F6)}`
      ].join('\n\n'));
    },
  },
  {
    name: 'upside', aliases: ['flipside'],
    async run({ args, reply }) {
      const t = args.join(' ').toLowerCase();
      return t ? reply([...t].reverse().map((ch) => FLIP[ch] || ch).join('')) : reply(`🙃 Usage: ${PREFIX}upside <text>`);
    },
  },
  {
    name: 'binary', aliases: ['unbinary'],
    async run({ args, command, reply }) {
      const t = args.join(' ');
      if (!t) return reply(`💻 Usage: ${PREFIX}binary <text>  |  ${PREFIX}unbinary 01001000 01101001`);
      if (command === 'binary') return reply([...Buffer.from(t.slice(0, 200))].map((b) => b.toString(2).padStart(8, '0')).join(' '));
      const bytes = t.split(/\s+/).filter((x) => /^[01]{8}$/.test(x)).map((x) => parseInt(x, 2));
      return bytes.length ? reply(Buffer.from(bytes).toString('utf8')) : reply('❌ Send groups of 8 bits like 01001000 01101001');
    },
  },
  {
    name: 'morse',
    async run({ args, reply }) {
      const t = args.join(' ').trim();
      if (!t) return reply(`📡 Usage: ${PREFIX}morse hello  or  ${PREFIX}morse .... . .-.. .-.. ---`);
      if (/^[.\-/\s]+$/.test(t)) return reply(t.split(/\s+/).map((c) => (c === '/' ? ' ' : UNMORSE[c] || '?')).join(''));
      return reply(t.toLowerCase().split('').map((c) => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' '));
    },
  },
  {
    name: 'base64', aliases: ['b64', 'unb64'],
    async run({ args, command, reply }) {
      const t = args.join(' ');
      if (!t) return reply(`🔤 Usage: ${PREFIX}b64 <text>  |  ${PREFIX}unb64 <base64>`);
      if (command === 'unb64') {
        if (!/^[A-Za-z0-9+/=]+$/.test(t)) return reply('❌ That is not valid base64.');
        return reply(Buffer.from(t, 'base64').toString('utf8'));
      }
      return reply(Buffer.from(t.slice(0, 500)).toString('base64'));
    },
  },
  {
    name: 'qr',
    async run({ sock, msg, jid, args, reply }) {
      const t = args.join(' ').trim();
      if (!t) return reply(`🔳 Usage: ${PREFIX}qr <text or link>`);
      const buf = await QRCode.toBuffer(t.slice(0, 500), { width: 512, margin: 2 });
      return sock.sendMessage(jid, { image: buf, caption: '🔳 Here is your QR code' }, { quoted: msg });
    },
  },
  {
    name: 'time', aliases: ['date', 'clock'],
    async run({ args, reply }) {
      const tz = args[0] || TIMEZONE;
      try {
        const s = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'medium', timeZone: tz }).format(new Date());
        return reply(`🕒 *${tz}*\n${s}`);
      } catch { return reply(`❌ Unknown time zone. Example: ${PREFIX}time Asia/Colombo  or  ${PREFIX}time Europe/London`); }
    },
  },
  {
    name: 'remind', aliases: ['reminder'],
    async run({ sock, msg, jid, args, reply, name }) {
      const m = /^(\d{1,3})(s|m|h)$/i.exec(args[0] || '');
      const text = args.slice(1).join(' ').trim();
      if (!m || !text) return reply(`⏰ Usage: ${PREFIX}remind 10m take a break\nUnits: s, m, h (max 24h)\n_Reminders are lost if the bot restarts._`);
      const ms = Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2].toLowerCase()];
      if (ms < 5000 || ms > 24 * 3600 * 1000) return reply('❌ Choose a time between 5 seconds and 24 hours.');
      if ((reminders.get(jid) || 0) >= 5) return reply('❌ This chat already has 5 active reminders. Wait for one to finish.');
      reminders.set(jid, (reminders.get(jid) || 0) + 1);
      const who = msg.key.participant || (msg.key.fromMe ? sock.user?.id : jid);
      setTimeout(async () => {
        reminders.set(jid, Math.max(0, (reminders.get(jid) || 1) - 1));
        try { await say(sock, jid, `⏰ *Reminder for ${tag(who)}*\n${text.slice(0, 300)}`, undefined, { mentions: [who] }); }
        catch (err) { console.error('Reminder error:', err?.message || err); }
      }, ms).unref?.();
      return reply(`✅ Okay *${name}*, I will remind you in ${m[1]}${m[2].toLowerCase()}.`);
    },
  },
];
