import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const { getCsong, setCsong, makeEqualizerVideo } = await import('../lib/csong.js');
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('default look is the normal thumbnail', () => {
  assert.deepEqual(getCsong(), { mode: 'normal', seconds: 30, style: 'cyan' });
});
test('settings are validated and clamped', () => {
  assert.equal(setCsong({ mode: 'equalizer' }).mode, 'equalizer');
  assert.equal(setCsong({ seconds: 999 }).seconds, 60);
  assert.equal(setCsong({ seconds: 1 }).seconds, 8);
  assert.throws(() => setCsong({ style: 'rainbow' }), /colour/);
  assert.throws(() => setCsong({ seconds: 'abc' }), /number/);
  assert.equal(setCsong({ mode: 'whatever' }).mode, 'normal'); // anything unknown = normal
});
test('the equalizer clip is a real mp4 with video + audio', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const tone = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=3:c=pink', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 });
  const jpg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=1', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-'], { maxBuffer: 1 << 24 });
  for (const pic of [jpg, null]) { // with a thumbnail, and without one (plain background)
    const mp4 = await makeEqualizerVideo(pic, tone, 'mp3', { seconds: 8, style: 'pink' });
    assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
    assert.ok(mp4.length > 2000 && mp4.length < 1_500_000);
  }
});
test('broken audio rejects (the command then falls back to the normal thumbnail)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  await assert.rejects(makeEqualizerVideo(null, Buffer.from('not audio'), 'm4a', {}), /ffmpeg/);
});
