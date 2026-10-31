// Media / sticker commands.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { PREFIX } from '../lib/config.js';

export default [
  {
    name: 'media', aliases: ['sticker'],
    async run({ command, reply }) {
        return reply(`🎨 *MEDIA MENU*\n${PREFIX}tosticker — photo → sticker\n${PREFIX}toasticker — video / GIF → animated sticker\n${PREFIX}toimg — sticker → photo\n${PREFIX}tovideo — animated sticker → video\n\nReply to the photo / video / sticker with the command, or send it with the command as the caption.`);
    },
  },
];
