import { useMultiFileAuthState, proto, BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { DEFAULT_MODE, MONGO_DB, MONGO_URL, SESSION_ROOT, sessionPath, sleep, state } from './config.js';

export async function getMongoCol() {
  if (!MONGO_URL) return null;
  if (state.mongoCol) return state.mongoCol;
  if (!state.mongoPending) {
    state.mongoPending = (async () => {
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 15000 });
          await client.connect();
          state.mongoDb = client.db(MONGO_DB);
          const col = state.mongoDb.collection('auth');
          await col.createIndex({ sid: 1 });
          state.mongoCol = col;
          console.log('Auth storage: MongoDB (sessions survive redeploys).');
          return col;
        } catch (err) { lastErr = err; console.error(`MongoDB connect attempt ${i + 1} failed:`, err?.message || err); await sleep(3000); }
      }
      throw lastErr;
    })().finally(() => { state.mongoPending = null; });
  }
  return state.mongoPending;
}

async function useMongoAuthState(col, sid) {
  const id = (k) => `${sid}:${k}`;
  const write = (k, v) => col.updateOne({ _id: id(k) }, { $set: { sid, data: JSON.stringify(v, BufferJSON.replacer) } }, { upsert: true });
  const read = async (k) => {
    const doc = await col.findOne({ _id: id(k) });
    return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
  };
  const remove = (k) => col.deleteOne({ _id: id(k) });

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (keyId) => {
            let value = await read(`${type}-${keyId}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[keyId] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const keyId of Object.keys(data[category])) {
              const value = data[category][keyId];
              const k = `${category}-${keyId}`;
              tasks.push(value ? write(k, value) : remove(k));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write('creds', creds)
  };
}

export async function getAuthState(sid) {
  const col = await getMongoCol(); // throws when MONGO_URL is set but unreachable: never silently fall back to files
  if (col) return useMongoAuthState(col, sid);
  return useMultiFileAuthState(sessionPath(sid));
}

export async function deleteSessionData(sid) {
  try { fs.rmSync(sessionPath(sid), { recursive: true, force: true }); } catch {}
  try { const d = path.join(SESSION_ROOT, '_callmedia'); for (const f of fs.readdirSync(d)) if (f.startsWith(`${sid}.`)) fs.rmSync(path.join(d, f), { force: true }); } catch {} // saved clips + packs
  delete settings[sid];
  clearTimeout(mongoTimers.get(sid)); mongoTimers.delete(sid);
  scheduleDisk();
  try {
    const col = await getMongoCol();
    if (col) {
      await col.deleteMany({ sid });
      await state.mongoDb.collection('settings').deleteOne({ _id: sid });
      await state.mongoDb.collection('callmedia').deleteMany({ sid });
    }
  } catch (err) { console.error('Mongo delete error:', err?.message || err); }
}

export async function isMongoSessionRegistered(col, sid) {
  try {
    const doc = await col.findOne({ _id: `${sid}:creds` });
    return !!doc && JSON.parse(doc.data).registered === true;
  } catch { return false; }
}

/* ---------- per-session settings (public/private mode) ---------- */
const SETTINGS_FILE = path.join(SESSION_ROOT, '_settings.json');
export const settings = {};
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}); } catch {}
export const getSetting = (sid, key, def) => settings[sid]?.[key] ?? def;

// Saving is debounced: many changes in a short time become ONE disk write (and one MongoDB write per session),
// done off the event loop and atomically (temp file + rename) so a crash can never leave a half-written file.
const SAVE_DELAY_MS = 400;
let diskTimer = null, diskWriting = false, diskDirty = false;
const mongoTimers = new Map();

async function writeDisk() {
  if (diskWriting) { diskDirty = true; return; }
  diskWriting = true; diskDirty = false;
  const tmp = `${SETTINGS_FILE}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(settings));
    await fs.promises.rename(tmp, SETTINGS_FILE);
  } catch (err) { console.error('Could not save settings:', err?.message || err); }
  diskWriting = false;
  if (diskDirty) scheduleDisk();
}
function scheduleDisk() {
  if (diskTimer) return;
  diskTimer = setTimeout(() => { diskTimer = null; writeDisk(); }, SAVE_DELAY_MS);
  diskTimer.unref?.();
}
function scheduleMongo(sid) {
  if (!MONGO_URL || mongoTimers.has(sid)) return;
  const t = setTimeout(() => {
    mongoTimers.delete(sid);
    getMongoCol().then(() => state.mongoDb?.collection('settings').updateOne({ _id: sid }, { $set: { data: settings[sid] || {} } }, { upsert: true }))
      .catch((err) => console.error('Mongo settings save error:', err?.message || err));
  }, SAVE_DELAY_MS);
  t.unref?.();
  mongoTimers.set(sid, t);
}
export function setSetting(sid, key, value) {
  settings[sid] = { ...(settings[sid] || {}), [key]: value };
  scheduleDisk();
  scheduleMongo(sid);
}
// Called on shutdown so the last changes are never lost.
export function flushSettings() {
  clearTimeout(diskTimer); diskTimer = null;
  for (const t of mongoTimers.values()) clearTimeout(t);
  mongoTimers.clear();
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (err) { console.error('Could not save settings:', err?.message || err); }
}
export const getMode = (sid) => getSetting(sid, 'mode', DEFAULT_MODE);
export const setMode = (sid, mode) => setSetting(sid, 'mode', mode);
export async function loadMongoSettings() {
  try {
    if (!state.mongoDb) return;
    for await (const d of state.mongoDb.collection('settings').find({})) settings[d._id] = { ...(settings[d._id] || {}), ...(d.data || {}) };
  } catch (err) { console.error('Mongo settings load error:', err?.message || err); }
}
