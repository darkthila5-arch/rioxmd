// Swipeable "carousel" menu: one card per category (picture + command list + a 📂 Select button that opens that category's commands).
// Used by .menu when the admin picks the Carousel style (/admin -> Commands -> Menu style), or with `.menu carousel`.
import { BOT_NAME, MENU_IMAGE, PREFIX } from './config.js';
import { getBotImage } from './botmedia.js';
import { sendCards } from './carousel.js';
import { fetchImage, qr } from './menu.js';
import { logoBuffer } from './brand.js';
import { say } from './card.js';
import { filterButtons, filterCaption } from './control.js';
import { formatUptime, greeting, nowStrings } from './text.js';

// rows: [command, title shown in the select list, short description, usage hint shown on the card (optional)]
// Picking a row in the list runs that command (commands that need words just show how to use them).
const SECTIONS = [
  { icon: '⚙️', title: 'GENERAL', rows: [
    ['alive', 'Alive', 'Check the bot is running'],
    ['ping', 'Ping', 'Check bot speed'],
    ['runtime', 'Runtime', 'How long the bot has been up'],
    ['about', 'About', 'About this bot'],
    ['owner', 'Owner', 'Contact the owner'],
    ['status', 'Status', 'Bot status'],
    ['pair', 'Pair Code', 'Link your own number as a bot', '<your number>'] ] },
  { icon: '📥', title: 'DOWNLOAD', rows: [
    ['tt', 'TikTok', 'Download a TikTok video', '<link>'],
    ['tts', 'TikTok Search', 'Search TikTok (swipe cards)', '<words>'],
    ['fb', 'Facebook', 'Download a Facebook video', '<link>'],
    ['ig', 'Instagram', 'Download an Instagram post', '<link>'],
    ['tw', 'Twitter / X', 'Download a Twitter / X video', '<link>'],
    ['pin', 'Pinterest', 'Download a Pinterest pin', '<link>'],
    ['song', 'YouTube Song', 'Song by name or link (swipe cards)', '<name/link>'],
    ['spotify', 'Spotify Song', 'Spotify track download', '<track link>'],
    ['video', 'YouTube Video', 'Video by name or link', '<name/link>'],
    ['apk', 'APK Download', 'Find an app', '<app name>'],
    ['lyrics', 'Lyrics', 'Song lyrics', '<song name>'] ] },
  { icon: '🌍', title: 'UTILITIES', rows: [
    ['weather', 'Weather', 'Weather of a city', '<city>'],
    ['currency', 'Currency', 'Convert money', '100 usd lkr'],
    ['translate', 'Translate', 'Translate text (or reply to a message)', '<lang> <text>'],
    ['define', 'Dictionary', 'Meaning of an English word', '<word>'],
    ['wiki', 'Wikipedia', 'Short summary of a topic', '<topic>'],
    ['short', 'Short Link', 'Make a short link', '<link>'],
    ['ss', 'Screenshot', 'Screenshot of a web page', '<link>'] ] },
  { icon: '📰', title: 'NEWS', rows: [
    ['news', 'News', 'Hiru, Derana, ITN headlines'],
    ['hiru', 'Hiru News', 'Latest from Hiru'],
    ['derana', 'Ada Derana', 'Latest from Derana'],
    ['itn', 'ITN News', 'Latest from ITN'] ] },
  { icon: '🎨', title: 'MEDIA', rows: [
    ['tosticker', 'To Sticker', 'Photo → sticker (reply)'],
    ['toasticker', 'To Animated Sticker', 'Video / GIF → animated sticker (reply)'],
    ['toimg', 'To Image', 'Sticker → photo (reply)'],
    ['tovideo', 'To Video', 'Animated sticker → video (reply)'],
    ['emojimix', 'Emoji Mix', 'Mix 2 emojis into a sticker', '😂+😍'],
    ['tomp3', 'To MP3', 'Video / voice → MP3 (reply)'],
    ['topdf', 'To PDF', 'Photos → PDF (reply, then done)'],
    ['ocr', 'OCR', 'Photo → text (reply)'],
    ['sticker', 'Sticker Help', 'Sticker guide'],
    ['media', 'Media Help', 'Media command guide'] ] },
  { icon: '👥', title: 'GROUP', rows: [
    ['groupinfo', 'Group Info', 'Current group details'],
    ['grouphelp', 'Group Help', 'All group admin commands'],
    ['gsettings', 'Group Settings', 'Welcome, anti-link status'],
    ['admins', 'Admins', 'List the group admins'],
    ['rules', 'Rules', 'Show the group rules'],
    ['tagadmins', 'Tag Admins', 'Call the admins'],
    ['warnlist', 'Warn List', 'Who has warnings'],
    ['poll', 'Poll', 'Make a poll', 'Question | A | B'],
    ['kick', 'Kick', 'Remove a member (admin)'],
    ['add', 'Add', 'Add a member (admin)'],
    ['promote', 'Promote', 'Make admin (admin)'],
    ['demote', 'Demote', 'Remove admin (admin)'],
    ['warn', 'Warn', 'Warn a member (admin)'],
    ['tagall', 'Tag All', 'Mention everyone (admin)'],
    ['hidetag', 'Hide Tag', 'Hidden mention (admin)'],
    ['del', 'Delete', 'Delete a message (admin)'],
    ['group', 'Group Open/Close', 'Open or close the group (admin)', 'open|close'],
    ['antilink', 'Anti-Link', 'Block links (admin)', 'off|on|all'],
    ['welcome', 'Welcome', 'Welcome message on/off (admin)'],
    ['goodbye', 'Goodbye', 'Goodbye message on/off (admin)'],
    ['lockinfo', 'Lock Info', 'Only admins edit group info'],
    ['requests', 'Join Requests', 'Pending join requests'] ] },
  { icon: '🎉', title: 'FUN', rows: [
    ['funmenu', 'Fun Menu', 'All fun commands'],
    ['joke', 'Joke', 'Random joke'],
    ['fact', 'Fact', 'Random fact'],
    ['truth', 'Truth', 'Truth question'],
    ['dare', 'Dare', 'Dare challenge'],
    ['wyr', 'Would You Rather', 'Pick one'],
    ['riddle', 'Riddle', 'Solve a riddle'],
    ['mathquiz', 'Math Quiz', 'Quick maths'],
    ['guess', 'Guess the Number', 'Play 1-100'],
    ['slot', 'Slot Machine', 'Try your luck'],
    ['fortune', 'Fortune', 'Your fortune'],
    ['8ball', '8 Ball', 'Ask the magic ball'],
    ['ship', 'Ship', 'Love match'],
    ['rps', 'Rock Paper Scissors', 'Play against the bot'],
    ['calc', 'Calculator', 'Quick maths', '<maths>'],
    ['roast', 'Roast', 'Friendly roast'],
    ['compliment', 'Compliment', 'Say something nice'],
    ['iq', 'IQ Test', 'Random IQ'],
    ['fancy', 'Fancy Text', 'Stylish text', '<text>'],
    ['morse', 'Morse', 'Text → morse', '<text>'],
    ['qr', 'QR Code', 'Make a QR code', '<text>'],
    ['remind', 'Reminder', 'Set a reminder', '<time> <text>'],
    ['time', 'Time', 'Current time'] ] },
  { icon: '📲', title: 'STATUS & VIEW-ONCE', rows: [
    ['autostatus', 'Status Settings', 'Show all status tools'],
    ['statusseen', 'Auto View', 'View statuses on/off', '<on/off>'],
    ['statusreact', 'Auto React', 'React to statuses on/off', '<on/off>'],
    ['statusemoji', 'React Emojis', 'Set your emojis', '😍 🔥 ❤️'],
    ['statussave', 'Auto Save', 'Save statuses on/off', '<on/off>'],
    ['viewonce', 'View-Once', 'Recover view-once on/off', '<on/off>'],
    ['vv', 'Open View-Once', 'Reply to a view-once message'],
    ['vvemoji', 'VV Emojis', 'Emojis that work like vv'],
    ['save', 'Save Media', 'Reply to a photo / video / voice'] ] },
  { icon: '👑', title: 'OWNER COMMANDS', rows: [
    ['mode', 'Mode', 'public / private', '<public/private>'],
    ['callreject', 'Call Reject', 'Reject calls on/off', '<on/off>'],
    ['broadcast', 'Broadcast', 'Send text to all groups', '<text>'],
    ['webpass', 'Web Password', 'Password for web settings'],
    ['premium', 'Premium', 'Your plan and days left'],
    ['forward', 'Forward', 'Reply to a message, then send to a target', '<link/jid/number>'],
    ['block', 'Block', 'Block a number'],
    ['unblock', 'Unblock', 'Unblock a number'],
    ['join', 'Join Group', 'Join with a link', '<group link>'],
    ['leave', 'Leave Group', 'Bot leaves this group'],
    ['setbio', 'Set Bio', 'Change the bio', '<text>'],
    ['setpp', 'Set Profile Picture', 'Reply to an image'],
    ['fulldp', 'Full DP', 'Reply to an image, DP keeps its original size'] ] },
];

