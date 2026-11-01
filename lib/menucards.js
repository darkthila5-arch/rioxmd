// Swipeable "carousel" menu: one card per category (picture + command list + a few tap buttons).
// Used by .menu when the admin picks the Carousel style (/admin -> Commands -> Menu style), or with `.menu carousel`.
import { BOT_NAME, MENU_IMAGE, PREFIX } from './config.js';
import { sendCards } from './carousel.js';
import { fetchImage, qr } from './menu.js';
import { logoBuffer } from './brand.js';
import { filterButtons, filterCaption } from './control.js';
import { formatUptime, greeting, nowStrings } from './text.js';

// cmds = lines shown on the card (same style as the classic menu, so switched-off commands are hidden the same way)
// tap  = commands that work without any extra words; they become tap buttons on the card
const SECTIONS = [
  { icon: '⚙️', title: 'GENERAL', tap: ['ping', 'alive', 'owner'],
    cmds: ['alive', 'ping', 'runtime', 'about', 'owner', 'status', 'pair <your number>'] },
  { icon: '📥', title: 'DOWNLOAD', tap: ['news'],
    cmds: ['tt <link>', 'tts <search words>', 'fb <link>', 'ig <link>', 'tw <link>', 'pin <link>', 'song <name/link>', 'spotify <track link>', 'video <name/link>', 'apk <app name>', 'lyrics <song name>'] },
  { icon: '📰', title: 'NEWS', tap: ['news', 'hiru', 'derana'],
    cmds: ['news', 'hiru · .derana · .itn'] },
  { icon: '🎨', title: 'MEDIA', tap: ['sticker', 'media'],
    cmds: ['tosticker (photo → sticker)', 'toasticker (video → animated sticker)', 'toimg (sticker → photo)', 'tovideo (animated sticker → video)', 'emojimix 😂+😍', 'sticker · .media'] },
  { icon: '👥', title: 'GROUP', tap: ['groupinfo', 'grouphelp', 'rules'],
    cmds: ['groupinfo', 'grouphelp (all admin tools)', 'kick · .add · .promote · .demote', 'warn · .tagall · .hidetag · .del', 'group open/close · .antilink', 'welcome · .goodbye', 'rules · .poll · .warnlist'] },
  { icon: '🎉', title: 'FUN', tap: ['funmenu', 'joke', 'fact'],
    cmds: ['funmenu (all fun commands)', 'joke · .fact · .8ball · .ship', 'truth · .dare · .rps · .calc', 'riddle · .mathquiz · .guess · .slot', 'roast · .compliment · .iq · .fortune', 'fancy · .morse · .qr · .remind · .time'] },
  { icon: '📲', title: 'STATUS & VIEW-ONCE', tap: ['autostatus'],
    cmds: ['autostatus (settings)', 'statusseen <on/off>', 'statusreact <on/off>', 'statusemoji 😍 🔥 ❤️', 'statussave <on/off>', 'viewonce <on/off>', 'vv · .vvemoji (reply to view-once)', 'save (reply to media)'] },
  { icon: '👑', title: 'OWNER COMMANDS', tap: ['webpass', 'premium'],
    cmds: ['mode <public/private>', 'callreject <on/off>', 'broadcast <text>', 'forward <link/jid/number>', 'block / .unblock', 'join <group link>', 'leave', 'setbio <text>', 'setpp (reply to image)', 'fulldp (reply to image)', 'webpass', 'premium'] },
];

const LABELS = { ping: '🏓 Ping', alive: '✅ Alive', owner: '👑 Owner', news: '📰 News', hiru: '📰 Hiru', derana: '📰 Derana', sticker: '🎨 Sticker help', media: '🎞️ Media help', groupinfo: '👥 Group info', grouphelp: '🛠️ Group help', rules: '📜 Rules', funmenu: '🎉 Fun menu', joke: '😂 Joke', fact: '💡 Fact', autostatus: '📲 Status settings', webpass: '🔑 Web password', premium: '💎 Premium' };

function cardBody(s) {
  const p = PREFIX;
  const text = filterCaption([
    `╭─❮ ${s.icon} *${s.title}* ❯`,
    ...s.cmds.map((c) => `│ ✦ ${p}${c}`),
    '╰──────────────⬣'
  ].join('\n'));
  return text.includes('│ ✦') ? text : null; // every command of this card is switched off: no card
}

// A picture URL that coverBuffer() in carousel.js can "download" with no network: the picture is read once (cached by fetchImage) and passed as a data: link.
async function pictureLink(sock) {
  const src = (await logoBuffer(sock)) || MENU_IMAGE; // premium logo replaces the default picture, like the classic menu
  const buf = Buffer.isBuffer(src) ? src : await fetchImage(src);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export async function sendMenuCarousel(sock, jid, { name, quoted }) {
  const p = PREFIX, { date, time } = nowStrings();
  const image = await pictureLink(sock);
  const cards = [];
  for (const s of SECTIONS) {
    const body = cardBody(s);
    if (!body) continue;
    const buttons = filterButtons(s.tap.map((c) => qr(LABELS[c] || `${p}${c}`, `${p}${c}`)));
    buttons.push(qr('📜 Full menu', `${p}menu full`)); // every card keeps at least one button
    cards.push({ image, body, buttons: buttons.slice(0, 4) });
  }
  if (!cards.length) throw new Error('no menu cards');
  const title = [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '👉 Swipe the cards to see every category'
  ].join('\n');
  await sendCards(sock, jid, { title, cards, quoted });
}
