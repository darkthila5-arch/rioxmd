// .schedule open 8pm / close 10pm  -> the group opens and closes by itself every day.
// Also: .schedule open 8pm | .schedule close 10pm | .schedule (show) | .schedule off
// Uses the bot's TIMEZONE setting. Saved per session, so it survives restarts.
import { PREFIX, TIMEZONE, sessions } from '../lib/config.js';
import { getSetting, setSetting } from '../lib/storage.js';
import { adminGuard } from '../lib/groups.js';
import { say } from '../lib/card.js';

const KEY = 'gschedule'; // { [groupJid]: { open: 'HH:MM'|null, close: 'HH:MM'|null, doneOpen: 'YYYY-MM-DD', doneClose: 'YYYY-MM-DD' } }
const CATCH_UP_MIN = 5; // if the bot was offline at the exact minute, still run it up to 5 minutes late

/* ---------- time helpers ---------- */
// "8pm" "8:30pm" "8.30 pm" "20:00" "2000" -> "20:00"   (null when it cannot be read)
export function parseTime(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '').replace('.', ':');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
  if (min > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
  else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export function parseSchedule(text) {
  const out = { open: null, close: null, error: null };
  for (const part of String(text || '').split(/[\/,|;]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(open|close)\s+(.+)$/i);
    if (!m) { out.error = `I could not understand "${part}".`; return out; }
    const t = parseTime(m[2]);
    if (!t) { out.error = `"${m[2]}" is not a valid time. Try 8pm, 8:30pm or 20:00.`; return out; }
    out[m[1].toLowerCase()] = t;
  }
  if (!out.open && !out.close) out.error = 'Give at least one time.';
  return out;
}
const pretty = (hhmm) => {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const nowIn = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/* ---------- storage ---------- */
const getAll = (sid) => getSetting(sid, KEY, {});
function saveGroup(sid, jid, value) {
  const all = { ...getAll(sid) };
  if (value) all[jid] = value; else delete all[jid];
  setSetting(sid, KEY, all);
}

/* ---------- the timer that does the opening / closing ---------- */
async function apply(sid, sock, jid, kind, cfg) {
  const open = kind === 'open';
  try {
    await sock.groupSettingUpdate(jid, open ? 'not_announcement' : 'announcement');
    await say(sock, jid, open ? '🔓 *Group opened* (scheduled): everyone can send messages now.' : '🔒 *Group closed* (scheduled): only admins can send messages now.');
  } catch (err) {
    console.error(`Scheduled ${kind} failed for ${jid}:`, err?.message || err);
    await say(sock, jid, `⚠️ I could not ${kind} the group at the scheduled time. Please make me a group admin.`).catch(() => {});
  }
  saveGroup(sid, jid, { ...cfg, [open ? 'doneOpen' : 'doneClose']: nowIn().date });
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const { date, minutes } = nowIn();
    for (const [sid, rec] of sessions) {
      if (!rec?.sock || rec.status !== 'connected') continue;
      for (const [jid, cfg] of Object.entries(getAll(sid))) {
        for (const kind of ['open', 'close']) {
          const at = cfg[kind];
          const doneKey = kind === 'open' ? 'doneOpen' : 'doneClose';
          if (!at || cfg[doneKey] === date) continue;
          const diff = minutes - toMin(at);
          if (diff >= 0 && diff <= CATCH_UP_MIN) await apply(sid, rec.sock, jid, kind, getAll(sid)[jid] || cfg);
        }
      }
    }
  } catch (err) { console.error('Schedule tick error:', err?.message || err); }
  finally { busy = false; }
}
setInterval(tick, 20 * 1000).unref();

/* ---------- command ---------- */
export default [
  {
    name: 'schedule', aliases: ['gschedule', 'autogroup'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const text = c.args.join(' ').trim();
      const cur = getAll(c.sessionId)[c.jid];

      if (!text) {
        return c.reply([
          '╭━━━〔 ⏰ *GROUP SCHEDULE* 〕━━━⬣',
          `┃ 🔓 Opens : ${pretty(cur?.open)}`,
          `┃ 🔒 Closes: ${pretty(cur?.close)}`,
          `┃ 🕒 Zone  : ${TIMEZONE}`,
          '╰━━━━━━━━━━━━━━━━━━━━⬣',
          `${PREFIX}schedule open 8pm / close 10pm`,
          `${PREFIX}schedule open 8pm  (only opening)`,
          `${PREFIX}schedule close 10pm  (only closing)`,
          `${PREFIX}schedule off`
        ].join('\n'));
      }
      if (/^(off|stop|cancel|remove|delete|clear)$/i.test(text)) {
        if (!cur) return c.reply('ℹ️ No schedule is set for this group.');
        saveGroup(c.sessionId, c.jid, null);
        return c.reply('✅ Schedule removed. The group will no longer open / close automatically.');
      }
      const p = parseSchedule(text);
      if (p.error) return c.reply(`❌ ${p.error}\n\nExample: ${PREFIX}schedule open 8pm / close 10pm`);

      const next = { ...(cur || {}), doneOpen: '', doneClose: '' };
      if (p.open) next.open = p.open;
      if (p.close) next.close = p.close;
      // if the time has already passed today, wait for tomorrow instead of firing right now
      const { date, minutes } = nowIn();
      if (p.open && minutes > toMin(p.open)) next.doneOpen = date;
      if (p.close && minutes > toMin(p.close)) next.doneClose = date;
      saveGroup(c.sessionId, c.jid, next);
      return c.reply([
        '✅ *Schedule saved* (every day)',
        `🔓 Opens : ${pretty(next.open)}`,
        `🔒 Closes: ${pretty(next.close)}`,
        `🕒 Zone  : ${TIMEZONE}`
      ].join('\n'));
    },
  },
];
