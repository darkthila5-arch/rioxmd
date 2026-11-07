// .logo <name>    ->  the name made into 10 different logo styles, shown as swipeable cards (HD FILE + MORE STYLES buttons)
// .logo2 <name>   ->  10 more styles (20 in total)
// .logohd <style> <name>  ->  one logo as a big 2048 px PNG file (this is what the HD FILE button sends)
// The logos are drawn by the bot itself (lib/logomaker.js), no web API. MAX_LOGO_JOBS (default 2) = pictures drawn at the same time.
import { FOOTER_LINE } from '../lib/brand.js';
import { PREFIX, USE_BUTTONS, sleep } from '../lib/config.js';
import { qr } from '../lib/menu.js';
import { sendCards } from '../lib/carousel.js';
import { MAX_NAME, PAGE_SIZE, STYLES, cleanName, renderLogo, styleByKey } from '../lib/logomaker.js';

const MAX_JOBS = Math.max(1, Number(process.env.MAX_LOGO_JOBS || 2));
let running = 0;
const waiting = [];
async function slot(fn) { // at most MAX_JOBS pictures are drawn at once, the rest wait in line
  if (running >= MAX_JOBS) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

const pageOf = (page) => STYLES.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
const pages = Math.ceil(STYLES.length / PAGE_SIZE);
const fileSafe = (s) => String(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'logo';

function usage(cmd) {
  return `❌ Type a name for the logo.\n\nනමක් ගහපන් බං, ලෝගෝ හදලා දෙන්නම් 🎨\nExample: ${PREFIX}${cmd} Rio X\n(max ${MAX_NAME} letters)`;
}

async function sendPage({ sock, msg, jid, args, reply }, page, cmd) {
  const name = cleanName(args.join(' '));
  if (!name) return reply(usage(cmd));
  await reply(`🎨 Making logos for *${name}*...`);
  let made;
  try {
    made = await Promise.all(pageOf(page).map(async (st) => ({ st, img: await slot(() => renderLogo(st.key, name, { px: 720, format: 'jpeg' })) })));
  } catch (err) {
    console.error('Logo error:', err?.message || err);
    return reply('❌ Could not make the logos right now. Try again in a few seconds.\n\nලෝගෝ හදන්න බැරි වුණා බං, ආයෙ ට්‍රයි කරපන් 😒');
  }
  const more = page + 1 < pages ? qr('➡️ MORE STYLES', `${PREFIX}logo2 ${name}`) : qr('⬅️ FIRST STYLES', `${PREFIX}logo ${name}`);
  if (USE_BUTTONS) { // same swipe cards as .tts / .song
    try {
      return await sendCards(sock, jid, {
        title: `🎨 *LOGO MAKER*\n👤 ${name}\nSwipe the cards ➡️ (page ${page + 1}/${pages}) and tap *HD FILE* on the one you like`,
        quoted: msg,
        cards: made.map(({ st, img }) => ({
          image: img,
          body: `🎨 *${st.title}*\n👤 ${name}`,
          buttons: [qr('📥 HD FILE', `${PREFIX}logohd ${st.key} ${name}`), more]
        }))
      });
    } catch (err) { console.error('Logo carousel failed, sending pictures one by one:', err?.message || err); }
  }
  // buttons off (or the carousel failed): normal pictures, one after another
  for (const { st, img } of made) {
    await sock.sendMessage(jid, { image: img, caption: `🎨 *${st.title}*\n👤 ${name}\n\nHD file: ${PREFIX}logohd ${st.key} ${name}` }, { quoted: msg });
    await sleep(500);
  }
  return reply(`${page + 1 < pages ? `➡️ More styles: ${PREFIX}logo2 ${name}` : `⬅️ First styles: ${PREFIX}logo ${name}`}\n\n${FOOTER_LINE}`);
}

export default [
  {
    name: 'logo', aliases: ['logomaker', 'mklogo'], react: '🎨',
    async run(ctx) { return sendPage(ctx, 0, 'logo'); },
  },
  {
    name: 'logo2', aliases: ['logomore'], react: '🎨',
    async run(ctx) { return sendPage(ctx, 1, 'logo2'); },
  },
  {
    name: 'logohd', aliases: ['logofile'], react: '📥',
    async run({ sock, msg, jid, args, reply }) {
      const st = styleByKey(args[0]);
      const name = cleanName(args.slice(1).join(' '));
      if (!st || !name) return reply(`❌ Use ${PREFIX}logo <name> first, then tap HD FILE on a style.\nExample: ${PREFIX}logohd neon Rio X\nStyles: ${STYLES.map((s) => s.key).join(', ')}`);
      try {
        const buf = await slot(() => renderLogo(st.key, name, { px: 2048, format: 'png' }));
        return await sock.sendMessage(jid, { document: buf, mimetype: 'image/png', fileName: `${fileSafe(name)}-${st.key}.png`, caption: `🎨 *${st.title}*\n👤 ${name}\n\n${FOOTER_LINE}` }, { quoted: msg });
      } catch (err) {
        console.error('Logo HD error:', err?.message || err);
        return reply('❌ Could not make the HD file. Try again in a few seconds.\n\nHD ෆයිල් එක හදන්න බැරි වුණා බං, ආයෙ ට්‍රයි කරපන් 😒');
      }
    },
  },
];
