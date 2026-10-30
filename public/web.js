// Shared client code for /settings and /admin. Uses textContent only (never innerHTML).
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  };
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3800);
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-rio': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Try again.'); e.status = r.status; throw e; }
    return j;
  }
  const flash = (el) => { el.classList.remove('saved'); void el.offsetWidth; el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 1200); };
  // Disables a button (and shows its spinner) while the async work runs.
  const busy = (btn, fn) => async (...a) => {
    btn.disabled = true; btn.classList.add('loading');
    try { return await fn(...a); } finally { btn.disabled = false; btn.classList.remove('loading'); }
  };

  /* ---------- confirm / input dialog (replaces the browser's own boxes) ---------- */
  function ask({ title, body = '', input = false, placeholder = '', ok = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const m = $('#modal'), field = $('#mField'), box = $('#mInput'), okBtn = $('#mOk'), cancel = $('#mCancel');
      $('#mTitle').textContent = title; $('#mBody').textContent = body;
      field.hidden = !input; box.value = ''; box.placeholder = placeholder;
      okBtn.querySelector('.label').textContent = ok;
      okBtn.classList.toggle('danger', danger);
      okBtn.classList.toggle('alt', false);
      m.hidden = false; (input ? box : cancel).focus();
      const done = (v) => { m.hidden = true; okBtn.onclick = cancel.onclick = m.onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      okBtn.onclick = () => { if (input && !box.value.trim()) { box.focus(); return; } done({ value: box.value.trim() }); };
      cancel.onclick = () => done(null);
      m.onclick = (e) => { if (e.target === m) done(null); };
    });
  }

  /* ---------- the list of options (one place, used by the settings page, the admin page and the bulk box) ---------- */
  const SCHEMA = [
    { title: 'General', items: [
      { k: 'mode', type: 'select', label: 'Who can use the bot', hint: 'Private means only you.', options: [['public', 'Everyone (public)'], ['private', 'Only me (private)']] },
    ] },
    { title: 'Statuses', items: [
      { k: 'statusSeen', type: 'switch', label: 'View statuses automatically' },
      { k: 'statusReact', type: 'switch', label: 'React to new statuses', hint: 'Only statuses under 30 minutes old. Too much automatic reacting can look like spam to WhatsApp.' },
      { k: 'statusEmojis', type: 'text', label: 'Reaction emojis', hint: 'Separate with spaces. Leave empty to use the default list.', placeholder: '😍 🔥 ❤️' },
      { k: 'statusSave', type: 'switch', label: 'Save statuses to my chat' },
    ] },
    { title: 'View-once', items: [
      { k: 'viewOnce', type: 'switch', label: 'Copy view-once photos, videos and voice notes to my chat' },
    ] },
    { title: 'Messages and presence', items: [
      { k: 'autoRead', type: 'switch', label: 'Read incoming messages automatically', hint: 'Blue ticks appear for people who message you, even if you did not open the chat.' },
      { k: 'autoTyping', type: 'switch', label: 'Show "typing…" when someone messages me' },
      { k: 'autoRecording', type: 'switch', label: 'Show "recording audio…" when someone messages me', hint: 'If both this and typing are on, recording is shown.' },
      { k: 'alwaysOnline', type: 'switch', label: 'Always show me as online', hint: 'Refreshed every minute while the bot is connected.' },
    ] },
    { title: 'Calls', items: [
      { k: 'callReject', type: 'switch', label: 'Reject incoming calls and send a message' },
      { k: 'autoAnswer', type: 'switch', label: 'Reject calls and reply with my saved audio or video' },
      { k: 'callStream', type: 'switch', label: 'Answer calls and play my saved clip', hint: 'You can turn it off here. To turn it on, send .callstream on in WhatsApp (one-time device link).' },
      { k: 'callLoop', type: 'switch', label: 'Repeat the clip until the caller hangs up' },
      { k: 'callMsg', type: 'textarea', label: 'Message sent to rejected callers', hint: 'Leave empty to use the default message.' },
    ] },
  ];
  const FLAT = SCHEMA.flatMap((g) => g.items);
  const SWITCHES = FLAT.filter((i) => i.type === 'switch').map((i) => i.k);

  function renderSettings(root, values, save, onChange) {
    root.replaceChildren();
    const send = async (patch) => { const res = await save(patch); if (res?.settings) Object.assign(values, res.settings); onChange?.(values); return res; };
    SCHEMA.forEach((group, gi) => {
      const card = h('section', { class: 'card flat' }, h('h2', {}, group.title));
      card.style.setProperty('--i', gi);
      for (const it of group.items) {
        const id = `f-${it.k}`;
        const txt = h('span', { class: 'txt' }, h('b', {}, it.label), it.hint && h('small', {}, it.hint));
        if (it.type === 'switch') {
          const box = h('input', { type: 'checkbox', role: 'switch', class: 'sw', id, 'aria-label': it.label });
          box.checked = !!values[it.k];
          box.addEventListener('change', async () => {
            box.disabled = true;
            try { await send({ [it.k]: box.checked }); toast('Saved'); flash(row); }
            catch (e) { box.checked = !box.checked; toast(e.message, true); }
            finally { box.disabled = false; }
          });
          const row = h('label', { class: 'row', for: id }, txt, box);
          card.append(row);
        } else if (it.type === 'select') {
          const sel = h('select', { id, 'aria-label': it.label }, it.options.map(([v, t]) => h('option', { value: v }, t)));
          sel.value = values[it.k];
          sel.addEventListener('change', async () => {
            const prev = values[it.k]; sel.disabled = true;
            try { await send({ [it.k]: sel.value }); toast('Saved'); flash(row); }
            catch (e) { sel.value = prev; toast(e.message, true); }
            finally { sel.disabled = false; }
          });
          const row = h('div', { class: 'stack' }, txt, h('div', { class: 'field sm' }, sel));
          card.append(row);
        } else {
          const area = it.type === 'textarea';
          const inp = area ? h('textarea', { id, maxlength: 500, 'aria-label': it.label }) : h('input', { id, type: 'text', maxlength: 200, placeholder: it.placeholder || '', 'aria-label': it.label });
          inp.value = values[it.k] || '';
          const btn = h('button', { class: 'btn alt', type: 'submit' }, h('span', { class: 'label' }, 'Save'), h('span', { class: 'spin', 'aria-hidden': 'true' }));
          const form = h('form', { class: 'inline' }, h('div', { class: `field sm${area ? ' area' : ''}` }, inp), btn);
          form.addEventListener('submit', busy(btn, async (ev) => {
            ev.preventDefault();
            try { await send({ [it.k]: inp.value }); toast('Saved'); flash(row); } catch (e) { toast(e.message, true); }
          }));
          const row = h('div', { class: 'stack' }, txt, form);
          card.append(row);
        }
      }
      root.append(card);
    });
  }

  async function login(url, fields, after) {
    const form = $('#loginForm'), err = $('#loginError'), btn = $('button[type=submit]', form);
    form.addEventListener('submit', busy(btn, async (ev) => {
      ev.preventDefault(); err.textContent = '';
      try { await api('POST', url, Object.fromEntries(fields.map((f) => [f, form.elements[f].value]))); form.elements.password.value = ''; await after(); }
      catch (e) { err.textContent = e.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
    }));
  }
  const uptime = (s) => { const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`; };
  const tile = (value, label) => h('div', {}, h('b', {}, String(value)), h('span', {}, label));

  /* ---------- /settings ---------- */
  async function settingsPage() {
    const phoneBox = $('#phone');
    phoneBox.addEventListener('input', () => { phoneBox.value = phoneBox.value.replace(/\D/g, ''); });
    const tiles = (me, values) => {
      const on = SWITCHES.filter((k) => values[k]).length;
      $('#tiles').replaceChildren(tile(me.status === 'connected' ? 'Online' : 'Offline', 'Bot'), tile(values.mode === 'private' ? 'Private' : 'Public', 'Mode'), tile(`${on}/${SWITCHES.length}`, 'Features on'));
    };
    const premium = (p) => {
      const card = $('#premiumCard'), pills = $('#premPills');
      card.classList.toggle('on', !!p?.active);
      pills.replaceChildren(p?.active ? h('span', { class: 'pill gold' }, 'Active') : h('span', { class: 'pill' }, p?.expired ? 'Ended' : 'Free plan'));
      if (p?.active) {
        pills.append(h('span', { class: 'pill' }, `${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`));
        $('#premText').textContent = `Your premium is active until ${new Date(p.until).toLocaleDateString(undefined, { dateStyle: 'medium' })}. Premium commands work for your number.`;
      } else {
        $('#premText').textContent = p?.expired ? 'Your premium days are over. Contact the bot owner to renew it.' : 'Premium unlocks extra commands. Contact the bot owner to get it. Send .premium in WhatsApp to check your plan.';
      }
    };
    const out = () => { $('#login').hidden = false; $('#panel').hidden = true; $('#who').hidden = true; };
    let me = null;
    const show = async () => {
      try {
        me = await api('GET', '/api/me');
        $('#login').hidden = true; $('#panel').hidden = false;
        $('#who').hidden = false; $('#whoNum').textContent = `+${me.phone}`;
        const up = me.status === 'connected';
        $('#status').textContent = up ? 'Your bot is online. Changes apply right away.' : 'Your bot is reconnecting. Changes are saved and apply once it is back.';
        $('#statusDot').className = up ? 'dot' : 'dot warn';
        tiles(me, me.settings); premium(me.premium);
        renderSettings($('#groups'), me.settings, (p) => api('PATCH', '/api/me/settings', p), (v) => tiles(me, v));
      } catch { out(); }
    };
    await login('/api/web/login', ['phone', 'password'], show);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/web/logout').catch(() => {}); out(); });
    $('#newPass').addEventListener('click', busy($('#newPass'), async () => {
      if (!(await ask({ title: 'Send a new password?', body: 'A new password goes to your WhatsApp chat. You will be logged out and the old password stops working.', ok: 'Send it' }))) return;
      try { await api('POST', '/api/me/password'); out(); toast('New password sent to your WhatsApp chat.'); } catch (e) { toast(e.message, true); }
    }));
    $('#resetAll').addEventListener('click', busy($('#resetAll'), async () => {
      if (!(await ask({ title: 'Reset your settings?', body: 'Every option goes back to its default. Your saved call clips and your password stay as they are.', ok: 'Reset', danger: true }))) return;
      try { const r = await api('POST', '/api/me/reset', { confirm: true }); Object.assign(me.settings, r.settings); tiles(me, me.settings); renderSettings($('#groups'), me.settings, (p) => api('PATCH', '/api/me/settings', p), (v) => tiles(me, v)); toast('Settings reset.'); } catch (e) { toast(e.message, true); }
    }));
    $('#unlink').addEventListener('click', busy($('#unlink'), async () => {
      if (!(await ask({ title: 'Unlink your number?', body: 'The bot logs out of your WhatsApp and your saved settings are deleted. You can link again later.', ok: 'Unlink', danger: true }))) return;
      try { await api('POST', '/api/me/unlink', { confirm: true }); out(); toast('Your number was unlinked.'); } catch (e) { toast(e.message, true); }
    }));
    show();
  }

  /* ---------- /admin ---------- */
  async function adminPage() {
    let current = null, first = true, all = [], overview = null, filter = 'all', timer = null;
    const sel = new Set();

    const stat = (value, label, count) => {
      const animate = count != null && first && count > 0;
      const num = h('span', {}, animate ? '0' : String(value));
      if (animate) {
        const t0 = performance.now();
        const tick = (t) => { const k = Math.min(1, Math.max(0, (t - t0 - 200) / 800)); num.textContent = k < 1 ? String(Math.round(k * count)) : String(value); if (k < 1) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }
      return h('div', { class: 'stat' }, h('b', {}, num), h('small', {}, label));
    };
    const isOnline = (s) => s.status === 'connected';
    const shown = () => all.filter((s) => (filter === 'all' || (filter === 'on' ? isOnline(s) : !isOnline(s))) && (!$('#q').value.trim() || s.phone.includes($('#q').value.replace(/\D/g, ''))));
    const selIds = () => [...sel];

    const drawSelection = () => {
      const n = sel.size;
      $('#selInfo').textContent = n ? `${n} selected` : 'Nothing selected';
      $('#bulkSel').textContent = `${n} selected`;
    };
    const drawList = () => {
      const ul = $('#sessions'); ul.replaceChildren();
      const list = shown();
      if (!all.length) ul.append(h('li', { class: 'empty' }, 'No numbers are linked yet.'));
      else if (!list.length) ul.append(h('li', { class: 'empty' }, 'No numbers match.'));
      for (const s of list) {
        const chk = h('input', { type: 'checkbox', class: 'chk', 'aria-label': s.linked ? `Select +${s.phone}` : 'Select pairing in progress' });
        chk.checked = sel.has(s.id);
        chk.addEventListener('change', () => { chk.checked ? sel.add(s.id) : sel.delete(s.id); drawSelection(); });
        ul.append(h('li', {}, chk, h('button', { class: 'go', type: 'button', 'aria-current': s.id === current ? 'true' : 'false', onclick: () => open(s.id) },
          h('span', { class: 'num' }, s.linked ? `+${s.phone}` : 'Pairing in progress'),
          h('span', { class: 'pills' },
            h('span', { class: `pill${isOnline(s) ? ' on' : ''}` }, s.status.replace(/_/g, ' ')),
            h('span', { class: 'pill' }, s.mode),
            s.premium && h('span', { class: 'pill gold' }, `👑 ${s.premiumDays}d`),
            s.linked && h('span', { class: 'pill' }, `${s.features} on`),
            s.linked && !s.webPassword && h('span', { class: 'pill warn' }, 'no web password')))));
      }
      drawSelection();
    };

    const refresh = async () => {
      try {
        const o = await api('GET', '/api/admin/overview');
        overview = o; all = o.sessions;
        for (const id of [...sel]) if (!all.some((s) => s.id === id)) sel.delete(id);
        $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false;
        const linked = all.filter((s) => s.linked).length;
        $('#stats').replaceChildren(stat(`${linked}/${o.maxSessions}`, 'Linked numbers', linked), stat(o.connected, 'Online now', o.connected), stat(o.pairingOpen ? 'Open' : 'Paused', 'New links'), stat(o.premiumCount || 0, 'Premium numbers'), stat(`${o.memoryMb} MB`, 'Memory'), stat(uptime(o.uptimeSeconds), 'Uptime'), stat(o.storage, 'Storage'), stat(o.callService ? 'Ready' : 'Off', 'Call service'));
        first = false;
        $('#pairSwitch').checked = o.pairingOpen;
        const b = o.bulk;
        $('#bulkBar').hidden = !b;
        if (b) { $('#bulkLabel').textContent = b.label; $('#bulkCount').textContent = `${b.done}/${b.total}`; $('#bulkFill').style.width = `${Math.round((b.done / Math.max(1, b.total)) * 100)}%`; }
        drawList();
        const log = $('#audit'); log.replaceChildren();
        if (!o.audit.length) log.append(h('li', {}, 'Nothing yet.'));
        for (const a of o.audit) log.append(h('li', {}, `${new Date(a.at).toLocaleString()}  ${a.action}${a.detail ? `: ${a.detail}` : ''}`));
        if (current && !all.some((s) => s.id === current)) closeDetail();
      } catch { $('#login').hidden = false; $('#panel').hidden = true; $('#logout').hidden = true; }
      schedule();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (!$('#panel').hidden) refresh(); else schedule(); }, overview?.bulk ? 2500 : 30000); };

    /* ----- one number ----- */
    const closeDetail = () => { current = null; $('#detail').hidden = true; };
    const drawDetail = (d) => {
      $('#detailTitle').textContent = d.linked ? `+${d.phone}` : 'Pairing in progress';
      $('#detailPills').replaceChildren(...[
        h('span', { class: `pill${d.status === 'connected' ? ' on' : ''}` }, d.status.replace(/_/g, ' ')),
        h('span', { class: `pill${d.webPassword ? '' : ' warn'}` }, d.webPassword ? 'web password set' : 'no web password'),
        d.premium?.active ? h('span', { class: 'pill gold' }, `👑 premium, ${d.premium.daysLeft} day(s) left`) : null,
        d.retries ? h('span', { class: 'pill warn' }, `${d.retries} reconnect(s)`) : null,
        d.error ? h('span', { class: 'pill warn' }, d.error) : null,
      ].filter(Boolean));
    };
    const open = async (id, scroll = true) => {
      try {
        const d = await api('GET', `/api/admin/session/${id}`);
        current = id; $('#detail').hidden = false; drawDetail(d);
        renderSettings($('#groups'), d.settings, (p) => api('PATCH', `/api/admin/session/${id}/settings`, p).then((r) => { refresh(); return r; }));
        drawList();
        if (scroll) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { toast(e.message, true); refresh(); }
    };
    const one = (btn, path, dialog, done, closes) => btn.addEventListener('click', busy(btn, async () => {
      if (!current) return;
      const a = await ask(dialog); if (!a) return;
      try {
        await api('POST', `/api/admin/session/${current}/${path}`, dialog.input ? { text: a.value } : undefined);
        toast(done);
        if (closes) closeDetail(); else if (path === 'reset') await open(current, false);
        refresh();
      } catch (e) { toast(e.message, true); }
    }));
    one($('#restart'), 'restart', { title: 'Restart this bot?', body: 'The connection drops and comes back by itself in a few seconds.', ok: 'Restart' }, 'Restarting');
    one($('#resetPass'), 'password', { title: 'Send a new web password?', body: 'It goes to this number\'s own WhatsApp chat. Their old password stops working.', ok: 'Send' }, 'New password sent');
    one($('#notice'), 'notice', { title: 'Message this number', body: 'It arrives in their own WhatsApp chat as a notice from the bot.', input: true, placeholder: 'Write your message…', ok: 'Send' }, 'Message sent');
    one($('#resetOne'), 'reset', { title: 'Reset this number\'s settings?', body: 'Every option goes back to its default.', ok: 'Reset', danger: true }, 'Settings reset');
    one($('#remove'), 'delete', { title: 'Unlink and delete?', body: 'The bot logs out of this number and its saved settings are deleted. This cannot be undone.', ok: 'Unlink', danger: true }, 'Session deleted', true);

    const parseDaysInput = (v) => { const n = Number(String(v).trim()); return /^\d{1,4}$/.test(String(v).trim()) && n >= 1 && n <= 3650 ? n : null; };
    $('#premGive').addEventListener('click', busy($('#premGive'), async () => {
      if (!current) return;
      const a = await ask({ title: 'Give premium', body: 'How many days? They are added after any days this number already has.', input: true, placeholder: '30', ok: 'Give premium' }); if (!a) return;
      const days = parseDaysInput(a.value);
      if (!days) return toast('Enter a whole number of days from 1 to 3650.', true);
      try { await api('POST', `/api/admin/session/${current}/premium`, { action: 'grant', days }); toast(`Premium: +${days} day(s)`); await open(current, false); refresh(); } catch (e) { toast(e.message, true); }
    }));
    $('#premRemove').addEventListener('click', busy($('#premRemove'), async () => {
      if (!current) return;
      if (!(await ask({ title: 'Remove premium?', body: 'This number goes back to the free plan right away.', ok: 'Remove', danger: true }))) return;
      try { await api('POST', `/api/admin/session/${current}/premium`, { action: 'revoke' }); toast('Premium removed'); await open(current, false); refresh(); } catch (e) { toast(e.message, true); }
    }));

    /* ----- many numbers ----- */
    $('#selShown').addEventListener('click', () => { shown().forEach((s) => sel.add(s.id)); drawList(); });
    $('#selOnline').addEventListener('click', () => { sel.clear(); all.filter(isOnline).forEach((s) => sel.add(s.id)); drawList(); });
    $('#selNone').addEventListener('click', () => { sel.clear(); drawList(); });
    $('#q').addEventListener('input', drawList);
    $('#filters').addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      filter = b.dataset.f;
      $('#filters').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      drawList();
    });
    const bulkCall = async (body, done) => {
      if (!sel.size) { toast('Tick at least one number first.', true); return false; }
      try {
        const r = await api('POST', '/api/admin/bulk', { ids: selIds(), ...body });
        toast(r.queued ? `${done}: working on ${r.queued} number(s)…` : `${done}: ${r.done} number(s)`);
        refresh(); return true;
      } catch (e) { toast(e.message, true); return false; }
    };
    const bulkBtn = (btn, action, dialog, done) => btn.addEventListener('click', busy(btn, async () => {
      if (!sel.size) return toast('Tick at least one number first.', true);
      const a = await ask({ ...dialog, body: `${dialog.body} (${sel.size} number${sel.size === 1 ? '' : 's'})` }); if (!a) return;
      await bulkCall({ action, ...(dialog.input ? { text: a.value } : {}) }, done);
    }));
    $('#premChips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) $('#premDays').value = b.dataset.d; });
    $('#bPremGive').addEventListener('click', busy($('#bPremGive'), async () => {
      if (!sel.size) return toast('Tick at least one number first.', true);
      const days = parseDaysInput($('#premDays').value);
      if (!days) return toast('Enter a whole number of days from 1 to 3650.', true);
      if (!(await ask({ title: 'Give premium?', body: `+${days} day${days === 1 ? '' : 's'} for ${sel.size} number${sel.size === 1 ? '' : 's'}.`, ok: 'Give premium' }))) return;
      await bulkCall({ action: 'premium', days }, 'Premium');
    }));
    bulkBtn($('#bPremRemove'), 'unpremium', { title: 'Remove premium?', body: 'They go back to the free plan right away.', ok: 'Remove', danger: true }, 'Premium removed');
    bulkBtn($('#bRestart'), 'restart', { title: 'Restart the selected bots?', body: 'They reconnect by themselves, one after another.', ok: 'Restart' }, 'Restart');
    bulkBtn($('#bPass'), 'password', { title: 'Send new web passwords?', body: 'Each number gets a new password in its own chat. Old passwords stop working.', ok: 'Send' }, 'Passwords');
    bulkBtn($('#bNotice'), 'notice', { title: 'Message the selected numbers', body: 'Sent one by one to each number\'s own chat.', input: true, placeholder: 'Write your message…', ok: 'Send' }, 'Message');
    bulkBtn($('#bReset'), 'reset', { title: 'Reset their settings?', body: 'Every option goes back to its default.', ok: 'Reset', danger: true }, 'Reset');
    bulkBtn($('#bDelete'), 'delete', { title: 'Unlink and delete them?', body: 'Each bot logs out and its saved settings are deleted. This cannot be undone.', ok: 'Unlink all', danger: true }, 'Unlink');

    // the "change an option for all of them" row: the value box follows the chosen option
    const keySel = $('#bulkKey');
    FLAT.forEach((it) => keySel.append(h('option', { value: it.k }, it.label)));
    let valueField = null;
    const drawValue = () => {
      const it = FLAT.find((i) => i.k === keySel.value);
      const box = $('#bulkValBox'); box.replaceChildren();
      if (it.type === 'switch') valueField = h('select', { 'aria-label': 'Value' }, h('option', { value: 'on' }, 'Turn on'), h('option', { value: 'off' }, 'Turn off'));
      else if (it.type === 'select') valueField = h('select', { 'aria-label': 'Value' }, it.options.map(([v, t]) => h('option', { value: v }, t)));
      else valueField = h('input', { type: 'text', maxlength: it.k === 'callMsg' ? 500 : 200, placeholder: it.k === 'callMsg' ? 'Message (empty = default)' : '😍 🔥 ❤️ (empty = default)', 'aria-label': 'Value' });
      box.append(valueField);
    };
    keySel.addEventListener('change', drawValue); drawValue();
    $('#bulkApply').addEventListener('click', busy($('#bulkApply'), async () => {
      if (!sel.size) return toast('Tick at least one number first.', true);
      const it = FLAT.find((i) => i.k === keySel.value);
      const v = it.type === 'switch' ? valueField.value === 'on' : valueField.value;
      const text = it.type === 'switch' ? (v ? 'on' : 'off') : (String(v) || 'default');
      if (!(await ask({ title: 'Change this option?', body: `${it.label}: ${text}, for ${sel.size} number${sel.size === 1 ? '' : 's'}.`, ok: 'Apply' }))) return;
      await bulkCall({ action: 'settings', patch: { [it.k]: v } }, 'Changed');
      if (current) open(current, false);
    }));

    /* ----- everyone ----- */
    $('#pairSwitch').addEventListener('change', async (e) => {
      const box = e.target; box.disabled = true;
      try { await api('POST', '/api/admin/pairing', { open: box.checked }); toast(box.checked ? 'New links are open.' : 'New links are paused.'); refresh(); }
      catch (err) { box.checked = !box.checked; toast(err.message, true); }
      finally { box.disabled = false; }
    });

    await login('/api/admin/login', ['user', 'password'], refresh);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); sel.clear(); closeDetail(); refresh(); });
    refresh();
  }

  document.body.dataset.page === 'admin' ? adminPage() : settingsPage();
})();
