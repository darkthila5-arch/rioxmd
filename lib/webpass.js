// Web password for the /settings page. Only a salted scrypt hash is stored (in the per-session settings);
// the plain password is sent once to the user's own WhatsApp inbox and never shown anywhere else.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { BOT_NAME, PREFIX, jidNum } from './config.js';
import { getSetting, setSetting } from './storage.js';
import { say } from './card.js';

export const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
// async scrypt runs on the libuv thread pool, so a login attempt never freezes every linked session.
const scrypt = promisify(crypto.scrypt);
const hash = async (pw, salt) => (await scrypt(String(pw).slice(0, 100), salt, 32)).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

export function newPassword(len = 12) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
export async function issueWebPassword(sid) {
  const pw = newPassword();
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting(sid, 'webPass', { salt, hash: await hash(pw, salt) });
  return pw;
}
export const hasWebPassword = (sid) => !!getSetting(sid, 'webPass', null)?.hash;
export const webPasswordVersion = (sid) => String(getSetting(sid, 'webPass', null)?.hash || '').slice(0, 16);
export async function checkWebPassword(sid, pw) {
  const rec = getSetting(sid, 'webPass', null);
  const a = Buffer.from(await hash(pw, rec?.salt || DUMMY_SALT), 'hex'); // always hash, so timing does not reveal unknown numbers
  if (!rec?.hash) return false;
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function webPasswordText(num, pw) {
  const url = PUBLIC_URL ? `${PUBLIC_URL}/settings` : '/settings (on the same website where you linked your number)';
  return [
    '╭━━━〔 🔑 *WEB SETTINGS* 〕━━━⬣',
    `┃ 🤖 *${BOT_NAME}* settings page`,
    `┃ 📱 Number   : +${num}`,
    `┃ 🔑 Password : *${pw}*`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `▸ Open: ${url}`,
    '▸ Log in with your number and this password, then turn features on or off.',
    `▸ Lost it or want a new one? Send *${PREFIX}webpass* here. The old password stops working.`,
    '',
    '_Never share this password. Anyone who has it can change your bot settings._',
  ].join('\n');
}

// Creates a new password and sends it to the linked account's own chat.
export async function sendWebPassword(sock, sid) {
  const num = jidNum(sock.user?.id);
  const pw = await issueWebPassword(sid);
  await say(sock, `${num}@s.whatsapp.net`, webPasswordText(num, pw));
  return true;
}
