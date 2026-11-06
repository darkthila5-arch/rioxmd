import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const ai = await import('../commands/ai.js');
const { registry } = await import('../commands/index.js');
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

let n = 0;
function ctx(args = [], extra = {}) {
  const out = [];
  return { out, c: { sock: {}, jid: '94770000000@s.whatsapp.net', sessionId: `ai${++n}`, args, msg: { key: { id: `A${n}`, participant: `9477${n}@s.whatsapp.net` }, message: { conversation: '.x' } }, reply: async (t) => { out.push(t); }, ...extra } };
}
const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('AI commands are registered with aliases', () => {
  for (const x of ['gpt4', 'nexagpt', 'blackbox', 'blackboxai', 'claudeai', 'claude', 'googleans', 'gans', 'addai', 'delai']) assert.ok(registry.has(x), x);
});
test('chat commands show usage with no question and make no request', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  for (const x of ['gpt4', 'blackbox', 'claudeai', 'googleans']) {
    const { c, out } = ctx();
    await registry.get(x).run(c);
    assert.match(out[0], /Usage/);
  }
});
test('pickAnswer finds the text in different shapes', () => {
  assert.equal(ai.pickAnswer({ result: 'a' }), 'a');
  assert.equal(ai.pickAnswer({ data: { message: { text: 'deep' } } }), 'deep');
  assert.equal(ai.pickAnswer({ status: true }), '');
  assert.equal(ai.pickAnswer('plain'), 'plain');
});
test('askAI sends the question in the right parameter and returns the answer', async () => {
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return res({ result: 'hello' }); };
  assert.equal(await ai.askAI('gpt4', 'hi there'), 'hello');
  assert.match(seen[0], /[?&]q=hi\+there/);
  await ai.askAI('blackbox', 'x'); assert.match(seen[1], /[?&]query=x/);
  await ai.askAI('claude', 'x'); assert.match(seen[2], /[?&]prompt=x/);
});
test('askAI does not retry a claude request on 503', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res('down', 503); };
  await assert.rejects(ai.askAI('claude', 'x'));
  assert.equal(calls, 1);
});
test('the command answers, and a second question right away is refused', async () => {
  globalThis.fetch = async () => res({ answer: 'forty two' });
  const { c, out } = ctx(['meaning', 'of', 'life']);
  await registry.get('gpt4').run(c);
  assert.equal(out[0], 'forty two');
  await registry.get('gpt4').run(c);
  assert.match(out[1], /wait/i);
});
test('a failing API gives a friendly message, not the raw error', async () => {
  globalThis.fetch = async () => res('boom', 500);
  const { c, out } = ctx(['x'], {});
  await registry.get('claudeai').run(c);
  assert.match(out[0], /could not answer/);
  assert.doesNotMatch(out[0], /boom|HTTP/);
});
test('clip cuts long answers on a sentence', () => {
  const t = ai.clip('Hello world. '.repeat(500), 100);
  assert.ok(t.length <= 101 && t.endsWith('.') || t.endsWith('…'));
});
test('parseDuckHtml reads title, url and snippet', () => {
  const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">Ex &amp; Co</a> x <a class="result__snippet" href="#">A <b>snippet</b></a>';
  assert.deepEqual(ai.parseDuckHtml(html), [{ title: 'Ex & Co', url: 'https://example.com/a', snippet: 'A snippet' }]);
});
test('addai needs a group', async () => {
  const { c, out } = ctx();
  await registry.get('addai').run(c);
  assert.match(out[0], /only works in groups/);
});
