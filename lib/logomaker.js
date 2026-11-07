// Logo maker used by .logo / .logo2 / .logohd. A name goes in, 20 different logo styles come out.
// Every logo is drawn here as SVG and turned into a picture with sharp, so there is no web API that can break or die.
// Fonts: the Docker image already has Noto Sans / Noto Serif / DejaVu (Sinhala and Tamil names work too).

export const MAX_NAME = 24;       // longest name (letters)
export const PAGE_SIZE = 10;      // cards in one swipe message (WhatsApp allows up to 10)
const S = 800;                    // drawing area, every style is drawn on 800 x 800

const SANS = "'Noto Sans','DejaVu Sans','Liberation Sans',Arial,sans-serif";
const SERIF = "'Noto Serif','DejaVu Serif','Liberation Serif',Georgia,serif";
const MONO = "'DejaVu Sans Mono','Noto Sans Mono','Liberation Mono',monospace";

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Name typed by the user -> safe, short, single line.
export function cleanName(raw) {
  return [...String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME).join('').trim();
}

// Same name always gives the same random stars / embers.
function rng(seed) {
  let a = 7;
  for (const c of String(seed)) a = (Math.imul(a, 31) + c.codePointAt(0)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- text helpers ---------- */
// Splits long names on a space into 2 lines and works out a font size that fits maxW.
function layout(name, { upper = true, maxW = 640, maxSize = 150, minSize = 30, factor = 0.68, ls = 0 } = {}) {
  const t = upper ? name.toUpperCase() : name;
  let lines = [t];
  const len = (x) => [...x].length;
  if (len(t) > 11 && t.includes(' ')) {
    let best = null;
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== ' ') continue;
      const a = t.slice(0, i).trim(); const b = t.slice(i + 1).trim();
      if (!a || !b) continue;
      const d = Math.abs(len(a) - len(b));
      if (!best || d < best.d) best = { a, b, d };
    }
    if (best) lines = [best.a, best.b];
  }
  const longest = Math.max(...lines.map(len));
  const size = Math.max(minSize, Math.min(maxSize, (maxW - longest * ls) / (longest * factor))); // letter spacing (ls) counts in the width
  const h = lines.length * size * 1.12;
  const w = Math.min(maxW, longest * (size * factor + ls));
  return { lines, size, h, w };
}

function txt(L, o = {}) {
  const { x = S / 2, y = S / 2, fill = '#fff', fam = SANS, weight = 800, ls = 0, style = 'normal', extra = '', size = L.size, lh = 1.12, dx = 0, dy = 0 } = o;
  const n = L.lines.length;
  const first = y + dy - ((n - 1) * lh * size) / 2 + size * 0.35;
  const spans = L.lines.map((l, i) => `<tspan x="${(x + dx + ls / 2).toFixed(1)}" y="${(first + i * lh * size).toFixed(1)}">${esc(l)}</tspan>`).join('');
  return `<text text-anchor="middle" font-family="${fam}" font-weight="${weight}" font-style="${style}" font-size="${size.toFixed(1)}" letter-spacing="${ls}" fill="${fill}" ${extra}>${spans}</text>`;
}

const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`).join('');
const vgrad = (id, y1, y2, list) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1.toFixed(1)}" x2="0" y2="${y2.toFixed(1)}">${stops(list)}</linearGradient>`;
const hgrad = (id, x1, x2, list) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="0" x2="${x2.toFixed(1)}" y2="0">${stops(list)}</linearGradient>`;
const bgGrad = (id, list, x2 = 1, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops(list)}</linearGradient>`;
const radial = (id, list, r = '75%') => `<radialGradient id="${id}" cx="50%" cy="50%" r="${r}">${stops(list)}</radialGradient>`;
const blur = (id, sd) => `<filter id="${id}" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
const bg = (fill) => `<rect width="${S}" height="${S}" fill="${fill}"/>`;
const star = (cx, cy, r, fill, pts = 5) => {
  const p = [];
  for (let i = 0; i < pts * 2; i++) { const a = (Math.PI * i) / pts - Math.PI / 2; const rr = i % 2 ? r * 0.42 : r; p.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`); }
  return `<polygon points="${p.join(' ')}" fill="${fill}"/>`;
};
const sparkle = (cx, cy, r, fill) => `<path d="M${cx} ${cy - r} Q${cx} ${cy} ${cx + r} ${cy} Q${cx} ${cy} ${cx} ${cy + r} Q${cx} ${cy} ${cx - r} ${cy} Q${cx} ${cy} ${cx} ${cy - r}Z" fill="${fill}"/>`;
const initials = (name, n = 1) => {
  const words = name.split(' ').filter(Boolean);
  const pick = (words.length > 1 && n > 1 ? words.slice(0, n) : [words[0] || name]).map((w) => [...w][0]);
  return (pick.length > 1 ? pick.join('') : pick[0] || '?').toUpperCase();
};

