// Media tools.
//   .tomp3  (aliases .mp3 .toaudio)       video / voice note / audio  -> MP3          (.tomp3 doc = send it as a file)
//   .topdf  (aliases .pdf .imgtopdf)      photos and text             -> one PDF      (add photos / .topdf text ... one by one, then .topdf done)
//   .ocr    (aliases .totext .imgtext)    photo with text             -> the text     (.ocr si / en / ta / si+en)
// Use them by replying to the media, or send the media with the command as its caption.
// The work is in lib/mediatools.js. Needs ffmpeg (MP3) and tesseract (OCR); both are in the Docker image.
import { BOT_NAME, PREFIX } from '../lib/config.js';
import { say } from '../lib/card.js';
import { brandOf } from '../lib/brand.js';
import { getText, unwrapMessage } from '../lib/text.js';
import { MAX_AUDIO_SECONDS, MAX_INPUT_BYTES, MAX_PDF_PAGES, MAX_TEXT_CHARS, DEFAULT_OCR_LANGS, OCR_NAMES, buildPdf, downloadMedia, findMedia, imageToPage, ocrImage, parseOcrLang, renderFooterImage, renderTextPages, toMp3 } from '../lib/mediatools.js';

const MB = (n) => Math.round(n / 1048576);
const sizeOf = (part) => (typeof part?.fileLength?.toNumber === 'function' ? part.fileLength.toNumber() : Number(part?.fileLength || 0));

function failText(err) {
  if (err?.missing === 'ffmpeg') return '❌ ffmpeg is not installed on the server, so this command cannot work.';
  if (err?.missing) return `❌ ${err.missing} is not installed on the server, so this command cannot work.`;
  if (err?.noLang) return `❌ ${err.noLang.map((l) => OCR_NAMES[l] || l).join(' / ')} language data is not installed on this server.`;
  if (err?.tooBig) return `❌ That file is bigger than ${MB(MAX_INPUT_BYTES)} MB.`;
  if (err?.download) return '❌ Could not download that file. Forward it again and reply to the new one.';
  if (err?.noAudio) return '❌ That file has no sound to convert.';
  if (err?.badImage) return '❌ I could not read that picture. Try another one.';
  if (err?.noText) return '❌ There is no text to add.';
  if (err?.badText) return '❌ Could not draw that text. Try again with a shorter text.';
  return '❌ Could not convert that file. Try another one.';
}

// Same person can not start many heavy jobs in a row.
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();
function tooSoon(key, ms) {
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < ms) return true;
  lastUse.set(key, now);
  return false;
}
const whoKey = (sessionId, jid, msg) => `${sessionId}|${jid}|${msg.key?.fromMe ? 'me' : (msg.key?.participant || '')}`;

/* ---------- .tomp3 ---------- */
const tomp3 = {
  name: 'tomp3', aliases: ['mp3', 'toaudio'], react: '🎧',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const usage = `🎧 *Video / Voice → MP3*\nReply to a video, voice note or audio with ${PREFIX}tomp3 (or send it with ${PREFIX}tomp3 as the caption).\n${PREFIX}tomp3 doc = send the MP3 as a file.\nUp to ${Math.round(MAX_AUDIO_SECONDS / 60)} minutes and ${MB(MAX_INPUT_BYTES)} MB.`;
    const media = findMedia(msg, jid);
    if (!media) return reply(usage);
    if (media.kind !== 'video' && media.kind !== 'audio') return reply(`That is not a video or audio.\n${usage}`);
    if (sizeOf(media.part) > MAX_INPUT_BYTES) return reply(failText({ tooBig: true }));
    if (tooSoon(`mp3|${whoKey(sessionId, jid, msg)}`, 4000)) return reply('⏳ One at a time please. Try again in a few seconds.');
    try {
      const input = await downloadMedia(sock, media);
      if (input.length > 4 * 1048576) reply('⏳ Converting to MP3…').catch(() => {});
      const mp3 = await toMp3(input);
      const asFile = /^(doc|file|document)$/i.test(args[0] || '');
      if (asFile) {
        const base = String(media.part.fileName || '').replace(/\.[^.]{1,5}$/, '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'RioXMD-audio';
        return await sock.sendMessage(jid, { document: mp3, mimetype: 'audio/mpeg', fileName: `${base}.mp3` }, { quoted: msg });
      }
      return await sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
    } catch (err) {
      console.error('tomp3 error:', err?.message || err);
      return reply(failText(err));
    }
  },
};

