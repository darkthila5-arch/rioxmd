// .csong <channel link | channel jid | group jid> <song name or YouTube link>
// Posts a song to a WhatsApp channel (or group) as: 1) the thumbnail with the song details, 2) the song as a voice note.
// Leave the target out and it posts into the chat where you typed the command.
// The linked number must be the channel owner / admin (channels) or a member (groups).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { BOT_NAME, PREFIX, USE_BUTTONS } from '../lib/config.js';
import { qr } from '../lib/menu.js';
import { sendCards } from '../lib/carousel.js';
import { MAX_DL_BYTES, getSong, rememberSong, ytDownload, ytQuickInfo, ytSearchInfo, ytSearchList } from '../lib/downloader.js';

const MAX_SONG_MIN = Number(process.env.MAX_SONG_MIN || 20);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function resolveTarget(sock, raw) {
  const t = String(raw || '').trim();
  if (/@(g\.us|newsletter)$/.test(t)) return t;
  const ch = t.match(/whatsapp\.com\/channel\/([\w-]+)/i);
  if (ch) return (await sock.newsletterMetadata('invite', ch[1])).id;
  const gr = t.match(/chat\.whatsapp\.com\/([\w-]+)/i);
  if (gr) return (await sock.groupGetInviteInfo(gr[1])).id;
  return null;
}
const looksLikeTarget = (t) => /@(g\.us|newsletter)$/.test(t) || /whatsapp\.com\/(channel|chat)|chat\.whatsapp\.com/i.test(t);

// WhatsApp voice notes are mono Opus in an Ogg file. Anything else shows as a normal audio file instead of a voice note.
function toVoiceNote(buf, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `csong-${crypto.randomBytes(3).toString('hex')}-`));
  const input = path.join(dir, `in.${ext || 'm4a'}`), output = path.join(dir, 'out.ogg');
  fs.writeFileSync(input, buf);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', output],
      { timeout: 180000 }, (err, _out, stderr) => {
        try { if (err) return reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)); resolve(fs.readFileSync(output)); }
        finally { fs.rmSync(dir, { recursive: true, force: true }); }
      });
  });
}

// A 1 second silent Opus voice note, only used by the "test" mode.
function silentVoiceNote() {
  const out = path.join(os.tmpdir(), `csong-silence-${crypto.randomBytes(3).toString('hex')}.ogg`);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', out], { timeout: 60000 }, (err, _o, stderr) => {
      try { if (err) return reject(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 150)}`)); resolve(fs.readFileSync(out)); }
      finally { fs.rmSync(out, { force: true }); }
    });
  });
}

async function thumbnail(info) {
  const id = String(info.sourceUrl || '').match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
  for (const url of [id && `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, info.thumb].filter(Boolean)) { // jpg first: WhatsApp does not like webp pictures
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

const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '-');

