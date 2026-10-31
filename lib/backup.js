// Backup / restore of the linked numbers (WhatsApp login data + settings) as ONE encrypted file.
// The file contains WhatsApp session keys, so it is always encrypted with a passphrase chosen by the admin (AES-256-GCM, scrypt key).
// Not included: saved call clips (can be big) and the audit / login history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { MAX_SESSIONS, SESSION_ROOT, safeId, sessionPath, sessions, sleep, state } from './config.js';
import { getMongoCol, setSetting, settings } from './storage.js';
import { startSession } from './session.js';

const scrypt = promisify(crypto.scrypt), gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MAGIC = 'rio-x-md-backup', VERSION = 1;
export const MIN_PASS = 8;
const MAX_UNPACKED = 200 * 1024 * 1024;
const FILE_NAME = /^[\w@+=\-][\w.@+=\-]{0,300}\.json$/;
const MONGO_KEY = /^[\w.@+=:\-]{1,300}$/;
const SKIP_GLOBAL = new Set(['auditLog', 'loginLog', 'knownAdminIps', 'broadcasts', 'boostJobs']); // history and running jobs are never restored
const kind = () => (state.mongoCol ? 'mongo' : 'files');

async function key(pass, salt) { return scrypt(String(pass), salt, 32); }

async function isRegistered(creds) { try { return JSON.parse(creds).registered === true; } catch { return false; } }

// Linked sessions that exist in storage right now.
async function storedSessionIds() {
  if (state.mongoCol) return (await state.mongoCol.distinct('sid')).filter(safeId);
  let entries = [];
  try { entries = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }); } catch {}
  return entries.filter((e) => e.isDirectory() && safeId(e.name)).map((e) => e.name);
}

export async function createBackup(pass) {
  if (String(pass || '').length < MIN_PASS) throw new Error(`The passphrase needs at least ${MIN_PASS} characters.`);
  await getMongoCol();
  const out = { app: MAGIC, v: VERSION, kind: kind(), created: new Date().toISOString(), sessions: {}, settings: {} };
  let count = 0;
  for (const sid of await storedSessionIds()) {
    const items = [];
    if (state.mongoCol) {
      for await (const d of state.mongoCol.find({ sid })) items.push([String(d._id).slice(sid.length + 1), d.data]);
    } else {
      const dir = sessionPath(sid);
      for (const f of fs.readdirSync(dir)) {
        if (!FILE_NAME.test(f) || f.includes('..')) continue;
        try { items.push([f, fs.readFileSync(path.join(dir, f), 'utf8')]); } catch {}
      }
    }
    const creds = items.find(([k]) => k === (state.mongoCol ? 'creds' : 'creds.json'))?.[1];
    if (!creds || !(await isRegistered(creds))) continue; // unfinished pairing: nothing worth saving
    out.sessions[sid] = items; count++;
    if (settings[sid]) out.settings[sid] = settings[sid];
  }
  if (settings._global) out.settings._global = Object.fromEntries(Object.entries(settings._global).filter(([k]) => !SKIP_GLOBAL.has(k)));
  return { buffer: await seal(out, pass), sessions: count };
}

// Packs and encrypts a backup object into the file format.
export async function seal(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await key(pass, salt), iv);
  const packed = await gzip(Buffer.from(JSON.stringify(obj)));
  const enc = Buffer.concat([cipher.update(packed), cipher.final()]);
  return Buffer.from(JSON.stringify({ app: MAGIC, v: VERSION, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') }));
}

async function open(buffer, pass) {
  let env;
  try { env = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('This is not a RIO X MD backup file.'); }
  if (env?.app !== MAGIC || env.v !== VERSION || typeof env.data !== 'string') throw new Error('This is not a RIO X MD backup file.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', await key(pass, Buffer.from(env.salt, 'base64')), Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const packed = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]);
    return JSON.parse((await gunzip(packed, { maxOutputLength: MAX_UNPACKED })).toString('utf8'));
  } catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}

// Checks a backup without changing anything. Returns what a restore would do.
export async function inspectBackup(buffer, pass) {
  const b = await open(buffer, pass);
  if (b.kind !== kind()) throw new Error(`This backup was made with ${b.kind === 'mongo' ? 'MongoDB' : 'file'} storage, but this server uses ${kind() === 'mongo' ? 'MongoDB' : 'file'} storage.`);
  const ids = Object.keys(b.sessions || {}).filter(safeId);
  return { created: b.created, total: ids.length, existing: ids.filter((id) => sessions.has(id)).length, hasGlobal: !!b.settings?._global, backup: b };
}

export async function restoreBackup(buffer, pass, { restoreGlobal = false, starter = startSession } = {}) {
  const info = await inspectBackup(buffer, pass), b = info.backup;
  const room = Math.max(0, MAX_SESSIONS - sessions.size);
  const todo = [], skipped = { existing: 0, full: 0, invalid: 0 };
  for (const sid of Object.keys(b.sessions || {})) {
    if (!safeId(sid)) { skipped.invalid++; continue; }
    if (sessions.has(sid)) { skipped.existing++; continue; } // a running number is never overwritten
    const items = b.sessions[sid];
    const ok = Array.isArray(items) && items.length <= 5000 && items.every((it) => Array.isArray(it) && typeof it[0] === 'string' && typeof it[1] === 'string' && it[1].length <= 4 * 1024 * 1024 && (state.mongoCol ? MONGO_KEY.test(it[0]) : FILE_NAME.test(it[0]) && !it[0].includes('..')));
    const creds = ok && items.find(([k]) => k === (state.mongoCol ? 'creds' : 'creds.json'))?.[1];
    if (!ok || !creds || !(await isRegistered(creds))) { skipped.invalid++; continue; }
    if (todo.length >= room) { skipped.full++; continue; }
    todo.push(sid);
  }
  for (const sid of todo) {
    const items = b.sessions[sid];
    if (state.mongoCol) {
      for (const [k, data] of items) await state.mongoCol.updateOne({ _id: `${sid}:${k}` }, { $set: { sid, data } }, { upsert: true });
    } else {
      const dir = sessionPath(sid);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, data] of items) { const tmp = path.join(dir, `.${name}.tmp`); fs.writeFileSync(tmp, data); fs.renameSync(tmp, path.join(dir, name)); }
    }
    for (const [k, v] of Object.entries(b.settings?.[sid] || {})) setSetting(sid, k, v);
  }
  if (restoreGlobal && b.settings?._global) for (const [k, v] of Object.entries(b.settings._global)) if (!SKIP_GLOBAL.has(k)) setSetting('_global', k, v);
  // The numbers come online one by one in the background, like after a normal restart.
  (async () => { for (const sid of todo) { try { await starter(sid); } catch (e) { console.error(`Restore: could not start ${sid}:`, e?.message || e); } await sleep(1500); } })();
  return { imported: todo.length, skipped, created: b.created, globalRestored: !!(restoreGlobal && b.settings?._global) };
}
