import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.MAX_DL_MB = '1';   // 1 MB limit for the test
process.env.MAX_DL_JOBS = '3';
const { fetchBuffer, limited, MAX_DL_BYTES } = await import('../lib/downloader.js');

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

test('limit is 1 MB in this test', () => assert.equal(MAX_DL_BYTES, 1048576));

test('a small file downloads completely', async () => {
  const { server, url } = await listen((_q, res) => res.end(Buffer.alloc(200_000, 7)));
  const buf = await fetchBuffer(url);
  server.close();
  assert.equal(buf.length, 200_000);
  assert.equal(buf[0], 7);
});

test('too big (Content-Length says so): refused before downloading', async () => {
  const { server, url } = await listen((_q, res) => { res.setHeader('content-length', 50_000_000); res.write('x'); setTimeout(() => res.destroy(), 200); });
  await assert.rejects(fetchBuffer(url), /TOO_BIG/);
  server.close();
});

test('too big with NO Content-Length: stops reading at the limit instead of loading everything', async () => {
  let sent = 0, stopped = false;
  const { server, url } = await listen((_q, res) => {
    res.on('close', () => { stopped = true; });
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (!stopped && res.writableLength < 1_000_000) { sent += chunk.length; if (!res.write(chunk)) break; if (sent > 200 * 1024 * 1024) return res.end(); }
      if (!stopped && sent <= 200 * 1024 * 1024) res.once('drain', pump);
    };
    pump();
  });
  await assert.rejects(fetchBuffer(url), /TOO_BIG/);
  await new Promise((r) => setTimeout(r, 300));
  server.close();
  assert.ok(stopped, 'server connection was closed by the client');
  assert.ok(sent < 40 * 1024 * 1024, `server pushed ${(sent / 1048576).toFixed(0)} MB (a full read would be 200 MB)`);
});

test('HTTP errors are reported', async () => {
  const { server, url } = await listen((_q, res) => { res.statusCode = 404; res.end('no'); });
  await assert.rejects(fetchBuffer(url), /404/);
  server.close();
});

test('job limiter: 12 jobs, never more than 3 at the same time, all finish, in order of arrival', async () => {
  let running = 0, peak = 0; const order = [];
  const job = (i) => limited(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    order.push(i); running--; return i;
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => job(i)));
  assert.equal(peak, 3);
  assert.deepEqual(results, [...Array(12).keys()]);
  assert.deepEqual(order, [...Array(12).keys()]);
});

test('job limiter: a failing job frees its slot', async () => {
  for (let i = 0; i < 10; i++) await assert.rejects(limited(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limited(async () => 'still works'), 'still works');
});
