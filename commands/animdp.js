// .animdp (👑 premium + linked-number owner): "animated" profile picture.
// WhatsApp has no real moving profile picture, so this takes frames from a video / GIF and changes the DP to the next frame
// every few seconds, over and over. It looks like a slow animation when someone opens your profile.
//   .animdp            (reply to a video / GIF, or send one with .animdp as the caption)  start, default gap
//   .animdp 45         start with a 45 second gap between frames
//   .animdp stop       stop and keep the first frame as the DP
//   .animdp status     show what is running
// Changing the DP too fast can get a number restricted, so the gap, frame count and number of loops are limited (env below).
// Needs ffmpeg + ffprobe (both are in the Docker image). Runs only while the bot is up: a restart stops it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { PREFIX, sleep } from '../lib/config.js';
import { resetBotDp } from '../lib/card.js';
import { createLimiter, downloadMedia, findMedia } from '../lib/mediatools.js';

const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MIN_GAP_S = Math.max(15, int(process.env.ANIMDP_MIN_S, 30));      // shortest pause between two DP changes
const DEF_GAP_S = Math.max(MIN_GAP_S, int(process.env.ANIMDP_GAP_S, 60));
const MAX_FRAMES = Math.min(12, Math.max(2, int(process.env.ANIMDP_MAX_FRAMES, 6)));
const MAX_LOOPS = Math.max(1, int(process.env.ANIMDP_MAX_LOOPS, 20));   // after this many full rounds it stops by itself
const MAX_VIDEO_MB = Math.max(1, int(process.env.ANIMDP_MAX_MB, 20));
const SIZE = 640;                                                       // square picture, centre crop

const jobs = new Map();            // sessionId -> { cancelled, frames, gap, loop, loops, started, step }
const ffLimit = createLimiter(1);  // one ffmpeg job at a time

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      if (err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} is not installed`), { missing: cmd }));
      reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-200)}`));
    });
  });
}

// video / GIF bytes -> array of square JPEG buffers taken evenly across the clip
export function extractFrames(input, count = MAX_FRAMES) {
  return ffLimit(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rio-adp-'));
    try {
      const inFile = path.join(dir, 'in.bin');
      await fs.writeFile(inFile, input);
      let dur = 0;
      try {
        dur = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inFile], 20000));
      } catch (err) { if (err.missing) throw err; }
      if (!Number.isFinite(dur) || dur <= 0) dur = 3;
      const frames = [];
      for (let i = 0; i < count; i++) {
        const out = path.join(dir, `f${i}.jpg`);
        const t = Math.min(dur * i / count, Math.max(0, dur - 0.1));
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', t.toFixed(2), '-i', inFile, '-frames:v', '1',
          '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`, '-q:v', '3', out]);
        const buf = await fs.readFile(out).catch(() => null);
        if (buf?.length) frames.push(buf);
      }
      return frames;
    } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
}

const setDp = (sock, buf) => sock.updateProfilePicture(jidNormalizedUser(sock.user.id), buf);

async function loop(sock, jid, sid, job) {
  let failures = 0;
  const say = (text) => sock.sendMessage(jid, { text }).catch(() => {});
  try {
    for (job.loop = 1; job.loop <= MAX_LOOPS && !job.cancelled; job.loop++) {
      for (job.step = 0; job.step < job.frames.length && !job.cancelled; job.step++) {
        if (!(job.loop === 1 && job.step === 0)) { // frame 1 was already set by the command
          try { await setDp(sock, job.frames[job.step]); failures = 0; }
          catch (err) {
            console.error('animdp set failed:', err?.message || err);
            if (++failures >= 3) { await say('⚠️ *.animdp* stopped: WhatsApp refused the picture 3 times in a row (or the connection dropped). Start it again later.'); return; }
          }
        }
        // wait in small steps so .animdp stop reacts fast
        for (let w = 0; w < job.gap && !job.cancelled; w++) await sleep(1000);
      }
    }
    if (!job.cancelled) {
      await setDp(sock, job.frames[0]).catch(() => {});
      await say(`✅ *.animdp* finished (${MAX_LOOPS} rounds). The first frame is your DP now.`);
    }
  } finally {
    if (jobs.get(sid) === job) jobs.delete(sid);
    resetBotDp(sock);
  }
}

