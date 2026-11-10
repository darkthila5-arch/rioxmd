// Premium page: loads plans / features from /api/premium/info and checks a number with /api/premium/status.
// Text is always set with textContent (never innerHTML), so nothing from the server can inject markup.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let info = { plans: [], features: [], contact: '', note: '', bot: 'RIO X MD' };

const waLink = (text) => (info.contact ? `https://wa.me/${info.contact}?text=${encodeURIComponent(text)}` : '');

function drawPlans() {
  const box = $('plans');
  box.replaceChildren();
  if (!info.plans.length) {
    box.append(el('div', 'pm-empty', 'Ask the owner for the current prices.'));
  } else {
    info.plans.forEach((p, i) => {
      const card = el('div', `pcard${/best|popular/i.test(p.note) ? ' best' : ''}`); // the owner highlights a plan by writing "Best value" / "Popular" in its note
      card.style.animationDelay = `${i * 60}ms`;
      card.append(el('span', 'days', `${p.days} day${p.days === 1 ? '' : 's'}`), el('span', 'pname', p.name), el('span', 'price', p.price || '—'), el('span', 'pnote', p.note || ''));
      const link = waLink(`Hi, I want the ${p.name} (${p.days} days) premium plan${p.price ? ` for ${p.price}` : ''} on ${info.bot}. My number: `);
      if (link) { const a = el('a', 'buy', 'Contact owner'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a); }
      box.append(card);
    });
  }
  const note = $('note');
  note.hidden = !info.note;
  note.textContent = info.note || '';
}

function drawRest() {
  const ul = $('features');
  ul.replaceChildren(...info.features.map((f) => el('li', '', f)));
  const btn = $('contactBtn');
  const link = waLink(`Hi, I want to buy / renew premium on ${info.bot}. My number: `);
  if (link) { btn.href = link; btn.hidden = false; } else { btn.hidden = true; $('contactHint').textContent = 'Contact the bot owner to buy or renew premium.'; }
}

async function load() {
  try {
    const r = await fetch('/api/premium/info');
    if (r.ok) info = { ...info, ...(await r.json()) };
  } catch { /* the page still works with empty plans */ }
  drawPlans();
  drawRest();
}

function showOut(kind, nodes) {
  const out = $('out');
  out.hidden = false;
  out.className = `pm-out ${kind}`;
  out.replaceChildren(...nodes);
}

async function check() {
  const btn = $('check'), label = btn.querySelector('.label');
  const number = $('num').value.trim();
  if (!number) { $('num').parentElement.classList.add('bad'); setTimeout(() => $('num').parentElement.classList.remove('bad'), 500); return; }
  btn.disabled = true; btn.classList.add('loading'); label.textContent = 'Checking…';
  try {
    const r = await fetch('/api/premium/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rio': '1' }, body: JSON.stringify({ number }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return showOut('bad', [el('b', '', 'Could not check'), el('p', '', j.error || 'Something went wrong. Try again.')]);
    if (j.active) {
      const until = new Date(j.until).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      showOut('ok', [el('b', '', '👑 Premium is active'), el('div', 'big', `${j.daysLeft} day${j.daysLeft === 1 ? '' : 's'} left`), el('p', '', `Until ${until}`)]);
    } else {
      showOut('bad', [el('b', '', 'No active premium found'), el('p', '', 'Check the number (country code, digits only). If you just paid, message the owner and your days will be added.')]);
    }
  } catch {
    showOut('bad', [el('b', '', 'No connection'), el('p', '', 'Check your internet and try again.')]);
  } finally { btn.disabled = false; btn.classList.remove('loading'); label.textContent = 'Check'; }
}

$('check').addEventListener('click', check);
$('num').addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
$('num').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d+\s-]/g, ''); });
load();
