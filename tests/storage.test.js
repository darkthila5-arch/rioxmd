import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { setSetting, getSetting, flushSettings, getMode, setMode } = await import('../lib/storage.js');
const FILE = path.join(process.env.SESSION_DIR, '_settings.json');
const SID = 'b'.repeat(24);

test('defaults', () => {
  assert.equal(getSetting(SID, 'nothing', 42), 42);
  assert.equal(getMode(SID), 'public');
});
test('many changes in a row become one disk write', async () => {
  const orig = fs.promises.writeFile; let writes = 0;
  fs.promises.writeFile = (...a) => { writes++; return orig(...a); };
  for (let i = 0; i < 300; i++) setSetting(SID, `k${i % 3}`, i);
  await new Promise((r) => setTimeout(r, 900));
  fs.promises.writeFile = orig;
  assert.equal(writes, 1);
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(saved[SID].k0, 297);
  assert.equal(fs.existsSync(`${FILE}.tmp`), false); // atomic: no half-written leftovers
});
test('flushSettings saves immediately (used on shutdown)', () => {
  setMode(SID, 'private');
  flushSettings();
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8'))[SID].mode, 'private');
});
