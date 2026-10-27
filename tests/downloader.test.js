import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { parseUrl } = await import('../lib/downloader.js');

const ok = {
  tiktok: ['https://www.tiktok.com/@a/video/1', 'https://vm.tiktok.com/abc'],
  facebook: ['https://www.facebook.com/watch?v=1', 'https://fb.watch/abc'],
  pinterest: ['https://www.pinterest.com/pin/1/', 'https://pin.it/abc'],
  instagram: ['https://www.instagram.com/reel/abc/', 'https://instagr.am/p/abc'],
  twitter: ['https://x.com/a/status/1', 'https://twitter.com/a/status/1'],
};
for (const [platform, urls] of Object.entries(ok)) {
  test(`${platform}: accepts its own links`, () => { for (const u of urls) assert.ok(parseUrl(u, platform), u); });
}
test('rejects other sites, look-alike hosts, bad schemes and junk', () => {
  assert.equal(parseUrl('https://www.instagram.com/p/1', 'tiktok'), null);
  assert.equal(parseUrl('https://evil-instagram.com/p/1', 'instagram'), null);
  assert.equal(parseUrl('https://instagram.com.evil.io/p/1', 'instagram'), null);
  assert.equal(parseUrl('file:///etc/passwd', 'tiktok'), null);
  assert.equal(parseUrl('javascript:alert(1)', 'twitter'), null);
  assert.equal(parseUrl('not a url', 'facebook'), null);
  assert.equal(parseUrl(undefined, 'facebook'), null);
  assert.equal(parseUrl('https://x.com/a', 'unknown-platform'), null);
});
