// .translate [language] <text>    (aliases .tr .trt)       or reply to a message with  .translate [language]
//   .tr si good morning        -> Sinhala          .tr en මම ගෙදර යනවා   -> English
//   .tr                         (reply)  Sinhala text becomes English, anything else becomes Sinhala
// Engines: Google web translate endpoint (no key), then MyMemory as a fallback. Both are free public services.
import { PREFIX } from '../lib/config.js';
import { unwrapMessage } from '../lib/text.js';

const TIMEOUT_MS = 12000;
const MAX_CHARS = 600;
const SINHALA = /[඀-෿]/;

export const LANGS = {
  si: 'Sinhala', en: 'English', ta: 'Tamil', hi: 'Hindi', ur: 'Urdu', bn: 'Bengali', ne: 'Nepali', ml: 'Malayalam', te: 'Telugu', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati',
  ar: 'Arabic', fa: 'Persian', tr: 'Turkish', he: 'Hebrew', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', uk: 'Ukrainian',
  pl: 'Polish', sv: 'Swedish', el: 'Greek', ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', fil: 'Filipino', sw: 'Swahili', la: 'Latin'
};
const ALIASES = { sinhala: 'si', sinhalese: 'si', english: 'en', tamil: 'ta', hindi: 'hi', urdu: 'ur', arabic: 'ar', french: 'fr', german: 'de', spanish: 'es', japanese: 'ja', korean: 'ko', chinese: 'zh-CN', zh: 'zh-CN', russian: 'ru', turkish: 'tr', malay: 'ms', thai: 'th', italian: 'it', portuguese: 'pt', indonesian: 'id', bengali: 'bn', malayalam: 'ml', telugu: 'te' };

// "si" / "Sinhala" / "ZH-cn" -> canonical code, otherwise null.
export function langCode(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  if (ALIASES[w]) return ALIASES[w];
  for (const code of Object.keys(LANGS)) if (code.toLowerCase() === w) return code;
  return null;
}

// Works out target language + text from the arguments and the replied-to text.
export function parseTranslate(args, quotedText = '') {
  const list = [...args];
  let to = langCode(list[0]);
  if (to) list.shift();
  let text = list.join(' ').trim();
  if (!text) text = String(quotedText || '').trim();
  if (!to) to = SINHALA.test(text) ? 'en' : 'si';
  return { to, text: text.slice(0, MAX_CHARS) };
}

async function google(text, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`google HTTP ${res.status}`);
  const data = await res.json();
  const out = (data?.[0] || []).map((p) => p?.[0] || '').join('').trim();
  if (!out) throw new Error('google empty');
  return { text: out, from: typeof data?.[2] === 'string' ? data[2] : '' };
}
async function myMemory(text, to) {
  const from = SINHALA.test(text) ? 'si' : 'en';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${encodeURIComponent(to)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`mymemory HTTP ${res.status}`);
  const data = await res.json();
  const out = String(data?.responseData?.translatedText || '').trim();
  if (!out || /^(MYMEMORY WARNING|PLEASE SELECT)/i.test(out)) throw new Error('mymemory empty');
  return { text: out, from };
}

export async function translate(text, to) {
  try { return await google(text, to); }
  catch (err) { console.error('translate (google) failed, trying MyMemory:', err?.message || err); }
  return myMemory(text, to);
}

function quotedTextOf(msg) {
  const m = unwrapMessage(msg?.message);
  const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo;
  const q = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
  return q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption || '';
}

export default [
  {
    name: 'translate', aliases: ['tr', 'trt'], react: '🌐',
    async run({ args, msg, reply }) {
      const { to, text } = parseTranslate(args, quotedTextOf(msg));
      if (!text) {
        return reply(`🌐 *Translate*\n\n${PREFIX}translate si good morning\n${PREFIX}translate en මම ගෙදර යනවා\n${PREFIX}translate  _(reply to a message)_\n\nLanguages: ${Object.entries(LANGS).slice(0, 12).map(([c, n]) => `${c} (${n})`).join(', ')} ...\n_Without a language: Sinhala → English, anything else → Sinhala._`);
      }
      try {
        const r = await translate(text, to);
        const src = r.from && LANGS[r.from] ? LANGS[r.from] : (r.from || 'auto');
        return reply(`🌐 *${src} → ${LANGS[to]}*\n\n${r.text}`);
      } catch (err) {
        console.error('translate error:', err?.message || err);
        return reply('❌ Could not translate right now. Try again in a minute.');
      }
    }
  }
];