export default [
  {
    name: 'csong', aliases: ['channelsong'], owner: true, react: '🎙️',
    async run({ sock, msg, jid, args, reply }) {
      if (!args.length) return reply(`🎙️ *Post a song to a channel*\n\n${PREFIX}csong <channel link or jid> <song name>\nExample: ${PREFIX}csong https://whatsapp.com/channel/xxxx shape of you\n\nWithout the channel it posts in this chat.\n\nTest first (no YouTube): ${PREFIX}csong <channel> test`);

      let target = jid, rest = args;
      if (looksLikeTarget(args[0])) {
        try { target = await resolveTarget(sock, args[0]); } catch (err) { console.error('csong resolve error:', err?.message || err); target = null; }
        if (!target) return reply('❌ I could not read that channel / group. Send the channel link, or a jid ending in @newsletter / @g.us.');
        rest = args.slice(1);
      }
      const query = rest.join(' ').trim();
      if (!query) return reply(`❌ Add the song name.\nExample: ${PREFIX}csong <channel> shape of you`);

      if (/^(test|check)$/i.test(query)) { // .csong <channel> test : proves the bot can post there, without touching YouTube
        try {
          await sock.sendMessage(target, { text: `✅ Test post from ${BOT_NAME}. If you can read this, text posts work here.` });
          await sock.sendMessage(target, { audio: await silentVoiceNote(), mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 1 });
          return reply(`✅ Test posted to ${target.endsWith('@newsletter') ? 'the channel' : 'the chat'}: a text and a 1 second voice note.\nIf both arrived, ${PREFIX}csong will work there.`);
        } catch (err) {
          console.error('csong test error:', err?.message || err);
          return reply(`❌ Could not post there: ${clip(err?.message || err, 150)}\nFor a channel the linked number must be its owner or an admin.`);
        }
      }

      // A song NAME (not a link) with buttons on: show picture cards first. Tapping 📢 POST runs this command again with that video's link.
      if (USE_BUTTONS && !/^https?:\/\//i.test(query) && !/^[0-9a-f]{8}$/.test(query)) { // (not for a link, and not for the id a POST button carries)
        try {
          await reply('🔎 Searching YouTube...');
          const list = await ytSearchList(query, 8);
          if (list.length) {
            const dest = target === jid ? '' : `${target} `; // the channel / group id travels inside the button
            await sendCards(sock, jid, {
              title: `🔎 *YouTube results for* “${clip(query, 60)}”\nSwipe and tap 📢 POST to send the song ${target === jid ? 'here' : target.endsWith('@newsletter') ? 'to the channel' : 'to the group'}`,
              quoted: msg,
              cards: list.map((r) => ({
                image: [r.thumb, r.thumb.replace('mqdefault', 'hqdefault')],
                body: [`🎵 ${clip(r.title, 110)}`, r.author ? `👤 ${clip(r.author, 40)}` : null, r.duration ? `⏱️ ${mmss(r.duration)}` : null].filter(Boolean).join('\n'),
                buttons: [qr('📢 POST', `${PREFIX}csong ${dest}${rememberSong(r)}`)]
              }))
            });
            return;
          }
        } catch (err) { console.error('csong cards failed, posting the first result instead:', err?.stderr || err?.message || err); }
      }

      let info = null;
      if (/^[0-9a-f]{8}$/.test(query)) { // the id a 📢 POST button carries: everything about the song is already known, no YouTube lookup needed
        info = getSong(query);
        if (!info) return reply(`⌛ That card expired. Search again with ${PREFIX}csong <channel> <song name>.`);
      } else {
        let ytTarget = `ytsearch1:${query}`;
        if (/^https?:\/\//i.test(query)) {
          let u; try { u = new URL(query); } catch { /* checked below */ }
          if (!u || !/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(u.hostname)) return reply('❌ Only YouTube links are supported.');
          ytTarget = u.toString();
        }
        await reply('🔎 Searching YouTube...');
        try {
          info = /^https?:\/\//i.test(query) ? await ytQuickInfo(ytTarget) : ((await ytSearchList(query, 1))[0] || await ytSearchInfo(ytTarget));
        } catch (err) {
          console.error('csong search error:', err?.stderr || err?.message || err);
          return reply(youtubeProblem(err));
        }
      }
      if (info.duration && info.duration > MAX_SONG_MIN * 60) return reply(`❌ That video is longer than ${MAX_SONG_MIN} minutes.`);

      await reply(`⏳ Preparing *${clip(info.title, 80)}*...`);
      try {
        const token = crypto.randomBytes(4).toString('hex');
        const got = await ytDownload(info.sourceUrl, token, { format: 'bestaudio/best' });
        const { buf, ext } = got;
        const voice = await toVoiceNote(buf, ext);
        if (voice.length > MAX_DL_BYTES) throw new Error('TOO_BIG');
        const pic = await thumbnail(info);

        const details = [
          `🎵 *${clip(info.title, 150)}*`,
          info.author ? `👤 ${clip(info.author, 60)}` : null,
          `⏱️ ${mmss(info.duration)}`,
          info.sourceUrl ? `🔗 ${info.sourceUrl}` : null,
          '', `🎧 Voice note below ⬇️`, `> ${BOT_NAME}`
        ].filter((l) => l !== null).join('\n');

        // 1) thumbnail + details, 2) the song as a voice note
        if (pic) await sock.sendMessage(target, { image: pic, caption: details });
        else await sock.sendMessage(target, { text: details });
        await sock.sendMessage(target, { audio: voice, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...(info.duration ? { seconds: Math.round(info.duration) } : {}) });
        return target === jid ? undefined : reply(`✅ Posted to ${target.endsWith('@newsletter') ? 'the channel' : 'the group'}:\n🎵 ${clip(info.title, 80)}`);
      } catch (err) {
        console.error('csong error:', err?.stderr || err?.message || err);
        const m = String(err?.stderr || err?.message || err);
        if (err?.message === 'TOO_BIG') return reply(`❌ The file is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB.`);
        if (/confirm you.?re not a bot|sign in|cookies|netscape|format is not available/i.test(m)) return reply(youtubeProblem(err) + `\n🔧 Owner: send ${PREFIX}ytcheck to see why.`);
        if (/ffmpeg/i.test(m)) return reply('❌ Could not convert the audio to a voice note (ffmpeg problem). Check the logs.');
        if (/forbidden|not-authorized|401|403|admin|owner/i.test(m)) return reply('❌ WhatsApp refused the post. For a channel, the linked number must be its owner or an admin; for a group it must be a member.');
        return reply('❌ Could not post the song. Check the logs.');
      }
    }
  }
];
