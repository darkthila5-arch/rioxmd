import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dictionary = await import('../commands/dictionary.js');
const webtools = await import('../commands/webtools.js');
const mediatools = await import('../commands/mediatools.js');
const lib = await import('../lib/mediatools.js');
const { registry } = await import('../commands/index.js');

const realFetch = globalThis.fetch;
const realDownload = lib.deps.download;
test.afterEach(() => { globalThis.fetch = realFetch; lib.deps.download = realDownload; mediatools.stacks.clear(); });

const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status !== null || spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== null;
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_TESSERACT = spawnSync('tesseract', ['--version'], { stdio: 'ignore' }).status === 0;
const HAS_PDFINFO = spawnSync('pdfinfo', ['-v'], { stdio: 'ignore' }).status !== null;
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== null;

let counter = 0;
function ctx(command, args = [], message = { conversation: `.${command}` }, extra = {}) {
  const out = [];
  const sid = `t${++counter}`.padEnd(24, 'x');
  const sock = {
    user: { id: '94771234567:5@s.whatsapp.net' },
    sendMessage: async (_j, c) => { out.push(c); return { key: { id: 'x' } }; },
    profilePictureUrl: async () => { throw new Error('none'); },
  };
  return {
    out,
    c: {
      sock, jid: '94770000000@s.whatsapp.net', sessionId: sid, args, command,
      msg: { key: { remoteJid: '94770000000@s.whatsapp.net', id: `M${counter}`, fromMe: false, participant: `9477${counter}@s.whatsapp.net` }, message },
      reply: async (t) => { out.push({ reply: t }); return { key: { id: 'r' } }; },
      ...extra,
    },
  };
}
const replies = (out) => out.map((o) => o.reply || '').filter(Boolean).join('\n');
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: new Headers() });

/* ---------- registry ---------- */
test('all new commands are registered with their aliases', () => {
  for (const n of ['define', 'dict', 'meaning', 'wiki', 'wikipedia', 'wp', 'short', 'shorten', 'shorturl', 'ss', 'screenshot', 'ssweb', 'tomp3', 'mp3', 'toaudio', 'topdf', 'pdf', 'imgtopdf', 'ocr', 'totext', 'imgtext']) {
    assert.ok(registry.has(n), n);
  }
});
test('every new command shows usage with no argument and no network', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  for (const n of ['define', 'wiki', 'short', 'ss', 'tomp3', 'topdf', 'ocr']) {
    const { c, out } = ctx(n);
    await registry.get(n).run(c);
    assert.ok(replies(out).length > 20, n);
  }
});

/* ---------- links ---------- */
test('normalizeUrl: accepts normal links, refuses dangerous or local ones', () => {
  const ok = webtools.normalizeUrl;
  assert.equal(ok('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(ok('example.com/page'), 'https://example.com/page');
  assert.equal(ok('www.example.lk.'), 'https://www.example.lk/');
  assert.equal(ok('<https://example.com>'), 'https://example.com/');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'http://localhost:3000', 'http://127.0.0.1/', 'http://192.168.1.1/',
    'http://10.0.0.5/admin', 'http://169.254.169.254/latest', 'http://user:pw@example.com/', 'hello', 'http://[::1]/', 'http://printer.local/', 'http://intranet/', '']) {
    assert.equal(ok(bad), null, bad);
  }
});

/* ---------- .short ---------- */
test('short: is.gd answer is used', async () => {
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({ shorturl: 'https://is.gd/abc123' }); };
  const { c, out } = ctx('short', ['https://example.com/very/long?x=1&y=2']);
  await registry.get('short').run(c);
  assert.match(replies(out), /https:\/\/is\.gd\/abc123/);
  assert.ok(urls[0].startsWith('https://is.gd/create.php?') && urls[0].includes('example.com%2Fvery%2Flong%3Fx%3D1%26y%3D2'));
});
test('short: falls back to TinyURL when is.gd fails; link from the replied message works', async () => {
  globalThis.fetch = async (u) => (String(u).includes('is.gd') ? jsonRes({ errorcode: 3, errormessage: 'rate limit' }, 200) : { ok: true, status: 200, text: async () => 'https://tinyurl.com/yabc\n' });
  const { c, out } = ctx('short', [], { extendedTextMessage: { text: '.short', contextInfo: { quotedMessage: { conversation: 'see https://news.example.org/story/42 now' } } } });
  await registry.get('short').run(c);
  assert.match(replies(out), /https:\/\/tinyurl\.com\/yabc/);
});
test('short: both services down -> friendly error; bad link -> usage', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  let r = ctx('short', ['https://example.com']);
  await registry.get('short').run(r.c);
  assert.match(replies(r.out), /not answering/);
  r = ctx('short', ['javascript:alert(1)']);
  await registry.get('short').run(r.c);
  assert.match(replies(r.out), /Usage/);
});

