// Look-up commands.
//   .define <word>   (aliases .dict .meaning)     English dictionary: meaning, example, synonyms
//   .wiki <topic>    (aliases .wikipedia .wp)     Wikipedia summary with the picture and link
//     .wiki -si <topic> picks the language (-en -si -ta -hi ...). Sinhala / Tamil letters pick Sinhala / Tamil Wikipedia on their own.
// Free services, no API key: dictionaryapi.dev and the Wikipedia API (https://www.mediawiki.org/wiki/API:Action_API).
// Wikipedia text is CC BY-SA, so the reply always carries the link.
import { PREFIX } from '../lib/config.js';

const TIMEOUT_MS = 12000;
const UA = { 'user-agent': 'RIO-X-MD/1.4 (WhatsApp bot; https://www.mediawiki.org/wiki/API:Etiquette)', accept: 'application/json' };
const SINHALA = /[඀-෿]/;
const TAMIL = /[஀-௿]/;

// A user can not ask many times in a row (the free services have limits too).
const COOLDOWN_MS = 3000;
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();
function tooSoon(key) {
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < COOLDOWN_MS) return true;
  lastUse.set(key, now);
  return false;
}
const who = (sessionId, msg, jid) => `${sessionId}|${msg.key?.participant || jid}`;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Cuts at the end of a sentence when it can, so a long text never stops in the middle of a word.
export function clip(text, max) {
  const t = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')}…`;
}

/* ---------- .define ---------- */
async function lookup(word) {
  const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  return Array.isArray(data) && data.length ? data : null;
}

// Pure formatter (tested without network). entries = the dictionaryapi.dev answer.
export function defineText(entries) {
  const first = entries[0];
  const phonetic = first.phonetic || first.phonetics?.find((p) => p?.text)?.text || '';
  const lines = [`📖 *${first.word}*${phonetic ? `  ${phonetic}` : ''}`];
  const seen = new Set();
  let shown = 0;
  for (const entry of entries) {
    for (const m of entry.meanings || []) {
      const pos = m.partOfSpeech || 'other';
      if (seen.has(pos) || shown >= 3 || !m.definitions?.length) continue;
      seen.add(pos);
      shown++;
      lines.push('', `_${pos}_`);
      m.definitions.slice(0, 2).forEach((d, i) => {
        lines.push(`${i + 1}. ${clip(d.definition, 260)}`);
        if (i === 0 && d.example) lines.push(`   _e.g. ${clip(d.example, 160)}_`);
      });
      const syn = [...new Set([...(m.synonyms || []), ...(m.definitions[0]?.synonyms || [])])].slice(0, 5);
      if (syn.length) lines.push(`🔁 ${syn.join(', ')}`);
    }
  }
  if (shown === 0) return null;
  lines.push('', `💡 Sinhala meaning: ${PREFIX}tr si ${first.word}`);
  return lines.join('\n');
}

