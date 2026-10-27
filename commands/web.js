// .webpass: send a new web settings password to your own chat (owner only).
import { jidNum } from '../lib/config.js';
import { sendWebPassword } from '../lib/webpass.js';

export default [
  {
    name: 'webpass', aliases: ['websettings', 'webpassword'], owner: true, react: '🔑',
    async run({ sock, sessionId, reply }) {
      try {
        await sendWebPassword(sock, sessionId);
      } catch (err) {
        console.error('webpass error:', err?.message || err);
        return reply('❌ Could not send the password. Try again in a moment.');
      }
      return reply(`🔑 A new web password was sent to your own chat (+${jidNum(sock.user?.id)}). The old one no longer works.`);
    },
  },
];