const p = PREFIX;

function cardBody(s) {
  const text = filterCaption([
    `╭─❮ ${s.icon} *${s.title}* ❯`,
    ...s.rows.map(([id, , , usage]) => `│ ✦ ${p}${id}${usage ? ` ${usage}` : ''}`),
    '╰──────────────⬣'
  ].join('\n'));
  return text.includes('│ ✦') ? text : null; // every command of this card is switched off: no card
}

// The 📂 Select button of a card: a list with that card's commands. Switched-off commands are removed by filterButtons().
const selectButton = (s) => ({
  name: 'single_select',
  buttonParamsJson: JSON.stringify({
    title: `📂 Select ${s.title.split(' ')[0]}`,
    sections: [{ title: `${s.icon} ${s.title}`, rows: s.rows.map(([id, title, desc]) => ({ header: '', title, description: desc, id: `${p}${id}` })) }]
  })
});

// A picture URL that coverBuffer() in carousel.js can "download" with no network: the picture is read once (cached by fetchImage) and passed as a data: link.
async function pictureLink(sock) {
  const src = (await logoBuffer(sock)) || (await getBotImage('menuImg').catch(() => null)) || MENU_IMAGE; // premium logo replaces the default picture, like the classic menu
  const buf = Buffer.isBuffer(src) ? src : await fetchImage(src);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export async function sendMenuCarousel(sock, jid, { name, quoted }) {
  const { date, time } = nowStrings();
  const image = await pictureLink(sock);
  const cards = [];
  for (const s of SECTIONS) {
    const body = cardBody(s);
    if (!body) continue;
    const buttons = filterButtons([selectButton(s)]);
    buttons.push(qr('📜 Full menu', `${p}menu full`)); // every card keeps at least one button
    cards.push({ image, body, buttons });
  }
  if (!cards.length) throw new Error('no menu cards');
  // 1st message: the greeting box with the bot DP preview card (the same card every reply has); 2nd message: the swipe cards.
  const header = [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣'
  ].join('\n');
  try { await say(sock, jid, header, quoted); }
  catch (err) { console.error('Menu header card failed, sending the cards only:', err?.message || err); }
  const title = '👉 Swipe the cards, then tap 📂 Select to pick a command';
  await sendCards(sock, jid, { title, cards, quoted });
}
