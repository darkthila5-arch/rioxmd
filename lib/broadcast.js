// Scheduled broadcasts: the list of jobs (data only). web.js runs them with its slow one-number-at-a-time bulk sender.
// Stored under the reserved id "_global", so scheduled messages survive restarts (disk or MongoDB).
import crypto from 'node:crypto';
import { getSetting, setSetting } from './storage.js';

const G = '_global', KEY = 'broadcasts';
export const MAX_PENDING = 20, MAX_TEXT = 1000, MAX_KEEP = 60;
export const LATE_GRACE_MS = 10 * 60 * 1000; // a job that is more than 10 minutes late after a restart is marked "missed" instead of sent

const read = () => (Array.isArray(getSetting(G, KEY, null)) ? getSetting(G, KEY, []) : []);
const write = (list) => {
  // keep every pending job, plus the newest finished ones
  const pending = list.filter((j) => j.status === 'scheduled' || j.status === 'running');
  const done = list.filter((j) => j.status !== 'scheduled' && j.status !== 'running').sort((a, b) => b.created - a.created).slice(0, MAX_KEEP);
  setSetting(G, KEY, [...pending, ...done]);
};

export const listJobs = () => read().slice().sort((a, b) => (a.status === 'scheduled' ? 0 : 1) - (b.status === 'scheduled' ? 0 : 1) || (a.status === 'scheduled' ? a.at - b.at : b.created - a.created));

export function addJob({ text, at, target }) {
  const list = read();
  if (list.filter((j) => j.status === 'scheduled').length >= MAX_PENDING) throw new Error(`You can schedule up to ${MAX_PENDING} messages. Cancel one first.`);
  const job = { id: crypto.randomBytes(5).toString('hex'), text, at, target: target === 'online' ? 'online' : 'all', status: 'scheduled', created: Date.now(), result: '' };
  list.push(job); write(list);
  return job;
}

export function updateJob(id, patch) {
  const list = read();
  const j = list.find((x) => x.id === id);
  if (!j) return null;
  Object.assign(j, patch); write(list);
  return j;
}

export function cancelJob(id) {
  const j = read().find((x) => x.id === id);
  if (!j || j.status !== 'scheduled') return false;
  updateJob(id, { status: 'cancelled', result: 'Cancelled by the admin.' });
  return true;
}

export const dueJobs = (now = Date.now()) => read().filter((j) => j.status === 'scheduled' && j.at <= now).sort((a, b) => a.at - b.at);
