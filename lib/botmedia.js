// Bot media set by the host in /admin → Bot media:
//   aliveImg / menuImg  pictures for .alive and .menu
//   aliveVoice          voice note sent right AFTER the alive message
//   aliveNote           round video note sent right AFTER the alive voice
//   callImg             picture sent with the "rejected call" message
//   callMsg             default text for rejected calls (a number's own .setcallmsg still wins)
// Every file comes from the host's gallery (file upload) or from a link. A link is downloaded ONCE when it is saved,
// converted (pictures to JPEG, voice to opus, video note to a square mp4) and kept on disk (+ MongoDB), so sending never waits for a remote host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import express from 'express';
import sharp from 'sharp';
import { MONGO_URL, SESSION_ROOT, sleep, state } from './config.js';
import { getMongoCol, getSetting, setSetting } from './storage.js';

const G = '_global';
const DIR = path.join(SESSION_ROOT, '_botmedia');
const MB = 1024 * 1024;
export const BUILTIN_CALL_MSG = '📵 Sorry, I can\'t take calls right now. Please send a message.';

export const SLOTS = {
  aliveImg:   { kind: 'image', label: 'Alive picture', ext: 'jpg', mime: 'image/jpeg', max: 12 * MB },
  menuImg:    { kind: 'image', label: 'Menu picture', ext: 'jpg', mime: 'image/jpeg', max: 12 * MB },
  aliveVoice: { kind: 'audio', label: 'Alive voice', ext: 'ogg', mime: 'audio/ogg; codecs=opus', max: 20 * MB },
  aliveNote:  { kind: 'video', label: 'Alive video note', ext: 'mp4', mime: 'video/mp4', max: 40 * MB },
  callImg:    { kind: 'image', label: 'Call reject picture', ext: 'jpg', mime: 'image/jpeg', max: 12 * MB },
};
const metaKey = (slot) => `botmedia_${slot}`;
const getMeta = (slot) => getSetting(G, metaKey(slot), null);
const fileOf = (slot) => path.join(DIR, `${slot}.${SLOTS[slot].ext}`);

/* ---------- reading (used by .alive, .menu and the call handler) ---------- */
const cache = new Map(); // slot -> { at, buf }
export async function getBotMedia(slot) {
  const meta = SLOTS[slot] && getMeta(slot);
  if (!meta) return null;
  const c = cache.get(slot);
  if (c && c.at === meta.at) return { meta, buf: c.buf };
  let buf = null;
  try { buf = fs.readFileSync(fileOf(slot)); } catch { /* file lost (redeploy): try MongoDB */ }
  if (!buf && MONGO_URL) {
    try {
      await getMongoCol();
      const doc = await state.mongoDb.collection('callmedia').findOne({ _id: `bot:${slot}` });
      if (doc?.data) {
        buf = Buffer.from(doc.data.buffer ? doc.data.buffer.subarray(0, doc.data.position ?? doc.data.buffer.length) : doc.data);
        try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(slot), buf); } catch {}
      }
    } catch (err) { console.error('Bot media load error:', err?.message || err); }
  }
  if (!buf) return null;
  cache.set(slot, { at: meta.at, buf });
  return { meta, buf };
}
export const getBotImage = async (slot) => (await getBotMedia(slot))?.buf || null; // Buffer or null (= use the built-in picture)
export const getDefaultCallMsg = () => String(getSetting(G, 'botmedia_callMsg', '') || '').trim() || BUILTIN_CALL_MSG;

// After the alive message: the voice note, then the round video note. Each one only if the host saved it and left it switched on.
export async function sendAliveExtras(sock, jid) {
  const voice = await getBotMedia('aliveVoice').catch(() => null);
  if (voice && voice.meta.on !== false) {
    try { await sock.sendMessage(jid, { audio: voice.buf, mimetype: SLOTS.aliveVoice.mime, ptt: true }); }
    catch (err) { console.error('Alive voice error:', err?.message || err); }
    await sleep(700);
  }
  const note = await getBotMedia('aliveNote').catch(() => null);
  if (note && note.meta.on !== false) {
    try { await sock.sendMessage(jid, { video: note.buf, mimetype: 'video/mp4', ptv: true }); }
    catch (err) {
      console.error('Alive video note error, sending a normal video:', err?.message || err);
      try { await sock.sendMessage(jid, { video: note.buf, mimetype: 'video/mp4' }); } catch {}
    }
  }
}

