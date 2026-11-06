import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { remember } from './msgstore.js';
import { ownerChoices } from './carousel.js';
import fs from 'node:fs';
import path from 'node:path';
import { prettify } from './format.js';
import { formatUptime, greeting, mem, nowStrings } from './text.js';
import { DEFAULT_FOOTER, applyBrand, logoBuffer } from './brand.js';
import { filterButtons, filterCaption } from './control.js';
import { BOT_NAME, MENU_IMAGE, OWNER_NUMBER, PREFIX, ROOT_DIR, USE_BUTTONS } from './config.js';
import { getBotImage } from './botmedia.js';


function _aliveCaption(name) {
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
    '*මැරිලා කියලා හිතුවද උට්ටො....😒 තාම පණපිටින්...*',
    '',
    `👇 Tap a button, or send *${PREFIX}menu*`
  ].join('\n');
}

function _menuCaption(name) {
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
    `│ ✦ ${p}pair <your number> (get a pair code)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📥 *DOWNLOAD* ❯',
    `│ ✦ ${p}tt <link>`,
    `│ ✦ ${p}tts <search words>`,
    `│ ✦ ${p}ttdl <link> (TikTok video, straight away)`,
    `│ ✦ ${p}ttmp3 <link> (TikTok sound, straight away)`,
    `│ ✦ ${p}fb <link>`,
    `│ ✦ ${p}ig <link>`,
    `│ ✦ ${p}tw <link>`,
    `│ ✦ ${p}pin <link>`,
    `│ ✦ ${p}song <name/link> (swipe cards)`,
    `│ ✦ ${p}spotify <track link>`,
    `│ ✦ ${p}video <name/link>`,
    `│ ✦ ${p}apk <app name>`,
    `│ ✦ ${p}lyrics <song name>`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🌍 *UTILITIES* ❯',
    `│ ✦ ${p}weather <city>`,
    `│ ✦ ${p}imdb <movie> (rating, plot, poster)`,
    `│ ✦ ${p}currency 100 usd lkr`,
    `│ ✦ ${p}bmi <kg> <cm> (BMI calculator)`,
    `│ ✦ ${p}age <dob> (age calculator)`,
    `│ ✦ ${p}translate <lang> <text> (or reply)`,
    `│ ✦ ${p}define <word> (dictionary)`,
    `│ ✦ ${p}wiki <topic> (Wikipedia)`,
    `│ ✦ ${p}short <link> (short link)`,
    `│ ✦ ${p}expand <link> (real address of a short link)`,
    `│ ✦ ${p}ss <link> (website screenshot)`,
    `│ ✦ ${p}tempmail (temporary email, private chat)`,
    `│ ✦ ${p}walink <number> [text] (wa.me chat link)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🤖 *AI & SEARCH* ❯',
    `│ ✦ ${p}gpt4 <question> (or reply)`,
    `│ ✦ ${p}blackbox <question>`,
    `│ ✦ ${p}claudeai <question>`,
    `│ ✦ ${p}googleans <question> (answer + results)`,
    `│ ✦ ${p}addai · ${p}delai (Meta AI in a group, admins)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📰 *NEWS* ❯',
    `│ ✦ ${p}news`,
    `│ ✦ ${p}hiru · ${p}derana · ${p}itn`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🎨 *MEDIA* ❯',
    `│ ✦ ${p}tosticker (photo → sticker)`,
    `│ ✦ ${p}toasticker (video → animated sticker)`,
    `│ ✦ ${p}toimg (sticker → photo)`,
    `│ ✦ ${p}tovideo (animated sticker → video)`,
    `│ ✦ ${p}emojimix 😂+😍 (mix 2 emojis)`,
    `│ ✦ ${p}tomp3 (video / voice → MP3)`,
    `│ ✦ ${p}topdf (photos → PDF)`,
    `│ ✦ ${p}ocr (photo → text)`,
    `│ ✦ ${p}readqr (read a QR code from a photo)`,
    `│ ✦ ${p}sticker · ${p}media`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👥 *GROUP* ❯',
    `│ ✦ ${p}groupinfo`,
    `│ ✦ ${p}grouphelp (all admin tools)`,
    `│ ✦ ${p}kick · ${p}add · ${p}promote · ${p}demote`,
    `│ ✦ ${p}warn · ${p}tagall · ${p}hidetag · ${p}del · ${p}delfrom`,
    `│ ✦ ${p}group open/close · ${p}antilink`,
    `│ ✦ ${p}schedule open 8pm / close 10pm (auto open/close)`,
    `│ ✦ ${p}leaderboard (most active members) · today/week/month/me`,
    `│ ✦ ${p}welcome · ${p}goodbye`,
    `│ ✦ ${p}setwelcomeimg (picture for the welcome message)`,
    `│ ✦ ${p}inactive <days> · ${p}listonline`,
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
    `│ ✦ ${p}font <text> (60+ styles) · ${p}fancy · ${p}morse · ${p}qr · ${p}remind · ${p}time`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📲 *STATUS & VIEW-ONCE* ❯',
    `│ ✦ ${p}autostatus (settings)`,
    `│ ✦ ${p}statusseen <on/off>`,
    `│ ✦ ${p}statusreact <on/off>`,
    `│ ✦ ${p}statusemoji 😍 🔥 ❤️`,
    `│ ✦ ${p}statussave <on/off>`,
    `│ ✦ ${p}viewonce <on/off>`,
    `│ ✦ ${p}vv · ${p}vvemoji (reply to view-once, saved silently)`,
    `│ ✦ ${p}save (reply to media)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👑 *OWNER COMMANDS* ❯',
    '│ (only for the number that linked this bot)',
    `│ ✦ ${p}mode <public/private>`,
    `│ ✦ ${p}callreject <on/off>`,
    `│ ✦ ${p}broadcast <text>`,
    `│ ✦ ${p}forward <link/jid/number> (reply to a message)`,
    `│ ✦ ${p}block / ${p}unblock`,
    `│ ✦ ${p}join <group link>`,
    `│ ✦ ${p}leave`,
    `│ ✦ ${p}setbio <text>`,
    `│ ✦ ${p}setpp (reply to image)`,
    `│ ✦ ${p}fulldp (reply to image, original size DP)`,
    `│ ✦ ${p}getdp <number> / reply (👑 premium: download someone's DP)`,
    `│ ✦ ${p}gadd <group link> <numbers> (👑 premium: add many numbers, in inbox)`,
    `│ ✦ ${p}gadd <numbers> (👑 premium: add many numbers, inside a group)`,
    `│ ✦ ${p}antidelete <owner/chat/off> (see deleted messages)`,
    `│ ✦ ${p}webpass (web settings password)`,
    `│ ✦ ${p}premium (your plan and days left)`,
    `│ ✦ ${p}chsong <channel jid> <song/link>`,
    `│ ✦ ${p}chid <channel link> (get its jid)`,
    '╰──────────────⬣'
  ].join('\n');
}

