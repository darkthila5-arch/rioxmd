import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { getCsong, setCsong, makeEqualizerVideo, clipStart } = await import('../lib/csong.js');
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('default look is the normal thumbnail', () => {
  assert.deepEqual(getCsong(), { mode: 'normal', seconds: 8, style: 'white', layout: 'circle', center: 'thumbnail', motion: 'spin', hasImage: false });
});
test('settings are validated and clamped', () => {
  assert.equal(setCsong({ mode: 'equalizer' }).mode, 'equalizer');
  assert.equal(setCsong({ seconds: 999 }).seconds, 30);
  assert.equal(setCsong({ seconds: 1 }).seconds, 4);
  assert.equal(setCsong({ layout: 'bars' }).layout, 'bars');
  assert.throws(() => setCsong({ layout: 'spiral' }), /layout/);
  setCsong({ layout: 'circle' });
  assert.throws(() => setCsong({ style: 'rainbow' }), /colour/);
  assert.equal(setCsong({ center: 'channel' }).center, 'channel');
  assert.throws(() => setCsong({ center: 'moon' }), /centre/);
  assert.throws(() => setCsong({ center: 'custom' }), /picture/); // nothing uploaded yet
  assert.equal(setCsong({ motion: 'pulse' }).motion, 'pulse');
  assert.throws(() => setCsong({ motion: 'dance' }), /motion/);
  setCsong({ center: 'thumbnail', motion: 'spin' });
  assert.throws(() => setCsong({ seconds: 'abc' }), /number/);
  assert.equal(setCsong({ mode: 'whatever' }).mode, 'normal'); // anything unknown = normal
});
test('the clip starts a little way into the song and always inside it', () => {
  assert.equal(clipStart(200, 8), 40);
  assert.equal(clipStart(1000, 8), 60);   // never later than 60 s
  assert.equal(clipStart(20, 8), 4);      // short song: stays inside it
  assert.equal(clipStart(0, 8), 0);       // unknown length: from the start
});
test('every layout makes a silent GIF-style mp4 (640x360, 20 fps), with and without a thumbnail', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const tone = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 });
  const jpg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=1', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-'], { maxBuffer: 1 << 24 });
  for (const layout of ['circle', 'bars']) for (const pic of [jpg, null]) {
    const mp4 = await makeEqualizerVideo(pic, tone, 'mp3', { seconds: 4, style: 'pink', layout, start: 0 });
    assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
    assert.ok(mp4.length > 2000 && mp4.length < 1_500_000, `${layout} size ${mp4.length}`);
    const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate', '-of', 'csv=p=0', '-'], { input: mp4 }).toString().trim();
    assert.equal(info, 'video,640,360,20/1');                  // one stream only: no audio
  }
});
test('broken audio rejects (the command then falls back to the normal thumbnail)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  await assert.rejects(makeEqualizerVideo(null, Buffer.from('not audio'), 'm4a', {}), /ffmpeg/);
});
test('the round layout can show another picture (channel logo) in the middle', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { imageExt } = await import('../lib/csong.js');
  const tone = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 });
  const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=256x256', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'], { maxBuffer: 1 << 24 });
  assert.equal(imageExt(png), 'png');
  assert.equal(imageExt(Buffer.from('not a picture at all')), null);
  const mp4 = await makeEqualizerVideo(null, tone, 'mp3', { seconds: 4, layout: 'circle', badge: png });
  assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
});
test('every motion of the middle picture renders (turning, still, pulsing with the beat, both)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const tone = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 });
  for (const motion of ['spin', 'still', 'pulse', 'both']) {
    const mp4 = await makeEqualizerVideo(null, tone, 'mp3', { seconds: 4, layout: 'circle', motion });
    assert.equal(mp4.subarray(4, 8).toString(), 'ftyp', motion);
  }
});
test('who gets the animation: free numbers never, premium numbers with their own look, the host always', async () => {
  const { resolveCsong, PREMIUM_MAX_S } = await import('../lib/csong.js');
  const { setSetting } = await import('../lib/storage.js');
  setCsong({ mode: 'equalizer', layout: 'circle', seconds: 30, motion: 'spin', center: 'thumbnail' });
  const free = resolveCsong('free1');
  assert.equal(free.allowed, false); assert.equal(free.mode, 'normal');
  const host = resolveCsong('free1', { host: true });
  assert.equal(host.allowed, true); assert.equal(host.mode, 'equalizer'); assert.equal(host.seconds, 30); // the host is not limited
  setSetting('vip', 'premium', { until: Date.now() + 1e7 });
  const vip = resolveCsong('vip');
  assert.equal(vip.allowed, true); assert.equal(vip.mode, 'equalizer'); assert.equal(vip.layout, 'circle'); assert.equal(vip.seconds, PREMIUM_MAX_S); // host default, capped
  setSetting('vip', 'csongEqLayout', 'bars'); setSetting('vip', 'csongEqMotion', 'pulse'); setSetting('vip', 'csongEqSeconds', 9); setSetting('vip', 'csongEqStyle', 'pink');
  const own = resolveCsong('vip');
  assert.deepEqual([own.layout, own.motion, own.seconds, own.style], ['bars', 'pulse', 9, 'pink']);
  setSetting('vip', 'csongMode', 'normal');
  assert.equal(resolveCsong('vip').mode, 'normal');                       // its own choice wins over the host default
  setSetting('vip', 'csongEqCenter', 'custom');
  assert.equal(resolveCsong('vip').center, 'thumbnail');                   // "my own picture" without a picture = thumbnail
  setSetting('vip', 'premium', { until: Date.now() - 1000 });
  assert.equal(resolveCsong('vip').mode, 'normal');                       // premium ended: back to the normal thumbnail
  setCsong({ mode: 'normal', seconds: 8 });
});
test('too many animations at once: the extra one is turned away (the command then posts the normal thumbnail)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const jobs = [1, 2, 3].map(() => makeEqualizerVideo(null, Buffer.from('x'), 'm4a', {}).catch((e) => e.message));
  await assert.rejects(makeEqualizerVideo(null, Buffer.from('x'), 'm4a', {}), /BUSY/);
  await Promise.all(jobs);
});
