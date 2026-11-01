// Remembers the messages this bot SENT for a while, so WhatsApp "retry" requests can be answered.
// Why: when a contact's phone cannot decrypt a message (new link, changed device, missing session keys) it asks the sender to send it again.
// Baileys can only do that when it can get the original message back (the `getMessage` option). Without it the contact sees
// "Waiting for this message. This may take a while." forever, usually only for SOME contacts. Memory only, nothing is written to disk.
const TTL_MS = 2 * 60 * 60 * 1000, MAX = 4000;
const sent = new Map(); // message id -> { message, at }

export function remember(id, message) {
  if (!id || !message) return;
  sent.set(id, { message, at: Date.now() });
  if (sent.size > MAX) for (const k of [...sent.keys()].slice(0, MAX / 4)) sent.delete(k);
}
export const getStored = (id) => {
  const e = sent.get(id);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) { sent.delete(id); return undefined; }
  return e.message;
};
setInterval(() => { const cutoff = Date.now() - TTL_MS; for (const [k, v] of sent) if (v.at < cutoff) sent.delete(k); }, 10 * 60 * 1000).unref();

// Small cache with the get / set / del / flushAll methods Baileys expects for `msgRetryCounterCache` (how many times a message was retried).
export class RetryCache {
  constructor(ttlMs = 10 * 60 * 1000, max = 2000) { this.ttl = ttlMs; this.max = max; this.m = new Map(); }
  get(k) { const e = this.m.get(k); if (!e) return undefined; if (Date.now() > e.exp) { this.m.delete(k); return undefined; } return e.v; }
  set(k, v) { this.m.set(k, { v, exp: Date.now() + this.ttl }); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  del(k) { this.m.delete(k); }
  flushAll() { this.m.clear(); }
}
