// .premium: shows this number's plan (free or premium, days left). The admin gives premium days on the admin site.
// To make a command premium-only, add `premium: true` to it (like `owner: true`).
import { planText } from '../lib/premium.js';

export default [
  {
    name: 'premium', aliases: ['plan', 'vip'], owner: true, react: '👑',
    async run({ sessionId, reply }) { return reply(planText(sessionId)); },
  },
];
