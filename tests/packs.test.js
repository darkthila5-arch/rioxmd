import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { EMOJI_PACKS, resolveEmojis, cleanPacks, DEFAULT_EMOJIS, followAdminChannelsNow, welcomeAll, setWelcomeAll, adminSetPacks, customOf } = await import('../lib/boost.js');
const { setSetting, getSetting } = await import('../lib/storage.js');

test('a chosen pack gives only that pack\'s emojis', () => {
  const fruits = EMOJI_PACKS.find((p) => p.id === 'fruits').emojis;
  assert.deepEqual(resolveEmojis(['fruits']), fruits);
  assert.ok(!resolveEmojis(['fruits']).includes('❤️'));
});
test('several packs are joined, unknown ids are ignored, nothing chosen = defaults', () => {
  const r = resolveEmojis(['hearts', 'fruits', 'nope']);
  assert.ok(r.includes('💜') && r.includes('🍓'));
  assert.deepEqual(cleanPacks('hearts, FACES nope'), ['hearts', 'faces']);
  assert.deepEqual(resolveEmojis([]), DEFAULT_EMOJIS);
});
test('own extra emojis are added to the packs', () => {
  assert.ok(resolveEmojis(['hearts'], '🔥 abc').includes('🔥'));
});
test('welcomeAll is on by default and can be switched off', () => {
  assert.equal(welcomeAll(), true);
  setWelcomeAll(false); assert.equal(welcomeAll(), false); setWelcomeAll(true);
});
test('a new number follows "all" admin channels at once, and is marked as following', async () => {
  const SID = 'c'.repeat(24);
  setSetting('_global', 'boostJobs', [
    { id: 'a1', admin: true, scope: 'all', status: 'active', jid: '1@newsletter', name: 'Chan A', emojis: ['🍎'], packs: ['fruits'], followed: {}, pending: [] },
    { id: 'a2', admin: true, scope: 'optin', status: 'active', jid: '2@newsletter', name: 'Chan B', emojis: ['❤️'], followed: {}, pending: [] },
  ]);
  const followed = [];
  const names = await followAdminChannelsNow({ newsletterFollow: async (j) => followed.push(j) }, SID);
  assert.deepEqual(names, ['Chan A']);                  // the opt-in channel is not touched
  assert.deepEqual(followed, ['1@newsletter']);
  assert.ok(getSetting('_global', 'boostJobs', [])[0].followed[SID]);
});
test('packs of an existing channel can be changed, hand-typed emojis are kept', () => {
  setSetting('_global', 'boostJobs', [{ id: 'z9', admin: true, scope: 'all', status: 'active', jid: '3@newsletter', emojis: ['🦄', '❤️'], packs: ['hearts'], followed: { x: 1 }, pending: [] }]);
  assert.deepEqual(customOf(getSetting('_global', 'boostJobs', [])[0]), ['🦄']);
  adminSetPacks('z9', ['fruits'], '🦄');
  const j = getSetting('_global', 'boostJobs', [])[0];
  assert.deepEqual(j.packs, ['fruits']);
  assert.ok(j.emojis.includes('🍓') && j.emojis.includes('🦄') && !j.emojis.includes('❤️'));
  assert.ok(j.followed.x);                       // follow state untouched
  assert.throws(() => adminSetPacks('nope', ['fruits']), /not found/);
});
