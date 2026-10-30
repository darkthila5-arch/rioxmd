// .apk <app name>  ->  searches Aptoide (a public Android app store) and shows swipe cards: icon, version, size, rating and Aptoide's safety scan.
// Tap ⬇️ DOWNLOAD and the APK arrives in the chat as a file.   (.apkget <id> is what the button runs)
// Settings (Render environment, all optional):  MAX_APK_MB (default 150)  ·  APK_API_BASE (default https://ws75.aptoide.com)
import crypto from 'node:crypto';
import { BOT_NAME, PREFIX, USE_BUTTONS } from '../lib/config.js';
import { qr } from '../lib/menu.js';
import { sendCards } from '../lib/carousel.js';

const BASES = [...new Set([(process.env.APK_API_BASE || 'https://ws75.aptoide.com').replace(/\/$/, ''), 'https://ws75-cache.aptoide.com'])];
const MAX_APK_MB = Number(process.env.MAX_APK_MB || 150);
const MAX_CARDS = 8, MAX_SENDING = 2, KEEP_MS = 30 * 60 * 1000;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mb = (bytes) => (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1);
const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
const RANK = { TRUSTED: '✅ Aptoide scan: Trusted', WARN: '⚠️ Aptoide scan: Warning', UNKNOWN: '❔ Not scanned by Aptoide', CRITICAL: '⛔ Flagged as malware' };

// search results kept for 30 minutes, so a button only needs a short id
const pending = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); }, 60 * 1000).unref();

function normalise(app) {
  const f = app?.file || {};
  const urls = [...new Set([f.path_alt, f.path].filter((u) => /^https?:\/\//i.test(u || '')))];
  if (!app?.name || !urls.length) return null;
  return {
    name: app.name, pkg: app.package || '', icon: app.icon || app.graphic || '',
    size: Number(f.filesize || app.size || 0), version: f.vername || '', urls,
    rank: String(f.malware?.rank || '').toUpperCase(), downloads: Number(app.stats?.downloads || 0),
    rating: Number(app.stats?.rating?.avg || 0), store: app.store?.name || '', obb: !!app.obb
  };
}

async function searchApps(query, n = MAX_CARDS) {
  const q = encodeURIComponent(query);
  const tries = BASES.flatMap((b) => [`${b}/api/7/apps/search?query=${q}&limit=${n}&mature=false`, `${b}/api/7/apps/search/query=${q}/limit=${n}`]);
  let answered = false, lastErr = null;
  for (const url of tries) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json())?.datalist?.list;
      if (!Array.isArray(list)) throw new Error('unexpected reply');
      answered = true; // the store did answer, even if it had nothing
      const apps = list.map(normalise).filter(Boolean);
      if (apps.length) return apps;
    } catch (err) { lastErr = err; }
  }
  if (!answered && lastErr) throw lastErr; // no route answered at all: that is a problem. An empty answer is just "no apps".
  return [];
}

const cardBody = (a) => [
  `📱 ${clip(a.name, 60)}`,
  a.pkg ? `📦 ${clip(a.pkg, 45)}` : null,
  `🆚 ${a.version || '-'}${a.size ? `  ·  💾 ${mb(a.size)} MB` : ''}`,
  a.rating || a.downloads ? `${a.rating ? `⭐ ${a.rating.toFixed(1)}  ·  ` : ''}⬇️ ${compact(a.downloads)}` : null,
  RANK[a.rank] || null,
  a.obb ? '📂 Needs extra OBB data (not included)' : null
].filter(Boolean).join('\n');

let sending = 0;

