import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const weather = await import('../commands/weather.js');
const currency = await import('../commands/currency.js');
const translate = await import('../commands/translate.js');
const adCmd = (await import('../commands/antidelete.js')).default[0];
const ad = await import('../lib/antidelete.js');
const { setSetting } = await import('../lib/storage.js');

const SID = 'd'.repeat(24);
const realFetch = globalThis.fetch;
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
test.afterEach(() => { globalThis.fetch = realFetch; currency.clearRateCache(); });

function ctx(args = [], extra = {}) {
  const out = [];
  return { out, c: { args, sessionId: SID, jid: 'x@s.whatsapp.net', msg: { key: { id: 'M' }, message: { conversation: '.x' } }, reply: async (t) => { out.push(t); }, ...extra } };
}

/* ---------- weather ---------- */
test('weather: no argument shows usage without any network call', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  const { c, out } = ctx([]);
  await weather.default[0].run(c);
  assert.match(out[0], /Usage/);
});
test('weather: formats current weather and 3 day forecast', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).includes('geocoding')) return jsonRes({ results: [{ name: 'Colombo', admin1: 'Western', country: 'Sri Lanka', latitude: 6.93, longitude: 79.85 }] });
    return jsonRes({ current: { temperature_2m: 29.4, apparent_temperature: 33, relative_humidity_2m: 80, wind_speed_10m: 12, precipitation: 0.2, weather_code: 63 },
      daily: { time: ['2026-11-04', '2026-11-05', '2026-11-06'], weather_code: [63, 3, 0], temperature_2m_min: [25, 24, 25], temperature_2m_max: [31, 30, 32], precipitation_probability_max: [80, 40, 10] } });
  };
  const { c, out } = ctx(['Colombo']);
  c.sessionId = 'w'.repeat(24);
  await weather.default[0].run(c);
  assert.match(out[0], /Weather in Colombo, Western, Sri Lanka/);
  assert.match(out[0], /29\.4°C/);
  assert.match(out[0], /Rain/);
  assert.match(out[0], /Today: 25° - 31°C, rain 80%/);
  assert.ok(urls[0].includes('name=Colombo'));
});
test('weather: unknown city and network error give friendly messages', async () => {
  globalThis.fetch = async () => jsonRes({});
  let r = ctx(['Nowhereville']); r.c.sessionId = 'n'.repeat(24); await weather.default[0].run(r.c);
  assert.match(r.out[0], /could not find/);
  globalThis.fetch = async () => { throw new Error('boom'); };
  r = ctx(['Kandy']); r.c.sessionId = 'k'.repeat(24); await weather.default[0].run(r.c);
  assert.match(r.out[0], /Could not get the weather/);
});

/* ---------- currency ---------- */
test('currency: parsing', () => {
  const p = currency.parseCurrency;
  assert.deepEqual(p(['100', 'usd', 'lkr']), { amount: 100, from: 'USD', to: ['LKR'] });
  assert.deepEqual(p(['100usd', 'to', 'lkr', 'eur']), { amount: 100, from: 'USD', to: ['LKR', 'EUR'] });
  assert.deepEqual(p(['1,500', 'usd']), { amount: 1500, from: 'USD', to: ['LKR'] });
  assert.deepEqual(p(['5000', 'lkr']), { amount: 5000, from: 'LKR', to: ['USD'] });
  assert.deepEqual(p(['usd', 'lkr']), { amount: 1, from: 'USD', to: ['LKR'] });
  assert.equal(p([]), null);
  assert.equal(p(['hello', 'world']), null);
  assert.equal(p(['-5', 'usd']), null);
  assert.equal(p(['99999999999999', 'usd']), null);
  assert.equal(p(['1', 'aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh']).to.length, 5, 'targets are capped');
});
test('currency: converts with the fetched rates and caches them', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonRes({ result: 'success', time_last_update_utc: 'Wed, 04 Nov 2026 00:00:01 +0000', rates: { USD: 1, LKR: 300, EUR: 0.9 } }); };
  const run = async (a) => { const { c, out } = ctx(a); await currency.default[0].run(c); return out.join('\n'); };
  const t = await run(['100', 'usd', 'lkr', 'eur']);
  assert.match(t, /100\.00 USD/);
  assert.match(t, /30,000\.00 LKR/);
  assert.match(t, /90\.00 EUR/);
  await run(['5', 'usd', 'lkr']);
  assert.equal(calls, 1, 'second call used the cache');
  assert.match(await run(['5', 'usd', 'zzz']), /do not know the currency/);
});
test('currency: no argument shows usage, api failure is friendly', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  let { c, out } = ctx([]); await currency.default[0].run(c); assert.match(out[0], /Currency converter/);
  globalThis.fetch = async () => jsonRes({}, 500);
  ({ c, out } = ctx(['1', 'usd'])); await currency.default[0].run(c); assert.match(out[0], /Could not get the rate/);
});

