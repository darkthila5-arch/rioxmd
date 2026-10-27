import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { issueWebPassword, checkWebPassword, hasWebPassword, webPasswordVersion, newPassword } = await import('../lib/webpass.js');
const SID = 'a'.repeat(24);

test('password is 12 chars from the safe alphabet', () => {
  assert.match(newPassword(), /^[a-hj-km-np-zA-HJ-NP-Z2-9]{12}$/);
});
test('issue -> check round trip, wrong passwords rejected', async () => {
  assert.equal(hasWebPassword(SID), false);
  assert.equal(await checkWebPassword(SID, 'anything'), false);
  const pw = await issueWebPassword(SID);
  assert.equal(hasWebPassword(SID), true);
  assert.equal(await checkWebPassword(SID, pw), true);
  assert.equal(await checkWebPassword(SID, pw + 'x'), false);
});
test('a new password invalidates the old one and changes the cookie version', async () => {
  const v1 = webPasswordVersion(SID);
  const old = await issueWebPassword(SID);
  const fresh = await issueWebPassword(SID);
  assert.notEqual(webPasswordVersion(SID), v1);
  assert.equal(await checkWebPassword(SID, old), false);
  assert.equal(await checkWebPassword(SID, fresh), true);
});
test('login checks do not freeze the event loop (10 at once, max stall < 60 ms)', async () => {
  let worst = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 5); last = n; }, 5);
  await Promise.all(Array.from({ length: 10 }, (_, i) => checkWebPassword(SID, `wrong${i}`)));
  clearInterval(iv);
  assert.ok(worst < 60, `event loop stalled for ${worst.toFixed(0)} ms`);
});
