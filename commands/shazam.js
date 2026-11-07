// .shazam (aliases .whatsong .findsong): finds the song in an audio, voice note or video.
//   Reply to the audio / video with .shazam (or send it with .shazam as the caption).
//   .shazam 45   listens from second 45 (when the song starts later in a long file).
// Only a short clip (default 20 s, SHAZAM_CLIP_SECONDS) is cut with ffmpeg and sent to the AudD recognition API. Needs AUDD_API_TOKEN (see lib/shazam.js).
// Limits: one request per person every 15 s, and SHAZAM_DAILY_MAX requests per day for the whole bot (default 100, 0 = no limit) to protect the API quota.
import { PREFIX } from '../lib/config.js';
import { MAX_INPUT_BYTES, downloadMedia, findMedia } from '../lib/mediatools.js';
import { CLIP_SECONDS, MAX_START_SECONDS, deps, identify, songText } from '../lib/shazam.js';

const MB = (n) => Math.round(n / 1048576);
const sizeOf = (part) => (typeof part?.fileLength?.toNumber === 'function' ? part.fileLength.toNumber() : Number(part?.fileLength || 0));

const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();
function tooSoon(key, ms) {
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < ms) return true;
  lastUse.set(key, now);
  return false;
}

const day = { key: '', count: 0 };
export function dailyLimitReached() {
  const max = Number(process.env.SHAZAM_DAILY_MAX ?? 100);
  if (!(max > 0)) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (day.key !== today) { day.key = today; day.count = 0; }
  if (day.count >= max) return true;
  day.count++;
  return false;
}
export const resetDaily = () => { day.key = ''; day.count = 0; };

function failText(err) {
  if (err?.missing) return '❌ ffmpeg is not installed on the server, so this command cannot work.';
  if (err?.tooBig) return `❌ That file is bigger than ${MB(MAX_INPUT_BYTES)} MB.`;
  if (err?.download) return '❌ Could not download that file. Forward it again and reply to the new one.';
  if (err?.tooShort) return '❌ The file is shorter than that start time. Try a smaller number.';
  if (err?.noAudio) return '❌ That file has no sound to listen to.';
  if (err?.api && [900, 901, 902].includes(err.code)) return '⚠️ Song search is not available right now (API token missing or its limit is used up). Tell the bot owner.';
  if (err?.api) return '❌ The song search service did not answer. Try again in a moment.';
  if (err?.name === 'TimeoutError') return '❌ The song search took too long. Try again.';
  return '❌ Could not search for that song. Try another file.';
}

export default [{
  name: 'shazam', aliases: ['whatsong', 'findsong'], react: '🎶',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const usage = `🎶 *Find a song*\nReply to a song (audio, voice note or video) with ${PREFIX}shazam, or send it with ${PREFIX}shazam as the caption.\n${PREFIX}shazam 45 = listen from second 45.\nIt listens to about ${CLIP_SECONDS} seconds.`;
    const media = findMedia(msg, jid);
    if (!media) return reply(usage);
    if (media.kind !== 'audio' && media.kind !== 'video') return reply(`That is not audio or video.\n${usage}`);
    if (sizeOf(media.part) > MAX_INPUT_BYTES) return reply(failText({ tooBig: true }));
    const start = args[0] === undefined ? 0 : Number(args[0]);
    if (!Number.isFinite(start) || start < 0 || start > MAX_START_SECONDS) return reply(`Use a number of seconds, for example ${PREFIX}shazam 45`);
    if (tooSoon(`shazam|${sessionId}|${jid}|${msg.key?.participant || ''}`, 15000)) return reply('⏳ One song at a time please. Try again in a few seconds.');
    if (dailyLimitReached()) return reply('⚠️ The song search limit for today is finished. Try again tomorrow.');
    try {
      reply('🎧 Listening…').catch(() => {});
      const input = await downloadMedia(sock, media);
      const clip = await deps.clip(input, start);
      const song = await identify(clip);
      if (!song) return reply(`🤷 I could not recognise that song.\nTry a clearer part with ${PREFIX}shazam 30 (start second). Songs with loud talking or noise are hard to find.`);
      return await reply(songText(song, { prefix: PREFIX }));
    } catch (err) {
      console.error('shazam error:', err?.message || err);
      return reply(failText(err));
    }
  },
}];