/* ---------- the styles ---------- */
export const STYLES = [
  { key: 'neon', title: 'Neon Glow', build(n) {
    const L = layout(n, { maxSize: 150, factor: 0.8 });
    return `<defs>${radial('b', [[0, '#1d0b3d'], [1, '#05030f']])}${blur('g1', 16)}${blur('g2', 5)}</defs>${bg('url(#b)')}
<rect x="70" y="70" width="660" height="660" rx="40" fill="none" stroke="#00e5ff" stroke-width="8" filter="url(#g2)"/>
<rect x="70" y="70" width="660" height="660" rx="40" fill="none" stroke="#b8f6ff" stroke-width="3"/>
${txt(L, { fill: '#ff2bd6', extra: 'filter="url(#g1)"' })}${txt(L, { fill: '#ff2bd6', extra: 'filter="url(#g2)"' })}
${txt(L, { fill: '#fff', extra: 'stroke="#ff7bf0" stroke-width="2"' })}`;
  } },
  { key: 'gold', title: 'Gold Luxury', build(n) {
    const L = layout(n, { maxSize: 120, factor: 0.85, maxW: 600 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    const line = (y) => `<line x1="210" y1="${y}" x2="590" y2="${y}" stroke="url(#gl)" stroke-width="3"/><rect x="392" y="${y - 8}" width="16" height="16" transform="rotate(45 400 ${y})" fill="url(#gl)"/>`;
    return `<defs>${radial('b', [[0, '#2c1f08'], [1, '#050301']])}${vgrad('gd', t, b, [[0, '#fff2b0'], [0.45, '#f5c542'], [0.55, '#b8860b'], [1, '#ffe27a']])}${hgrad('gl', 200, 600, [[0, '#b8860b', 0], [0.5, '#ffe27a'], [1, '#b8860b', 0]])}${hgrad('fr', 0, 800, [[0, '#8a6508'], [0.5, '#ffe27a'], [1, '#8a6508']])}</defs>${bg('url(#b)')}
<rect x="40" y="40" width="720" height="720" fill="none" stroke="url(#fr)" stroke-width="5"/><rect x="60" y="60" width="680" height="680" fill="none" stroke="url(#fr)" stroke-width="1.5"/>
${line(t - 50)}${line(b + 50)}
${txt(L, { fill: '#000', fam: SERIF, weight: 700, dx: 4, dy: 5, extra: 'opacity="0.6"' })}${txt(L, { fill: 'url(#gd)', fam: SERIF, weight: 700, extra: 'stroke="#5a3d00" stroke-width="1.5"' })}`;
  } },
  { key: 'chrome', title: 'Chrome Metal', build(n) {
    const L = layout(n, { maxSize: 150, factor: 0.8 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    return `<defs>${radial('b', [[0, '#3b4354'], [1, '#090b10']])}${vgrad('ch', t, b, [[0, '#ffffff'], [0.46, '#9aa4b4'], [0.5, '#262d3a'], [0.56, '#7b8798'], [1, '#f4f7fb']])}</defs>${bg('url(#b)')}
${txt(L, { fill: '#05070b', extra: 'stroke="#05070b" stroke-width="14" stroke-linejoin="round"', dy: 8 })}
${txt(L, { fill: '#0b0f16', extra: 'stroke="#d8e0ec" stroke-width="9" stroke-linejoin="round"' })}
${txt(L, { fill: 'url(#ch)' })}`;
  } },
  { key: 'fire', title: 'Fire Blaze', build(n) {
    const L = layout(n, { maxSize: 150, factor: 0.8 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    const r = rng(n); let embers = '';
    for (let i = 0; i < 40; i++) embers += `<circle cx="${(r() * S).toFixed(0)}" cy="${(250 + r() * 520).toFixed(0)}" r="${(1 + r() * 3.5).toFixed(1)}" fill="${r() > 0.5 ? '#ffb300' : '#ff5a00'}" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`;
    return `<defs>${radial('b', [[0, '#4a0d00'], [1, '#050000']])}${vgrad('fi', t, b, [[0, '#fff7a1'], [0.35, '#ffb300'], [0.7, '#ff5a00'], [1, '#c40000']])}${blur('g', 18)}</defs>${bg('url(#b)')}
<ellipse cx="400" cy="${b + 10}" rx="${L.w / 2 + 40}" ry="70" fill="#ff4500" opacity="0.55" filter="url(#g)"/>${embers}
${txt(L, { fill: '#ff6a00', extra: 'filter="url(#g)"' })}${txt(L, { fill: '#3a0500', extra: 'stroke="#3a0500" stroke-width="10" stroke-linejoin="round"' })}${txt(L, { fill: 'url(#fi)' })}`;
  } },
  { key: 'ice', title: 'Frozen Ice', build(n) {
    const L = layout(n, { maxSize: 150, factor: 0.8 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    const r = rng(n); let snow = '';
    for (let i = 0; i < 60; i++) snow += `<circle cx="${(r() * S).toFixed(0)}" cy="${(r() * S).toFixed(0)}" r="${(1 + r() * 4).toFixed(1)}" fill="#fff" opacity="${(0.25 + r() * 0.6).toFixed(2)}"/>`;
    return `<defs>${bgGrad('b', [[0, '#031a33'], [1, '#0b5ea8']], 0.3, 1)}${vgrad('ic', t, b, [[0, '#ffffff'], [0.5, '#c4f1ff'], [1, '#4fc3f7']])}${blur('g', 14)}</defs>${bg('url(#b)')}${snow}
${txt(L, { fill: '#7fe0ff', extra: 'filter="url(#g)"' })}${txt(L, { fill: '#0a4a80', extra: 'stroke="#0a4a80" stroke-width="9" stroke-linejoin="round"', dy: 4 })}${txt(L, { fill: 'url(#ic)', extra: 'stroke="#e9fbff" stroke-width="1.5"' })}`;
  } },
  { key: 'esports', title: 'Esports Gaming', build(n) {
    const L = layout(n, { maxSize: 140, factor: 0.8, maxW: 600 });
    return `<defs>${bgGrad('b', [[0, '#0b0b0b'], [1, '#1c1c1c']])}</defs>${bg('url(#b)')}
<polygon points="0,500 800,250 800,400 0,660" fill="#e10600"/><polygon points="0,545 800,295 800,310 0,560" fill="#fff" opacity="0.9"/>
<path d="M60 90 h110 M60 90 v110 M740 710 h-110 M740 710 v-110" stroke="#e10600" stroke-width="10" fill="none"/>
${txt(L, { fill: '#e10600', style: 'italic', dx: 9, dy: 9, extra: 'opacity="0.9"' })}
${txt(L, { fill: '#000', style: 'italic', extra: 'stroke="#000" stroke-width="14" stroke-linejoin="round"' })}${txt(L, { fill: '#fff', style: 'italic' })}`;
  } },
  { key: 'glitch', title: 'Glitch Cyber', build(n) {
    const L = layout(n, { maxSize: 150, factor: 0.8 });
    const r = rng(n); const cuts = [0, 1, 2].map(() => 320 + r() * 160);
    return `<defs><pattern id="sl" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="3" fill="#fff" opacity="0.06"/></pattern>
${cuts.map((y, i) => `<clipPath id="c${i}"><rect x="0" y="${y.toFixed(0)}" width="800" height="${(14 + r() * 26).toFixed(0)}"/></clipPath>`).join('')}</defs>${bg('#090909')}<rect width="800" height="800" fill="url(#sl)"/>
${txt(L, { fill: '#00f0ff', dx: -9, extra: 'opacity="0.9"' })}${txt(L, { fill: '#ff003c', dx: 9, extra: 'opacity="0.9"' })}${txt(L, { fill: '#fff' })}
${cuts.map((_, i) => `<g clip-path="url(#c${i})">${txt(L, { fill: '#fff', dx: i % 2 ? 26 : -26 })}${txt(L, { fill: '#00f0ff', dx: i % 2 ? 34 : -34, extra: 'opacity="0.7"' })}</g>`).join('')}`;
  } },
  { key: 'pop3d', title: '3D Pop', build(n) {
    const L = layout(n, { maxSize: 140, factor: 0.8, maxW: 600 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    let ext = '';
    for (let i = 20; i >= 1; i--) ext += txt(L, { fill: i > 10 ? '#150a5e' : '#2a14a8', dx: i * 0.9, dy: i * 0.9 });
    return `<defs>${bgGrad('b', [[0, '#6a11cb'], [1, '#2575fc']])}${vgrad('f', t, b, [[0, '#fff27a'], [1, '#ff9f1c']])}${blur('g', 12)}</defs>${bg('url(#b)')}
<ellipse cx="420" cy="${b + 40}" rx="${L.w / 2}" ry="26" fill="#000" opacity="0.35" filter="url(#g)"/>${ext}${txt(L, { fill: 'url(#f)', extra: 'stroke="#fff" stroke-width="3" stroke-linejoin="round"' })}`;
  } },
  { key: 'synth', title: 'Synthwave 80s', build(n) {
    const L = layout(n, { maxSize: 130, factor: 0.8, maxW: 620 });
    let bars = ''; for (let i = 0; i < 6; i++) bars += `<rect x="190" y="${470 + i * 18}" width="420" height="${3 + i * 2.2}" fill="#000"/>`;
    let grid = ''; for (let x = -800; x <= 1600; x += 130) grid += `<line x1="400" y1="560" x2="${x}" y2="800" stroke="#ff2d95" stroke-width="2" opacity="0.85"/>`;
    for (let k = 1; k <= 6; k++) { const y = 560 + 240 * (k / 6) ** 2; grid += `<line x1="0" y1="${y.toFixed(0)}" x2="800" y2="${y.toFixed(0)}" stroke="#ff2d95" stroke-width="2" opacity="0.85"/>`; }
    return `<defs>${bgGrad('b', [[0, '#12002b'], [0.7, '#4a0a7a'], [1, '#ff2d95']], 0, 1)}${vgrad('sun', 330, 560, [[0, '#ffe66d'], [1, '#ff2d95']])}<mask id="m"><rect width="800" height="800" fill="#fff"/>${bars}</mask>${blur('g', 10)}</defs>
${bg('url(#b)')}<circle cx="400" cy="440" r="200" fill="url(#sun)" mask="url(#m)"/><rect y="560" width="800" height="240" fill="#12002b"/><line x1="0" y1="560" x2="800" y2="560" stroke="#00e5ff" stroke-width="4"/>${grid}
${txt(L, { fill: '#ff2d95', style: 'italic', y: 330, extra: 'filter="url(#g)"' })}${txt(L, { fill: '#fff', style: 'italic', y: 330, extra: 'stroke="#00e5ff" stroke-width="3"' })}`;
  } },
  { key: 'sticker', title: 'Comic Sticker', build(n) {
    const L = layout(n, { maxSize: 140, factor: 0.8, maxW: 540 });
    const t = S / 2 - L.h / 2; const b = S / 2 + L.h / 2;
    return `<defs><pattern id="d" width="50" height="50" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="7" fill="#fff" opacity="0.28"/><circle cx="37" cy="37" r="7" fill="#fff" opacity="0.28"/></pattern>${vgrad('f', t, b, [[0, '#ffe14d'], [1, '#ff9d00']])}</defs>${bg('#3ac7ff')}${bg('url(#d)')}
<g transform="rotate(-6 400 400)">${txt(L, { fill: '#111', dx: 9, dy: 11, extra: 'stroke="#111" stroke-width="36" stroke-linejoin="round"' })}${txt(L, { fill: '#fff', extra: 'stroke="#fff" stroke-width="30" stroke-linejoin="round"' })}${txt(L, { fill: '#111', extra: 'stroke="#111" stroke-width="12" stroke-linejoin="round"' })}${txt(L, { fill: 'url(#f)' })}</g>`;
  } },
  { key: 'minimal', title: 'Minimal Clean', build(n) {
    const L = layout(n, { maxSize: 96, factor: 0.8, maxW: 600, minSize: 12, ls: 14 });
    const b = S / 2 + L.h / 2;
    return `${bg('#f4f1ea')}<rect x="50" y="50" width="700" height="700" fill="none" stroke="#111" stroke-width="2"/>
${txt(L, { fill: '#111', weight: 500, ls: 14 })}<line x1="330" y1="${b + 40}" x2="470" y2="${b + 40}" stroke="#111" stroke-width="3"/><circle cx="400" cy="${b + 40}" r="8" fill="#e63946"/>`;
  } },
  { key: 'emblem', title: 'Round Emblem', build(n) {
    const L = layout(n, { maxSize: 100, factor: 0.8, maxW: 420 });
    return `<defs>${radial('b', [[0, '#16213a'], [1, '#070b14']])}${radial('d', [[0, '#26396a'], [1, '#0b1220']], '70%')}${hgrad('g', 70, 730, [[0, '#8a6508'], [0.5, '#ffe27a'], [1, '#8a6508']])}</defs>${bg('url(#b)')}
<circle cx="400" cy="400" r="330" fill="none" stroke="url(#g)" stroke-width="10"/><circle cx="400" cy="400" r="312" fill="none" stroke="url(#g)" stroke-width="2"/><circle cx="400" cy="400" r="300" fill="url(#d)"/>
<circle cx="400" cy="400" r="278" fill="none" stroke="#ffe27a" stroke-width="4" stroke-dasharray="2 14" stroke-linecap="round"/>
${star(400, 235, 22, '#ffe27a')}${star(340, 250, 14, '#ffe27a')}${star(460, 250, 14, '#ffe27a')}${star(400, 575, 22, '#ffe27a')}${star(340, 560, 14, '#ffe27a')}${star(460, 560, 14, '#ffe27a')}
${txt(L, { fill: '#000', dy: 5, extra: 'opacity="0.5"' })}${txt(L, { fill: '#fff' })}`;
  } },
  { key: 'graffiti', title: 'Graffiti Street', build(n) {
    const L = layout(n, { maxSize: 140, factor: 0.8, maxW: 560 });
    let bricks = ''; for (let y = 0; y < 800; y += 50) bricks += `<line x1="0" y1="${y}" x2="800" y2="${y}" stroke="#000" opacity="0.35" stroke-width="3"/>${[...Array(9)].map((_, i) => `<line x1="${i * 100 + (y / 50 % 2 ? 50 : 0)}" y1="${y}" x2="${i * 100 + (y / 50 % 2 ? 50 : 0)}" y2="${y + 50}" stroke="#000" opacity="0.35" stroke-width="3"/>`).join('')}`;
    return `<defs>${bgGrad('b', [[0, '#2b2b31'], [1, '#17171b']])}${hgrad('f', 400 - L.w / 2, 400 + L.w / 2, [[0, '#ff0080'], [0.35, '#ff8c00'], [0.65, '#ffe600'], [1, '#27e6c4']])}</defs>${bg('url(#b)')}${bricks}
<g transform="rotate(-5 400 400)">${txt(L, { fill: '#000', dx: 10, dy: 12, extra: 'stroke="#000" stroke-width="34" stroke-linejoin="round"' })}${txt(L, { fill: '#fff', extra: 'stroke="#fff" stroke-width="26" stroke-linejoin="round"' })}${txt(L, { fill: '#000', extra: 'stroke="#000" stroke-width="12" stroke-linejoin="round"' })}${txt(L, { fill: 'url(#f)' })}</g>`;
  } },
  { key: 'rosegold', title: 'Rose Gold Monogram', build(n) {
    const ini = initials(n, 2);
    const L = layout(n, { maxSize: 58, factor: 0.8, maxW: 580, minSize: 18, ls: 8 });
    return `<defs>${radial('b', [[0, '#2e171e'], [1, '#0c0507']])}${bgGrad('r', [[0, '#fde1d3'], [0.5, '#e0a28b'], [1, '#b76e79']])}</defs>${bg('url(#b)')}
<circle cx="400" cy="320" r="200" fill="none" stroke="url(#r)" stroke-width="7"/><circle cx="400" cy="320" r="182" fill="none" stroke="url(#r)" stroke-width="1.5"/>
${txt({ lines: [ini], size: ini.length > 1 ? 170 : 220 }, { y: 325, fill: 'url(#r)', fam: SERIF, weight: 700, extra: 'stroke="#5a2a30" stroke-width="1.5"' })}
<line x1="250" y1="600" x2="550" y2="600" stroke="url(#r)" stroke-width="2"/>${txt(L, { y: 670, fill: 'url(#r)', fam: SERIF, weight: 600, ls: 8 })}`;
  } },
  { key: 'cyber', title: 'Cyberpunk Slab', build(n) {
    const L = layout(n, { maxSize: 130, factor: 0.8, maxW: 520 });
    const t = S / 2 - L.h / 2 - 40; const b = S / 2 + L.h / 2 + 40;
    let grid = ''; for (let i = 0; i <= 800; i += 50) grid += `<line x1="${i}" y1="0" x2="${i}" y2="800" stroke="#00f0ff" opacity="0.08"/><line x1="0" y1="${i}" x2="800" y2="${i}" stroke="#00f0ff" opacity="0.08"/>`;
    const poly = (dx, dy, fill) => `<polygon points="${70 + dx},${t + dy} ${690 + dx},${t + dy} ${740 + dx},${t + 46 + dy} ${740 + dx},${b + dy} ${110 + dx},${b + dy} ${60 + dx},${b - 46 + dy}" fill="${fill}"/>`;
    return `${bg('#0a0a0f')}${grid}${poly(10, 10, '#00f0ff')}${poly(0, 0, '#fcee0a')}
<rect x="90" y="${t - 26}" width="150" height="10" fill="#ff003c"/><rect x="560" y="${b + 18}" width="150" height="10" fill="#00f0ff"/><rect x="90" y="${b + 18}" width="40" height="10" fill="#fcee0a"/>
${txt(L, { fill: '#ff003c', dx: 5, dy: 5, extra: 'opacity="0.7"' })}${txt(L, { fill: '#0a0a0f', weight: 900 })}`;
  } },
  { key: 'galaxy', title: 'Galaxy Space', build(n) {
    const L = layout(n, { maxSize: 130, factor: 0.8, maxW: 600, ls: 6 });
    const r = rng(n); let stars = '';
    for (let i = 0; i < 130; i++) stars += `<circle cx="${(r() * S).toFixed(0)}" cy="${(r() * S).toFixed(0)}" r="${(0.5 + r() * 2).toFixed(1)}" fill="#fff" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
    return `<defs>${radial('b', [[0, '#1d0c44'], [1, '#04010d']], '80%')}${blur('n', 60)}${blur('g', 12)}</defs>${bg('url(#b)')}
<ellipse cx="230" cy="260" rx="230" ry="150" fill="#7b2ff7" opacity="0.55" filter="url(#n)"/><ellipse cx="600" cy="560" rx="250" ry="160" fill="#00c6ff" opacity="0.4" filter="url(#n)"/><ellipse cx="560" cy="200" rx="160" ry="100" fill="#ff4fa3" opacity="0.35" filter="url(#n)"/>${stars}
<ellipse cx="400" cy="400" rx="340" ry="90" transform="rotate(-14 400 400)" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 10" opacity="0.5"/>
${txt(L, { fill: '#7fd8ff', ls: 6, extra: 'filter="url(#g)"' })}${txt(L, { fill: '#fff', ls: 6 })}`;
  } },
  { key: 'pastel', title: 'Pastel Dream', build(n) {
    const L = layout(n, { upper: false, maxSize: 140, factor: 0.7, maxW: 600 });
    const b = S / 2 + L.h / 2;
    return `<defs>${bgGrad('b', [[0, '#ffd6e8'], [1, '#d6e9ff']])}${hgrad('f', 400 - L.w / 2, 400 + L.w / 2, [[0, '#ff5fa2'], [0.5, '#8a5cff'], [1, '#27c4f5']])}${blur('s', 7)}${blur('bl', 30)}</defs>${bg('url(#b)')}
<circle cx="150" cy="150" r="120" fill="#fff" opacity="0.6" filter="url(#bl)"/><circle cx="680" cy="660" r="150" fill="#fff" opacity="0.6" filter="url(#bl)"/>
${sparkle(150, 560, 30, '#fff')}${sparkle(660, 210, 38, '#fff')}${sparkle(560, 120, 20, '#ff9ac9')}${sparkle(230, 690, 22, '#9ad0ff')}
${txt(L, { fill: '#8a5cff', dy: 10, extra: 'opacity="0.35" filter="url(#s)"' })}${txt(L, { fill: 'url(#f)', weight: 800 })}
<path d="M${400 - L.w / 2} ${b + 40} q${L.w / 8} -26 ${L.w / 4} 0 t${L.w / 4} 0 t${L.w / 4} 0 t${L.w / 4} 0" fill="none" stroke="url(#f)" stroke-width="8" stroke-linecap="round"/>`;
  } },
  { key: 'matrix', title: 'Matrix Code', build(n) {
    const L = layout(n, { upper: false, maxSize: 110, factor: 0.64, maxW: 600 });
    const r = rng(n); const pool = `01ABCDEFXYZ${n.replace(/\s/g, '')}`.toUpperCase().replace(/[<>&'"]/g, '');
    const chars = [...pool]; let rain = '';
    for (let x = 20; x < 800; x += 36) {
      const len = 8 + Math.floor(r() * 12); const y0 = r() * 300;
      for (let i = 0; i < len; i++) rain += `<text x="${x}" y="${(y0 + i * 30 + (r() * 400)).toFixed(0)}" font-family="${MONO}" font-size="24" font-weight="700" fill="#00ff66" opacity="${(0.12 + (i / len) * 0.5).toFixed(2)}">${esc(chars[Math.floor(r() * chars.length)])}</text>`;
    }
    return `<defs>${blur('g', 10)}</defs>${bg('#000')}${rain}<rect x="${400 - L.w / 2 - 40}" y="${400 - L.h / 2 - 30}" width="${L.w + 80}" height="${L.h + 60}" rx="14" fill="#000" opacity="0.75" stroke="#00ff66" stroke-width="3"/>
${txt(L, { fam: MONO, weight: 700, fill: '#00ff66', extra: 'filter="url(#g)"' })}${txt(L, { fam: MONO, weight: 700, fill: '#c8ffd9' })}`;
  } },
  { key: 'royal', title: 'Royal Crown', build(n) {
    const L = layout(n, { maxSize: 100, factor: 0.8, maxW: 600, ls: 4 });
    const ty = 530 - L.h / 2; const by = 530 + L.h / 2;
    return `<defs>${radial('b', [[0, '#31115a'], [1, '#08031a']])}${bgGrad('g', [[0, '#fff2b0'], [0.5, '#f5c542'], [1, '#a87400']], 0, 1)}${vgrad('t', ty, by, [[0, '#fff2b0'], [0.5, '#f5c542'], [1, '#b8860b']])}</defs>${bg('url(#b)')}
<g transform="translate(400 228) scale(1.6)"><path d="M-90 60 L-100 -20 L-50 20 L0 -60 L50 20 L100 -20 L90 60 Z" fill="url(#g)" stroke="#7a5a00" stroke-width="3"/><path d="M-90 60 L90 60 L86 82 L-86 82 Z" fill="#c99a1a" stroke="#7a5a00" stroke-width="3"/>
<circle cx="-100" cy="-28" r="12" fill="url(#g)"/><circle cx="0" cy="-68" r="12" fill="url(#g)"/><circle cx="100" cy="-28" r="12" fill="url(#g)"/><circle cx="0" cy="30" r="9" fill="#e11d48"/><circle cx="-48" cy="42" r="6" fill="#2563eb"/><circle cx="48" cy="42" r="6" fill="#2563eb"/></g>
${txt(L, { y: 530, fill: '#000', fam: SERIF, weight: 700, ls: 4, dx: 3, dy: 4, extra: 'opacity="0.6"' })}${txt(L, { y: 530, fill: 'url(#t)', fam: SERIF, weight: 700, ls: 4 })}
<line x1="220" y1="${by + 40}" x2="580" y2="${by + 40}" stroke="#f5c542" stroke-width="3"/>${star(400, by + 40, 14, '#f5c542')}`;
  } },
  { key: 'shield', title: 'Shield Team', build(n) {
    const ini = initials(n, 1);
    const L = layout(n, { maxSize: 62, factor: 0.8, maxW: 380, minSize: 16, ls: 2 });
    const sh = 'M400 90 L640 170 L640 400 C640 560 520 660 400 720 C280 660 160 560 160 400 L160 170 Z';
    return `<defs>${bgGrad('b', [[0, '#0d1117'], [1, '#161b26']])}${bgGrad('e', [[0, '#00e5ff'], [1, '#8a2be2']])}${bgGrad('f', [[0, '#25324f'], [1, '#0a0f1e']], 0, 1)}</defs>${bg('url(#b)')}
<path d="${sh}" fill="url(#f)" stroke="url(#e)" stroke-width="14" stroke-linejoin="round"/><path d="${sh}" transform="translate(400 400) scale(0.88) translate(-400 -400)" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="3"/>
${star(400, 190, 18, '#ffd24d')}${star(340, 205, 11, '#ffd24d')}${star(460, 205, 11, '#ffd24d')}
${txt({ lines: [ini], size: 230 }, { y: 360, fill: '#000', style: 'italic', dx: 7, dy: 8, extra: 'opacity="0.5"' })}${txt({ lines: [ini], size: 230 }, { y: 360, fill: '#fff', style: 'italic', extra: 'stroke="#00e5ff" stroke-width="3"' })}
<rect x="210" y="505" width="380" height="5" fill="url(#e)"/>${txt(L, { y: 570, fill: '#fff', ls: 2 })}`;
  } }
];

export const STYLE_KEYS = STYLES.map((s) => s.key);
export const styleByKey = (key) => STYLES.find((s) => s.key === String(key || '').toLowerCase()) || null;

// px = picture size (the drawing is always 800 x 800 and is scaled).
export function logoSvg(key, name, px = S) {
  const st = styleByKey(key);
  if (!st) throw new Error(`unknown logo style "${key}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${S} ${S}">${st.build(cleanName(name) || 'LOGO')}</svg>`;
}

let sharpMod = null;
// Picture of one logo: 'jpeg' (small, for the swipe cards) or 'png' (big, for the HD file).
export async function renderLogo(key, name, { px = 720, format = 'jpeg' } = {}) {
  sharpMod ||= (await import('sharp')).default;
  const img = sharpMod(Buffer.from(logoSvg(key, name, px)), { density: 72 });
  return format === 'png' ? img.png({ compressionLevel: 9 }).toBuffer() : img.jpeg({ quality: 88 }).toBuffer();
}
