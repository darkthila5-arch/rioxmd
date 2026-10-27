import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import { prettify } from './format.js';
import { formatUptime, greeting, mem, nowStrings } from './text.js';
import { BOT_NAME, MENU_IMAGE, OWNER_NUMBER, PREFIX, ROOT_DIR, USE_BUTTONS } from './config.js';


export function aliveCaption(name) {
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ ${greeting()}, *${name}*!`,
    '┃',
    '┃ ✅ *I am alive and running!*',
    `┃ ⏱️ Uptime  : ${formatUptime(process.uptime())}`,
    `┃ 🧠 RAM     : ${mem()}`,
    `┃ 📅 Date    : ${date}`,
    `┃ 🕒 Time    : ${time}`,
    `┃ 🔰 Prefix  : ${PREFIX}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `👇 Tap a button, or send *${PREFIX}menu*`
  ].join('\n');
}

export function menuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ ⚙️ *GENERAL* ❯',
    `│ ✦ ${p}alive`,
    `│ ✦ ${p}ping`,
    `│ ✦ ${p}runtime`,
    `│ ✦ ${p}about`,
    `│ ✦ ${p}owner`,
    `│ ✦ ${p}status`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📥 *DOWNLOAD* ❯',
    `│ ✦ ${p}tt <link>`,
    `│ ✦ ${p}fb <link>`,
    `│ ✦ ${p}pin <link>`,
    `│ ✦ ${p}song <name/link>`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🎨 *MEDIA* ❯',
    `│ ✦ ${p}sticker`,
    `│ ✦ ${p}media`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👥 *GROUP* ❯',
    `│ ✦ ${p}groupinfo`,
    `│ ✦ ${p}grouphelp (all admin tools)`,
    `│ ✦ ${p}kick · ${p}add · ${p}promote · ${p}demote`,
    `│ ✦ ${p}warn · ${p}tagall · ${p}hidetag · ${p}del`,
    `│ ✦ ${p}group open/close · ${p}antilink`,
    `│ ✦ ${p}welcome · ${p}goodbye`,
    `│ ✦ ${p}rules · ${p}poll · ${p}warnlist`,
    `│ ✦ ${p}tagadmins · ${p}lockinfo · ${p}requests`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🎉 *FUN* ❯',
    `│ ✦ ${p}funmenu (all fun commands)`,
    `│ ✦ ${p}joke · ${p}fact · ${p}8ball · ${p}ship`,
    `│ ✦ ${p}truth · ${p}dare · ${p}rps · ${p}calc`,
    `│ ✦ ${p}riddle · ${p}mathquiz · ${p}guess · ${p}slot`,
    `│ ✦ ${p}roast · ${p}compliment · ${p}iq · ${p}fortune`,
    `│ ✦ ${p}fancy · ${p}morse · ${p}qr · ${p}remind · ${p}time`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📲 *STATUS & VIEW-ONCE* ❯',
    `│ ✦ ${p}autostatus (settings)`,
    `│ ✦ ${p}statusseen <on/off>`,
    `│ ✦ ${p}statusreact <on/off>`,
    `│ ✦ ${p}statusemoji 😍 🔥 ❤️`,
    `│ ✦ ${p}statussave <on/off>`,
    `│ ✦ ${p}viewonce <on/off>`,
    `│ ✦ ${p}vv (reply to view-once)`,
    `│ ✦ ${p}save (reply to media)`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Powered by Rio Editz`
  ].join('\n');
}

// Owner-only menu (.momenu). Never shown in .menu.
export function ownerMenuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 👑 *${BOT_NAME} OWNER MENU* 👑 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ 👑 *OWNER* ❯',
    `│ ✦ ${p}status`,
    `│ ✦ ${p}mode <public/private>`,
    `│ ✦ ${p}broadcast <text>`,
    `│ ✦ ${p}block / ${p}unblock`,
    `│ ✦ ${p}join <group link>`,
    `│ ✦ ${p}leave`,
    `│ ✦ ${p}setbio <text>`,
    `│ ✦ ${p}setpp (reply to image)`,
    `│ ✦ ${p}restart`,
    `│ ✦ ${p}webpass (web settings password)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📞 *CALL* ❯',
    `│ ✦ ${p}call (settings)`,
    `│ ✦ ${p}callstream <on/off>`,
    `│ ✦ ${p}callreject <on/off>`,
    `│ ✦ ${p}autoanswer <on/off>`,
    `│ ✦ ${p}setcallaudio (reply)`,
    `│ ✦ ${p}setcallvideo (reply)`,
    `│ ✦ ${p}setcallmsg <text>`,
    `│ ✦ ${p}callpreview`,
    `│ ✦ ${p}delcallmedia <audio/video>`,
    `│ ✦ ${p}addpack <name> (reply)`,
    `│ ✦ ${p}packs / ${p}delpack <name>`,
    `│ ✦ ${p}callto <number> <pack>`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Owner only`
  ].join('\n');
}

/* ---------- button helpers ---------- */
export const qr = (text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) });
export const copyBtn = (text, code) => ({ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: code }) });
const urlBtn = (text, url) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }) });
const listBtn = (title, sections) => ({ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections }) });

export function menuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  const buttons = [
    qr('🏓 Ping', `${p}ping`),
    qr('✅ Alive', `${p}alive`),
    listBtn('📂 Select Menu', [
      { title: '⚙️ GENERAL', rows: [
        row('Ping', 'Check bot speed', 'ping'),
        row('Runtime', 'How long the bot has been up', 'runtime'),
        row('About', 'About this bot', 'about'),
        row('Owner', 'Contact the owner', 'owner'),
        row('Status', 'Bot status', 'status')
      ] },
      { title: '📥 DOWNLOAD', rows: [
        row('TikTok', 'Use .tt <link>', 'tt'),
        row('Facebook', 'Use .fb <link>', 'fb'),
        row('Pinterest', 'Use .pin <link>', 'pin'),
        row('YouTube Song', 'Use .song <name or link>', 'song')
      ] },
      { title: '🎨 MEDIA', rows: [
        row('Sticker', 'Sticker help', 'sticker'),
        row('Media', 'Media command guide', 'media')
      ] },
      { title: '👥 GROUP', rows: [
        row('Group Info', 'Current group details', 'groupinfo'),
        row('Group Help', 'All group admin commands', 'grouphelp'),
        row('Group Settings', 'Welcome, anti-link status', 'gsettings'),
        row('Admins', 'List the group admins', 'admins'),
        row('Rules', 'Show the group rules', 'rules'),
        row('Tag Admins', 'Call the admins', 'tagadmins'),
        row('Warn List', 'Who has warnings', 'warnlist')
      ] },
      { title: '🎉 FUN', rows: [
        row('Fun Menu', 'All fun commands', 'funmenu'),
        row('Joke', 'Random joke', 'joke'),
        row('Fact', 'Random fact', 'fact'),
        row('Truth', 'Truth question', 'truth'),
        row('Dare', 'Dare challenge', 'dare'),
        row('Would You Rather', 'Pick one', 'wyr'),
        row('Riddle', 'Solve a riddle', 'riddle'),
        row('Math Quiz', 'Quick maths', 'mathquiz'),
        row('Guess the Number', 'Play 1-100', 'guess'),
        row('Slot Machine', 'Try your luck', 'slot'),
        row('Fortune', 'Your fortune', 'fortune')
      ] },
      { title: '📲 STATUS & VIEW-ONCE', rows: [
        row('Status Settings', 'Show all status tools', 'autostatus'),
        row('Auto View', 'View statuses on/off', 'statusseen'),
        row('Auto React', 'React to statuses on/off', 'statusreact'),
        row('React Emojis', 'Set your emojis', 'statusemoji'),
        row('Auto Save', 'Save statuses on/off', 'statussave'),
        row('View-Once', 'Recover view-once on/off', 'viewonce')
      ] }
    ])
  ];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Chat Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}
export function ownerMenuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  return [
    qr('📞 Call Settings', `${p}call`),
    qr('📜 Main Menu', `${p}menu`),
    listBtn('👑 Owner Menu', [
      { title: '👑 OWNER', rows: [
        row('Mode', 'public / private', 'mode'),
        row('Broadcast', 'Send text to all groups', 'broadcast'),
        row('Block', 'Block a user', 'block'),
        row('Unblock', 'Unblock a user', 'unblock'),
        row('Join', 'Join a group by link', 'join'),
        row('Leave', 'Leave this group', 'leave'),
        row('Set Bio', 'Change bot bio', 'setbio'),
        row('Set DP', 'Reply to an image', 'setpp'),
        row('Restart', 'Restart the bot', 'restart')
      ] },
      { title: '📞 CALL', rows: [
        row('Call Settings', 'Show call settings', 'call'),
        row('Real Call Answer', 'Answer calls + play audio/video', 'callstream'),
        row('Call Reject', 'Reject calls on/off', 'callreject'),
        row('Auto Answer', 'Reply to calls with audio/video', 'autoanswer'),
        row('Call Preview', 'Send the saved audio/video', 'callpreview')
      ] }
    ])
  ];
}
export function aliveButtons() {
  const p = PREFIX;
  const buttons = [qr('📜 Menu', `${p}menu`), qr('🏓 Ping', `${p}ping`)];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}

// Native-flow interactive message (the type that shows real tappable buttons).
async function sendInteractive(sock, jid, { image, body, footer, buttons }, quoted) {
  const buf = image ? await fetchImage(image) : null; // download here (cached, with backup route) so WhatsApp never has to reach the host itself
  const media = buf ? await prepareWAMessageMedia({ image: buf }, { upload: sock.waUploadToServer }) : null;
  const IM = proto.Message.InteractiveMessage;
  const interactiveMessage = IM.create({
    header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: !!media, ...(media || {}) }),
    body: IM.Body.create({ text: body }),
    footer: IM.Footer.create({ text: footer }),
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons, messageParamsJson: '' })
  });
  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage
      }
    }
  };
  const waMsg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted });
  const additionalNodes = [{
    tag: 'biz', attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
}

// Default: image + caption (always shows up). With BUTTONS=on it tries tappable buttons first, but WhatsApp often
// accepts those and then silently never shows them, so they are opt-in. Any failure falls back to the next option.
const LOCAL_IMAGE = path.join(ROOT_DIR, 'public', 'ghost.png'); // always on disk, so a picture still shows when the remote link is dead
const LOCAL_MENU = path.join(ROOT_DIR, 'public', 'menu.jpg');   // optional: drop your menu picture here and it is used first (no network needed)
const IMG_TTL = 60 * 60 * 1000, IMG_RETRY = 60 * 1000, IMG_TIMEOUT = 20000;
const imgCache = new Map(); // url -> { buf, at } | { pending }

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMG_TIMEOUT), headers: { 'user-agent': 'Mozilla/5.0 (compatible; RIO-X-MD)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('empty image');
  return buf;
}
// Some hosts (catbox.moe) time out from Render. Try the direct link and an image proxy at the same time; the first one wins.
async function loadImage(url) {
  if (url === MENU_IMAGE && fs.existsSync(LOCAL_MENU)) return fs.readFileSync(LOCAL_MENU);
  if (!/^https?:\/\//i.test(url)) return fs.readFileSync(url);
  const proxy = `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//i, ''))}&output=jpg`;
  return Promise.any([download(url), download(proxy)]).catch((e) => { throw e?.errors?.[0] || e; });
}
// Returns a Buffer (cached for an hour). A failed download is retried after a minute and the bundled picture is used meanwhile.
export async function fetchImage(url) {
  const c = imgCache.get(url);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < (c.buf ? IMG_TTL : IMG_RETRY)) return c.buf || fs.readFileSync(LOCAL_IMAGE);
  const pending = loadImage(url)
    .then((buf) => { imgCache.set(url, { buf, at: Date.now() }); return buf; })
    .catch((err) => {
      console.error(`MENU_IMAGE could not be downloaded (${err?.message || err}); using the bundled picture. Check MENU_IMAGE: ${url}`);
      imgCache.set(url, { buf: null, at: Date.now() });
      return fs.readFileSync(LOCAL_IMAGE);
    });
  imgCache.set(url, { pending });
  return pending;
}
fetchImage(MENU_IMAGE).catch(() => {}); // warm the cache at startup so the first menu is instant
export async function sendRich(sock, jid, { caption: plainCaption, buttons, footer, image = MENU_IMAGE }, quoted) {
  const caption = prettify(USE_BUTTONS ? plainCaption : `${plainCaption}\n\n▸ ${PREFIX}menu · ${PREFIX}ping · ${PREFIX}owner`);
  if (USE_BUTTONS) {
    try {
      await sendInteractive(sock, jid, { image, body: caption, footer, buttons }, quoted);
      return;
    } catch (err) { console.error('Button send failed, using fallback:', err?.message || err); }
  }
  try {
    if (!image) throw new Error('no image');
    await sock.sendMessage(jid, { image: await fetchImage(image), caption }, { quoted });
    return;
  } catch (err) { console.error('Image send failed, using text:', err?.message || err); }
  await sock.sendMessage(jid, { text: caption }, { quoted });
}
