// .stats: users (linked numbers), commands used, top commands, uptime and memory (host owner only).
// Numbers come from the same counters as the /admin Server tab, so they survive restarts.
import { sessions, PREFIX } from '../lib/config.js';
import { analytics, bannedList, liveCounts } from '../lib/control.js';
import { isPremium } from '../lib/premium.js';
import { formatUptime, mem } from '../lib/text.js';

const n = (v) => Number(v || 0).toLocaleString('en-US');

export default [
  {
    name: 'stats', aliases: ['botstats', 'usage'], adminOnly: true, owner: true, react: '📊',
    async run({ reply }) {
      const all = [...sessions.entries()].filter(([, s]) => s.phone);
      const online = all.filter(([, s]) => s.status === 'connected').length;
      const premium = all.filter(([sid]) => isPremium(sid)).length;
      const a = analytics((sid) => sessions.get(sid)?.phone || '');
      const live = liveCounts();
      const top = a.top.slice(0, 5).map((c, i) => `${i + 1}. ${PREFIX}${c.name} — ${n(c.n)}`);
      const since = a.since ? new Date(a.since).toISOString().slice(0, 10) : '-';
      return reply([
        '╭━━━〔 📊 *BOT STATS* 〕━━━⬣',
        `┃ 👥 Linked numbers : ${n(all.length)} (🟢 ${n(online)} online)`,
        `┃ 👑 Premium        : ${n(premium)}`,
        `┃ 🔨 Banned         : ${n(bannedList().length)}`,
        '┃',
        `┃ ⌨️ Commands today : ${n(a.today)}`,
        `┃ ⌨️ Commands total : ${n(a.total)} (since ${since})`,
        `┃ ⚡ Last minute    : ${n(live.perMin)}`,
        `┃ ⚠️ Errors         : ${n(a.errors)}`,
        '┃',
        `┃ ⏱️ Uptime         : ${formatUptime(process.uptime())}`,
        `┃ 💾 Memory         : ${mem()}`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        ...(top.length ? ['', '🏆 *Top commands*', ...top] : []),
      ].join('\n'));
    },
  },
];
