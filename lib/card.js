import { BOT_NAME, CARD_URL, MENU_IMAGE, OWNER_NUMBER, jidNum, sleep } from './config.js';
import { pinterest } from './downloader.js';
import { fetchImage } from './menu.js';
import { prettify } from './format.js';
import { logoBuffer } from './brand.js';

/* ---------- bot DP card (the "web og image" style preview on every reply) ---------- */
const DP_TTL = 30 * 60 * 1000, DP_RETRY = 2 * 60 * 1000;
const dpCache = new WeakMap(); // sock -> { buf, at } | { pending }
async function loadBotDp(sock) {
  let buf = null;
  try {
    const url = await sock.profilePictureUrl(sock.user.id, 'image');
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) buf = Buffer.from(await res.arrayBuffer());
  } catch { /* no profile picture or privacy hides it */ }
  if (!buf) {
    try {
      buf = await fetchImage(MENU_IMAGE);
    } catch { /* ignore */ }
  }
  return buf;
}
// Concurrent replies share ONE download. A failed download is retried after 2 min instead of being remembered for 30.
function getBotDp(sock) {
  const c = dpCache.get(sock);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < DP_TTL) return Promise.resolve(c.buf);
  const pending = loadBotDp(sock)
    .catch(() => null)
    .then((buf) => { dpCache.set(sock, { buf, at: Date.now() - (buf ? 0 : DP_TTL - DP_RETRY) }); return buf; });
  dpCache.set(sock, { pending });
  return pending;
}
export function resetBotDp(sock) { dpCache.delete(sock); }

async function cardContext(sock) {
  const thumbnail = await Promise.race([(async () => (await logoBuffer(sock)) || getBotDp(sock))(), sleep(1500).then(() => null)]); // premium logo first, else the bot's DP; a slow download never delays the reply
  const me = jidNum(sock.user?.id);
  return {
    externalAdReply: {
      title: BOT_NAME,
      body: 'Powered by Rio Editz',
      mediaType: 1,
      renderLargerThumbnail: true,
      showAdAttribution: false,
      sourceUrl: CARD_URL || (OWNER_NUMBER ? `https://wa.me/${OWNER_NUMBER}` : `https://wa.me/${me}`),
      ...(thumbnail ? { thumbnail } : {})
    }
  };
}

// Every text reply goes through here so it shows the bot's DP as a preview card.
export async function say(sock, jid, text, quoted, extra = {}) {
  const { raw, ...rest } = extra; // raw: true = send the text exactly as given (copy-paste results)
  let contextInfo;
  try { contextInfo = await cardContext(sock); } catch { /* send without the card */ }
  return sock.sendMessage(jid, { text: raw ? text : prettify(text), ...rest, ...(contextInfo ? { contextInfo } : {}) }, { quoted });
}

/* ---------- emoji reactions ---------- */
export const REACTIONS = {
  menu: '📜', help: '📜', list: '📜', alive: '💚', bot: '🤖', ping: '🏓', runtime: '⏱️', about: 'ℹ️', owner: '👑',
  tt: '🎵', tiktok: '🎵', tts: '🔎', ttsearch: '🔎', news: '📰', hirunews: '🔴', derananews: '🔵', itnnews: '🟢', hiru: '🔴', derana: '🔵', itn: '🟢', newson: '📰', newsoff: '🔕', fb: '📘', facebook: '📘', pin: '📌', pinterest: '📌', song: '🎶', play: '🎶', yt: '🎶', ytmp3: '🎶',
  dl: '📥', ytdl: '📥', dlcheck: '🔍', media: '🎨', sticker: '🎨', groupinfo: '👥', grouphelp: '👥', status: '📊',
  mode: '⚙️', forward: '📤', fwd: '📤', broadcast: '📢', bc: '📢', block: '⛔', unblock: '✅', join: '🔗', leave: '🚪', setbio: '✍️', setpp: '🖼️', restart: '🔄',
  autostatus: '📲', statussettings: '📲', statusseen: '👀', autoseen: '👀', statusreact: '😍', autoreact: '😍', statussave: '💾', autosave: '💾', statusemoji: '🎭', viewonce: '👁️', antiviewonce: '👁️', vv: '👁️', save: '💾',
  kick: '👢', remove: '👢', add: '➕', promote: '⬆️', demote: '⬇️', warn: '⚠️', resetwarn: '✅', tagall: '📢', everyone: '📢', hidetag: '📢', del: '🗑️', delete: '🗑️',
  group: '👥', gc: '👥', mute: '🔒', unmute: '🔓', setname: '✍️', setdesc: '✍️', link: '🔗', invite: '🔗', revoke: '♻️', antilink: '🔗', welcome: '👋', goodbye: '🚪', gsettings: '⚙️', admins: '👮',
  funmenu: '🎉', fun: '🎉', joke: '😂', fact: '🧠', quote: '💬', '8ball': '🎱', dice: '🎲', coin: '🪙', rps: '✂️', truth: '🟢', dare: '🔴', wyr: '🤷', ship: '💘', hug: '🤗', slap: '👋', calc: '🧮', password: '🔐',
  rules: '📜', poll: '📊', warnlist: '⚠️', warnings: '⚠️', tagadmins: '🚨', calladmin: '🚨', report: '🚨', lockinfo: '🔒', unlockinfo: '🔓', ephemeral: '⏳', requests: '📥', approveall: '✅', rejectall: '🚫', setgpp: '🖼️',
  roast: '🔥', compliment: '💛', pickup: '😏', fortune: '🔮', iq: '🧠', slot: '🎰', riddle: '🧩', mathquiz: '🧮', answer: '💡', guess: '🔢', random: '🎯', fancy: '✨', upside: '🙃', binary: '💻', morse: '📡', base64: '🔤', b64: '🔤', qr: '🔳', time: '🕒', remind: '⏰',
  momenu: '👑', premium: '👑', plan: '👑', vip: '👑', webpass: '🔑', ownermenu: '👑', omenu: '👑',
  call: '📞', callsettings: '📞', callstream: '📞', realcall: '📞', callreject: '📵', anticall: '📵', autoanswer: '🤖', callanswer: '🤖', setcallmsg: '✍️',
  setcallaudio: '🎙️', setcallvideo: '🎬', callpreview: '▶️', delcallmedia: '🗑️',
  addpack: '📦', setpack: '📦', packs: '📦', callpacks: '📦', listpacks: '📦', delpack: '🗑️', removepack: '🗑️', callto: '📞', ohelp: '📖', callhelp: '📖', packhelp: '📖', callpack: '📞', streamcall: '📞'
};
export async function react(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); }
  catch (err) { console.error('React error:', err?.message || err); }
}
