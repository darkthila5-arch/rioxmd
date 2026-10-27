import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { prettify } = await import('../lib/format.js');
const { parseToggle, formatUptime, unwrapMessage, getText } = await import('../lib/text.js');

test('prettify boxes error / done replies', () => {
  assert.match(prettify('❌ Nope'), /ERROR/);
  assert.match(prettify('✅ Done'), /DONE/);
  assert.match(prettify('🚫 No'), /NOT ALLOWED/);
});
test('prettify leaves code, links and menus alone', () => {
  assert.equal(prettify('```code```'), '```code```');
  assert.equal(prettify('https://x.com/a'), 'https://x.com/a');
  assert.equal(prettify(''), '');
});
test('prettify is fast enough for every reply (80-line menu x500 < 400 ms)', () => {
  const menu = '╭━━━〔 x 〕━━━⬣\n' + Array.from({ length: 80 }, (_, i) => `│ ✦ .cmd${i}`).join('\n');
  const t = performance.now();
  for (let i = 0; i < 500; i++) prettify(menu);
  assert.ok(performance.now() - t < 400);
});
test('parseToggle', () => {
  assert.equal(parseToggle('on'), true);
  assert.equal(parseToggle('OFF'), false);
  assert.equal(parseToggle('maybe'), null);
  assert.equal(parseToggle(undefined), null);
});
test('formatUptime', () => {
  assert.equal(formatUptime(3661), '1h 1m 1s');
  assert.equal(formatUptime(90061), '1d 1h 1m 1s');
});
test('getText reads plain, wrapped and button replies', () => {
  assert.equal(getText({ message: { conversation: '.menu' } }), '.menu');
  assert.equal(getText({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: '.ping' } } } } }), '.ping');
  assert.equal(getText({ message: { buttonsResponseMessage: { selectedButtonId: '.alive' } } }), '.alive');
  const native = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: '.song x' }) } } };
  assert.equal(getText({ message: native }), '.song x');
  assert.deepEqual(unwrapMessage(null), {});
});
