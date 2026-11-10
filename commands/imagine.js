// .imagine <prompt>: AI image from text. 👑 Premium only (`premium: true`; the admin can change this in /admin -> Commands).
// Uses the free Pollinations service by default. To use another one set IMAGINE_URL with {prompt} and {seed} in it,
// e.g.  IMAGINE_URL=https://image.pollinations.ai/prompt/{prompt}?width=1024&height=1024&nologo=true&seed={seed}
import { BOT_NAME, PREFIX } from '../lib/config.js';

const URL_TPL = (process.env.IMAGINE_URL || 'https://image.pollinations.ai/prompt/{prompt}?width=1024&height=1024&nologo=true&seed={seed}').trim();
const GAP_MS = 20 * 1000; // one picture per number every 20 s (these services are slow and rate limited)
const last = new Map();
let busy = 0;
const MAX_BUSY = 2;

export default [
  {
    name: 'imagine', aliases: ['img', 'aiimg', 'draw'], premium: true, react: '🎨',
    async run({ sock, msg, jid, sessionId, args, reply }) {
      const prompt = args.join(' ').trim().slice(0, 400);
      if (!prompt) return reply(`🎨 Usage: *${PREFIX}imagine a red dragon flying over Sigiriya, sunset*\nDescribe the picture in English for the best result.`);
      const wait = GAP_MS - (Date.now() - (last.get(sessionId) || 0));
      if (wait > 0) return reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before the next picture.`);
      if (busy >= MAX_BUSY) return reply('⏳ Many pictures are being made right now. Try again in a minute.');
      last.set(sessionId, Date.now());
      busy++;
      try {
        await reply('🎨 Creating your picture... (10–40 seconds)');
        const url = URL_TPL.replace('{prompt}', encodeURIComponent(prompt)).replace('{seed}', String(Math.floor(Math.random() * 1e9)));
        const res = await fetch(url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!(res.headers.get('content-type') || '').startsWith('image/')) throw new Error('not an image');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000 || buf.length > 15 * 1024 * 1024) throw new Error(`bad size ${buf.length}`);
        return await sock.sendMessage(jid, { image: buf, caption: `🎨 *${prompt}*\n\n_${BOT_NAME}_` }, { quoted: msg });
      } catch (err) {
        console.error('imagine error:', err?.message || err);
        last.delete(sessionId); // a failed try does not count
        return reply('❌ Could not create the picture. Try a different prompt or try again later.');
      } finally { busy--; }
    },
  },
];