/* ---------- .ss ---------- */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 1)]);
const imgRes = (buf, type = 'image/png') => ({ ok: true, status: 200, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
test('screenshot: first service fails, second answers; a web page instead of a picture is refused', async () => {
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    if (String(u).includes('thum.io')) return imgRes(Buffer.from('<html>' + 'x'.repeat(3000) + '</html>'), 'text/html');
    return imgRes(PNG);
  };
  const buf = await webtools.screenshot('https://example.com/', true);
  assert.ok(buf.equals(PNG));
  assert.ok(seen[0].includes('thum.io/get/fullpage/width/1280') && seen[1].includes('microlink.io'));
  assert.ok(seen[1].includes('screenshot.fullPage=true'));
});
test('ss command: sends the picture with the link; all services failing gives a friendly error', async () => {
  globalThis.fetch = async () => imgRes(PNG);
  let r = ctx('ss', ['example.com']);
  await registry.get('ss').run(r.c);
  const sent = r.out.find((o) => o.image);
  assert.ok(sent && /https:\/\/example\.com\//.test(sent.caption));
  globalThis.fetch = async () => { throw new Error('down'); };
  r = ctx('ss', ['example.com']);
  await registry.get('ss').run(r.c);
  assert.match(replies(r.out), /Could not take a screenshot/);
});
test('ss command: private addresses are refused before any network call', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  const { c, out } = ctx('ss', ['http://192.168.1.1/admin']);
  await registry.get('ss').run(c);
  assert.match(replies(out), /Usage/);
});

/* ---------- .define ---------- */
const ENTRY = [{ word: 'serendipity', phonetic: '/ˌsɛɹənˈdɪpɪti/', meanings: [
  { partOfSpeech: 'noun', definitions: [{ definition: 'The occurrence of events by chance in a happy way.', example: 'A fortunate serendipity.' }, { definition: 'A second meaning.' }], synonyms: ['luck', 'fortune'] },
  { partOfSpeech: 'verb', definitions: [{ definition: 'A made-up verb sense.' }] }] }];
test('defineText: phonetic, parts of speech, example, synonyms and the Sinhala hint', () => {
  const t = dictionary.defineText(ENTRY);
  assert.match(t, /\*serendipity\*  \/ˌsɛɹənˈdɪpɪti\//);
  assert.match(t, /_noun_/); assert.match(t, /_verb_/);
  assert.match(t, /1\. The occurrence/); assert.match(t, /_e\.g\. A fortunate serendipity\._/);
  assert.match(t, /luck, fortune/); assert.match(t, /\.tr si serendipity/);
});
test('define: finds a word, says so when unknown, explains Sinhala letters, refuses odd input', async () => {
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return String(u).endsWith('/nonexistentword') ? { ok: false, status: 404 } : jsonRes(ENTRY); };
  let r = ctx('define', ['Serendipity']);
  await registry.get('define').run(r.c);
  assert.match(replies(r.out), /happy way/);
  assert.ok(urls[0].endsWith('/entries/en/serendipity'));
  r = ctx('define', ['nonexistentword']);
  await registry.get('define').run(r.c);
  assert.match(replies(r.out), /No meaning found/);
  r = ctx('define', ['අම්මා']);
  await registry.get('define').run(r.c);
  assert.match(replies(r.out), /English words/);
  r = ctx('define', ['a/b;c']);
  await registry.get('define').run(r.c);
  assert.match(replies(r.out), /one English word/);
  globalThis.fetch = async () => { throw new Error('down'); };
  r = ctx('define', ['happy']);
  await registry.get('define').run(r.c);
  assert.match(replies(r.out), /not answering/);
});

/* ---------- .wiki ---------- */
test('parseWiki: language flag, Sinhala / Tamil letters, default English', () => {
  assert.deepEqual(dictionary.parseWiki(['-si', 'colombo']), { lang: 'si', topic: 'colombo' });
  assert.deepEqual(dictionary.parseWiki(['කොළඹ']), { lang: 'si', topic: 'කොළඹ' });
  assert.deepEqual(dictionary.parseWiki(['சென்னை']), { lang: 'ta', topic: 'சென்னை' });
  assert.deepEqual(dictionary.parseWiki(['id', 'card']), { lang: 'en', topic: 'id card' }); // no flag: "id" is just a word
  assert.equal(dictionary.parseWiki([]).topic, '');
});
test('clip: cuts at a sentence end and never inside a word', () => {
  const t = 'First sentence here. Second sentence is a little longer than the first one. Third sentence goes on and on without any end in sight';
  assert.equal(dictionary.clip(t, 80), 'First sentence here. Second sentence is a little longer than the first one.…');
  assert.equal(dictionary.clip(t, 60), 'First sentence here. Second sentence is a little longer…'); // early sentence end is ignored: cut at a word instead
  assert.equal(dictionary.clip('short', 60), 'short');
  assert.ok(!/\s…$/.test(dictionary.clip('word '.repeat(50), 33)));
});
const WIKI_PAGE = { title: 'Sigiriya', extract: 'Sigiriya is an ancient rock fortress in Sri Lanka. It is a UNESCO World Heritage Site.', fullurl: 'https://en.wikipedia.org/wiki/Sigiriya', thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' } };
test('wiki: exact title answers with the picture and the link', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).includes('upload.wikimedia.org')) return imgRes(PNG);
    return jsonRes({ query: { pages: [WIKI_PAGE] } });
  };
  const { c, out } = ctx('wiki', ['Sigiriya']);
  await registry.get('wiki').run(c);
  const sent = out.find((o) => o.image);
  assert.ok(sent, 'picture sent');
  assert.match(sent.caption, /\*Sigiriya\*/); assert.match(sent.caption, /ancient rock fortress/); assert.match(sent.caption, /https:\/\/en\.wikipedia\.org\/wiki\/Sigiriya/);
  assert.ok(urls[0].startsWith('https://en.wikipedia.org/w/api.php?') && urls[0].includes('titles=Sigiriya'));
});
test('wiki: unknown exact title falls back to search; Sinhala letters use si.wikipedia.org; no picture = text reply', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (/[?&]titles=/.test(String(u))) return jsonRes({ query: { pages: [{ title: 'x', missing: true }] } });
    return jsonRes({ query: { pages: [{ ...WIKI_PAGE, thumbnail: undefined, fullurl: 'https://si.wikipedia.org/wiki/x' }] } });
  };
  const { c, out } = ctx('wiki', ['සීගිරිය']);
  await registry.get('wiki').run(c);
  assert.ok(urls[0].startsWith('https://si.wikipedia.org/') && urls[1].includes('generator=search'));
  assert.match(replies(out), /ancient rock fortress/);
  assert.ok(!out.some((o) => o.image));
});
test('wiki: not found, disambiguation hint, service error', async () => {
  globalThis.fetch = async () => jsonRes({ batchcomplete: true });
  let r = ctx('wiki', ['qwertyuiopasdf']);
  await registry.get('wiki').run(r.c);
  assert.match(replies(r.out), /Nothing found/);
  globalThis.fetch = async () => jsonRes({ query: { pages: [{ ...WIKI_PAGE, thumbnail: undefined, pageprops: { disambiguation: '' } }] } });
  r = ctx('wiki', ['Mercury']);
  await registry.get('wiki').run(r.c);
  assert.match(replies(r.out), /Be more specific/);
  globalThis.fetch = async () => { throw new Error('down'); };
  r = ctx('wiki', ['Colombo']);
  await registry.get('wiki').run(r.c);
  assert.match(replies(r.out), /not answering/);
});
test('wiki: only Wikimedia picture hosts are downloaded', async () => {
  const hit = [];
  globalThis.fetch = async (u) => {
    hit.push(String(u));
    return jsonRes({ query: { pages: [{ ...WIKI_PAGE, thumbnail: { source: 'https://evil.example.com/p.png' } }] } });
  };
  const { c, out } = ctx('wiki', ['Sigiriya']);
  await registry.get('wiki').run(c);
  assert.ok(!hit.some((u) => u.includes('evil.example.com')));
  assert.ok(!out.some((o) => o.image));
});

