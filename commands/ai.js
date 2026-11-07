// AI and search commands.
//   .gpt4 <question>        (alias .nexagpt)              GPT-4 style answer
//   .googleans <question>   (alias .gans)                 Google direct answer + top results (DuckDuckGo fallback)
//   .addai / .delai         (group admins)                add / remove Meta AI in a group
// For .gpt4 you can also reply to a message instead of typing the question.
// It calls a free public AI API (no key). That API is run by a third party and can go down or change at any time:
// change the URL in PROVIDERS below (or set AI_GPT4_URL) if it stops working.
// Everything a user types is sent to that third party, so tell users not to send private information.
// Adapted from the Kaguya MD plugins by Dhanz (gpt4, googleans) and the add-ai plugin.
import { PREFIX } from '../lib/config.js';
import { adminGuard } from '../lib/groups.js';
import { unwrapMessage } from '../lib/text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const MAX_QUESTION = 1500;   // characters sent to the API
const MAX_ANSWER = 3500;     // characters sent back (a WhatsApp message can be long, but keep it readable)
const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);
const META_AI = '867051314767696@bot';

// param = name of the query parameter that carries the question
export const PROVIDERS = {
  gpt4: { title: 'GPT-4', url: process.env.AI_GPT4_URL || 'https://api.nexadev.my.id/ai/gpt4', param: 'q', retries: 2, timeout: 30000 },
};

// A user can not ask many times in a row (these free APIs have limits, and a slow answer should not be asked twice).
const COOLDOWN_MS = 5000;
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();
function tooSoon(key) {
  const now = Date.now();
  if (now - (lastUse.get(key) || 0) < COOLDOWN_MS) return true;
  lastUse.set(key, now);
  return false;
}
const who = (c) => `${c.sessionId}|${c.msg?.key?.participant || c.jid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Finds the answer text in whatever shape the API returned.
export function pickAnswer(data, depth = 0) {
  if (data == null || depth > 4) return '';
  if (typeof data === 'string') return data;
  for (const key of ['result', 'answer', 'response', 'data', 'message', 'text', 'content']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') { const inner = pickAnswer(v, depth + 1); if (inner) return inner; }
  }
  return '';
}

export function clip(text, max = MAX_ANSWER) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'));
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')}…`;
}

export async function askAI(provider, question, opts = {}) {
  const p = PROVIDERS[provider];
  const retries = opts.retries ?? p.retries;
  const url = new URL(p.url);
  url.searchParams.set(p.param, question);
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(p.timeout) });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* plain text answer */ }
      if (RETRYABLE.has(res.status) && attempt < retries) { await sleep(1500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      const answer = pickAnswer(data ?? raw).trim();
      if (!answer) throw new Error('The AI sent no answer.');
      return answer;
    } catch (err) {
      last = err;
      if (attempt < retries) await sleep(1500 * 2 ** attempt);
    }
  }
  throw last || new Error('The AI request failed.');
}

function quotedTextOf(msg) {
  const m = unwrapMessage(msg?.message);
  const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo;
  const q = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
  return q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption || '';
}

function chatCommand(provider, name, aliases, example) {
  return {
    name, aliases, react: '🤖',
    async run(c) {
      const question = (c.args.join(' ').trim() || quotedTextOf(c.msg).trim()).slice(0, MAX_QUESTION);
      if (!question) return c.reply(`🤖 *${PROVIDERS[provider].title}*\n\nUsage: ${PREFIX}${name} <question>  (or reply to a message)\nExample: ${PREFIX}${name} ${example}`);
      if (tooSoon(who(c))) return c.reply('⏳ Please wait a few seconds before asking again.');
      try {
        const answer = await askAI(provider, question);
        return c.reply(clip(answer));
      } catch (err) {
        console.error(`ai (${provider}) failed:`, err?.message || err);
        return c.reply(`❌ ${PROVIDERS[provider].title} could not answer now${err?.name === 'TimeoutError' ? ' (timeout)' : ''}. Try again in a moment.`);
      }
    },
  };
}