/* ---------- converting ---------- */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 180000, maxBuffer: 4 * MB }, (err, _o, stderr) => {
      if (!err) return resolve();
      if (err.code === 'ENOENT') return reject(new Error('ffmpeg is not installed on the server.'));
      reject(new Error('That file could not be read as audio / video.'));
    });
  });
}
async function viaFile(input, ext, args) { // ffmpeg works on files: temp dir in, temp dir out
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riobm-'));
  const inp = path.join(dir, 'in'), out = path.join(dir, `out.${ext}`);
  try { fs.writeFileSync(inp, input); await ffmpeg(['-i', inp, ...args, out]); return fs.readFileSync(out); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function convert(def, input) {
  if (def.kind === 'image') {
    try { return await sharp(input, { failOn: 'none' }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer(); }
    catch { throw new Error('That is not a picture this site can read. Use a JPG, PNG, WEBP or GIF.'); }
  }
  if (def.kind === 'audio') return viaFile(input, 'ogg', ['-vn', '-t', '300', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1']);
  // round video note: square 480x480, up to 60 s
  return viaFile(input, 'mp4', ['-t', '60', '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=480:480,setsar=1", '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-movflags', '+faststart']);
}

/* ---------- downloading a link (https only, no private addresses) ---------- */
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}
async function checkUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('That is not a valid link.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The link must start with https:// or http://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new Error('That link\'s website was not found.'); })).map((a) => a.address);
  if (!ips.length || ips.some(privateIp)) throw new Error('That link points to a private address.');
  return u;
}
async function grab(url, max) {
  let u = await checkUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(40000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; RIO-X-MD)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = await checkUrl(new URL(res.headers.get('location'), u).href); continue; }
    if (!res.ok) throw new Error(`The link answered HTTP ${res.status}.`);
    if (Number(res.headers.get('content-length')) > max) throw new Error(`The file is too big (max ${Math.round(max / MB)} MB).`);
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > max) throw new Error(`The file is too big (max ${Math.round(max / MB)} MB).`); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many redirects.');
}
async function downloadLink(url, def) {
  try { return await grab(url, def.max); }
  catch (err) {
    if (def.kind !== 'image') throw err;
    // some hosts (catbox.moe) time out from Render: try the same image proxy the menu already uses
    try { return await grab(`https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//i, ''))}&output=jpg`, def.max); } catch { throw err; }
  }
}

/* ---------- saving / removing ---------- */
export async function saveBotMedia(slot, input, { source, url = '', name = '' }) {
  const def = SLOTS[slot];
  if (input.length > def.max) throw new Error(`The file is too big (max ${Math.round(def.max / MB)} MB).`);
  const buf = await convert(def, input);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(slot), buf);
  if (MONGO_URL) {
    try { await getMongoCol(); await state.mongoDb.collection('callmedia').updateOne({ _id: `bot:${slot}` }, { $set: { sid: G, kind: slot, data: buf } }, { upsert: true }); }
    catch (err) { console.error('Bot media save error (MongoDB):', err?.message || err); }
  }
  const meta = { source, url: source === 'link' ? url : '', name: String(name || '').slice(0, 80), bytes: buf.length, at: Date.now(), on: getMeta(slot)?.on !== false };
  setSetting(G, metaKey(slot), meta);
  cache.delete(slot);
  return meta;
}
export async function removeBotMedia(slot) {
  try { fs.rmSync(fileOf(slot), { force: true }); } catch {}
  setSetting(G, metaKey(slot), null);
  cache.delete(slot);
  if (MONGO_URL) { try { await getMongoCol(); await state.mongoDb.collection('callmedia').deleteOne({ _id: `bot:${slot}` }); } catch {} }
}