/* ---------- translate ---------- */
test('translate: language and text parsing', () => {
  const p = translate.parseTranslate;
  assert.deepEqual(p(['si', 'good', 'morning']), { to: 'si', text: 'good morning' });
  assert.deepEqual(p(['Sinhala', 'hi']), { to: 'si', text: 'hi' });
  assert.deepEqual(p(['good', 'morning']), { to: 'si', text: 'good morning' }); // default: non-Sinhala -> Sinhala
  assert.deepEqual(p(['මම', 'ගෙදර']), { to: 'en', text: 'මම ගෙදර' }); // Sinhala -> English
  assert.deepEqual(p([], 'quoted text'), { to: 'si', text: 'quoted text' });
  assert.deepEqual(p(['ta'], 'quoted text'), { to: 'ta', text: 'quoted text' });
  assert.equal(p(['en'], '').text, '');
  assert.equal(translate.langCode('ZH-cn'), 'zh-CN');
  assert.equal(translate.langCode('hello'), null);
  assert.equal(p(['en', 'x'.repeat(5000)]).text.length, 600);
});
test('translate: google result, reply text and fallback to MyMemory', async () => {
  globalThis.fetch = async (u) => {
    assert.ok(String(u).includes('tl=si'));
    return jsonRes([[['සුභ ', 'good ', null], ['උදෑසනක්', 'morning', null]], null, 'en']);
  };
  const reply = { key: { id: 'M' }, message: { extendedTextMessage: { text: '.tr', contextInfo: { quotedMessage: { conversation: 'good morning' } } } } };
  let { c, out } = ctx([], { msg: reply });
  await translate.default[0].run(c);
  assert.match(out[0], /English → Sinhala/);
  assert.match(out[0], /සුභ උදෑසනක්/);

  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return String(u).includes('google') ? jsonRes({}, 429) : jsonRes({ responseData: { translatedText: 'Good morning' } }); };
  ({ c, out } = ctx(['en', 'සුභ', 'උදෑසනක්']));
  await translate.default[0].run(c);
  assert.match(out[0], /Good morning/);
  assert.ok(seen.some((u) => u.includes('mymemory')));
});
test('translate: no text shows usage with no network', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  const { c, out } = ctx([]); await translate.default[0].run(c); assert.match(out[0], /Translate/);
});

/* ---------- antidelete ---------- */
function fakeSock() {
  const sent = [];
  return { sent, user: { id: '94771234567:5@s.whatsapp.net' }, sendMessage: async (j, content) => { sent.push({ j, content }); return { key: { id: 'z' } }; }, groupMetadata: async () => ({ subject: 'Fun Group' }) };
}
const incoming = (id, message, extra = {}) => ({ key: { remoteJid: '94770000000@s.whatsapp.net', id, fromMe: false, ...(extra.key || {}) }, pushName: 'Nimal', message });
const revoke = (id) => ({ key: { remoteJid: '94770000000@s.whatsapp.net', id: 'R' + id, fromMe: false }, message: { protocolMessage: { type: 0, key: { id } } } });
const tick = () => new Promise((r) => setTimeout(r, 20));

