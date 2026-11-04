// .antidelete [owner|chat|off]   (owner = the linked number only; see lib/antidelete.js)
import { PREFIX } from '../lib/config.js';
import { setSetting } from '../lib/storage.js';
import { antiDeleteMode, clearAntiDelete } from '../lib/antidelete.js';

const PICK = { on: 'owner', owner: 'owner', private: 'owner', me: 'owner', inbox: 'owner', chat: 'chat', here: 'chat', same: 'chat', off: 'off', disable: 'off', false: 'off', no: 'off' };
const SAY = {
  off: '❌ OFF',
  owner: '✅ ON: deleted messages are sent to *your own chat*',
  chat: '✅ ON: deleted messages are shown *in the same chat*'
};

export default [
  {
    name: 'antidelete', aliases: ['antidel'], owner: true, react: '🗑️',
    async run({ args, reply, sessionId }) {
      const sub = (args[0] || '').toLowerCase();
      if (!sub) {
        return reply(`🗑️ *Anti-delete:* ${SAY[antiDeleteMode(sessionId)]}\n\n${PREFIX}antidelete owner — send deleted messages to your own chat (private)\n${PREFIX}antidelete chat — show them in the same chat (everybody sees them)\n${PREFIX}antidelete off\n\n_Only messages received after you switch it on are covered. They are kept in memory for 1 hour. View-once messages are not kept._`);
      }
      const mode = PICK[sub];
      if (!mode) return reply(`❌ Use: ${PREFIX}antidelete owner | chat | off`);
      setSetting(sessionId, 'antiDelete', mode);
      if (mode === 'off') clearAntiDelete(sessionId);
      return reply(`🗑️ Anti-delete: ${SAY[mode]}`);
    }
  }
];