const define = {
  name: 'define', aliases: ['dict', 'meaning'], react: '📖',
  async run({ msg, jid, sessionId, args, reply }) {
    const word = args.join(' ').trim();
    if (!word) return reply(`📖 *Dictionary*\nUsage: ${PREFIX}define <word>\nExample: ${PREFIX}define serendipity`);
    if (SINHALA.test(word) || TAMIL.test(word)) return reply(`📖 This dictionary is for English words.\nFor Sinhala or Tamil use ${PREFIX}translate (example: ${PREFIX}tr en ${word.slice(0, 30)}).`);
    if (!/^[\p{L}][\p{L}'’ -]{0,39}$/u.test(word)) return reply(`❌ Send one English word (letters only, up to 40 characters).\nExample: ${PREFIX}define serendipity`);
    if (tooSoon(`def|${who(sessionId, msg, jid)}`)) return reply('⏳ Wait a few seconds before the next look-up.');
    let entries;
    try {
      entries = await lookup(word.toLowerCase());
    } catch (err) {
      console.error('define error:', err?.message || err);
      return reply('❌ The dictionary service is not answering right now. Try again in a little while.');
    }
    const text = entries && defineText(entries);
    if (!text) return reply(`🔍 No meaning found for "${word}".\nCheck the spelling, or try ${PREFIX}wiki ${word}`);
    return reply(text);
  },
};

/* ---------- .wiki ---------- */
// "-si colombo" -> { lang: 'si', topic: 'colombo' }.  Without a flag the language comes from the letters used (Sinhala / Tamil), else English.
export function parseWiki(args) {
  const list = [...args];
  let lang = null;
  const flag = /^-([a-z]{2,3})$/i.exec(list[0] || '');
  if (flag) { lang = flag[1].toLowerCase(); list.shift(); }
  const topic = list.join(' ').trim().slice(0, 100);
  if (!lang) lang = SINHALA.test(topic) ? 'si' : TAMIL.test(topic) ? 'ta' : 'en';
  return { lang, topic };
}

async function wikiPage(lang, topic) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const common = {
    action: 'query', format: 'json', formatversion: '2', redirects: '1', converttitles: '1',
    prop: 'extracts|pageimages|info|pageprops', exintro: '1', explaintext: '1', exsentences: '6',
    inprop: 'url', piprop: 'thumbnail', pithumbsize: '640', ppprop: 'disambiguation',
  };
  const ask = async (extra) => (await getJson(`${base}?${new URLSearchParams({ ...common, ...extra })}`))?.query?.pages?.[0];
  let page = await ask({ titles: topic });                                       // exact title first
  if (!page || page.missing || page.invalid) page = await ask({ generator: 'search', gsrsearch: topic, gsrlimit: '1' }); // then the best search hit
  if (!page || page.missing || !page.extract) return null;
  return { title: page.title, extract: page.extract, url: page.fullurl, thumb: page.thumbnail?.source || null, disambiguation: !!page.pageprops && 'disambiguation' in page.pageprops };  // the API sends this page property with an empty value
}

// Pure formatter (tested without network).
export function wikiText(page, lang) {
  const out = [`📚 *${page.title}*`, '', clip(page.extract, 750)];
  if (page.disambiguation) out.push('', `ℹ️ Many things share this name. Be more specific, for example ${PREFIX}wiki ${page.title} (city).`);
  out.push('', `🔗 ${page.url}`, `_Source: Wikipedia (${lang})_`);
  return out.join('\n');
}

async function fetchThumb(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)wikimedia\.org$/i.test(u.hostname)) return null; // only Wikipedia's own picture host
    const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA['user-agent'] } });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= 3 * 1048576 ? buf : null;
  } catch { return null; }
}

const wiki = {
  name: 'wiki', aliases: ['wikipedia', 'wp'], react: '📚',
  async run({ sock, msg, jid, sessionId, args, reply }) {
    const { lang, topic } = parseWiki(args);
    if (!topic) return reply(`📚 *Wikipedia*\nUsage: ${PREFIX}wiki <topic>\nExample: ${PREFIX}wiki Sigiriya\nOther language: ${PREFIX}wiki -si කොළඹ  (-en, -si, -ta, -hi ...)`);
    if (tooSoon(`wiki|${who(sessionId, msg, jid)}`)) return reply('⏳ Wait a few seconds before the next look-up.');
    let page;
    try {
      page = await wikiPage(lang, topic);
    } catch (err) {
      console.error('wiki error:', err?.message || err);
      return reply('❌ Wikipedia is not answering right now (or that language does not exist). Try again in a little while.');
    }
    if (!page) return reply(`🔍 Nothing found for "${topic.slice(0, 60)}" on Wikipedia (${lang}).\nTry other words${lang === 'en' ? '' : ' or another language with -en'}.`);
    const text = wikiText(page, lang);
    const thumb = page.thumb && await fetchThumb(page.thumb);
    if (thumb) {
      try { return await sock.sendMessage(jid, { image: thumb, caption: text }, { quoted: msg }); }
      catch (err) { console.error('wiki picture skipped:', err?.message || err); }
    }
    return reply(text);
  },
};

export default [define, wiki];
