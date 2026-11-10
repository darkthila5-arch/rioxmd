// Admin → Premium page tab: edit the plans, prices, "What you get" list, contact number and note of the public /premium page.
// Saved on the server (no redeploy). Uses textContent only (never innerHTML).
(() => {
  if (document.body.dataset.page !== 'admin') return;
  const root = document.getElementById('ppAdmin'), pane = document.getElementById('pane-premiumpage'), panel = document.getElementById('panel');
  if (!root || !pane || !panel) return;

  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  };
  let toastTimer;
  const toast = (msg, bad) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3800); };
  const call = async (method, url, body) => {
    const headers = { 'x-rio': '1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(url, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { if (r.status === 401) document.dispatchEvent(new Event('rio:admin-auth-lost')); throw new Error(j.error || 'Something went wrong. Try again.'); }
    return j;
  };

  let data = null;   // what the server has
  let plans = [];    // the form (edited locally until Save)
  let featuresEl, contactEl, noteEl;

  const field = (input, cls = '') => h('div', { class: `field sm ${cls}`.trim() }, input);

  function planRow(p, i) {
    const days = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 3650, placeholder: 'Days', value: p.days || '', 'aria-label': `Plan ${i + 1} days` });
    const name = h('input', { type: 'text', maxlength: data.limits.name, placeholder: 'Name, e.g. 1 Month', value: p.name, 'aria-label': `Plan ${i + 1} name`, autocomplete: 'off' });
    const price = h('input', { type: 'text', maxlength: data.limits.price, placeholder: 'Price, e.g. Rs. 500', value: p.price, 'aria-label': `Plan ${i + 1} price`, autocomplete: 'off' });
    const note = h('input', { type: 'text', maxlength: data.limits.note, placeholder: 'Small note (write "Best value" to highlight)', value: p.note, 'aria-label': `Plan ${i + 1} note`, autocomplete: 'off' });
    days.addEventListener('input', () => { p.days = days.value; });
    name.addEventListener('input', () => { p.name = name.value; });
    price.addEventListener('input', () => { p.price = price.value; });
    note.addEventListener('input', () => { p.note = note.value; });
    return h('div', { class: 'stack', style: 'padding:12px 0;border-top:1px solid var(--line)' },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        h('b', { style: 'min-width:64px' }, `Plan ${i + 1}`),
        field(days, 'pp-days'),
        h('button', { class: 'btn danger sm', type: 'button', 'aria-label': `Remove plan ${i + 1}`, onclick: () => { plans.splice(i, 1); draw(); } }, 'Remove')),
      field(name), field(price), field(note));
  }

  const sourceNote = () => (data.saved
    ? 'Showing what you saved here. "Use the default" goes back to the Render settings.'
    : 'Nothing saved here yet: the page shows the Render settings (PREMIUM_PLANS and so on) or the built-in list. Save to take over.');

  function draw() {
    const limits = data.limits;
    featuresEl = h('textarea', { maxlength: limits.features * (limits.feature + 1), 'aria-label': 'What you get, one per line', placeholder: data.defaults.features.join('\n') }, data.features.join('\n'));
    contactEl = h('input', { type: 'text', inputmode: 'numeric', maxlength: 18, placeholder: data.defaults.contact || '94771234567', value: data.saved ? data.contact : '', 'aria-label': 'Contact number', autocomplete: 'off' });
    noteEl = h('input', { type: 'text', maxlength: limits.pageNote, placeholder: 'One line under the plans, e.g. Pay by bank transfer, then send the slip', value: data.note, 'aria-label': 'Note under the plans', autocomplete: 'off' });

    const plansCard = h('section', { class: 'card' },
      h('h2', {}, '👑 Plans'),
      h('p', { class: 'note' }, `Up to ${limits.plans}. Each plan has a Contact owner button that opens WhatsApp with the plan written in. No plans = the page says "Ask the owner for the current prices".`),
      plans.length ? plans.map(planRow) : h('p', { class: 'note', style: 'margin:12px 0' }, 'No plans yet.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn alt', type: 'button', disabled: plans.length >= limits.plans, onclick: () => { plans.push({ days: '', name: '', price: '', note: '' }); draw(); } }, '+ Add a plan')));

    const listCard = h('section', { class: 'card' },
      h('h2', {}, '✅ What you get'),
      h('p', { class: 'note' }, `One line per feature, up to ${limits.features}. Empty = the default list.`),
      h('div', { class: 'field area' }, featuresEl));

    const contactCard = h('section', { class: 'card' },
      h('h2', {}, '💬 Contact and note'),
      h('p', { class: 'note' }, 'The WhatsApp number people message to buy (digits with country code). Empty = the default (grey text).'),
      field(contactEl),
      h('p', { class: 'note', style: 'margin-top:14px' }, 'A short note shown under the plans.'),
      field(noteEl));

    const save = h('button', { class: 'btn', type: 'button' }, 'Save');
    const reset = h('button', { class: 'btn alt', type: 'button' }, 'Use the default');
    const busy = (btn, label, fn) => async () => {
      const old = btn.textContent; save.disabled = reset.disabled = true; btn.textContent = label;
      try { await fn(); } catch (e) { toast(e.message, true); save.disabled = reset.disabled = false; btn.textContent = old; }
    };
    save.addEventListener('click', busy(save, 'Saving…', async () => {
      const out = plans.map((p) => ({ days: String(p.days ?? '').trim() === '' ? 0 : Number(p.days), name: String(p.name || '').trim(), price: String(p.price || '').trim(), note: String(p.note || '').trim() }));
      data = await call('POST', '/api/admin/premiumpage', { plans: out, features: featuresEl.value.split('\n'), contact: contactEl.value.trim(), note: noteEl.value.trim() });
      plans = data.plans.map((p) => ({ ...p })); toast('Premium page saved.'); draw();
    }));
    reset.addEventListener('click', busy(reset, 'Resetting…', async () => {
      data = await call('POST', '/api/admin/premiumpage/reset');
      plans = data.plans.map((p) => ({ ...p })); toast('Back to the default.'); draw();
    }));

    root.replaceChildren(
      h('p', { class: 'note', style: 'margin:0 0 12px' }, sourceNote()),
      plansCard, listCard, contactCard,
      h('div', { class: 'actions' }, save, reset, h('a', { class: 'btn alt', href: '/premium', target: '_blank', rel: 'noopener noreferrer', style: 'text-decoration:none;display:flex;align-items:center;justify-content:center' }, 'Open the page ↗')));
  }

  const visible = () => !pane.hidden && !panel.hidden;
  let loading = false;
  const load = async () => {
    if (loading) return; loading = true;
    try { data = await call('GET', '/api/admin/premiumpage'); plans = data.plans.map((p) => ({ ...p })); draw(); }
    catch (e) { root.replaceChildren(h('p', { class: 'note' }, e.message)); }
    finally { loading = false; }
  };
  new MutationObserver(() => { if (visible() && !data) load(); }).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if (visible() && !data) load(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (visible()) load();
})();