/* ---------- .googleans ---------- */
const decodeHtml = (s = '') => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Pure parsers (tested without network).
export function parseGoogleHtml(html) {
  let direct = null;
  for (const re of [
    /<span[^>]*class=["'][^"']*qv3Wpe[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*class=["'][^"']*IZ6rdc[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class=["'][^"']*hgKElc[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*data-attrid=["']wa:\/description["'][^>]*>([\s\S]*?)<\/div>/i,
  ]) {
    const m = html.match(re);
    const t = m && decodeHtml(m[1]);
    if (t) { direct = t; break; }
  }
  const results = [];
  const block = /<div class="yuRUbf">[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/div>(?:[\s\S]*?<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let m;
  while ((m = block.exec(html))) {
    const title = decodeHtml(m[2]);
    if (m[1].startsWith('http') && title) results.push({ title, url: m[1], snippet: m[3] ? decodeHtml(m[3]) : '' });
  }
  return { direct, results };
}

export function parseDuckHtml(html) {
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* keep as is */ } }
    if (/^https?:\/\//.test(url)) results.push({ title: decodeHtml(m[2]), url, snippet: decodeHtml(m[3]) });
  }
  return results;
}

export async function googleAnswer(query) {
  const signal = AbortSignal.timeout(20000);
  let direct = null; let results = [];
  try {
    const u = new URL('https://www.google.com/search');
    u.searchParams.set('q', query); u.searchParams.set('hl', 'en'); u.searchParams.set('ie', 'UTF-8');
    const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' }, signal });
    if (res.ok) ({ direct, results } = parseGoogleHtml(await res.text()));
  } catch (err) { console.error('googleans (google) failed:', err?.message || err); }
  if (!results.length) {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ q: query }).toString(), signal,
    });
    if (res.ok) results = parseDuckHtml(await res.text());
  }
  return { answer: direct || results[0]?.snippet || '', results: results.slice(0, 5) };
}

export function googleText(query, { answer, results }) {
  const out = [`🔎 *${query}*`];
  if (answer) out.push('', `💡 ${clip(answer, 600)}`);
  results.forEach((r, i) => out.push('', `${i + 1}. *${clip(r.title, 90)}*${r.snippet ? `\n${clip(r.snippet, 160)}` : ''}\n${r.url}`));
  return out.join('\n');
}

export default [
  chatCommand('gpt4', 'gpt4', ['nexagpt'], 'write a short poem about rain'),
  {
    name: 'googleans', aliases: ['gans'], react: '🔎',
    async run(c) {
      const query = c.args.join(' ').trim().slice(0, 300);
      if (!query) return c.reply(`🔎 *Google answer*\n\nUsage: ${PREFIX}googleans <question>\nExample: ${PREFIX}googleans capital of Sri Lanka`);
      if (tooSoon(who(c))) return c.reply('⏳ Please wait a few seconds before asking again.');
      try {
        const res = await googleAnswer(query);
        if (!res.answer && !res.results.length) return c.reply('🤷 Nothing found. Try different words.');
        return c.reply(googleText(query, res));
      } catch (err) {
        console.error('googleans failed:', err?.message || err);
        return c.reply('❌ Search is not working now. Try again in a moment.');
      }
    },
  },
  ...['addai', 'delai'].map((name) => ({
    name, react: '🤖',
    async run(c) {
      const add = name === 'addai';
      const g = await adminGuard(c, { botAdmin: !add }); // adding only needs the group to allow it, removing needs the bot to be admin
      if (!g) return;
      try {
        await c.sock.groupParticipantsUpdate(c.jid, [META_AI], add ? 'add' : 'remove');
        return c.reply(add ? '✅ Meta AI added to this group.' : '✅ Meta AI removed from this group.');
      } catch (err) {
        const msg = String(err?.message || err);
        if (/not-authorized|forbidden|403/i.test(msg)) return c.reply(add ? '⚠️ I am not allowed to add members here. Make me an admin, or let all members add members in the group settings.' : '⚠️ Make me a group admin first.');
        return c.reply(`❌ Could not ${add ? 'add' : 'remove'} Meta AI: ${msg}`);
      }
    },
  })),
];
