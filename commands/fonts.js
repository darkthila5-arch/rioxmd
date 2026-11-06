// .font <text>        shows your text in 40+ numbered styles
// .font 7             picks style 7 for the LAST text you sent (clean, easy to copy)
// .font 7 <text>      picks style 7 for a new text
// Works offline (Unicode letters only, no API). Aliases: .fonts .textstyle .ts
import { PREFIX } from '../lib/config.js';

const MAX_LEN = 150;
const TTL_MS = 30 * 60e3;
const last = new Map(); // jid -> { text, at }
setInterval(() => { const t = Date.now(); for (const [k, v] of last) if (t - v.at > TTL_MS) last.delete(k); }, 5 * 60e3).unref();

const cp = (n) => String.fromCodePoint(n);

// Maps A-Z, a-z and 0-9 onto a Unicode block. `holes` are letters that live elsewhere in Unicode.
function alpha(upper, lower, digit, holes = {}) {
  return (s) => [...s].map((ch) => {
    if (holes[ch]) return holes[ch];
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90 && upper != null) return cp(upper + c - 65);
    if (c >= 97 && c <= 122 && lower != null) return cp(lower + c - 97);
    if (c >= 48 && c <= 57 && digit != null) return cp(digit + c - 48);
    return ch;
  }).join('');
}

// Character-by-character table (small caps, super script, upside down ...).
const table = (from, to) => {
  const f = [...from], t = [...to], m = new Map(f.map((c, i) => [c, t[i]]));
  return (s) => [...s].map((ch) => m.get(ch) ?? m.get(ch.toLowerCase()) ?? ch).join('');
};
const combine = (mark) => (s) => [...s].map((ch) => (ch === ' ' ? ch : ch + mark)).join('');
const wrap = (l, r) => (s) => `${l}${s}${r}`;
const spaced = (s) => [...s].join(' ');