/* ---------- admin routes ---------- */
export function mountBotMedia(app, { adminAuth, guard, wrap, HttpError, audit }) {
  const view = () => ({
    slots: Object.fromEntries(Object.entries(SLOTS).map(([k, d]) => {
      const m = getMeta(k);
      return [k, { kind: d.kind, label: d.label, set: !!m, source: m?.source || '', url: m?.url || '', name: m?.name || '', kb: m ? Math.max(1, Math.round(m.bytes / 1024)) : 0, at: m?.at || 0, on: m ? m.on !== false : false, maxMb: Math.round(d.max / MB) }];
    })),
    callMsg: { value: String(getSetting(G, 'botmedia_callMsg', '') || ''), builtin: BUILTIN_CALL_MSG },
  });
  const slotOf = (req) => { if (!Object.hasOwn(SLOTS, req.params.slot)) throw new HttpError(404, 'Unknown item.'); return req.params.slot; };
  const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

  app.get('/api/admin/botmedia', adminAuth, (_req, res) => res.json(view()));

  // preview in the admin page (supports Range so audio / video can be scrubbed on every browser)
  app.get('/api/admin/botmedia/:slot/file', adminAuth, wrap(async (req, res) => {
    const slot = slotOf(req);
    const m = await getBotMedia(slot);
    if (!m) throw new HttpError(404, 'Nothing saved yet.');
    const len = m.buf.length, type = SLOTS[slot].mime.split(';')[0];
    res.set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
    if (r && (r[1] || r[2])) {
      let s = r[1] === '' ? Math.max(0, len - Number(r[2])) : Number(r[1]);
      let e = r[1] === '' || r[2] === '' ? len - 1 : Math.min(Number(r[2]), len - 1);
      if (s > e || s >= len) return res.status(416).set('Content-Range', `bytes */${len}`).end();
      return res.status(206).set({ 'Content-Range': `bytes ${s}-${e}/${len}`, 'Content-Length': String(e - s + 1) }).end(m.buf.subarray(s, e + 1));
    }
    res.set('Content-Length', String(len)).end(m.buf);
  }));

  // gallery: the browser sends the raw file as the request body
  app.post('/api/admin/botmedia/:slot/upload', guard, adminAuth, express.raw({ type: () => true, limit: '42mb' }), wrap(async (req, res) => {
    const slot = slotOf(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a file first.');
    let name = ''; try { name = decodeURIComponent(String(req.get('x-rio-name') || '')); } catch {}
    let meta; try { meta = await saveBotMedia(slot, req.body, { source: 'upload', name }); } catch (e) { throw new HttpError(400, e.message || 'Could not save that file.'); }
    audit(`bot media: set ${SLOTS[slot].label}`, `gallery, ${kb(meta.bytes)}`);
    res.json(view());
  }));
  app.post('/api/admin/botmedia/:slot/link', guard, adminAuth, wrap(async (req, res) => {
    const slot = slotOf(req);
    const url = String(req.body?.url || '').trim().slice(0, 1000);
    if (!url) throw new HttpError(400, 'Paste a link first.');
    let meta; try { meta = await saveBotMedia(slot, await downloadLink(url, SLOTS[slot]), { source: 'link', url }); } catch (e) { throw new HttpError(400, e.message || 'Could not use that link.'); }
    audit(`bot media: set ${SLOTS[slot].label}`, `link, ${kb(meta.bytes)}`);
    res.json(view());
  }));
  app.post('/api/admin/botmedia/:slot/toggle', guard, adminAuth, wrap((req, res) => {
    const slot = slotOf(req), m = getMeta(slot);
    if (!m) throw new HttpError(400, 'Save a file first.');
    setSetting(G, metaKey(slot), { ...m, on: req.body?.on !== false });
    audit(`bot media: ${SLOTS[slot].label} ${req.body?.on === false ? 'OFF' : 'ON'}`);
    res.json(view());
  }));
  app.post('/api/admin/botmedia/:slot/remove', guard, adminAuth, wrap(async (req, res) => {
    const slot = slotOf(req);
    await removeBotMedia(slot);
    audit(`bot media: removed ${SLOTS[slot].label}`);
    res.json(view());
  }));
  app.post('/api/admin/botmedia/callmsg', guard, adminAuth, wrap((req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 500);
    setSetting(G, 'botmedia_callMsg', text || null);
    audit('bot media: default call reject message', text ? 'changed' : 'back to built-in');
    res.json(view());
  }));
}