const usage = () => [
  '🎞️ *ANIMATED DP*  👑 premium',
  '',
  `Reply to a *video / GIF* with ${PREFIX}animdp (or send it with ${PREFIX}animdp as the caption).`,
  'The bot takes frames from it and changes your DP to the next frame every few seconds, in a loop.',
  '',
  `• ${PREFIX}animdp  →  start (gap ${DEF_GAP_S}s)`,
  `• ${PREFIX}animdp <seconds>  →  own gap, ${MIN_GAP_S}s or more`,
  `• ${PREFIX}animdp stop  →  stop`,
  `• ${PREFIX}animdp status`,
  '',
  `ℹ️ WhatsApp has no real moving DP, so this is a slideshow of ${MAX_FRAMES} frames. A short gap looks smoother but changing the DP too often can get a number restricted, so it stops by itself after ${MAX_LOOPS} rounds.`,
].join('\n');

export default [
  {
    name: 'animdp', aliases: ['animateddp', 'dpanim', 'videodp'], owner: true, premium: true, react: '🎞️',
    async run({ sock, msg, jid, sessionId, args, reply }) {
      const sub = (args[0] || '').toLowerCase();
      const job = jobs.get(sessionId);

      if (sub === 'stop' || sub === 'off') {
        if (!job) return reply('ℹ️ No animated DP is running.');
        job.cancelled = true;
        jobs.delete(sessionId); // gone at once, so a second stop / a new start is not confused by the loop that is still waking up
        await setDp(sock, job.frames[0]).catch(() => {});
        return reply('🛑 Animated DP stopped. The first frame is your DP now.');
      }
      if (sub === 'status') {
        if (!job) return reply(`ℹ️ No animated DP is running. ${PREFIX}animdp to see how to start one.`);
        const mins = Math.round((Date.now() - job.started) / 60000);
        return reply(`🎞️ Running: frame ${job.step + 1}/${job.frames.length}, round ${job.loop}/${MAX_LOOPS}, gap ${job.gap}s, started ${mins} min ago.\n${PREFIX}animdp stop to stop it.`);
      }
      if (job) return reply(`⏳ An animated DP is already running. Send ${PREFIX}animdp stop first.`);

      const media = findMedia(msg, jid);
      if (!media || media.kind !== 'video') return reply(usage());

      let gap = DEF_GAP_S;
      if (args[0]) {
        const n = Number(args[0].replace(/s$/i, ''));
        if (!Number.isFinite(n)) return reply(usage());
        if (n < MIN_GAP_S) return reply(`❌ The gap must be at least ${MIN_GAP_S} seconds (changing the DP faster can get your number restricted).`);
        gap = Math.min(n, 3600);
      }

      let frames;
      try {
        const buf = await downloadMedia(sock, media, MAX_VIDEO_MB * 1024 * 1024);
        frames = await extractFrames(buf);
      } catch (err) {
        console.error('animdp error:', err?.message || err);
        if (err.tooBig) return reply(`❌ That video is too big (over ${MAX_VIDEO_MB} MB). Send a shorter one.`);
        if (err.missing) return reply(`❌ ${err.missing} is not installed on this server.`);
        if (err.download) return reply('❌ Could not open that video (it may have expired). Send it again.');
        return reply('❌ Could not read frames from that video.');
      }
      if (frames.length < 2) return reply('❌ Could not get enough frames from that video.');

      try { await setDp(sock, frames[0]); }
      catch (err) { console.error('animdp first frame failed:', err?.message || err); return reply('❌ WhatsApp did not accept the first picture. Try again in a moment.'); }

      const j = { cancelled: false, frames, gap, loop: 1, step: 0, started: Date.now() };
      jobs.set(sessionId, j);
      loop(sock, jid, sessionId, j).catch((err) => { console.error('animdp loop error:', err?.message || err); jobs.delete(sessionId); });
      return reply(`✅ Animated DP started: ${frames.length} frames, a new frame every ${gap}s, ${MAX_LOOPS} rounds (about ${Math.round(frames.length * gap * MAX_LOOPS / 60)} min).\nFrame 1 is your DP now. ${PREFIX}animdp stop to stop.`);
    },
  },
];