const ABC = 'abcdefghijklmnopqrstuvwxyz';
const smallCaps = table(ABC, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ');
const superS = table(ABC + '0123456789', 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖqʳˢᵗᵘᵛʷˣʸᶻ⁰¹²³⁴⁵⁶⁷⁸⁹');
const subS = table('aehijklmnoprstuvx0123456789', 'ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₀₁₂₃₄₅₆₇₈₉');
const flipS = (s) => [...table(ABC + '0123456789?!.,\'"()[]&_', 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz0ƖᄅƐㄣϛ9ㄥ86¿¡˙\'\'„,)(][⅋‾')(s.toLowerCase())].reverse().join('');
const bubble = alpha(0x24B6, 0x24D0, 0x2460 - 1, { 0: '⓪' }); // 1-9 -> ①-⑨
const doubleStruck = alpha(0x1D538, 0x1D552, 0x1D7D8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' });
const italicS = alpha(0x1D434, 0x1D44E, null, { h: 'ℎ' });
const scriptS = alpha(0x1D49C, 0x1D4B6, null, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' });
const frakS = alpha(0x1D504, 0x1D51E, null, { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' });
const regional = (s) => [...s].map((ch) => { const c = ch.toUpperCase().codePointAt(0); return c >= 65 && c <= 90 ? cp(0x1F1E6 + c - 65) + '​' : ch; }).join('');
const fullwidth = (s) => [...s].map((ch) => { const c = ch.codePointAt(0); return c === 32 ? '　' : c > 32 && c < 127 ? cp(c + 0xFEE0) : ch; }).join('');
const alternate = (s) => [...s].map((ch, i) => (i % 2 ? ch.toLowerCase() : ch.toUpperCase())).join('');
const bold = alpha(0x1D400, 0x1D41A, 0x1D7CE);
const boldScript = alpha(0x1D4D0, 0x1D4EA);
const boldFrak = alpha(0x1D56C, 0x1D586);

export const STYLES = [
  ['Bold', bold],
  ['Italic', italicS],
  ['Bold Italic', alpha(0x1D468, 0x1D482)],
  ['Script', scriptS],
  ['Bold Script', boldScript],
  ['Fraktur', frakS],
  ['Bold Fraktur', boldFrak],
  ['Double Struck', doubleStruck],
  ['Sans', alpha(0x1D5A0, 0x1D5BA, 0x1D7E2)],
  ['Sans Bold', alpha(0x1D5D4, 0x1D5EE, 0x1D7EC)],
  ['Sans Italic', alpha(0x1D608, 0x1D622)],
  ['Sans Bold Italic', alpha(0x1D63C, 0x1D656)],
  ['Monospace', alpha(0x1D670, 0x1D68A, 0x1D7F6)],
  ['Bubble', bubble],
  ['Black Bubble', alpha(0x1F150, 0x1F150, null)],
  ['Square', alpha(0x1F130, 0x1F130, null)],
  ['Black Square', alpha(0x1F170, 0x1F170, null)],
  ['Parenthesis', alpha(0x1F110, 0x249C, null)],
  ['Small Caps', smallCaps],
  ['Super Script', superS],
  ['Sub Script', subS],
  ['Upside Down', flipS],
  ['Full Width', fullwidth],
  ['Regional', regional],
  ['Spaced', spaced],
  ['Alternate Case', alternate],
  ['Strikethrough', combine('̶')],
  ['Underline', combine('̲')],
  ['Double Underline', combine('̳')],
  ['Slash', combine('̸')],
  ['Wavy', combine('̰')],
  ['Dotted', combine('̇')],
  ['Cross Below', combine('͓')],
  ['Stars', (s) => `★彡 ${s} 彡★`],
  ['Wings', (s) => `꧁༺ ${boldScript(s)} ༻꧂`],
  ['Crown', (s) => `♛ ${boldFrak(s)} ♛`],
  ['Brackets', wrap('【', '】')],
  ['Corner', (s) => `「${s}」`],
  ['Fire', (s) => `🔥 ${bold(s)} 🔥`],
  ['Sparkle', (s) => `✨ ${scriptS(s)} ✨`],
  ['Hearts', (s) => `♡ ${italicS(s)} ♡`],
  ['Dots', (s) => `•°•° ${smallCaps(s)} °•°•`],
  ['Arrow', (s) => `➳ ${alpha(0x1D5D4, 0x1D5EE, 0x1D7EC)(s)} ➳`]
];

export function renderStyle(n, text) {
  const st = STYLES[n - 1];
  return st ? st[1](text) : null;
}

export function renderAll(text) {
  return STYLES.map(([label, fn], i) => `*${i + 1}.* ${fn(text)}`).join('\n');
}

export default [
  {
    name: 'font', aliases: ['fonts', 'textstyle', 'ts'],
    react: '✨',
    async run({ args, jid, reply }) {
      const first = args[0];
      const asNumber = /^\d{1,3}$/.test(first || '') ? parseInt(first, 10) : null;

      // .font 7 [text]  -> one style, plain text so it is easy to copy
      if (asNumber !== null) {
        const text = (args.slice(1).join(' ') || last.get(jid)?.text || '').slice(0, MAX_LEN);
        if (!text) return reply(`✨ Send some text first: ${PREFIX}font <text>`);
        const out = renderStyle(asNumber, text);
        if (!out) return reply(`❌ Pick a number from 1 to ${STYLES.length}.`);
        last.set(jid, { text, at: Date.now() });
        return reply(out);
      }

      // .font <text> -> list every style
      const text = args.join(' ').slice(0, MAX_LEN);
      if (!text) return reply(`✨ *FONT STYLES* (${STYLES.length})\nUse: ${PREFIX}font <text>\nThen pick one: ${PREFIX}font <number>\nExample: ${PREFIX}font Rio X`);
      last.set(jid, { text, at: Date.now() });
      return reply(`✨ *FONT STYLES*\n\n${renderAll(text)}\n\n👉 Pick one: *${PREFIX}font <number>* (example: ${PREFIX}font 8)`);
    },
  },
];