/* ---------- .topdf ---------- */
// WhatsApp commands see one message at a time, so photos are collected per person:
//   .topdf (with a photo)  adds a page      .topdf done [name]  makes the PDF      .topdf now  = add this photo and make the PDF
//   .topdf clear           starts again     .topdf status       shows the page count
//   .topdf text <words>    adds a text page (line breaks kept; long text goes on more pages)      .topdf text  (reply to a text message) adds that text
// Every page of the PDF gets the bot footer and a page number at the bottom (lib/mediatools.js buildPdf).
// Pages wait in memory for 20 minutes. Limits: pages per PDF (TOPDF_MAX_PAGES, default 20), 20 MB per person, 80 MB for everybody.
const STACK_TTL_MS = 20 * 60e3;
const MAX_STACK_BYTES = 20 * 1048576;
const MAX_ALL_BYTES = 80 * 1048576;
export const stacks = new Map(); // key -> { pages: [{ jpeg, width, height }], bytes, at }
setInterval(() => { const t = Date.now(); for (const [k, s] of stacks) if (t - s.at > STACK_TTL_MS) stacks.delete(k); }, 60e3).unref();
const allBytes = () => { let n = 0; for (const s of stacks.values()) n += s.bytes; return n; };

// Photos from one person are handled in the order their commands arrived.
const chains = new Map();
function serial(key, fn) {
  const next = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  next.catch(() => {}).finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

const DONE = new Set(['done', 'make', 'finish', 'create', 'go', 'send']);
const CLEAR = new Set(['clear', 'reset', 'cancel', 'stop']);
const STATUS = new Set(['status', 'list', 'pages', 'count']);
const TEXT = new Set(['text', 'txt']);

// Text typed after ".topdf text", with its line breaks (args has lost them). Falls back to the words in args.
function textBody(msg, args) {
  const m = /^\s*\S+[ \t]+(?:text|txt)\b[ \t]*\n?([\s\S]*)$/i.exec(getText(msg) || '');
  return m ? m[1] : args.slice(1).join(' ');
}
// Text of the message this command replies to.
function quotedText(msg) {
  const info = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
  const q = info?.quotedMessage ? unwrapMessage(info.quotedMessage) : null;
  return q?.conversation || q?.extendedTextMessage?.text || '';
}

// Footer line of the PDF: the premium number's own footer, else PDF_FOOTER, else "© Powered by <bot name>". PDF_FOOTER=off = no footer text (page numbers stay).
function pdfFooterText(sock) {
  const env = String(process.env.PDF_FOOTER ?? '').trim();
  if (/^(off|none|false|0|no)$/i.test(env)) return '';
  const b = brandOf(sock);
  return b?.footer || env || `© Powered by ${b?.name || BOT_NAME}`;
}

export function pdfName(words) {
  const base = words.join(' ').replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_').slice(0, 40);
  return base || `RioXMD-${new Date().toISOString().slice(0, 10)}`;
}

const topdf = {
  name: 'topdf', aliases: ['pdf', 'imgtopdf'], react: '📄',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const key = whoKey(sessionId, jid, msg);
    const sub = (args[0] || '').toLowerCase();
    const usage = [
      '📄 *Photos & text → PDF*',
      `1) Reply to a photo with ${PREFIX}topdf (or send the photo with ${PREFIX}topdf as the caption). Do it for each photo, one at a time, up to ${MAX_PDF_PAGES} pages.`,
      `   Text page: ${PREFIX}topdf text Your words here (line breaks are kept, up to ${MAX_TEXT_CHARS} letters), or reply to a text message with ${PREFIX}topdf text.`,
      `2) Send ${PREFIX}topdf done  (or ${PREFIX}topdf done MyNotes to name the file).`,
      `Only one photo? Use ${PREFIX}topdf now.`,
      'Every page gets the bot footer and a page number at the bottom.',
      `${PREFIX}topdf clear = start again · ${PREFIX}topdf status = pages so far`,
    ].join('\n');

    if (CLEAR.has(sub)) {
      const had = stacks.get(key)?.pages.length || 0;
      stacks.delete(key);
      return reply(had ? `🗑️ Cleared ${had} page(s). Start again with a photo.` : 'Nothing to clear. Send a photo with the command to start.');
    }
    if (STATUS.has(sub)) {
      const n = stacks.get(key)?.pages.length || 0;
      return reply(n ? `📄 ${n} page(s) waiting. Add more, or send ${PREFIX}topdf done` : usage);
    }

    return serial(key, async () => {
      const wantsDone = DONE.has(sub);
      const now = sub === 'now';
      const isText = TEXT.has(sub);
      // ".topdf text ..." = a text page. A plain ".topdf" that replies to a text message (no photo) also adds that text.
      let media = isText ? null : findMedia(msg, jid);
      if (wantsDone && stacks.get(key)?.pages.length) media = null; // "done" only finishes: it does not add the photo it replies to
      const nameWords = args.slice(wantsDone || now ? 1 : 0);
      const textInput = isText ? (textBody(msg, args).trim() || quotedText(msg).trim()) : (!media && !args.length ? quotedText(msg).trim() : '');

      if (isText || textInput) {
        if (!textInput) return reply(usage);
        const have = stacks.get(key)?.pages.length || 0;
        if (have >= MAX_PDF_PAGES) return reply(`📄 That is already ${MAX_PDF_PAGES} pages (the limit). Send ${PREFIX}topdf done to get the PDF.`);
        if (allBytes() > MAX_ALL_BYTES) return reply('⏳ The server is busy with other PDFs right now. Try again in a few minutes.');
        let made;
        try {
          made = await renderTextPages(textInput, { maxPages: MAX_PDF_PAGES - have });
        } catch (err) {
          console.error('topdf text error:', err?.message || err);
          return reply(failText(err));
        }
        const cur = stacks.get(key) || { pages: [], bytes: 0, at: Date.now() };
        const add = made.pages.reduce((n, p) => n + p.jpeg.length, 0);
        if (cur.bytes + add > MAX_STACK_BYTES) return reply(`📄 Those pages are already ${MB(MAX_STACK_BYTES)} MB. Send ${PREFIX}topdf done to get the PDF, then start a new one.`);
        const first = cur.pages.length + 1;
        cur.pages.push(...made.pages);
        cur.bytes += add;
        cur.at = Date.now();
        stacks.set(key, cur);
        const last = cur.pages.length;
        const label = first === last ? `Page *${last}* added (text).` : `Pages *${first}–${last}* added (text).`;
        const warn = made.truncated ? `\n⚠️ The text was too long, so only the first part was used (${MAX_TEXT_CHARS} letters / ${MAX_PDF_PAGES} pages at most).` : '';
        return reply(`📄 ${label}${warn}\nSend the next photo or ${PREFIX}topdf text, or ${PREFIX}topdf done to get the PDF.`);
      }

      if (media) {
        if (media.kind !== 'image') return reply(`🖼️ ${PREFIX}topdf works with photos only (or ${PREFIX}topdf text for words).\n${usage}`);
        if (sizeOf(media.part) > MAX_INPUT_BYTES) return reply(failText({ tooBig: true }));
        const st = stacks.get(key);
        if (st && st.pages.length >= MAX_PDF_PAGES) return reply(`📄 That is already ${MAX_PDF_PAGES} pages (the limit). Send ${PREFIX}topdf done to get the PDF.`);
        if (allBytes() > MAX_ALL_BYTES) return reply('⏳ The server is busy with other PDFs right now. Try again in a few minutes.');
        let page;
        try {
          page = await imageToPage(await downloadMedia(sock, media));
        } catch (err) {
          console.error('topdf error:', err?.message || err);
          return reply(failText(err));
        }
        const cur = stacks.get(key) || { pages: [], bytes: 0, at: Date.now() };
        if (cur.bytes + page.jpeg.length > MAX_STACK_BYTES) return reply(`📄 Those pages are already ${MB(MAX_STACK_BYTES)} MB. Send ${PREFIX}topdf done to get the PDF, then start a new one.`);
        cur.pages.push(page);
        cur.bytes += page.jpeg.length;
        cur.at = Date.now();
        stacks.set(key, cur);
        if (!now && !wantsDone) {
          return reply(`📄 Page *${cur.pages.length}* added.\nSend the next photo with ${PREFIX}topdf, or ${PREFIX}topdf done to get the PDF.`);
        }
      }

      const st = stacks.get(key);
      if (!(wantsDone || now)) return reply(st?.pages.length ? `📄 ${st.pages.length} page(s) waiting. Send a photo with ${PREFIX}topdf to add one, or ${PREFIX}topdf done` : usage);
      if (!st?.pages.length) return reply(usage);

      try {
        const name = pdfName(nameWords);
        const footerText = pdfFooterText(sock);
        const footerImage = footerText ? await renderFooterImage(footerText) : null; // null (no fonts) = plain Helvetica text instead
        const pdf = buildPdf(st.pages, { title: name, pageNumbers: true, footer: footerText ? { text: footerText, image: footerImage } : null });
        await sock.sendMessage(jid, { document: pdf, mimetype: 'application/pdf', fileName: `${name}.pdf`, caption: `📄 PDF ready: ${st.pages.length} page(s)` }, { quoted: msg });
        stacks.delete(key);
      } catch (err) {
        console.error('topdf build error:', err?.message || err);
        return reply('❌ Could not make the PDF. Your pages are still saved: try again, or ' + `${PREFIX}topdf clear to start over.`);
      }
    });
  },
};

