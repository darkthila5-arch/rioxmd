// Makes every bot reply look the same: text in bold, errors / notices in a small box.
// Used by say() in card.js and by sendRich() in menu.js. Pure function, no imports.
const HAS_TEXT = /[\p{L}\p{N}]/u;
const LINE_RE = /^(\s*(?:[┃│]\s*(?:✦\s*)?|[▸▪•]\s+|\d+[.)]\s+|[-–]\s+)?)(.*?)(\s*)$/u;
const PAIR_RE = /\*(?=\S)[^*\n]+?(?<=\S)\*/gu;
const KINDS = [
  [/^(❌|❎)/u, '❌', 'ERROR'],
  [/^🚫/u, '🚫', 'NOT ALLOWED'],
  [/^⛔/u, '⛔', 'BLOCKED'],
  [/^\u26A0\uFE0F?/u, '⚠️', 'WARNING'],
  [/^❔/u, '❔', 'NOT FOUND'],
  [/^✅/u, '✅', 'DONE'],
];

function boldLine(line) {
  if (!line.trim()) return line;
  if (/^\s*[╭╰]/u.test(line)) return line;               // box edges
  if (/https?:\/\/|@\d{5,}|^\s*>/u.test(line)) return line;     // links, mentions, quotes
  if (line.includes('*')) {                                      // part of the line is already bold: make all of it bold
    const pairs = line.match(PAIR_RE) || [];
    if (!pairs.length || line.match(/\*/g).length !== pairs.length * 2) return line; // odd asterisks (like 2 * 3): leave it
    line = line.replace(PAIR_RE, (m) => m.slice(1, -1));
  }
  const [, pre, body, post] = LINE_RE.exec(line);
  if (!HAS_TEXT.test(body) || /^_.*_$/u.test(body)) return line; // decoration only, or an italic note
  return `${pre}*${body}*${post}`;
}

export function prettify(text) {
  const raw = String(text ?? '');
  if (!raw.trim() || raw.includes('```')) return raw;
  const t = raw.replace(/^\s+/, '');
  if (/^[╭╰]/u.test(t)) return raw.split('\n').map(boldLine).join('\n'); // already a box (menu, alive ...)
  for (const [re, icon, label] of KINDS) {
    if (!re.test(t)) continue;
    const body = t.replace(re, '').trim();
    const lines = body.split('\n').map((l) => (l.trim() ? boldLine(`┃ ${l.trim()}`) : '┃'));
    return [`╭━━━〔 ${icon} *${label}* 〕━━━⬣`, ...lines, '╰━━━━━━━━━━━━━━━━━━━━⬣'].join('\n');
  }
  return raw.split('\n').map(boldLine).join('\n');
}
