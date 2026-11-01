// Shared swipeable card carousel (picture + text + buttons per card), the same kind of message .tts uses.
import { remember } from './msgstore.js';
// Used by .song and .csong. Each card: { image: url | [urls], body: 'text', buttons: [qr(...), ...] }
import fs from 'node:fs';
import path from 'node:path';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { BOT_NAME, ROOT_DIR } from './config.js';
import { FOOTER_TEXT, applyBrand } from './brand.js';

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


/* ---------- the owner cannot tap the buttons of their own number ---------- */
// WhatsApp never lets the SENDER tap the buttons of their own message, and the bot IS the owner's account.
// So when the owner started the command, every card gets numbered choices (1.1 audio, 1.2 video, 1.3 doc / 2.1 ...) and the owner just sends the number.
const picks = new Map(); // "botnumber:chat" -> { map: { '1.2': '.ytdl video abc' }, at }
const PICK_TTL = 15 * 60 * 1000;
const keyOf = (sock, jid) => `${String(sock.user?.id || '').split('@')[0].split(':')[0]}:${jid}`;
function remember_picks(sock, jid, map) {
  picks.set(keyOf(sock, jid), { map, at: Date.now() });
  if (picks.size > 300) picks.delete(picks.keys().next().value);
}
const quickReplies = (buttons) => {
  const out = [];
  for (const b of buttons || []) {
    if (b?.name !== 'quick_reply') continue;
    try { const o = JSON.parse(b.buttonParamsJson); if (o?.id) out.push({ text: o.display_text || '', id: o.id }); } catch { /* skip */ }
  }
  return out;
};
// cards: [{ body, buttons }]. Returns the cards with the numbered choices added to each body (and remembers them). Not the owner: returned unchanged.
export function ownerCards(sock, jid, quoted, cards) {
  if (!quoted?.key?.fromMe) return cards;
  const map = {};
  const out = cards.map((c, i) => {
    const opts = quickReplies(c.buttons);
    if (!opts.length) return c;
    const lines = opts.map((o, j) => { map[`${i + 1}.${j + 1}`] = o.id; return `${i + 1}.${j + 1}  ${o.text}`; });
    return { ...c, body: `${c.body}\n\n${lines.join('\n')}` };
  });
  remember_picks(sock, jid, map);
  return out;
}
// A single message with buttons (the download card): choices 1, 2, 3. Returns the text lines to add under the caption ('' when not the owner).
export function ownerChoices(sock, jid, quoted, buttons) {
  if (!quoted?.key?.fromMe) return '';
  const opts = quickReplies(buttons);
  if (!opts.length) return '';
  const map = {};
  const lines = opts.map((o, i) => { map[String(i + 1)] = o.id; return `${i + 1}  ${o.text}`; });
  remember_picks(sock, jid, map);
  return `\n\n👑 Send the number:\n${lines.join('\n')}`;
}
// "1.2" / "2" sent by the owner -> the command of that choice (or null).
export function resolveOwnerPick(sock, jid, text) {
  const t = String(text || '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const e = picks.get(keyOf(sock, jid));
  return e && Date.now() - e.at < PICK_TTL ? (e.map[t] || null) : null;
}

export async function sendCards(sock, jid, { title, cards: rawCards, quoted }) {
  const IM = proto.Message.InteractiveMessage;
  const cards = ownerCards(sock, jid, quoted, rawCards);
  if (quoted?.key?.fromMe) title += '\n\n👑 Your own number cannot tap buttons: send the number, example *1.2*';
  const built = await Promise.all(cards.map(async (c) => {
    const media = await prepareWAMessageMedia({ image: await coverBuffer(c.image) }, { upload: sock.waUploadToServer });
    return IM.create({
      header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: true, ...media }),
      body: IM.Body.create({ text: applyBrand(sock, c.body) }),
      footer: IM.Footer.create({ text: applyBrand(sock, FOOTER_TEXT) }),
      nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: c.buttons, messageParamsJson: '' })
    });
  }));
  const interactiveMessage = IM.create({
    body: IM.Body.create({ text: applyBrand(sock, title) }),
    footer: IM.Footer.create({ text: applyBrand(sock, FOOTER_TEXT) }),
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
  remember(waMsg.key.id, waMsg.message); // relayMessage sends are not reported back, so keep them for retry requests
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });

}
