import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const qr = await import('../commands/readqr.js');
const media = await import('../lib/mediatools.js');
const cmd = qr.default[0];

// jsqr is a separate package, so these tests give readQr a fake decoder and check what it is fed.
const png = (w = 300, h = 200, bg = '#ffffff') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();

let n = 0;
function ctx(message, sendMessage) {
  const out = [];
  const jid = '94770000000@s.whatsapp.net';
  return { out, c: {
    sock: { sendMessage: sendMessage || (async () => {}) }, jid, sessionId: `q${++n}`.padEnd(24, 'q'), args: [],
    msg: { key: { remoteJid: jid, id: 'M', fromMe: false, participant: 'p' + n }, message },
    reply: async (t) => { out.push(t); }
  } };
}
const imageMsg = (caption = '.readqr', extra = {}) => ({ imageMessage: { caption, mimetype: 'image/png', fileLength: 1000, ...extra } });
const realDownload = media.deps.download;
test.afterEach(() => { media.deps.download = realDownload; });

test('readqr: registered with its aliases', () => {
  assert.equal(cmd.name, 'readqr');
  for (const a of ['scanqr', 'qrread', 'decodeqr']) assert.ok(cmd.aliases.includes(a), a);
});
test('readqr: no photo shows usage; a video is refused', async () => {
  let r = ctx({ conversation: '.readqr' }); await cmd.run(r.c);
  assert.match(r.out[0], /Reply to a photo/);
  r = ctx({ videoMessage: { caption: '.readqr', mimetype: 'video/mp4', fileLength: 10 } }); await cmd.run(r.c);
  assert.match(r.out[0], /photos only/);
});
test('readQr: gives the decoder real RGBA pixels and returns the text', async () => {
  const seen = [];
  const text = await qr.readQr(await png(), (data, w, h, opts) => {
    seen.push({ len: data.length, w, h, opts, type: data.constructor.name });
    return { data: 'https://example.com/x' };
  });
  assert.equal(text, 'https://example.com/x');
  const s = seen[0];
  assert.equal(s.type, 'Uint8ClampedArray');
  assert.ok(s.w > 300); // small pictures are scaled up so tiny codes are easier to find
  assert.equal(s.opts.inversionAttempts, 'attemptBoth');
});
test('readQr: every processing attempt (also the greyscale one) hands over exactly width x height x 4 bytes', async () => {
  const seen = [];
  await qr.readQr(await png(), (data, w, h) => { seen.push(data.length === w * h * 4 && data.constructor.name === 'Uint8ClampedArray'); return null; });
  assert.deepEqual(seen, [true, true, true]);
});
test('toRgba: expands 1, 2, 3 and 4 channel pixels to RGBA', () => {
  assert.deepEqual([...qr.toRgba(Buffer.from([10, 20]), 2, 1, 1)], [10, 10, 10, 255, 20, 20, 20, 255]);
  assert.deepEqual([...qr.toRgba(Buffer.from([10, 99, 20, 98]), 2, 1, 2)], [10, 10, 10, 99, 20, 20, 20, 98]);
  assert.deepEqual([...qr.toRgba(Buffer.from([1, 2, 3, 4, 5, 6]), 2, 1, 3)], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...qr.toRgba(Buffer.from([1, 2, 3, 4]), 1, 1, 4)], [1, 2, 3, 4]);
  assert.throws(() => qr.toRgba(Buffer.from([1]), 2, 2, 3));
});
test('readQr: tries again with another processing when the first try finds nothing', async () => {
  let calls = 0;
  const text = await qr.readQr(await png(), () => (++calls === 3 ? { data: 'found late' } : null));
  assert.equal(text, 'found late');
  assert.equal(calls, 3);
});
test('readQr: no QR gives empty text, a broken picture gives badImage', async () => {
  assert.equal(await qr.readQr(await png(), () => null), '');
  await assert.rejects(() => qr.readQr(Buffer.from('not a picture'), () => null), (e) => e.badImage === true);
});
test('readqr: a picture with no QR code gets a friendly answer', async () => {
  media.deps.download = async () => png();
  const { c, out } = ctx(imageMsg());
  await cmd.run(c);
  assert.equal(out.length, 1);
  assert.match(out[0], /could not find a QR|not installed/i); // "not installed" only if jsqr is missing on this machine
});
// Real end to end check: make a QR picture with the bot's own "qrcode" package and read it back with jsqr. Skipped until both are installed.
const HAS_REAL = await Promise.all([import('jsqr'), import('qrcode')]).then(() => true, () => false);
test('readQr: reads a real QR picture (jsqr + qrcode)', { skip: !HAS_REAL }, async () => {
  const QRCode = (await import('qrcode')).default;
  for (const text of ['https://example.com/hello?x=1', 'WIFI:T:WPA;S:Home;P:secret;;', 'සිංහල 123']) {
    const img = await QRCode.toBuffer(text, { type: 'png', width: 400, margin: 4 });
    assert.equal(await qr.readQr(img), text);
    const small = await sharp(img).resize(90).png().toBuffer(); // tiny picture
    assert.equal(await qr.readQr(small), text);
  }
});
test('qrReplyText: labels the kind, warns about links, cuts very long text', () => {
  assert.match(qr.qrReplyText('https://example.com'), /Link.*\n\nhttps:\/\/example\.com\n\n⚠️ I did not open/s);
  assert.match(qr.qrReplyText('WIFI:T:WPA;S:Home;P:secret;;'), /Wi-Fi/);
  assert.match(qr.qrReplyText('hello'), /Text/);
  assert.doesNotMatch(qr.qrReplyText('hello'), /⚠️/);
  assert.ok(qr.qrReplyText('a'.repeat(9000)).length < 3200);
  assert.equal(qr.qrKind('mailto:a@b.c'), '📧 Email');
  assert.equal(qr.qrKind('tel:+94771234567'), '📞 Phone');
});
test('readqr: a second use right away is asked to wait', async () => {
  media.deps.download = async () => png();
  const r = ctx(imageMsg());
  await cmd.run(r.c);
  r.out.length = 0;
  await cmd.run(r.c);
  assert.match(r.out[0], /One at a time/);
});