// Host-owner menu (.momenu): only OWNER_NUMBER sees and uses it. The commands for every linked number are in .menu under OWNER COMMANDS.
function _ownerMenuCaption(name) {
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
    '╭─❮ 👑 *HOST OWNER* ❯',
    `│ ✦ ${p}restart`,
    `│ ✦ ${p}momenu (this menu)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🩺 *DOWNLOAD TOOLS* ❯',
    `│ ✦ ${p}ytcheck (why YouTube downloads fail)`,
    `│ ✦ ${p}dlcheck (yt-dlp + TikTok check)`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📰 *AUTO NEWS* ❯',
    `│ ✦ ${p}newson [hiru derana itn]`,
    `│ ✦ ${p}newsoff`,
    `│ ✦ ${p}newsadd <group/channel link or jid>`,
    `│ ✦ ${p}support on|off`,
    `│ ✦ ${p}autojoin <group link|off>`,
    `│ ✦ ${p}autofollow <channel link|off>`,
    `│ ✦ ${p}followall <channel link>`,
    `│ ✦ ${p}creact <post link> [emojis]`,
    `│ ✦ ${p}newsdel <target>`,
    `│ ✦ ${p}newslist`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📞 *CALL* ❯',
    `│ ✦ ${p}call (settings)`,
    `│ ✦ ${p}callstream <on/off>`,
    `│ ✦ ${p}autoanswer <on/off>`,
    `│ ✦ ${p}setcallaudio (reply)`,
    `│ ✦ ${p}setcallvideo (reply)`,
    `│ ✦ ${p}setcallmsg <text>`,
    `│ ✦ ${p}callpreview`,
    `│ ✦ ${p}delcallmedia <audio/video>`,
    `│ ✦ ${p}addpack <name> (reply)`,
    `│ ✦ ${p}packs / ${p}delpack <name>`,
    `│ ✦ ${p}callto <number> <pack>`,
    `│ ✦ ${p}ohelp (call pack help)`,
    '╰──────────────⬣'
  ].join('\n');
}

/* ---------- button helpers ---------- */
export const qr = (text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) });
export const copyBtn = (text, code) => ({ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: code }) });
export const urlBtn = (text, url) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }) });
const listBtn = (title, sections) => ({ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections }) });

function _menuButtons() {
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
        row('Status', 'Bot status', 'status'),
        row('Pair Code', 'Use .pair <your number> to link your own bot', 'pair')
      ] },
      { title: '📥 DOWNLOAD', rows: [
        row('TikTok', 'Use .tt <link>', 'tt'),
        row('TikTok Search', 'Use .tts <words>', 'tts'),
        row('TikTok Video', 'Use .ttdl <link> (video straight away)', 'ttdl'),
        row('TikTok MP3', 'Use .ttmp3 <link> (sound straight away)', 'ttmp3'),
        row('Facebook', 'Use .fb <link>', 'fb'),
        row('Instagram', 'Use .ig <link>', 'ig'),
        row('Twitter / X', 'Use .tw <link>', 'tw'),
        row('Pinterest', 'Use .pin <link>', 'pin'),
        row('YouTube Song', 'Use .song <name or link> (swipe cards)', 'song'),
        row('Spotify Song', 'Use .spotify <track link>', 'spotify'),
        row('YouTube Video', 'Use .video <name or link>', 'video'),
        row('APK Download', 'Use .apk <app name>', 'apk'),
        row('Lyrics', 'Use .lyrics <song name>', 'lyrics')
      ] },
      { title: '🌍 UTILITIES', rows: [
        row('Weather', 'Use .weather <city>', 'weather'),
        row('IMDb Movie', 'Use .imdb <movie or series>', 'imdb'),
        row('Currency', 'Use .currency 100 usd lkr', 'currency'),
        row('BMI', 'Use .bmi <kg> <cm>', 'bmi'),
        row('Age Calculator', 'Use .age <dob>', 'age'),
        row('Translate', 'Use .translate <lang> <text>', 'translate'),
        row('Dictionary', 'Use .define <word>', 'define'),
        row('Wikipedia', 'Use .wiki <topic>', 'wiki'),
        row('Short Link', 'Use .short <link>', 'short'),
        row('Expand Link', 'Use .expand <link>', 'expand'),
        row('Screenshot', 'Use .ss <link>', 'ss'),
        row('Temp Mail', 'Temporary email (private chat)', 'tempmail'),
        row('WA Link', 'Use .walink <number> [text]', 'walink')
      ] },
      { title: '🤖 AI & SEARCH', rows: [
        row('GPT-4', 'Use .gpt4 <question>', 'gpt4'),
        row('Blackbox AI', 'Use .blackbox <question>', 'blackbox'),
        row('Claude AI', 'Use .claudeai <question>', 'claudeai'),
        row('Google Answer', 'Use .googleans <question>', 'googleans'),
        row('Add Meta AI', 'Group admins: add Meta AI', 'addai'),
        row('Remove Meta AI', 'Group admins: remove Meta AI', 'delai')
      ] },
      { title: '📰 NEWS', rows: [
        row('News', 'Hiru, Derana, ITN headlines', 'news'),
        row('Hiru News', 'Latest from Hiru', 'hiru'),
        row('Ada Derana', 'Latest from Derana', 'derana'),
        row('ITN News', 'Latest from ITN', 'itn')
      ] },
      { title: '🎨 MEDIA', rows: [
        row('To Sticker', 'Photo → sticker', 'tosticker'),
        row('To Animated Sticker', 'Video / GIF → animated sticker', 'toasticker'),
        row('To Image', 'Sticker → photo', 'toimg'),
        row('To Video', 'Animated sticker → video', 'tovideo'),
        row('Emoji Mix', 'Mix 2 emojis into a sticker', 'emojimix'),
        row('To MP3', 'Video / voice → MP3', 'tomp3'),
        row('To PDF', 'Photos → PDF (add one by one, then .topdf done)', 'topdf'),
        row('OCR', 'Photo → text (Sinhala / English)', 'ocr'),
        row('Read QR', 'Reply to a photo with a QR code', 'readqr'),
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
        row('Warn List', 'Who has warnings', 'warnlist'),
        row('Poll', 'Use .poll Question | A | B', 'poll'),
        row('Kick', 'Remove a member (admin)', 'kick'),
        row('Add', 'Add a member (admin)', 'add'),
        row('Promote', 'Make admin (admin)', 'promote'),
        row('Demote', 'Remove admin (admin)', 'demote'),
        row('Warn', 'Warn a member (admin)', 'warn'),
        row('Tag All', 'Mention everyone (admin)', 'tagall'),
        row('Hide Tag', 'Hidden mention (admin)', 'hidetag'),
        row('Delete', 'Delete a message (admin)', 'del'),
        row('Delete From Here', 'Delete a message and all below it (admin)', 'delfrom'),
        row('Group Open/Close', 'Use .group open|close (admin)', 'group'),
        row('Anti-Link', 'Use .antilink off|on|all (admin)', 'antilink'),
        row('Welcome', 'Welcome message on/off (admin)', 'welcome'),
        row('Goodbye', 'Goodbye message on/off (admin)', 'goodbye'),
        row('Lock Info', 'Only admins edit group info', 'lockinfo'),
        row('Join Requests', 'Pending join requests', 'requests')
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
        row('Fortune', 'Your fortune', 'fortune'),
        row('8 Ball', 'Ask the magic ball', '8ball'),
        row('Ship', 'Love match', 'ship'),
        row('Rock Paper Scissors', 'Play against the bot', 'rps'),
        row('Calculator', 'Use .calc <maths>', 'calc'),
        row('Roast', 'Friendly roast', 'roast'),
        row('Compliment', 'Say something nice', 'compliment'),
        row('IQ Test', 'Random IQ', 'iq'),
        row('Font Styles', 'Use .font <text> (60+ styles)', 'font'),
        row('Fancy Text', 'Use .fancy <text>', 'fancy'),
        row('Morse', 'Use .morse <text>', 'morse'),
        row('QR Code', 'Use .qr <text>', 'qr'),
        row('Reminder', 'Use .remind <time> <text>', 'remind'),
        row('Time', 'Current time', 'time')
      ] },
      { title: '📲 STATUS & VIEW-ONCE', rows: [
        row('Status Settings', 'Show all status tools', 'autostatus'),
        row('Auto View', 'View statuses on/off', 'statusseen'),
        row('Auto React', 'React to statuses on/off', 'statusreact'),
        row('React Emojis', 'Set your emojis', 'statusemoji'),
        row('Auto Save', 'Save statuses on/off', 'statussave'),
        row('View-Once', 'Recover view-once on/off', 'viewonce'),
        row('Open View-Once', 'Reply to a view-once message (saved silently)', 'vv'),
        row('VV Emojis', 'Emojis that work like vv', 'vvemoji'),
        row('Save Media', 'Reply to a photo / video / voice', 'save')
      ] },
      { title: '👑 OWNER COMMANDS', rows: [
        row('Mode', 'public / private', 'mode'),
        row('Call Reject', 'Reject calls on/off', 'callreject'),
        row('Broadcast', 'Send text to all groups', 'broadcast'),
        row('Web Password', 'Password for web settings', 'webpass'),
        row('Premium', 'Your plan and days left', 'premium'),
        row('Forward', 'Reply to a message, then .forward <target>', 'forward'),
        row('Block', 'Block a number', 'block'),
        row('Unblock', 'Unblock a number', 'unblock'),
        row('Join Group', 'Use .join <group link>', 'join'),
        row('Leave Group', 'Bot leaves this group', 'leave'),
        row('Set Bio', 'Use .setbio <text>', 'setbio'),
        row('Set Profile Picture', 'Reply to an image', 'setpp'),
        row('Full DP', 'Reply to an image, DP keeps its original size', 'fulldp'),
        row('Get DP 👑', 'Premium: .getdp <number> or reply', 'getdp'),
        row('Bulk Add 👑', 'Premium: .gadd <group link> <numbers> (or inside a group)', 'gadd'),
        row('Channel Song', 'Use .chsong <channel jid> <song>', 'chsong'),
        row('Channel ID', 'Use .chid <channel link>', 'chid')
      ] }
    ])
  ];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Chat Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}
function _ownerMenuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  return [
    qr('📞 Call Settings', `${p}call`),
    qr('📜 Main Menu', `${p}menu`),
    listBtn('👑 Owner Menu', [
      { title: '👑 HOST OWNER', rows: [
        row('Restart', 'Restart the bot', 'restart'),
        row('Owner Menu', 'Show this menu', 'momenu')
      ] },
      { title: '🩺 DOWNLOAD TOOLS', rows: [
        row('YouTube Check', 'Why YouTube downloads fail', 'ytcheck'),
        row('Downloader Check', 'yt-dlp + TikTok check', 'dlcheck')
      ] },
      { title: '📰 AUTO NEWS', rows: [
        row('News On', 'Auto news in this chat', 'newson'),
        row('News Off', 'Stop auto news here', 'newsoff'),
        row('News Add', 'Add a group / channel', 'newsadd'),
        row('News Remove', 'Remove a target', 'newsdel'),
        row('News List', 'Where auto news goes', 'newslist'),
        row('Support Channels', 'Use .support on|off', 'support'),
        row('Auto Join', 'Use .autojoin <group link|off>', 'autojoin'),
        row('Auto Follow', 'Use .autofollow <channel link|off>', 'autofollow'),
        row('Follow All', 'Use .followall <channel link>', 'followall'),
        row('Channel React', 'Use .creact <post link> [emojis]', 'creact')
      ] },
      { title: '📞 CALL', rows: [
        row('Call Settings', 'Show call settings', 'call'),
        row('Real Call Answer', 'Answer calls + play audio/video', 'callstream'),
        row('Auto Answer', 'Reply to calls with audio/video', 'autoanswer'),
        row('Call Preview', 'Send the saved audio/video', 'callpreview'),
        row('Set Call Audio', 'Reply to a voice note', 'setcallaudio'),
        row('Set Call Video', 'Reply to a video', 'setcallvideo'),
        row('Set Call Message', 'Use .setcallmsg <text>', 'setcallmsg'),
        row('Delete Call Media', 'Use .delcallmedia audio|video', 'delcallmedia'),
        row('Add Pack', 'Use .addpack <name> (reply)', 'addpack'),
        row('Packs', 'List saved call packs', 'packs'),
        row('Delete Pack', 'Use .delpack <name>', 'delpack'),
        row('Call To', 'Use .callto <number> <pack>', 'callto'),
        row('Call Pack Help', 'Call pack guide', 'ohelp')
      ] }
    ])
  ];
}
function _aliveButtons() {
  const p = PREFIX;
  const buttons = [qr('📜 Menu', `${p}menu`), qr('🏓 Ping', `${p}ping`)];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}

// Native-flow interactive message (the type that shows real tappable buttons).
export async function sendInteractive(sock, jid, { image, body, footer, buttons }, quoted) {
  const buf = Buffer.isBuffer(image) ? image : image ? await fetchImage(image) : null; // download here (cached, with backup route) so WhatsApp never has to reach the host itself
  const media = buf ? await prepareWAMessageMedia({ image: buf }, { upload: sock.waUploadToServer }) : null;
  const IM = proto.Message.InteractiveMessage;
  const interactiveMessage = IM.create({
    header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: !!media, ...(media || {}) }),
    body: IM.Body.create({ text: applyBrand(sock, body) }),
    footer: IM.Footer.create({ text: applyBrand(sock, footer) }),
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
  remember(waMsg.key.id, waMsg.message); // relayMessage sends are not reported back, so keep them for retry requests
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
// slot: 'aliveImg' | 'menuImg' = the picture the host set in /admin → Bot media (a premium logo still comes first; no picture set = the built-in one)
export async function sendRich(sock, jid, { caption: plainCaption, buttons, footer, image = MENU_IMAGE, slot }, quoted) {
  if (image === MENU_IMAGE) image = (await logoBuffer(sock)) || (slot && await getBotImage(slot).catch(() => null)) || image; // premium logo replaces the default menu picture
  const ownerLines = USE_BUTTONS ? ownerChoices(sock, jid, quoted, buttons) : ''; // the owner cannot tap buttons of their own number: numbered choices instead
  const caption = prettify(USE_BUTTONS ? plainCaption + ownerLines : `${plainCaption}\n\n▸ ${PREFIX}menu · ${PREFIX}ping · ${PREFIX}owner`);
  if (USE_BUTTONS) {
    try {
      await sendInteractive(sock, jid, { image, body: caption, footer, buttons }, quoted);
      return;
    } catch (err) { console.error('Button send failed, using fallback:', err?.message || err); }
  }
  try {
    if (!image) throw new Error('no image');
    await sock.sendMessage(jid, { image: Buffer.isBuffer(image) ? image : await fetchImage(image), caption }, { quoted });
    return;
  } catch (err) { console.error('Image send failed, using text:', err?.message || err); }
  await sock.sendMessage(jid, { text: caption }, { quoted });
}

export const menuCaption = (name) => filterCaption(_menuCaption(name));
export const ownerMenuCaption = (name) => filterCaption(_ownerMenuCaption(name));
export const aliveCaption = (name) => filterCaption(_aliveCaption(name));
export const menuButtons = () => filterButtons(_menuButtons());
export const ownerMenuButtons = () => filterButtons(_ownerMenuButtons());
export const aliveButtons = () => filterButtons(_aliveButtons());
