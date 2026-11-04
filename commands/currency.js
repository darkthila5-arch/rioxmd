// .currency 100 usd lkr     (aliases .cur .fx .convert)
//   .currency usd lkr eur    1 USD in LKR and EUR      .currency 5000 lkr   LKR -> USD
// Rates: open.er-api.com (free, no key, updated daily). Cached for 30 minutes per base currency.
import { PREFIX } from '../lib/config.js';

const TIMEOUT_MS = 12000;
const CACHE_MS = 30 * 60 * 1000;
const MAX_TARGETS = 5;
const cache = new Map(); // base -> { at, data }

export function clearRateCache() { cache.clear(); }

async function getRates(base) {
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.result !== 'success' || !data.rates) throw new Error('bad response');
  cache.set(base, { at: Date.now(), data });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return data;
}

// "100 usd to lkr" / "100usd lkr eur" / "usd" / "5,000 lkr"  ->  { amount, from, to: [..] }   (null when it does not look like a conversion)
export function parseCurrency(args) {
  const s = String(Array.isArray(args) ? args.join(' ') : args || '').toLowerCase().replace(/,/g, '').replace(/->|=|\b(?:to|in|into)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)?\s*([a-z]{3})((?:\s+[a-z]{3})*)$/);
  if (!m) return null;
  const amount = m[1] === undefined ? 1 : Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return null;
  const from = m[2].toUpperCase();
  let to = m[3].trim() ? m[3].trim().split(' ').map((x) => x.toUpperCase()) : [];
  to = [...new Set(to)].filter((x) => x !== from).slice(0, MAX_TARGETS);
  if (!to.length) to = [from === 'LKR' ? 'USD' : 'LKR'];
  return { amount, from, to };
}

export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number(n.toPrecision(4)).toString();
}

// Pure (tested without network): rates = the "rates" table of `from`.
export function convertText({ amount, from, to }, rates, updated) {
  const lines = [`💱 *${fmtMoney(amount)} ${from}* =`];
  const bad = [];
  for (const code of to) {
    const r = rates[code];
    if (typeof r !== 'number') { bad.push(code); continue; }
    lines.push(`   ➜ *${fmtMoney(amount * r)} ${code}*   _(1 ${from} = ${fmtMoney(r)} ${code})_`);
  }
  if (bad.length) lines.push('', `❓ Unknown currency: ${bad.join(', ')}`);
  if (updated) lines.push('', `🕒 Rates updated: ${String(updated).replace(/ \+0000$/, ' UTC')}`);
  return lines.join('\n');
}

export default [
  {
    name: 'currency', aliases: ['cur', 'fx', 'convert'], react: '💱',
    async run({ args, reply }) {
      const usage = `💱 *Currency converter*\n\n${PREFIX}currency 100 usd lkr\n${PREFIX}currency usd lkr eur gbp\n${PREFIX}currency 5000 lkr  _(LKR → USD)_\n\n_Use 3-letter codes: USD, LKR, EUR, GBP, INR, AUD, AED, SAR ..._`;
      const q = parseCurrency(args);
      if (!q) return reply(usage);
      try {
        const data = await getRates(q.from);
        if (data.rates && !q.to.some((c) => typeof data.rates[c] === 'number')) return reply(`❌ I do not know the currency *${q.to.join(', ')}*.\n\n${usage}`);
        return reply(convertText(q, data.rates, data.time_last_update_utc));
      } catch (err) {
        console.error('currency error:', err?.message || err);
        return reply(`❌ Could not get the rate for *${q.from}*. Check the code (example: USD) or try again in a minute.`);
      }
    }
  }
];
