// Shared swipeable card carousel (picture + text + buttons per card), the same kind of message .tts uses.
// Used by .song and .csong. Each card: { image: url | [urls], body: 'text', buttons: [qr(...), ...] }
import fs from 'node:fs';
import path from 'node:path';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { BOT_NAME, ROOT_DIR } from './config.js';
import { applyBrand } from './brand.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FALLBACK_IMG = path.join(ROOT_DIR, 'public', 'ghost.png');

// Downloads the first picture that works; the bundled picture is used if none does, so a card still shows.
export async function coverBuffer(urls) {
  for (const url of [].concat(urls || []).filter(Boolean)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': UA } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 500) return buf;
    } catch { /* try the next one */ }
  }
  return fs.readFileSync(FALLBACK_IMG);
}

export async function sendCards(sock, jid, { title, cards, quoted }) {
  const IM = proto.Message.InteractiveMessage;
  const built = await Promise.all(cards.map(async (c) => {
    const media = await prepareWAMessageMedia({ image: await coverBuffer(c.image) }, { upload: sock.waUploadToServer });
    return IM.create({
      header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: true, ...media }),
      body: IM.Body.create({ text: applyBrand(sock, c.body) }),
      footer: IM.Footer.create({ text: applyBrand(sock, BOT_NAME) }),
      nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: c.buttons, messageParamsJson: '' })
    });
  }));
  const interactiveMessage = IM.create({
    body: IM.Body.create({ text: applyBrand(sock, title) }),
    footer: IM.Footer.create({ text: applyBrand(sock, BOT_NAME) }),
    carouselMessage: IM.CarouselMessage.create({ cards: built, messageVersion: 1 })
  });
  const content = {
    viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage } }
  };
  const waMsg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted });
  const additionalNodes = [{
    tag: 'biz', attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
}
