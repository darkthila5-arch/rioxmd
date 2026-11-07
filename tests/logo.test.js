import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const { STYLES, PAGE_SIZE, MAX_NAME, cleanName, logoSvg, renderLogo, styleByKey } = await import('../lib/logomaker.js');
const { registry } = await import('../commands/index.js');
let hasSharp = true;
try { await import('sharp'); } catch { hasSharp = false; }

test('30 styles with unique keys, 3 pages of 10', () => {
  assert.equal(STYLES.length, 30);
  assert.equal(new Set(STYLES.map((s) => s.key)).size, 30);
  assert.equal(PAGE_SIZE, 10);
});
test('cleanName: trims, collapses spaces, cuts long names, drops tags', () => {
  assert.equal(cleanName('  Rio   X  '), 'Rio X');
  assert.equal(cleanName('<b>Rio</b>'), 'b Rio /b');
  assert.equal([...cleanName('x'.repeat(100))].length, MAX_NAME);
  assert.equal(cleanName(''), '');
});
test('every style makes well-formed SVG for short, long, two-word, Sinhala and tricky names', () => {
  for (const name of ['R', 'Rio', 'Rio X Gaming Zone', 'RIO X MD OFFICIAL BOT', 'රියෝ', `A&B "Q" 'z'`]) {
    for (const st of STYLES) {
      const svg = logoSvg(st.key, name, 400);
      assert.match(svg, /^<svg [^>]*viewBox="0 0 800 800"[^>]*>[\s\S]*<\/svg>$/, `${st.key} / ${name}`);
      assert.ok(!/NaN|undefined|Infinity/.test(svg), `${st.key} / ${name} has a bad number`);
    }
  }
});
test('a name with quotes / & is escaped, never raw', () => {
  const svg = logoSvg('neon', `A&B "Q" <i>`, 400);
  assert.ok(!svg.includes('A&B'));
  assert.ok(svg.includes('A&amp;B'));
});
test('unknown style is rejected', () => {
  assert.equal(styleByKey('nope'), null);
  assert.throws(() => logoSvg('nope', 'x'));
});
test('.logo with no name asks for one; .logohd with a wrong style explains', async () => {
  const sent = [];
  const base = { sock: {}, msg: {}, jid: 'j', reply: async (t) => sent.push(t) };
  await registry.get('logo').run({ ...base, args: [] });
  assert.match(sent[0], /Type a name/);
  await registry.get('logohd').run({ ...base, args: ['nope', 'Rio'] });
  assert.match(sent[1], /Styles: neon/);
  assert.ok(registry.get('logo2') && registry.get('logo3') && registry.get('mklogo') === registry.get('logo'));
});
test('renders real pictures (jpeg card + png HD)', { skip: !hasSharp }, async () => {
  const jpg = await renderLogo('gold', 'Rio X', { px: 360, format: 'jpeg' });
  assert.equal(jpg[0], 0xff); assert.ok(jpg.length > 2000);
  const png = await renderLogo('neon', 'රියෝ', { px: 360, format: 'png' });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});
test('.logo sends 10 pictures when buttons are off', { skip: !hasSharp }, async () => {
  const out = [];
  const sock = { sendMessage: async (_j, c) => { out.push(c); return { key: { id: 'x' } }; } };
  await registry.get('logo').run({ sock, msg: {}, jid: 'j', args: ['Rio', 'X'], reply: async () => {} });
  assert.equal(out.filter((c) => c.image).length, 10);
  assert.match(out[0].caption, /logohd neon Rio X/);
  out.length = 0;
  await registry.get('logohd').run({ sock, msg: {}, jid: 'j', args: ['gold', 'Rio', 'X'], reply: async () => {} });
  assert.equal(out[0].mimetype, 'image/png'); assert.match(out[0].fileName, /^Rio_X-gold\.png$/);
});
