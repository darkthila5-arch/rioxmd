// Helpers for .gadd (add many numbers to a group). Plain functions only (no WhatsApp calls), so they are easy to test.

export const MAX_PER_RUN = 30;      // numbers handled by one command
export const MAX_PER_HOUR = 120;    // add attempts per linked number per hour
export const GAP_MIN_MS = 3000;     // pause between two adds: WhatsApp restricts accounts that add people in a burst
export const GAP_MAX_MS = 6500;

const LINK = /(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,40})/i;
export const parseGroupCode = (text) => String(text || '').match(LINK)?.[1] || null;

// "94771234567, +94 77 987 6543, 0711112222" -> { numbers: ['94771234567', ...], invalid: ['...'] }
// Numbers are separated by commas, semicolons or new lines. Plain numbers separated by spaces also work.
export function parseNumbers(text, cc = '94') {
  const numbers = [], invalid = [];
  const seen = new Set();
  const take = (raw) => {
    let d = String(raw).replace(/\D/g, '');
    if (!d) return;
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0') && cc) d = cc + d.slice(1); // 0771234567 -> 94771234567
    if (d.length < 8 || d.length > 15) { invalid.push(String(raw).trim().slice(0, 20)); return; }
    if (!seen.has(d)) { seen.add(d); numbers.push(d); }
  };
  for (const chunk of String(text || '').replace(LINK, ' ').split(/[,;\n\r]+/)) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (parts.length > 1 && parts.every((p) => p.replace(/\D/g, '').length >= 8)) parts.forEach(take); // "947711 947722"
    else take(parts.join(''));                                                                       // "+94 77 123 4567"
  }
  return { numbers, invalid };
}

// Result codes WhatsApp gives for one add. Anything unknown counts as a failure.
export const KINDS = {
  added:   { icon: '✅', label: 'Added' },
  already: { icon: '👥', label: 'Already in the group' },
  privacy: { icon: '🔒', label: 'Their privacy settings do not allow adding (send them the invite link)' },
  invited: { icon: '📨', label: 'Invite link sent to them' },
  left:    { icon: '⏳', label: 'Left recently (try again later)' },
  nowa:    { icon: '📵', label: 'Not on WhatsApp' },
  blocked: { icon: '⛔', label: 'Could not be added (blocked or not allowed)' },
  failed:  { icon: '❌', label: 'Failed' },
};
export function classify(status) {
  switch (String(status)) {
    case '200': return 'added';
    case '409': return 'already';
    case '403': return 'privacy';
    case '408': return 'left';
    case '401': case '404': return 'blocked';
    default: return 'failed';
  }
}

export const flag = (n) => `+${n}`;
// results: [{ num, kind }], extra: { invalid: [], rest: [] (not processed), stopped: 'reason' | '' }
export function buildSummary(groupName, results, { invalid = [], rest = [], stopped = '' } = {}) {
  const by = {};
  for (const r of results) (by[r.kind] ||= []).push(r.num);
  const lines = ['╭━━━〔 ➕ *BULK ADD* 〕━━━⬣', `┃ Group: *${groupName || 'the group'}*`];
  for (const [k, v] of Object.entries(KINDS)) if (by[k]) lines.push(`┃ ${v.icon} ${by[k].length} × ${v.label}`);
  if (invalid.length) lines.push(`┃ ❓ ${invalid.length} × Not a valid number`);
  if (rest.length) lines.push(`┃ ⏸️ ${rest.length} × Not processed (limit is ${MAX_PER_RUN} per command)`);
  lines.push('╰━━━━━━━━━━━━━━━━━━━━⬣');
  if (stopped) lines.push('', `⚠️ Stopped early: ${stopped}`);
  for (const [k, v] of Object.entries(KINDS)) {
    if (!by[k] || k === 'added' || k === 'already') continue; // the lists of problems are the useful part
    lines.push('', `${v.icon} *${v.label}*`, by[k].slice(0, 40).map(flag).join(', ') + (by[k].length > 40 ? ` +${by[k].length - 40} more` : ''));
  }
  if (invalid.length) lines.push('', '❓ *Not valid*', invalid.slice(0, 20).join(', '));
  if (rest.length) lines.push('', '⏸️ *Send these again*', rest.slice(0, 60).map(flag).join(', '));
  return lines.join('\n');
}
