// Keeps the bot's encryption sessions with the owner's OTHER devices (mainly the phone) healthy.
// Symptom this fixes: messages the bot sends to the owner's own chat ("Message yourself") show "Waiting for this message" on the phone
// while they look fine on WhatsApp Web / PC. That means the bot's Signal session with the phone's device is out of sync (after a restart,
// a re-link, or when the phone changed). Forcing fresh sessions with all the owner's devices repairs it.
// Runs: 8 s after every (re)connect, and before a message to the own chat when the last repair is older than 20 minutes.
import { jidDecode, jidEncode, jidNormalizedUser } from '@whiskeysockets/baileys';

const MIN_GAP_MS = 20 * 60 * 1000;
const state = new WeakMap(); // sock -> { at, pending }

export async function healSelfSessions(sock, { force = false } = {}) {
  const st = state.get(sock) || {};
  if (st.pending) return st.pending;
  if (!force && st.at && Date.now() - st.at < MIN_GAP_MS) return;
  if (!sock?.user?.id || typeof sock.getUSyncDevices !== 'function' || typeof sock.assertSessions !== 'function') return; // very old / different Baileys: skip
  const run = (async () => {
    const me = jidNormalizedUser(sock.user.id);
    const mine = jidDecode(sock.user.id)?.device || 0;
    const devices = await sock.getUSyncDevices([me], false, true);
    const jids = [...new Set(devices
      .filter((d) => (d.device ?? jidDecode(d.jid)?.device ?? 0) !== mine) // not the bot's own device
      .map((d) => d.jid || jidEncode(d.user, d.server || 's.whatsapp.net', d.device)))];
    if (!jids.length) return;
    await sock.assertSessions(jids, true); // fetch fresh keys and rebuild the sessions
    console.log(`Self sessions refreshed (${jids.length} device${jids.length === 1 ? '' : 's'}).`);
  })()
    .catch((err) => console.error('Self session refresh failed:', err?.message || err))
    .finally(() => { state.set(sock, { at: Date.now() }); });
  state.set(sock, { ...st, pending: run });
  return run;
}

// Wraps sock.sendMessage once: a message to the owner's own chat first makes sure the sessions are fresh (at most every 20 minutes).
export function guardSelfSends(sock) {
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, ...rest) => {
    try {
      if (sock.user?.id && jid && jidNormalizedUser(jid) === jidNormalizedUser(sock.user.id)) await healSelfSessions(sock);
    } catch { /* never block a send */ }
    return original(jid, ...rest);
  };
}