/* ---------- PDF writer ---------- */
async function jpegPage(w, h, color = '#336699') {
  const jpeg = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
  return { jpeg, width: w, height: h };
}
test('pageLayout: A4 portrait / landscape with margins; long screenshots keep their own shape', () => {
  let L = lib.pageLayout(3000, 4000);
  assert.ok(Math.abs(L.pw - 595.28) < 0.01 && Math.abs(L.ph - 841.89) < 0.01);
  assert.ok(L.x >= 24 - 0.01 && L.y >= 24 - 0.01 && L.dw <= L.pw - 47.9 && L.dh <= L.ph - 47.9);
  L = lib.pageLayout(4000, 3000);
  assert.ok(L.pw > L.ph);
  L = lib.pageLayout(1000, 5000); // long chat screenshot
  assert.ok(Math.abs(L.pw - 595.28) < 0.01 && Math.abs(L.ph - 2976.4) < 0.5 && L.x === 0 && L.y === 0);
  L = lib.pageLayout(10, 100000);
  assert.ok(L.ph <= 14400.001);
});
test('buildPdf: valid structure, every xref offset points at its object', async () => {
  const pdf = lib.buildPdf([await jpegPage(300, 400), await jpegPage(400, 300, '#aa3333'), await jpegPage(200, 1200)], { title: 'My Notes (1)' });
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 3/);
  assert.match(text, /\/Title \(My Notes 1\)/);
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref');
  const entries = text.slice(xrefAt).split('\n').filter((l) => /^\d{10} 00000 n $/.test(l));
  assert.equal(entries.length, 3 + 9);
  entries.forEach((e, i) => assert.equal(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.throws(() => lib.buildPdf([]), /no pages/);
  assert.throws(() => lib.buildPdf([{ jpeg: Buffer.from('nope'), width: 1, height: 1 }]), /JPEG/);
});
test('buildPdf: poppler reads it (page count, sizes)', { skip: !HAS_PDFINFO }, async () => {
  const file = path.join(os.tmpdir(), `rio-test-${process.pid}.pdf`);
  fs.writeFileSync(file, lib.buildPdf([await jpegPage(600, 800), await jpegPage(800, 600)]));
  try {
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '2', file]).toString();
    assert.match(info, /Pages:\s+2/);
    assert.match(info, /Page\s+1 size:\s+595\.28 x 841\.89/);
    assert.match(info, /Page\s+2 size:\s+841\.89 x 595\.28/);
    const png = execFileSync('pdftoppm', ['-png', '-r', '30', '-f', '1', '-l', '1', file]);
    assert.ok(png.length > 100); // renders without error
  } finally { fs.rmSync(file, { force: true }); }
});

