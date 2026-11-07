import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const shazam = await import('../commands/shazam.js');
const lib = await import('../lib/shazam.js');
const media = await import('../lib/mediatools.js');
const { registry } = await import('../commands/index.js');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const realFetch = globalThis.fetch;
const realDownload = media.deps.download;
const realClip = lib.deps.clip;
test.afterEach(() => {
  globalThis.fetch = realFetch; media.deps.download = realDownload; lib.deps.clip = realClip;
  shazam.resetDaily(); delete process.env.SHAZAM_DAILY_MAX; delete process.env.AUDD_API_TOKEN;
});

let n = 0;
function ctx(args = [], message = { audioMessage: { fileLength: 1000, mimetype: 'audio/ogg' } }) {
  const out = [];
  return {
    out,
    c: {
      sock: { sendMessage: async () => ({ key: { id: 'x' } }) }, jid: '94770000000@s.whatsapp.net', sessionId: `sz${++n}`, args,
      msg: { key: { remoteJid: '94770000000@s.whatsapp.net', id: `S${n}`, fromMe: false, participant: `9477${n}@s.whatsapp.net` }, message },
      reply: async (t) => { out.push(t); return { key: { id: 'r' } }; },
    },
  };
}
const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const SONG = { status: 'success', result: { artist: 'Artist A', title: 'Song B', album: 'Album C', release_date: '2020-01-02', label: 'Label D', song_link: 'https://lis.tn/x', spotify: { external_urls: { spotify: 'https://open.spotify.com/track/1' } }, apple_music: { url: 'https://music.apple.com/x' } } };

test('shazam is registered with aliases', () => {
  for (const x of ['shazam', 'whatsong', 'findsong']) assert.ok(registry.has(x), x);
});
test('no media: usage and no network', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  const { c, out } = ctx([], { conversation: '.shazam' });
  await registry.get('shazam').run(c);
  assert.match(out[0], /Find a song/);
});
test('a photo is refused', async () => {
  const { c, out } = ctx([], { imageMessage: { fileLength: 10 } });
  await registry.get('shazam').run(c);
  assert.match(out[0], /not audio or video/);
});
test('bad start second is refused', async () => {
  const { c, out } = ctx(['abc']);
  await registry.get('shazam').run(c);
  assert.match(out[0], /number of seconds/);
});
test('identify sends the clip with token and reads the song', async () => {
  process.env.AUDD_API_TOKEN = 'tok123';
  let body;
  globalThis.fetch = async (url, init) => { body = init.body; return res(SONG); };
  const song = await lib.identify(Buffer.alloc(3000));
  assert.equal(song.title, 'Song B');
  assert.equal(song.artist, 'Artist A');
  assert.equal(song.spotify, 'https://open.spotify.com/track/1');
  assert.equal(body.get('api_token'), 'tok123');
  assert.ok(body.get('file'));
});
test('identify returns null when nothing matched', async () => {
  globalThis.fetch = async () => res({ status: 'success', result: null });
  assert.equal(await lib.identify(Buffer.alloc(3000)), null);
});
test('identify turns an API error into an error with its code; bad links are dropped', async () => {
  globalThis.fetch = async () => res({ status: 'error', error: { error_code: 901, error_message: 'no token' } });
  await assert.rejects(lib.identify(Buffer.alloc(10)), (e) => e.api === true && e.code === 901);
  assert.equal(lib.normalizeSong({ title: 'T', artist: 'A', song_link: 'javascript:alert(1)' }).link, '');
});
test('full command: answers with the song details and a download hint', async () => {
  media.deps.download = async () => Buffer.alloc(3000);
  lib.deps.clip = async () => Buffer.alloc(3000);
  globalThis.fetch = async () => res(SONG);
  const { c, out } = ctx();
  await registry.get('shazam').run(c);
  const text = out.join('\n');
  assert.match(text, /Song B/);
  assert.match(text, /Artist A/);
  assert.match(text, /\.song Song B Artist A/);
});
test('full command: not recognised gives a friendly message', async () => {
  media.deps.download = async () => Buffer.alloc(3000);
  lib.deps.clip = async () => Buffer.alloc(3000);
  globalThis.fetch = async () => res({ status: 'success', result: null });
  const { c, out } = ctx();
  await registry.get('shazam').run(c);
  assert.match(out.join('\n'), /could not recognise/);
});
test('full command: token / limit errors give an owner message, not the raw error', async () => {
  media.deps.download = async () => Buffer.alloc(3000);
  lib.deps.clip = async () => Buffer.alloc(3000);
  globalThis.fetch = async () => res({ status: 'error', error: { error_code: 901, error_message: 'secret detail' } });
  const { c, out } = ctx();
  await registry.get('shazam').run(c);
  assert.match(out.join('\n'), /Tell the bot owner/);
  assert.doesNotMatch(out.join('\n'), /secret detail/);
});
test('the same person must wait between requests, and the daily limit works', async () => {
  media.deps.download = async () => Buffer.alloc(3000);
  lib.deps.clip = async () => Buffer.alloc(3000);
  globalThis.fetch = async () => res(SONG);
  const { c, out } = ctx();
  await registry.get('shazam').run(c);
  await registry.get('shazam').run(c);
  assert.match(out.join('\n'), /One song at a time/);
  process.env.SHAZAM_DAILY_MAX = '1';
  shazam.resetDaily();
  const a = ctx(); const b = ctx();
  await registry.get('shazam').run(a.c);
  await registry.get('shazam').run(b.c);
  assert.match(b.out.join('\n'), /limit for today/);
});
test('makeClip cuts a short mp3 (needs ffmpeg)', { skip: !HAS_FFMPEG }, async () => {
  const { execFileSync } = await import('node:child_process');
  const wav = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-f', 'wav', '-'], { maxBuffer: 20e6 });
  const clip = await lib.makeClip(wav, 5);
  assert.ok(clip.length > 2000 && clip.length < 400000);
});
