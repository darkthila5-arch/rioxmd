// .chsong <channel jid | channel link | group jid> <song name or YouTube link>      (old names .csong and .channelsong still work)
//   Posts to the channel by itself, no buttons: 1) the thumbnail with the song details and quality, 2) the song as a voice note.
//   Leave the target out and it posts into the chat where you typed the command.
//   The linked number must be the channel owner / admin (channels) or a member (groups).
// .chid <channel link>      shows the channel's JID, ready to copy. Also: reply to a forwarded channel post, or send .chid alone to get this chat's id.
import fs from 'node:fs';
import { FOOTER_LINE, FOOTER_TEXT } from '../lib/brand.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { BOT_NAME, PREFIX, USE_BUTTONS } from '../lib/config.js';
import { copyBtn, qr, sendRich } from '../lib/menu.js';
import { unwrapMessage } from '../lib/text.js';
import { MAX_DL_BYTES, ytDownload, ytQuickInfo, ytSearchInfo, ytSearchList } from '../lib/downloader.js';

const MAX_SONG_MIN = Number(process.env.MAX_SONG_MIN || 20);
const VOICE_KBPS = Math.min(256, Math.max(32, Number(process.env.CHSONG_KBPS || 128))); // voice note quality (Opus bitrate)
const STEREO = (process.env.CHSONG_STEREO || '').toLowerCase() === 'on'; // mono is the safe default for voice notes
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '-');
const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
const isUrl = (t) => /^https?:\/\//i.test(t);

const looksLikeTarget = (t) => /@(g\.us|newsletter)$/.test(t) || /whatsapp\.com\/(channel|chat)|chat\.whatsapp\.com/i.test(t) || /^0029V[\w-]{10,}$/.test(t);

// Link / invite code / jid -> { id, name, extra }. Channels and groups.
async function lookup(sock, raw) {
  const t = String(raw || '').trim();
  const ch = t.match(/whatsapp\.com\/channel\/([\w-]+)/i) || t.match(/^(0029V[\w-]{10,})$/);
  if (ch) {
    const meta = await sock.newsletterMetadata('invite', ch[1]);
    const subs = meta.subscribers ?? meta.thread_metadata?.subscribers_count;
    return { id: meta.id, name: meta.name || meta.thread_metadata?.name?.text || '', kind: 'channel', extra: subs ? `${compact(Number(subs))} followers` : '' };
  }
  const gr = t.match(/chat\.whatsapp\.com\/([\w-]+)/i);
  if (gr) {
    const info = await sock.groupGetInviteInfo(gr[1]);
    return { id: info.id, name: info.subject || '', kind: 'group', extra: info.size ? `${info.size} members` : '' };
  }
  if (/@newsletter$/.test(t)) { // already a jid: the name is only a bonus, so a failure here is fine
    let name = '';
    try { const meta = await sock.newsletterMetadata('jid', t); name = meta.name || meta.thread_metadata?.name?.text || ''; } catch { /* just the id */ }
    return { id: t, name, kind: 'channel', extra: '' };
  }
  if (/@g\.us$/.test(t)) return { id: t, name: '', kind: 'group', extra: '' };
  return null;
}

// WhatsApp voice notes are Opus in an Ogg file (anything else shows as a normal audio file).
// Returns the voice note and its real length in seconds (ffprobe, when it is installed).
function toVoiceNote(buf, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chsong-${crypto.randomBytes(3).toString('hex')}-`));
  const input = path.join(dir, `in.${ext || 'm4a'}`), output = path.join(dir, 'out.ogg');
  fs.writeFileSync(input, buf);
  const done = (fn) => { try { fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${VOICE_KBPS}k`, '-vbr', 'on', '-application', 'audio', '-ar', '48000', '-ac', STEREO ? '2' : '1', '-f', 'ogg', output],
      { timeout: 180000 }, (err, _out, stderr) => {
        if (err) return done(() => reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)));
        execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output], { timeout: 30000 }, (perr, so) => {
          const seconds = perr ? null : Math.round(parseFloat(so)) || null;
          done(() => resolve({ voice: fs.readFileSync(output), seconds }));
        });
      });
  });
}