/* ---------- .topdf ---------- */
async function photo(w = 640, h = 480, color = '#2a7') {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}
const imageMsg = (caption = '.topdf') => ({ imageMessage: { caption, mimetype: 'image/jpeg', fileLength: 1000 } });
const quotedImage = () => ({ extendedTextMessage: { text: '.topdf', contextInfo: { stanzaId: 'Q1', participant: '94772222222@s.whatsapp.net', quotedMessage: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1000 } } } } });

test('topdf: collect photos one by one, then done makes one PDF and empties the list', async () => {
  lib.deps.download = async () => photo();
  const first = ctx('topdf', [], imageMsg());
  await registry.get('topdf').run(first.c);
  assert.match(replies(first.out), /Page \*?1\*? added/);
  const sameUser = (r) => { r.c.sessionId = first.c.sessionId; r.c.msg.key.participant = first.c.msg.key.participant; return r; };
  const second = sameUser(ctx('topdf', [], quotedImage()));
  await registry.get('topdf').run(second.c);
  assert.match(replies(second.out), /Page \*?2\*? added/);
  const st = sameUser(ctx('topdf', ['status']));
  await registry.get('topdf').run(st.c);
  assert.match(replies(st.out), /2 page/);
  const done = sameUser(ctx('topdf', ['done', 'My', 'Notes']));
  await registry.get('topdf').run(done.c);
  const doc = done.out.find((o) => o.document);
  assert.ok(doc, 'PDF sent');
  assert.equal(doc.mimetype, 'application/pdf'); assert.equal(doc.fileName, 'My_Notes.pdf'); assert.match(doc.caption, /2 page/);
  assert.equal(doc.document.toString('latin1', 0, 5), '%PDF-'); assert.match(doc.document.toString('latin1'), /\/Count 2/);
  assert.equal(mediatools.stacks.size, 0);
  const again = sameUser(ctx('topdf', ['done']));
  await registry.get('topdf').run(again.c);
  assert.match(replies(again.out), /Photos & text → PDF/); // nothing left: usage
});
test('topdf: now = one photo straight to a PDF; clear empties; other people have their own list; video is refused', async () => {
  lib.deps.download = async () => photo();
  const one = ctx('topdf', ['now'], imageMsg('.topdf now'));
  await registry.get('topdf').run(one.c);
  assert.equal(one.out.filter((o) => o.document).length, 1);
  assert.match(one.out.find((o) => o.document).fileName, /^RioXMD-\d{4}-\d{2}-\d{2}\.pdf$/);

  const a = ctx('topdf', [], imageMsg()); await registry.get('topdf').run(a.c);
  const b = ctx('topdf', ['status']); await registry.get('topdf').run(b.c); // different person
  assert.doesNotMatch(replies(b.out), /1 page/);
  a.c.args = ['clear']; a.out.length = 0;
  await registry.get('topdf').run(a.c);
  assert.match(replies(a.out), /Cleared 1 page/);

  const v = ctx('topdf', [], { videoMessage: { caption: '.topdf', mimetype: 'video/mp4', fileLength: 1000 } });
  await registry.get('topdf').run(v.c);
  assert.match(replies(v.out), /photos only/);
});
test('topdf: not a picture / file too big give friendly errors', async () => {
  lib.deps.download = async () => Buffer.from('this is not an image');
  let r = ctx('topdf', [], imageMsg()); await registry.get('topdf').run(r.c);
  assert.match(replies(r.out), /could not read that picture/);
  r = ctx('topdf', [], { imageMessage: { caption: '.topdf', mimetype: 'image/jpeg', fileLength: 500 * 1048576 } });
  await registry.get('topdf').run(r.c);
  assert.match(replies(r.out), /bigger than/);
});
test('topdf: stops at the page limit', async () => {
  lib.deps.download = async () => photo(50, 50);
  const r = ctx('topdf', [], imageMsg());
  for (let i = 0; i < lib.MAX_PDF_PAGES; i++) { r.out.length = 0; r.c.msg.key.id = `p${i}`; await registry.get('topdf').run(r.c); await new Promise((ok) => setTimeout(ok, 5)); }
  r.out.length = 0;
  await registry.get('topdf').run(r.c);
  assert.match(replies(r.out), /already \d+ pages/);
});
test('pageLayout: a footer reserve keeps the picture clear of the bottom band', () => {
  let L = lib.pageLayout(3000, 4000, lib.FOOTER_RESERVE);
  assert.ok(L.y >= lib.FOOTER_RESERVE + 24 - 0.01 && L.y + L.dh <= 841.89 - 24 + 0.01);
  L = lib.pageLayout(1000, 5000, lib.FOOTER_RESERVE); // long screenshot: the page grows by the band, the picture keeps its size
  assert.ok(Math.abs(L.ph - (2976.4 + lib.FOOTER_RESERVE)) < 0.5 && L.y === lib.FOOTER_RESERVE && Math.abs(L.dh - 2976.4) < 0.5);
  L = lib.pageLayout(10, 100000, lib.FOOTER_RESERVE);
  assert.ok(L.ph <= 14400.001);
});
test('buildPdf: footer text and "n / total" on every page; valid xref; no footer = old output', { skip: !HAS_PDFINFO || !HAS_PDFTOTEXT }, async () => {
  const pages = [await jpegPage(600, 800), await jpegPage(800, 600), await jpegPage(200, 1200)];
  const plain = lib.buildPdf(pages).toString('latin1');
  assert.doesNotMatch(plain, /Helvetica/);
  const pdf = lib.buildPdf(pages, { pageNumbers: true, footer: { text: 'Powered by RIO X MD (test)' } }); // no picture: plain Helvetica footer
  const text = pdf.toString('latin1');
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  const entries = text.slice(xrefAt).split('\n').filter((l) => /^\d{10} 00000 n $/.test(l));
  assert.equal(entries.length, 3 + 9 + 1);
  entries.forEach((e, i) => assert.equal(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  const file = path.join(os.tmpdir(), `rio-test-foot-${process.pid}.pdf`);
  fs.writeFileSync(file, pdf);
  try {
    const out = execFileSync('pdftotext', [file, '-']).toString();
    for (const n of [1, 2, 3]) assert.match(out, new RegExp(`${n}\\s*/\\s*3`));
    assert.equal((out.match(/Powered by RIO X MD/g) || []).length, 3);
    assert.match(execFileSync('pdfinfo', [file]).toString(), /Pages:\s+3/);
  } finally { fs.rmSync(file, { force: true }); }
  const withPic = lib.buildPdf(pages, { pageNumbers: true, footer: { text: 'x', image: { ...(await jpegPage(400, 40, '#ffffff')), dpi: 300 } } });
  assert.match(withPic.toString('latin1'), /\/Ft \d+ 0 R/);
});
test('splitRows: pages are cut in the gaps between lines and never taller than the page', () => {
  const ink = new Uint32Array(400);
  for (let l = 0; l < 10; l++) for (let r = 0; r < 20; r++) ink[l * 40 + r + 5] = 3; // 10 lines of 20 rows, gaps of 20 rows
  const ranges = lib.splitRows(ink, 150);
  assert.ok(ranges.length >= 3);
  for (const [a, b] of ranges) { assert.ok(b - a <= 150); assert.equal(ink[b - 1], 0); }
  assert.equal(ranges.at(-1)[1], 400);
  const solid = lib.splitRows(new Uint32Array(1000).fill(5), 300); // no gap anywhere: still finishes
  assert.ok(solid.every(([a, b]) => b - a <= 300) && solid.at(-1)[1] === 1000);
  assert.deepEqual(lib.splitRows(new Uint32Array(50), 300), []);
});
test('prepText: cleans the text and caps it', () => {
  assert.equal(lib.prepText('a\r\n\r\n\r\n\r\nb\t<x>&  \n').text, 'a\n\nb    <x>&');
  const long = lib.prepText('x'.repeat(lib.MAX_TEXT_CHARS + 500));
  assert.equal(long.text.length, lib.MAX_TEXT_CHARS); assert.ok(long.truncated);
  assert.equal(lib.prepText('l\n'.repeat(400)).text.split('\n').length, 250);
  assert.equal(lib.prepText('  \n ').text, '');
});
test('renderTextPages: text (with markup characters and Sinhala) becomes JPEG pages; long text goes on more pages', async () => {
  await assert.rejects(() => lib.renderTextPages('   '), (e) => e.noText === true);
  const one = await lib.renderTextPages('Hello <b>world</b> & friends\nආයුබෝවන්');
  assert.equal(one.pages.length, 1);
  assert.equal(one.pages[0].jpeg[0], 0xff); assert.equal(one.pages[0].jpeg[1], 0xd8);
  const many = await lib.renderTextPages(Array.from({ length: 120 }, (_, i) => `Line number ${i + 1} of the long text`).join('\n'));
  assert.ok(many.pages.length >= 2 && many.pages.length <= 5);
  const capped = await lib.renderTextPages(Array.from({ length: 120 }, (_, i) => `Line ${i}`).join('\n'), { maxPages: 1 });
  assert.equal(capped.pages.length, 1); assert.equal(capped.truncated, true);
  const f = await lib.renderFooterImage('© Powered by RIO X MD');
  assert.ok(f === null || (f.jpeg[0] === 0xff && f.width > 20 && f.height > 5 && f.dpi === 300));
});
test('topdf text: text pages mixed with photos, quoted text, plain reply, empty text, then done adds footer + page numbers', async () => {
  lib.deps.download = async () => photo();
  const first = ctx('topdf', ['text', 'Hello', 'world'], { conversation: '.topdf text Hello world\nsecond line <b> & more' });
  await registry.get('topdf').run(first.c);
  assert.match(replies(first.out), /Page \*1\* added \(text\)/);
  const sameUser = (r) => { r.c.sessionId = first.c.sessionId; r.c.msg.key.participant = first.c.msg.key.participant; return r; };
  const photoAdd = sameUser(ctx('topdf', [], imageMsg()));
  await registry.get('topdf').run(photoAdd.c);
  assert.match(replies(photoAdd.out), /Page \*?2\*? added/);
  const quoted = sameUser(ctx('topdf', ['text'], { extendedTextMessage: { text: '.topdf text', contextInfo: { stanzaId: 'Q9', participant: '94772222222@s.whatsapp.net', quotedMessage: { conversation: 'Quoted words' } } } }));
  await registry.get('topdf').run(quoted.c);
  assert.match(replies(quoted.out), /Page \*3\* added \(text\)/);
  const plain = sameUser(ctx('topdf', [], { extendedTextMessage: { text: '.topdf', contextInfo: { stanzaId: 'Q8', participant: '94772222222@s.whatsapp.net', quotedMessage: { conversation: 'Another quoted text' } } } }));
  await registry.get('topdf').run(plain.c);
  assert.match(replies(plain.out), /Page \*4\* added \(text\)/);
  const empty = sameUser(ctx('topdf', ['text'], { conversation: '.topdf text' }));
  await registry.get('topdf').run(empty.c);
  assert.match(replies(empty.out), /Photos & text → PDF/);
  const done = sameUser(ctx('topdf', ['done', 'Mixed']));
  await registry.get('topdf').run(done.c);
  const doc = done.out.find((o) => o.document);
  assert.ok(doc, 'PDF sent');
  assert.match(doc.caption, /4 page/);
  const pdf = doc.document.toString('latin1');
  assert.match(pdf, /\/Count 4/);
  assert.match(pdf, /Helvetica/); // page numbers are real text
  if (HAS_PDFTOTEXT) {
    const file = path.join(os.tmpdir(), `rio-test-mixed-${process.pid}.pdf`);
    fs.writeFileSync(file, doc.document);
    try { const out = execFileSync('pdftotext', [file, '-']).toString(); for (const n of [1, 2, 3, 4]) assert.match(out, new RegExp(`${n}\\s*/\\s*4`)); } finally { fs.rmSync(file, { force: true }); }
  }
});
test('topdf text: long text is split over pages, too-long text is cut with a warning, page limit is respected', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `Line number ${i + 1} of the long text`).join('\n');
  const a = ctx('topdf', ['text'], { conversation: `.topdf text ${lines}` });
  await registry.get('topdf').run(a.c);
  assert.match(replies(a.out), /Pages \*1–\d+\* added \(text\)/);
  const b = ctx('topdf', ['text'], { conversation: `.topdf text ${'word '.repeat(3000)}` });
  await registry.get('topdf').run(b.c);
  assert.match(replies(b.out), /too long/);
});