test('antidelete command: status, switch modes (setting is saved), bad argument', async () => {
  let { c, out } = ctx([], { sessionId: 'a'.repeat(24) });
  await adCmd.run(c); assert.match(out[0], /OFF/);
  ({ c, out } = ctx(['on'], { sessionId: 'a'.repeat(24) })); await adCmd.run(c);
  assert.equal(ad.antiDeleteMode('a'.repeat(24)), 'owner');
  ({ c, out } = ctx(['chat'], { sessionId: 'a'.repeat(24) })); await adCmd.run(c);
  assert.equal(ad.antiDeleteMode('a'.repeat(24)), 'chat');
  ({ c, out } = ctx(['nope'], { sessionId: 'a'.repeat(24) })); await adCmd.run(c); assert.match(out[0], /Use:/);
  ({ c, out } = ctx(['off'], { sessionId: 'a'.repeat(24) })); await adCmd.run(c);
  assert.equal(ad.antiDeleteMode('a'.repeat(24)), 'off');
  assert.equal(adCmd.owner, true);
});
test('antidelete: does nothing while switched off', async () => {
  const sid = 'b'.repeat(24), sock = fakeSock();
  ad.antiDeleteSeen(sock, sid, incoming('A1', { conversation: 'secret' }));
  ad.antiDeleteSeen(sock, sid, revoke('A1'));
  await tick();
  assert.equal(sock.sent.length, 0);
});
test('antidelete owner mode: deleted text goes to the own chat', async () => {
  const sid = 'e'.repeat(24), sock = fakeSock();
  setSetting(sid, 'antiDelete', 'owner');
  ad.antiDeleteSeen(sock, sid, incoming('B1', { conversation: 'meka delete karanawa' }));
  ad.antiDeleteSeen(sock, sid, revoke('B1'));
  await tick();
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].j, '94771234567@s.whatsapp.net');
  assert.match(sock.sent[0].content.text, /Deleted message/);
  assert.match(sock.sent[0].content.text, /Nimal \(\+94770000000\)/);
  assert.match(sock.sent[0].content.text, /meka delete karanawa/);
  // the same delete notice again is not reported twice
  ad.antiDeleteSeen(sock, sid, revoke('B1'));
  await tick();
  assert.equal(sock.sent.length, 1);
});
test('antidelete chat mode in a group + media is re-sent', async () => {
  const sid = 'f'.repeat(24), sock = fakeSock();
  setSetting(sid, 'antiDelete', 'chat');
  const g = '1203@g.us';
  const img = { imageMessage: { caption: 'look', mimetype: 'image/jpeg', fileLength: 100 } };
  const m = { key: { remoteJid: g, id: 'C1', fromMe: false, participant: '94779999999@s.whatsapp.net' }, pushName: 'Kamal', message: img };
  // downloadMediaMessage is stubbed by the test environment
  ad.antiDeleteSeen(sock, sid, m);
  await tick();
  ad.antiDeleteSeen(sock, sid, { key: { remoteJid: g, id: 'RC1', fromMe: false, participant: '94779999999@s.whatsapp.net' }, message: { protocolMessage: { type: 0, key: { id: 'C1' } } } });
  await tick(); await tick();
  assert.equal(sock.sent[0].j, g);
  assert.match(sock.sent[0].content.text, /Group: Fun Group/);
  assert.match(sock.sent[0].content.text, /Kamal \(\+94779999999\)/);
  assert.match(sock.sent[0].content.text, /look/);
  assert.ok(sock.sent[1]?.content.image, 'image sent after the header');
});
test('antidelete ignores own messages, view-once, reactions and unknown ids', async () => {
  const sid = 'g'.repeat(24), sock = fakeSock();
  setSetting(sid, 'antiDelete', 'owner');
  ad.antiDeleteSeen(sock, sid, { key: { remoteJid: 'x@s.whatsapp.net', id: 'D1', fromMe: true }, message: { conversation: 'mine' } });
  ad.antiDeleteSeen(sock, sid, incoming('D2', { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true } } } }));
  ad.antiDeleteSeen(sock, sid, incoming('D3', { reactionMessage: { text: '👍' } }));
  for (const id of ['D1', 'D2', 'D3', 'NEVER-SEEN']) ad.antiDeleteSeen(sock, sid, revoke(id));
  await tick();
  assert.equal(sock.sent.length, 0);
});
test('antidelete describe()', () => {
  assert.equal(ad.describe({ conversation: 'hi' }).kind, 'text');
  assert.equal(ad.describe({ extendedTextMessage: { text: 'link' } }).text, 'link');
  assert.equal(ad.describe({ stickerMessage: {} }).kind, 'sticker');
  assert.equal(ad.describe({ ephemeralMessage: { message: { conversation: 'eph' } } }).text, 'eph');
  assert.match(ad.describe({ locationMessage: {} }).label, /Location/);
  assert.equal(ad.describe({ senderKeyDistributionMessage: {} }), null);
});