/* ---------- .ocr ---------- */
const OCR_MAX_CHARS = Math.max(500, Number(process.env.OCR_MAX_CHARS || 4000));
const ocr = {
  name: 'ocr', aliases: ['totext', 'imgtext'], react: '🔠',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const usage = [
      '🔠 *Photo → Text (OCR)*',
      `Reply to a photo with ${PREFIX}ocr (or send the photo with ${PREFIX}ocr as the caption).`,
      `Languages: ${PREFIX}ocr si (Sinhala) · ${PREFIX}ocr en (English) · ${PREFIX}ocr ta (Tamil) · ${PREFIX}ocr si+en. Default is Sinhala + English.`,
      'Clear, straight, well lit pictures work best. Sinhala is less accurate than English, so check the result.',
    ].join('\n');
    let langs = DEFAULT_OCR_LANGS;
    if (args[0]) {
      langs = parseOcrLang(args[0]);
      if (!langs) return reply(`❔ I do not know the language "${args[0].slice(0, 20)}".\n${usage}`);
    }
    const media = findMedia(msg, jid);
    if (!media) return reply(usage);
    if (media.kind !== 'image') return reply(`🖼️ ${PREFIX}ocr works with photos only.\n${usage}`);
    if (sizeOf(media.part) > MAX_INPUT_BYTES) return reply(failText({ tooBig: true }));
    if (tooSoon(`ocr|${whoKey(sessionId, jid, msg)}`, 6000)) return reply('⏳ One at a time please. Try again in a few seconds.');
    try {
      const input = await downloadMedia(sock, media);
      reply('⏳ Reading the text…').catch(() => {});
      const { text, skipped } = await ocrImage(input, langs);
      if (skipped.length) await reply(`⚠️ ${skipped.map((l) => OCR_NAMES[l] || l).join(' / ')} language data is not installed on this server, so it was skipped.`).catch(() => {});
      if (!text) return await reply('🔍 No text found in that picture. Try a clearer, closer photo.');
      const cut = text.length > OCR_MAX_CHARS;
      // Sent exactly as read (no bold, no footer) so it can be copied.
      return await say(sock, jid, cut ? `${text.slice(0, OCR_MAX_CHARS)}\n…` : text, msg, { raw: true });
    } catch (err) {
      console.error('ocr error:', err?.message || err);
      return reply(failText(err));
    }
  },
};

export default [tomp3, topdf, ocr];