// A 1 second silent Opus voice note, only used by the "test" mode.
function silentVoiceNote() {
  const out = path.join(os.tmpdir(), `chsong-silence-${crypto.randomBytes(3).toString('hex')}.ogg`);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', out], { timeout: 60000 }, (err, _o, stderr) => {
      try { if (err) return reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 150)}`)); resolve(fs.readFileSync(out)); }
      finally { fs.rmSync(out, { force: true }); }
    });
  });
}

// Biggest picture first (1280x720), then the normal one. jpg only: WhatsApp does not like webp pictures.
async function thumbnail(info) {
  const id = String(info.sourceUrl || '').match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
  const urls = [id && `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, id && `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, info.thumb].filter(Boolean);
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000) return buf;
    } catch { /* try the next one */ }
  }
  return null;
}

// The real reason sits on the LAST lines of yt-dlp's message (the first line is only the command), so it is shown in the reply.
function youtubeProblem(err) {
  const raw = String(err?.stderr || err?.message || err);
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !/^Command failed:/i.test(l));
  const reason = clip(lines.filter((l) => /error/i.test(l)).pop() || lines.pop() || 'unknown', 220);
  let hint = '';
  if (/netscape|cookie.*(format|invalid)|does not look like/i.test(raw)) hint = '\n💡 The cookies file is not in Netscape format (tabs were lost). Use a Render *Secret File* named cookies.txt instead of an env variable.';
  else if (/no longer valid|rotated|invalid.*cookie/i.test(raw)) hint = '\n💡 The cookies expired. Export new ones (private window, log in to YouTube, export, close the window) and update the secret file.';
  else if (/not a bot|sign in/i.test(raw)) hint = '\n💡 YouTube still sees a bot. Fresh cookies from a logged-in account usually fix it.';
  else if (/Requested format|unavailable|private|removed/i.test(raw)) hint = '\n💡 That video cannot be downloaded. Try another song name or link.';
  return `❌ YouTube problem:\n${reason}${hint}`;
}

export default [
  {
    name: 'chsong', aliases: ['csong', 'channelsong'], owner: true, react: '🎙️',
    async run({ sock, jid, args, reply }) {
      if (!args.length) return reply(`🎙️ *Post a song to a channel*\n\n${PREFIX}chsong <channel jid or link> <song name or YouTube link>\nExample: ${PREFIX}chsong 120363xxxxxxxxx@newsletter shape of you\n\nIt posts by itself: thumbnail + details + the song as a voice note.\nDon't know the channel jid? Send ${PREFIX}chid <channel link>\n\nTest first (no YouTube): ${PREFIX}chsong <channel> test`);

      let target = jid, rest = args;
      if (looksLikeTarget(args[0])) {
        try { target = (await lookup(sock, args[0]))?.id || null; } catch (err) { console.error('chsong resolve error:', err?.message || err); target = null; }
        if (!target) return reply(`❌ I could not read that channel / group. Send its jid (ending in @newsletter or @g.us) or its link. ${PREFIX}chid <link> shows the jid.`);
        rest = args.slice(1);
      }
      const query = rest.join(' ').trim();
      if (!query) return reply(`❌ Add the song name or a YouTube link.\nExample: ${PREFIX}chsong <channel> shape of you`);

      if (/^(test|check)$/i.test(query)) { // .chsong <channel> test : proves the bot can post there, without touching YouTube
        try {
          await sock.sendMessage(target, { text: `✅ Test post from ${BOT_NAME}. If you can read this, text posts work here.` });
          await sock.sendMessage(target, { audio: await silentVoiceNote(), mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 1 });
          return reply(`✅ Test posted to ${target.endsWith('@newsletter') ? 'the channel' : 'the chat'}: a text and a 1 second voice note.\nIf both arrived, ${PREFIX}chsong will work there.`);
        } catch (err) {
          console.error('chsong test error:', err?.message || err);
          return reply(`❌ Could not post there: ${clip(err?.message || err, 150)}\nFor a channel the linked number must be its owner or an admin.`);
        }
      }

      // 1) find the song
      let ytTarget = `ytsearch1:${query}`;
      if (isUrl(query)) {
        let u; try { u = new URL(query); } catch { /* checked below */ }
        if (!u || !/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(u.hostname)) return reply('❌ Only YouTube links are supported.');
        ytTarget = u.toString();
      }
      await reply('🔎 Searching YouTube...');
      let info;
      try {
        info = isUrl(query) ? await ytQuickInfo(ytTarget) : ((await ytSearchList(query, 1))[0] || await ytSearchInfo(ytTarget));
      } catch (err) {
        console.error('chsong search error:', err?.stderr || err?.message || err);
        return reply(youtubeProblem(err));
      }
      if (info.duration && info.duration > MAX_SONG_MIN * 60) return reply(`❌ That video is longer than ${MAX_SONG_MIN} minutes.`);

      // 2) download, make the voice note, post
      await reply(`⏳ Preparing *${clip(info.title, 80)}*...`);
      try {
        const token = crypto.randomBytes(4).toString('hex');
        const { buf, ext } = await ytDownload(info.sourceUrl, token, { format: 'bestaudio/best' });
        const { voice, seconds } = await toVoiceNote(buf, ext);
        if (voice.length > MAX_DL_BYTES) throw new Error('TOO_BIG');
        const pic = await thumbnail(info);
        const length = seconds || info.duration || 0;

        const details = [
          `🎵 *${clip(info.title, 150)}*`,
          info.author ? `👤 ${clip(info.author, 60)}` : null,
          `⏱️ ${mmss(length)}`,
          info.views ? `▶️ ${compact(info.views)} views` : null,
          `🎚️ Quality: Opus ${VOICE_KBPS} kbps${STEREO ? ' stereo' : ''}`,
          info.sourceUrl ? `🔗 ${info.sourceUrl}` : null,
          '', '🎧 Voice note below ⬇️', `${FOOTER_LINE}`
        ].filter((l) => l !== null).join('\n');

        // thumbnail + details first, then the voice note
        if (pic) await sock.sendMessage(target, { image: pic, caption: details });
        else await sock.sendMessage(target, { text: details });
        await sock.sendMessage(target, { audio: voice, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...(length ? { seconds: length } : {}) });
        return target === jid ? undefined : reply(`✅ Posted to ${target.endsWith('@newsletter') ? 'the channel' : 'the group'}:\n🎵 ${clip(info.title, 80)}\n🎚️ ${VOICE_KBPS} kbps · ⏱️ ${mmss(length)}`);
      } catch (err) {
        console.error('chsong error:', err?.stderr || err?.message || err);
        const m = String(err?.stderr || err?.message || err);
        if (err?.message === 'TOO_BIG') return reply(`❌ The file is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB.`);
        if (/confirm you.?re not a bot|sign in|cookies|netscape|format is not available/i.test(m)) return reply(youtubeProblem(err) + `\n🔧 Owner: send ${PREFIX}ytcheck to see why.`);
        if (/ffmpeg/i.test(m)) return reply('❌ Could not convert the audio to a voice note (ffmpeg problem). Check the logs.');
        if (/forbidden|not-authorized|401|403|admin|owner/i.test(m)) return reply('❌ WhatsApp refused the post. For a channel, the linked number must be its owner or an admin; for a group it must be a member.');
        return reply('❌ Could not post the song. Check the logs.');
      }
    }
  },
  {
    name: 'chid', aliases: ['cjid', 'channelid', 'channeljid', 'newsletterid'], owner: true, react: '🆔',
    async run({ sock, msg, jid, args, reply }) {
      const raw = args.join(' ').trim();
      // The reply has buttons: 📋 Copy JID, 📋 Copy the ready .chsong command, 🧪 Test post. Without buttons it is plain text.
      const show = (r) => {
        const title = `${r.kind === 'group' ? '👥' : '📢'} *${r.name || (r.kind === 'group' ? 'Group' : 'Channel')}*${r.extra ? `  (${r.extra})` : ''}`;
        if (USE_BUTTONS) {
          return sendRich(sock, jid, {
            caption: `${title}\n\n🆔 *JID:*\n${r.id}\n\nTap a button below 👇`,
            buttons: [copyBtn('📋 Copy JID', r.id), copyBtn('🎵 Copy .chsong command', `${PREFIX}chsong ${r.id} `), qr('🧪 Test post', `${PREFIX}chsong ${r.id} test`)],
            footer: FOOTER_TEXT, image: null
          }, msg);
        }
        return reply([title, '', '🆔 *JID* (copy this):', r.id, '', `Post a song:\n${PREFIX}chsong ${r.id} <song name>`].join('\n'));
      };

      if (!raw) { // nothing typed: a replied-to forwarded channel post, otherwise this chat's own id
        const ctx = unwrapMessage(msg.message)?.extendedTextMessage?.contextInfo;
        const fwd = ctx?.quotedMessage ? Object.values(ctx.quotedMessage).map((v) => v?.contextInfo?.forwardedNewsletterMessageInfo).find(Boolean) : null;
        if (fwd?.newsletterJid) return show({ id: fwd.newsletterJid, name: fwd.newsletterName || '', kind: 'channel', extra: '' });
        if (USE_BUTTONS) {
          return sendRich(sock, jid, {
            caption: `🆔 *This chat's id:*\n${jid}\n\nFor a channel send:\n${PREFIX}chid <channel link>\n(or reply ${PREFIX}chid to a post forwarded from the channel)`,
            buttons: [copyBtn('📋 Copy chat ID', jid)], footer: FOOTER_TEXT, image: null
          }, msg);
        }
        return reply(`🆔 *This chat's id:*\n${jid}\n\nFor a channel send:\n${PREFIX}chid <channel link>\n(or reply ${PREFIX}chid to a post forwarded from the channel)`);
      }
      if (!looksLikeTarget(raw.split(/\s+/)[0])) return reply(`❌ Send a channel link, e.g.\n${PREFIX}chid https://whatsapp.com/channel/xxxxxxxx`);
      try {
        const r = await lookup(sock, raw.split(/\s+/)[0]);
        if (!r?.id) throw new Error('not found');
        return show(r);
      } catch (err) {
        console.error('chid error:', err?.message || err);
        return reply('❌ I could not read that link. Check that the channel link is correct and still active.');
      }
    }
  }
];
