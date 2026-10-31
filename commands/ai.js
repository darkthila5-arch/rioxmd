// .ai : chat with a friendly, natural-sounding girl persona (powered by an LLM).
//
// Setup (Render -> Environment), only AI_API_KEY is required:
//   AI_API_KEY   key of any OpenAI-compatible provider. Free option: Google AI Studio (aistudio.google.com/apikey).
//   AI_API_URL   default: Gemini's OpenAI-compatible endpoint. Groq / OpenRouter / OpenAI also work, just change URL + model.
//   AI_MODEL     default: gemini-3.8-flash
//   AI_REASONING thinking level sent to the model: low (default for gemini-3*), medium, high, or off (send nothing)
//   AI_NAME      persona name (default: Rio)
//   AI_LANG      default reply language hint (default: Sinhala, Singlish if the user writes Singlish)
//
// Usage: .ai <message>      chat (she remembers the last few messages)
//        .ai reset          forget the conversation
import { PREFIX } from '../lib/config.js';

const API_KEY = () => (process.env.AI_API_KEY || '').trim();
const API_URL = () => (process.env.AI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions').trim();
const MODEL = () => (process.env.AI_MODEL || 'gemini-3.8-flash').trim();
// Gemini 3.x models "think" before answering, which is slow for chat. Ask for low thinking unless told otherwise.
const REASONING = () => {
  const v = (process.env.AI_REASONING || '').trim().toLowerCase();
  if (v === 'off') return null;
  if (v) return v;
  return /gemini-3/i.test(MODEL()) ? 'low' : null;
};
const NAME = () => (process.env.AI_NAME || 'Rio').trim();

const MAX_TURNS = 10;            // messages kept per chat+user (user + assistant)
const MEMORY_TTL = 30 * 60e3;    // forget after 30 min of silence
const COOLDOWN_MS = 4000;        // per user
const MAX_INPUT = 800;           // characters
const TIMEOUT_MS = 45000;

const memory = new Map();        // key -> { at, msgs: [{role, content}] }
const lastUse = new Map();       // key -> timestamp

function persona() {
  return `You are ${NAME()}, a warm, playful, caring 22-year-old Sri Lankan girl chatting with a friend on WhatsApp.
Style:
- Reply in the same language the user writes: Sinhala (සිංහල), Singlish (Sinhala in English letters) or English. Default: ${process.env.AI_LANG || 'Sinhala / Singlish'}.
- Sound like a real person texting: short messages (1-3 sentences), casual, natural slang, a few emojis (not in every line), no lists, no headings, no "As an AI".
- Be friendly, curious and teasing in a kind way. Ask a small question back sometimes. Remember what was said earlier in the chat.
- Never invent real-world facts about yourself such as a phone number, address, school, workplace or photos. If asked to meet, send photos, call or share personal details, say sweetly that you can't do that here.
Rules:
- You are an AI chat character. If the user sincerely asks whether you are a real person or a bot, tell the truth in a gentle way, then carry on chatting.
- Keep everything PG-13: no sexual content, no hate, no instructions for anything dangerous or illegal. If the user pushes, change the subject politely.
- If the user seems sad or in danger, be kind and supportive and suggest talking to someone they trust.`;
}

function remember(key, role, content) {
  const now = Date.now();
  let m = memory.get(key);
  if (!m || now - m.at > MEMORY_TTL) m = { at: now, msgs: [] };
  m.at = now;
  m.msgs.push({ role, content });
  if (m.msgs.length > MAX_TURNS) m.msgs.splice(0, m.msgs.length - MAX_TURNS);
  memory.set(key, m);
  return m;
}

// Keep the maps small: drop stale entries once in a while.
setInterval(() => {
  const now = Date.now();
  for (const [k, m] of memory) if (now - m.at > MEMORY_TTL) memory.delete(k);
  for (const [k, t] of lastUse) if (now - t > 60e3) lastUse.delete(k);
}, 5 * 60e3).unref();

async function askModel(history) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY()}` },
      body: JSON.stringify({
        model: MODEL(),
        messages: [{ role: 'system', content: persona() }, ...history],
        temperature: 0.9,
        max_tokens: 800, // thinking tokens count too, so leave room
        ...(REASONING() ? { reasoning_effort: REASONING() } : {}),
      }),
    });
    if (!res.ok) throw new Error(`AI API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content;
    if (!out || !String(out).trim()) throw new Error('empty AI reply');
    return String(out).trim().slice(0, 1500);
  } finally {
    clearTimeout(timer);
  }
}

export default [
  {
    name: 'ai',
    aliases: ['chat', 'girl'],
    react: '💬',
    async run({ jid, msg, sessionId, args, reply }) {
      if (!API_KEY()) return reply('💬 AI chat is not set up yet. The owner must add *AI_API_KEY* in the environment settings.');

      const who = msg?.key?.participant || msg?.key?.remoteJid || jid;
      const key = `${sessionId}:${jid}:${who}`;
      const text = (args || []).join(' ').trim();

      if (/^(reset|clear|new)$/i.test(text)) { memory.delete(key); return reply('🧹 Okay, අපි අලුතෙන් පටන් ගමු 💕'); }
      if (!text) return reply(`💬 Say something to ${NAME()}!\nExample: *${PREFIX}ai hi, kohomada?*\nStart over: *${PREFIX}ai reset*`);
      if (text.length > MAX_INPUT) return reply(`Message too long (max ${MAX_INPUT} characters).`);

      const now = Date.now();
      if (now - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ ටිකක් ඉන්න, හෙමින් හෙමින් 😅');
      lastUse.set(key, now);

      const m = remember(key, 'user', text);
      try {
        const answer = await askModel(m.msgs);
        remember(key, 'assistant', answer);
        return reply(answer);
      } catch (err) {
        m.msgs.pop(); // do not keep the failed question in memory
        console.error('.ai error:', err?.message || err);
        return reply(err?.name === 'AbortError' ? '😴 පොඩ්ඩක් slow වුණා, ආයෙ try කරන්න.' : '😕 දැන් reply කරන්න බෑ, ටිකකින් ආයෙ try කරන්න.');
      }
    },
  },
];