test('pdfName: safe file names', () => {
  assert.equal(mediatools.pdfName(['My', 'Notes.pdf']), 'My_Notes');
  assert.equal(mediatools.pdfName(['../../etc/passwd']), 'etcpasswd');
  assert.equal(mediatools.pdfName(['ආයුබෝවන්']).length > 0, true);
  assert.match(mediatools.pdfName([]), /^RioXMD-/);
});

/* ---------- .tomp3 (real ffmpeg) ---------- */
function makeMedia(args) { return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 20 * 1048576 }); }
test('tomp3: a voice note / audio becomes an MP3, as audio or as a file', { skip: !HAS_FFMPEG }, async () => {
  const tmp = path.join(os.tmpdir(), `rio-wav-${process.pid}.wav`);
  makeMedia(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', tmp]);
  const wav = fs.readFileSync(tmp); fs.rmSync(tmp);
  lib.deps.download = async () => wav;
  let r = ctx('tomp3', [], { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: wav.length } });
  await registry.get('tomp3').run(r.c);
  const sent = r.out.find((o) => o.audio);
  assert.ok(sent, replies(r.out));
  assert.equal(sent.mimetype, 'audio/mpeg');
  assert.ok(sent.audio[0] === 0xff || sent.audio.toString('latin1', 0, 3) === 'ID3'); // MP3 frame sync or tag
  assert.ok(sent.audio.length > 4000);
  r = ctx('tomp3', ['doc'], { documentMessage: { mimetype: 'audio/wav', fileName: 'my song.wav', fileLength: wav.length } });
  await registry.get('tomp3').run(r.c);
  assert.equal(r.out.find((o) => o.document)?.fileName, 'my song.mp3');
});
test('tomp3: a video with no sound says so; a photo is refused', { skip: !HAS_FFMPEG }, async () => {
  const tmp = path.join(os.tmpdir(), `rio-mute-${process.pid}.mp4`);
  makeMedia(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-pix_fmt', 'yuv420p', tmp]);
  const mute = fs.readFileSync(tmp); fs.rmSync(tmp);
  lib.deps.download = async () => mute;
  let r = ctx('tomp3', [], { videoMessage: { caption: '.tomp3', mimetype: 'video/mp4', fileLength: mute.length } });
  await registry.get('tomp3').run(r.c);
  assert.match(replies(r.out), /no sound/);
  r = ctx('tomp3', [], imageMsg('.tomp3'));
  await registry.get('tomp3').run(r.c);
  assert.match(replies(r.out), /not a video or audio/);
});

/* ---------- .ocr (real tesseract) ---------- */
test('parseOcrLang / cleanOcrText', () => {
  assert.deepEqual(lib.parseOcrLang('si'), ['sin']);
  assert.deepEqual(lib.parseOcrLang('EN'), ['eng']);
  assert.deepEqual(lib.parseOcrLang('si+en'), ['sin', 'eng']);
  assert.deepEqual(lib.parseOcrLang('tamil'), ['tam']);
  assert.equal(lib.parseOcrLang('klingon'), null);
  assert.equal(lib.parseOcrLang('si+xx'), null);
  assert.equal(lib.parseOcrLang(''), null);
  assert.equal(lib.cleanOcrText('a  \n\n\n\nb\f\r\n'), 'a\n\nb');
});
async function textImage(text, size = 54) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="260"><rect width="100%" height="100%" fill="white"/><text x="40" y="110" font-family="DejaVu Sans, sans-serif" font-size="${size}" fill="black">${text}</text><text x="40" y="190" font-family="DejaVu Sans, sans-serif" font-size="${size}" fill="black">Second line 12345</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
test('ocr: reads English text from a picture and sends it as plain text', { skip: !HAS_TESSERACT }, async () => {
  lib.resetOcrLangs();
  const img = await textImage('Hello RIO bot reading');
  lib.deps.download = async () => img;
  globalThis.fetch = async () => { throw new Error('offline'); }; // the reply card tries to download a picture: not in tests
  const r = ctx('ocr', ['en'], imageMsg('.ocr en'));
  await registry.get('ocr').run(r.c);
  const text = r.out.map((o) => o.text || '').join('\n');
  assert.match(text, /Hello RIO bot reading/i);
  assert.match(text, /Second line 12345/);
});
test('ocr: missing language data, unknown language and wrong media are explained', { skip: !HAS_TESSERACT }, async () => {
  lib.resetOcrLangs();
  lib.deps.download = async () => textImage('Hello');
  globalThis.fetch = async () => { throw new Error('offline'); };
  const have = await lib.ocrLangs();
  let r = ctx('ocr', ['ta'], imageMsg('.ocr ta'));
  await registry.get('ocr').run(r.c);
  if (!have.has('tam')) assert.match(replies(r.out), /Tamil language data is not installed/);
  r = ctx('ocr', ['klingon'], imageMsg('.ocr klingon'));
  await registry.get('ocr').run(r.c);
  assert.match(replies(r.out), /do not know the language/);
  r = ctx('ocr', [], { videoMessage: { caption: '.ocr', mimetype: 'video/mp4', fileLength: 10 } });
  await registry.get('ocr').run(r.c);
  assert.match(replies(r.out), /photos only/);
});
test('ocr: a picture with no text says so', { skip: !HAS_TESSERACT }, async () => {
  lib.resetOcrLangs();
  lib.deps.download = async () => sharp({ create: { width: 800, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer();
  globalThis.fetch = async () => { throw new Error('offline'); };
  const r = ctx('ocr', ['en'], imageMsg('.ocr en'));
  await registry.get('ocr').run(r.c);
  assert.match(replies(r.out), /No text found/);
});