export default [
  {
    name: 'apk', aliases: ['aptoide', 'getapk'], react: '📱',
    async run({ sock, msg, jid, args, reply }) {
      const query = args.join(' ').trim();
      if (!query) return reply(`📱 *APK download*\n\n${PREFIX}apk <app name>\nExample: ${PREFIX}apk whatsapp\n\nYou get swipe cards with the app's version, size and safety scan. Tap ⬇️ DOWNLOAD to receive the APK.`);

      await reply('🔎 Searching apps...');
      let apps;
      try { apps = await searchApps(query); }
      catch (err) { console.error('apk search error:', err?.message || err); return reply('❌ The app store did not answer. Try again in a minute.'); }
      if (!apps.length) return reply(`😕 No apps found for “${clip(query, 60)}”.`);

      const items = apps.map((a) => { const id = crypto.randomBytes(4).toString('hex'); pending.set(id, { ...a, expires: Date.now() + KEEP_MS }); return { a, id }; });
      if (USE_BUTTONS) {
        try {
          return await sendCards(sock, jid, {
            title: `📱 *Apps for* “${clip(query, 60)}”\nSwipe the cards and tap ⬇️ DOWNLOAD`,
            quoted: msg,
            cards: items.map(({ a, id }) => ({ image: a.icon, body: cardBody(a), buttons: [qr('⬇️ DOWNLOAD', `${PREFIX}apkget ${id}`)] }))
          });
        } catch (err) { console.error('apk cards failed, using the text list:', err?.message || err); }
      }
      return reply([
        `📱 *Apps for* “${clip(query, 60)}”`, '',
        ...items.map(({ a, id }, i) => `*${i + 1}.* ${clip(a.name, 50)}  ·  ${a.version || '-'}  ·  ${a.size ? `${mb(a.size)} MB` : '-'}${a.rank === 'CRITICAL' ? '  ⛔' : ''}\n   ${PREFIX}apkget ${id}`),
        '', `Copy a line and send it to download. > ${BOT_NAME}`
      ].join('\n'));
    }
  },
  {
    name: 'apkget',
    async run({ sock, msg, jid, args, reply }) {
      const e = pending.get(String(args[0] || ''));
      if (!e || e.expires < Date.now()) return reply(`⌛ That result expired. Search again with ${PREFIX}apk <app name>.`);
      if (e.rank === 'CRITICAL') return reply('⛔ Aptoide flagged this file as malware, so I will not send it. Pick another result.');

      const limit = MAX_APK_MB * 1048576;
      let size = e.size;
      try { // the real size from the file server, when it answers (the store's number can be a little off)
        const head = await fetch(e.urls[0], { method: 'HEAD', headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        const len = Number(head.headers.get('content-length') || 0);
        if (head.ok && len > 0) size = len;
      } catch { /* the store's size is used */ }
      if (size > limit) return reply(`❌ ${clip(e.name, 40)} is ${mb(size)} MB. The limit here is ${MAX_APK_MB} MB.`);
      if (sending >= MAX_SENDING) return reply('⏳ Two APKs are being sent right now. Try again in a minute.');

      sending++;
      try {
        await reply(`⏳ Sending *${clip(e.name, 50)}*${size ? ` (${mb(size)} MB)` : ''}...`);
        const safe = e.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'app';
        const caption = [
          `📱 *${clip(e.name, 80)}*`, `🆚 ${e.version || '-'}${size ? `  ·  💾 ${mb(size)} MB` : ''}`, e.pkg ? `📦 ${e.pkg}` : null,
          RANK[e.rank] || null, e.obb ? '📂 This app also needs OBB data, which is not included.' : null,
          '', '💡 Install apps from the Play Store when you can.', `> ${BOT_NAME}`
        ].filter((l) => l !== null).join('\n');
        let lastErr = null;
        for (const url of e.urls) { // the store gives two links; the second is the backup
          try {
            await sock.sendMessage(jid, { document: { url }, mimetype: 'application/vnd.android.package-archive', fileName: `${safe}${e.version ? `_v${e.version.replace(/[^\w.-]+/g, '')}` : ''}.apk`, caption }, { quoted: msg });
            return undefined;
          } catch (err) { lastErr = err; console.error('apk send failed on one link:', err?.message || err); }
        }
        throw lastErr || new Error('no link worked');
      } catch (err) {
        console.error('apk error:', err?.message || err);
        return reply('❌ I could not send that APK. Try another result.');
      } finally { sending--; }
    }
  }
];
