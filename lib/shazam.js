// Helpers for commands/shazam.js (.shazam: find a song from an audio / video / voice note).
//   makeClip(buf, start)   cuts a short mono MP3 clip out of the file (ffmpeg), starting at `start` seconds
//   identify(clip)         sends the clip to the recognition API (AudD by default) and returns the song or null
//   songText(song)         the WhatsApp reply text for a song
// Setup: get a token at https://dashboard.audd.io and set AUDD_API_TOKEN (without a token AudD only allows a few test requests).
// Another service with the same answer format can be used with SHAZAM_API_URL. Only the short clip is sent, never the whole file.
// User input never reaches a command line: ffmpeg only gets fixed options and file names made here.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLimiter } from './mediatools.js';

export const CLIP_SECONDS = Math.min(60, Math.max(8, Number(process.env.SHAZAM_CLIP_SECONDS || 20)));
export const MAX_START_SECONDS = 6 * 3600;
const limited = createLimiter(Math.max(1, Number(process.env.MAX_MEDIA_JOBS || 2)));
export const deps = { clip: (...a) => makeClip(...a) }; // tests replace deps.clip so ffmpeg is not needed

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      if (err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} is not installed`), { missing: cmd }));
      reject(Object.assign(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-300)}`), { stderr: String(stderr || '') }));
    });
  });
}

export function makeClip(input, start = 0) {
  const from = Math.min(MAX_START_SECONDS, Math.max(0, Math.floor(Number(start) || 0)));
  return limited(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rio-sz-'));
    try {
      const inFile = path.join(dir, 'in.bin');
      const outFile = path.join(dir, 'clip.mp3');
      await fs.writeFile(inFile, input);
      try {
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(from), '-i', inFile, '-vn', '-map', '0:a:0', '-map_metadata', '-1',
          '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-t', String(CLIP_SECONDS), outFile]);
      } catch (err) {
        if (/matches no streams|does not contain any stream|Stream map/i.test(err.stderr || err.message)) throw Object.assign(err, { noAudio: true });
        throw err;
      }
      const out = await fs.readFile(outFile).catch(() => Buffer.alloc(0));
      if (out.length < 2000) throw Object.assign(new Error('empty clip'), { noAudio: true, tooShort: from > 0 });
      return out;
    } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
}

const str = (v, n = 120) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// AudD answer -> { title, artist, album, released, label, link, spotify, apple }
export function normalizeSong(r) {
  if (!r || typeof r !== 'object') return null;
  const title = str(r.title); const artist = str(r.artist);
  if (!title && !artist) return null;
  const http = (u) => (/^https?:\/\//i.test(str(u, 500)) ? str(u, 500) : '');
  return {
    title: title || 'Unknown title', artist: artist || 'Unknown artist', album: str(r.album), released: str(r.release_date, 20), label: str(r.label),
    link: http(r.song_link), spotify: http(r.spotify?.external_urls?.spotify), apple: http(r.apple_music?.url),
  };
}

export async function identify(clip) {
  const form = new FormData();
  if (process.env.AUDD_API_TOKEN) form.set('api_token', process.env.AUDD_API_TOKEN);
  form.set('return', 'apple_music,spotify');
  form.set('file', new Blob([clip], { type: 'audio/mpeg' }), 'clip.mp3');
  const res = await fetch(process.env.SHAZAM_API_URL || 'https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!data || typeof data !== 'object') throw Object.assign(new Error(`HTTP ${res.status}`), { api: true });
  if (data.status === 'error' || data.error) {
    const e = data.error || {};
    throw Object.assign(new Error(e.error_message || `API error ${e.error_code || res.status}`), { api: true, code: Number(e.error_code) || 0 });
  }
  return normalizeSong(data.result);
}

export function songText(s, { name = 'song', prefix = '.' } = {}) {
  const out = ['🎶 *Song found*', '', `🎵 *${s.title}*`, `👤 ${s.artist}`];
  if (s.album) out.push(`💿 ${s.album}`);
  if (s.released) out.push(`📅 ${s.released}`);
  if (s.label) out.push(`🏷️ ${s.label}`);
  const links = [s.spotify && `Spotify: ${s.spotify}`, s.apple && `Apple Music: ${s.apple}`, s.link && `More: ${s.link}`].filter(Boolean);
  if (links.length) out.push('', ...links);
  out.push('', `⬇️ Download it: ${prefix}${name} ${s.title} ${s.artist}`.slice(0, 200));
  return out.join('\n');
}
