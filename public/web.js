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
    if (!r.ok) {
      const e = new Error(j.error || 'Something went wrong. Try again.'); e.status = r.status;
      if (r.status === 401 && url.startsWith('/api/admin/') && url !== '/api/admin/login') document.dispatchEvent(new Event('rio:admin-auth-lost')); // the admin cookie ended: show the login again
      throw e;
    }
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
    { title: '👑 Branding', premiumOnly: true, note: 'Your own bot name, footer and logo in every reply. Premium only.', items: [
      { k: 'brandName', type: 'text', max: 30, label: 'Bot name', hint: 'Replaces the default bot name in menus and replies. Leave empty for the default.', placeholder: 'My Bot' },
      { k: 'brandFooter', type: 'text', max: 60, label: 'Footer text', hint: 'Replaces the default footer text. Leave empty for the default.', placeholder: 'Powered by me' },
      { k: 'brandLogo', type: 'text', max: 400, label: 'Logo link', hint: 'A direct https link to a JPG, PNG or WEBP picture (max 3 MB). It replaces the menu picture and the reply card picture.', placeholder: 'https://example.com/logo.png' },
    ] },
    { title: '📣 Support other channels', userOnly: true, items: [
      { k: 'boostOptIn', type: 'switch', label: 'Let my number follow and react to channels added by premium users', hint: 'Off by default. When on, your number follows those channels and reacts to their new posts. Turn it off any time and your number unfollows them again. Heavy automatic following can make WhatsApp limit an account, so only turn it on if you accept that.' },
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
      { k: 'autoAnswer', hostOnly: true, type: 'switch', label: 'Reject calls and reply with my saved audio or video' },
      { k: 'callStream', hostOnly: true, type: 'switch', label: 'Answer calls and play my saved clip', hint: 'You can turn it off here. To turn it on, send .callstream on in WhatsApp (one-time device link).' },
      { k: 'callLoop', hostOnly: true, type: 'switch', label: 'Repeat the clip until the caller hangs up' },
      { k: 'callMsg', hostOnly: true, type: 'textarea', label: 'Message sent to rejected callers', hint: 'Leave empty to use the default message.' },
    ] },
  ];
  const FLAT = SCHEMA.flatMap((g) => g.items);
  const BULKABLE = FLAT.filter((i) => !i.hostOnly && !/^(brand|boostOptIn)/.test(i.k)); // name / footer / logo / consent switch are per number, never bulk
  const SWITCHES = FLAT.filter((i) => i.type === 'switch').map((i) => i.k);

  // premium: true / undefined = branding can be edited (admin sees everything); false = locked for a free number.
  // host: false = this number is not the bot host owner, so the call-answering options are locked (host-only); true / undefined = editable.
  function renderSettings(root, values, save, onChange, premium, host) {
    root.replaceChildren();
    const send = async (patch) => { const res = await save(patch); if (res?.settings) Object.assign(values, res.settings); onChange?.(values); return res; };
    SCHEMA.forEach((group, gi) => {
      if (group.userOnly && premium === undefined) return; // the admin cannot change a number's own consent switch
      const locked = !!group.premiumOnly && premium === false;
      const card = h('section', { class: 'card flat' }, h('h2', {}, group.title));
      card.style.setProperty('--i', gi);
      if (group.note) card.append(h('p', { class: 'note' }, locked ? '🔒 Premium only. Ask the bot owner to activate premium for your number, then these options unlock.' : group.note));
      for (const it of group.items) {
        const id = `f-${it.k}`;
        if (it.hostOnly && host === false) continue; // host-only call options are hidden for normal numbers (call reject stays)
        const hostLocked = false;
        const txt = h('span', { class: 'txt' }, h('b', {}, it.label), (hostLocked || it.hint) && h('small', {}, hostLocked ? '🔒 Only the bot host owner can use this. Call reject is available for you.' : it.hint));
        if (it.type === 'switch') {
          const box = h('input', { type: 'checkbox', role: 'switch', class: 'sw', id, 'aria-label': it.label });
          box.checked = !hostLocked && !!values[it.k]; box.disabled = hostLocked;
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
          const inp = area ? h('textarea', { id, maxlength: 500, 'aria-label': it.label }) : h('input', { id, type: 'text', maxlength: it.max || 200, placeholder: it.placeholder || '', 'aria-label': it.label });
          inp.value = values[it.k] || '';
          if (locked || hostLocked) inp.disabled = true;
          const btn = h('button', { class: 'btn alt', type: 'submit', disabled: locked || hostLocked }, h('span', { class: 'label' }, 'Save'), h('span', { class: 'spin', 'aria-hidden': 'true' }));
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

  /* ---------- channel support card (premium adds a channel; the pool is the numbers that opted in) ---------- */
  async function boostCard(box, premium) {
    if (!box) return;
    box.hidden = false;
    const draw = (b) => {
      const body = [h('h2', {}, '📣 Channel support'), h('p', { class: 'note' }, premium
        ? `Add your WhatsApp channel. Numbers whose owners turned on "Support other channels" follow it and react to new posts. Right now ${b.poolSize} number${b.poolSize === 1 ? ' is' : 's are'} in the pool.`
        : '🔒 Premium only. Ask the bot owner to activate premium for your number, then you can add a channel here.')];
      for (const j of b.jobs) {
        const del = h('button', { class: 'btn alt', type: 'button' }, 'Remove');
        del.addEventListener('click', busy(del, async () => { try { draw(await api('DELETE', `/api/me/boost/${j.id}`)); toast('Channel removed. Helper numbers will unfollow.'); } catch (e) { toast(e.message, true); } }));
        body.push(h('div', { class: 'row' }, h('span', { class: 'txt' }, h('b', {}, j.name), h('small', {}, `${j.followers} following · reactions: ${j.emojis.join(' ')}`)), del));
      }
      if (premium && b.jobs.length < b.max) {
        const link = h('input', { type: 'text', maxlength: 300, placeholder: 'https://whatsapp.com/channel/0029Va…', 'aria-label': 'Channel link' });
        const emo = h('input', { type: 'text', maxlength: 60, placeholder: `Reaction emojis (optional): ${b.defaultEmojis.join(' ')}`, 'aria-label': 'Reaction emojis' });
        const btn = h('button', { class: 'btn alt', type: 'submit' }, h('span', { class: 'label' }, 'Add channel'), h('span', { class: 'spin', 'aria-hidden': 'true' }));
        const form = h('form', { class: 'inline' }, h('div', { class: 'field sm' }, link), h('div', { class: 'field sm' }, emo), btn);
        form.addEventListener('submit', busy(btn, async (ev) => {
          ev.preventDefault();
          try { draw(await api('POST', '/api/me/boost', { link: link.value, emojis: emo.value })); toast('Channel added. Followers join gradually.'); } catch (e) { toast(e.message, true); }
        }));
        body.push(form);
      }
      box.replaceChildren(...body);
    };
    try { draw(await api('GET', '/api/me/boost')); } catch { box.hidden = true; }
  }

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
        tiles(me, me.settings); premium(me.premium); boostCard($('#boostCard'), !!me.premium?.active);
        renderSettings($('#groups'), me.settings, (p) => api('PATCH', '/api/me/settings', p), (v) => tiles(me, v), !!me.premium?.active, me.host);
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
      try { const r = await api('POST', '/api/me/reset', { confirm: true }); Object.assign(me.settings, r.settings); tiles(me, me.settings); renderSettings($('#groups'), me.settings, (p) => api('PATCH', '/api/me/settings', p), (v) => tiles(me, v), !!me.premium?.active, me.host); toast('Settings reset.'); } catch (e) { toast(e.message, true); }
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

    const stat = (value, label, count, tone) => {
      const animate = count != null && first && count > 0;
      const num = h('span', {}, animate ? '0' : String(value));
      if (animate) {
        const t0 = performance.now();
        const tick = (t) => { const k = Math.min(1, Math.max(0, (t - t0 - 200) / 800)); num.textContent = k < 1 ? String(Math.round(k * count)) : String(value); if (k < 1) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }
      return h('div', { class: `stat${tone ? ` ${tone}` : ''}` }, h('b', {}, num), h('small', {}, label));
    };
    const isOnline = (s) => s.status === 'connected';
    const FRIENDLY = { connected: 'Online', starting: 'Starting…', waiting_for_scan: 'Waiting to pair', waiting_for_pair: 'Waiting to pair', pair_error: 'Pairing failed', disconnected: 'Reconnecting', replaced: 'Used elsewhere', logged_out: 'Logged out', error: 'Error' };
    const friendly = (st) => FRIENDLY[st] || String(st).replace(/_/g, ' ');
    const dotClass = (s) => (isOnline(s) ? 'on' : /pair|scan|starting/.test(s.status) ? 'warn' : '');
    let found = null; // ids matching the typed digits (found on the server, because the numbers in the list are masked); null = no search
    const shown = () => all.filter((s) => (filter === 'all' || (filter === 'on' ? isOnline(s) : !isOnline(s))) && (!found || found.has(s.id)));
    const selIds = () => [...sel];

    const drawSelection = () => {
      const n = sel.size;
      $('#selInfo').textContent = n ? `${n} selected` : 'Nothing selected';
      $('#bulkSel').textContent = `${n} selected`;
      $('#bbCount').textContent = String(n);
      $('#bulkbar').hidden = !n;
      if (!n) closeBulk();
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
          h('span', { class: 'who' }, h('span', { class: `sdot ${dotClass(s)}`, 'aria-hidden': 'true' }), h('span', { class: 'num' }, s.linked ? `+${s.phone}` : 'Pairing in progress')),
          h('span', { class: 'pills' },
            h('span', { class: `pill${isOnline(s) ? ' on' : ''}` }, friendly(s.status)),
            h('span', { class: 'pill' }, s.mode === 'private' ? 'Private' : 'Public'),
            s.premium && h('span', { class: 'pill gold' }, `👑 ${s.premiumDays}d`),
            s.linked && !s.webPassword && h('span', { class: 'pill warn' }, 'No web password')))));
      }
      drawSelection();
    };

    const drawBoost = (bo) => {
      if (!bo) return;
      $('#boostSwitch').checked = !bo.paused;
      $('#boostInfo').textContent = `${bo.poolSize} number${bo.poolSize === 1 ? '' : 's'} opted in to support channels. ${bo.paused ? 'Paused right now.' : 'Running.'}`;
      const ul = $('#boostList'); ul.replaceChildren();
      const live = bo.jobs.filter((j) => j.status === 'active' || j.followers);
      if (!live.length) ul.append(h('li', {}, h('span', { class: 'txt' }, h('small', {}, 'No channels added yet.'))));
      for (const j of live) {
        const del = h('button', { class: 'btn alt', type: 'button', disabled: j.status !== 'active' }, j.status === 'active' ? 'Remove' : 'Removing…');
        del.addEventListener('click', busy(del, async () => {
          if (!(await ask({ title: 'Remove this channel?', body: 'Helper numbers stop reacting and unfollow it, a few at a time.', ok: 'Remove', danger: true }))) return;
          try { const r = await api('DELETE', `/api/admin/boost/${j.id}`); drawBoost(r.boost); toast('Channel removed.'); } catch (e) { toast(e.message, true); }
        }));
        ul.append(h('li', {}, h('span', { class: 'txt' }, h('b', {}, j.name), h('small', {}, `Added by +${j.owner || '?'} · ${j.followers} following · ${j.emojis.join(' ')}${j.premium ? '' : ' · premium ended'}`)), del));
      }
    };
    const drawAttention = () => {
      const ul = $('#attention'); ul.replaceChildren();
      const bad = all.filter((s) => s.linked && (!isOnline(s) || !s.webPassword));
      if (!bad.length) { ul.append(h('li', { class: 'good-note' }, '✅ All good. Every linked number is online and has a web password.')); return; }
      for (const s of bad.slice(0, 8)) {
        ul.append(h('li', {}, h('button', { class: 'go', type: 'button', onclick: () => { showTab('numbers'); open(s.id); } },
          h('span', { class: 'who' }, h('span', { class: `sdot ${dotClass(s)}`, 'aria-hidden': 'true' }), h('span', { class: 'num' }, `+${s.phone}`)),
          h('span', { class: 'pills' }, !isOnline(s) && h('span', { class: 'pill warn' }, friendly(s.status)), !s.webPassword && h('span', { class: 'pill warn' }, 'No web password')))));
      }
      if (bad.length > 8) ul.append(h('li', { class: 'empty' }, `…and ${bad.length - 8} more in the Numbers tab.`));
    };
    const showLogin = (msg) => {
      stopLogs(); sel.clear(); closeDetail(); closeBulk();
      $('#login').hidden = false; $('#panel').hidden = true; $('#logout').hidden = true;
      $('#loginError').textContent = msg || '';
    };
    document.addEventListener('rio:admin-auth-lost', () => { if (!$('#panel').hidden) showLogin('Your session ended. Please log in again.'); });
    const refresh = async () => {
      try {
        const o = await api('GET', '/api/admin/overview');
        overview = o; all = o.sessions;
        for (const id of [...sel]) if (!all.some((s) => s.id === id)) sel.delete(id);
        $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false;
        const linked = all.filter((s) => s.linked).length;
        const offline = all.filter((s) => s.linked && !isOnline(s)).length;
        $('#stats').replaceChildren(stat(`${linked}/${o.maxSessions}`, 'Linked numbers', linked), stat(o.connected, 'Online now', o.connected, 'good'), stat(offline, 'Offline', null, offline ? 'warn' : ''), stat(o.premiumCount || 0, '👑 Premium', o.premiumCount || 0));
        const kv = (label, value) => h('div', {}, h('span', {}, label), h('b', {}, String(value)));
        $('#serverStats').replaceChildren(kv('New links', o.pairingOpen ? 'Open' : 'Paused'), kv('Memory', `${o.memoryMb} MB`), kv('Uptime', uptime(o.uptimeSeconds)), kv('Storage', o.storage), kv('Call service', o.callService ? 'Ready' : 'Off'), kv('Node', o.node));
        $('#numBadge').textContent = String(linked);
        first = false;
        drawAttention();
        $('#pairSwitch').checked = o.pairingOpen;
        drawBoost(o.boost);
        const b = o.bulk;
        $('#bulkBar').hidden = !b;
        if (b) { $('#bulkLabel').textContent = b.label; $('#bulkCount').textContent = `${b.done}/${b.total}`; $('#bulkFill').style.width = `${Math.round((b.done / Math.max(1, b.total)) * 100)}%`; }
        drawList();
        if (!$('#pane-broadcast').hidden) loadBroadcast(); // shows sending progress
        if ($('#pane-logs').hidden) api('GET', '/api/admin/logs?level=error&limit=1').then((r) => drawLogBadge(r.counts)).catch(() => {}); // red badge on the Logs tab
        if (current && !all.some((s) => s.id === current)) closeDetail();
      } catch (e) {
        if (e.status === 401) showLogin(); // a short network or server problem must NOT throw the admin out: keep the panel and try again later
        else toast(e.message || 'Could not refresh. Trying again soon.', true);
      }
      schedule();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (!$('#panel').hidden) refresh(); else schedule(); }, overview?.bulk ? 2500 : 30000); };

    /* ----- one number ----- */
    const lock = () => document.body.classList.toggle('noscroll', !$('#detail').hidden || !$('#bulk').hidden);
    const closeDetail = () => { current = null; $('#detail').hidden = true; $('#scrim').hidden = true; lock(); drawList(); };
    const closeBulk = () => { $('#bulk').hidden = true; lock(); };
    const drawDetail = (d) => {
      $('#detailTitle').textContent = d.linked ? `+${d.phone}` : 'Pairing in progress';
      $('#detailPills').replaceChildren(...[
        h('span', { class: `pill${d.status === 'connected' ? ' on' : ''}` }, friendly(d.status)),
        h('span', { class: `pill${d.webPassword ? '' : ' warn'}` }, d.webPassword ? 'Web password set' : 'No web password'),
        d.premium?.active ? h('span', { class: 'pill gold' }, `👑 premium, ${d.premium.daysLeft} day(s) left`) : null,
        d.host ? h('span', { class: 'pill gold' }, '👑 host number') : null,
        d.retries ? h('span', { class: 'pill warn' }, `${d.retries} reconnect(s)`) : null,
        d.error ? h('span', { class: 'pill warn' }, d.error) : null,
      ].filter(Boolean));
    };
    const open = async (id, scroll = true) => {
      try {
        const d = await api('GET', `/api/admin/session/${id}`);
        const wasHidden = $('#detail').hidden;
        current = id; $('#detail').hidden = false; $('#scrim').hidden = false; lock(); drawDetail(d);
        if (wasHidden) $('#detailClose').focus({ preventScroll: true });
        renderSettings($('#groups'), d.settings, (p) => api('PATCH', `/api/admin/session/${id}/settings`, p).then((r) => { refresh(); return r; }), undefined, undefined, d.host);
        drawList();
        if (scroll) $('.drawer-body').scrollTop = 0;
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

    /* ----- tabs, drawer and the selection bar ----- */
    function showTab(name) {
      $('#tabs').querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
      document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
      try { history.replaceState(null, '', `#${name}`); } catch {}
      if (name === 'insights') drawInsights();
      if (name === 'commands') loadCommands();
      if (name === 'analytics') drawAnalytics();
      if (name === 'activity') loadAudit(true);
      if (name === 'broadcast') loadBroadcast();
      if (name === 'security') loadSecurity();
      if (name === 'logs') startLogs(); else stopLogs();
    }
    /* ----- commands on/off, maintenance, bans ----- */
    let cmds = [], cmdData = null, cfilter = 'all';
    const shownCmds = () => { const q = $('#cq').value.trim().toLowerCase(); return cmds.filter((c) => (cfilter === 'all' || (cfilter === 'off' ? c.disabled : c.errors > 0)) && (!q || c.name.includes(q) || c.aliases.some((a) => a.includes(q)))); };
    const drawCommands = (d) => {
      cmdData = d; cmds = d.commands; $('#maintSwitch').checked = d.maintenance.on; if (document.activeElement !== $('#maintText')) $('#maintText').value = d.maintenance.text;
      const bl = $('#banList'); bl.replaceChildren();
      if (!d.banned.length) bl.append(h('li', {}, h('span', { class: 'txt' }, h('small', {}, 'Nobody is banned.'))));
      for (const b of d.banned) { const x = h('button', { class: 'btn alt sm', type: 'button' }, 'Unban'); x.addEventListener('click', busy(x, async () => { try { drawCommands(await api('POST', '/api/admin/ban', { index: b.i })); toast('Unbanned.'); } catch (e) { toast(e.message, true); } })); bl.append(h('li', {}, h('span', { class: 'txt' }, h('b', {}, `+${b.m}`)), x)); }
      const ul = $('#cmdList'); ul.replaceChildren();
      const list = shownCmds();
      if (!list.length) ul.append(h('li', { class: 'empty' }, 'No commands match.'));
      let lastCat = null;
      const order = (d.cats || []);
      list.sort((a, b) => (order.indexOf(a.cat) - order.indexOf(b.cat)) || a.name.localeCompare(b.name)); // menu order, then A-Z
      for (const c of list) {
        if (c.cat !== lastCat) { // category header with its own on/off buttons (applies to the commands shown in that category)
          lastCat = c.cat;
          const inCat = list.filter((x) => x.cat === c.cat), names = inCat.map((x) => x.name);
          const mk = (label, off) => { const b = h('button', { class: 'btn alt sm', type: 'button' }, label); b.addEventListener('click', busy(b, async () => { try { drawCommands(await api('POST', '/api/admin/commands/toggle', { names, disabled: off })); toast('Done.'); } catch (e) { toast(e.message, true); } })); return b; };
          ul.append(h('li', { class: 'cathead' }, h('span', { class: 'txt' }, h('b', {}, c.cat), h('small', {}, `${inCat.length} command${inCat.length === 1 ? '' : 's'} · ${inCat.filter((x) => !x.disabled).length} on`)), h('span', { class: 'pills' }, mk('All on', false), mk('All off', true))));
        }
        const locked = d.protected.includes(c.name);
        const sw = h('input', { type: 'checkbox', class: 'sw', role: 'switch', 'aria-label': `${c.name} on` }); sw.checked = !c.disabled; sw.disabled = locked;
        sw.addEventListener('change', async () => { try { drawCommands(await api('POST', '/api/admin/commands/toggle', { names: [c.name], disabled: !sw.checked })); } catch (e) { sw.checked = !sw.checked; toast(e.message, true); } });
        ul.append(h('li', {}, h('span', { class: 'go' }, h('span', { class: 'who' }, h('span', { class: 'num' }, `.${c.name}`)),
          h('span', { class: 'pills' }, c.owner && h('span', { class: 'pill' }, 'Owner'), c.premium && h('span', { class: 'pill gold' }, '👑'), c.disabled && h('span', { class: 'pill off' }, 'Off'), h('span', { class: 'pill' }, `${c.uses} uses`), c.errors > 0 && h('span', { class: 'pill warn' }, `${c.errors} errors`))), sw));
      }
    };
    async function loadCommands() { try { drawCommands(await api('GET', '/api/admin/commands')); } catch (e) { toast(e.message, true); } }
    $('#cq').addEventListener('input', () => cmdData && drawCommands(cmdData));
    $('#cfilters').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; cfilter = b.dataset.f; $('#cfilters').querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (cmdData) drawCommands(cmdData); });
    const bulkCmds = (off) => async () => {
      const names = shownCmds().map((c) => c.name);
      if (!names.length) return;
      if (!(await ask({ title: `${off ? 'Switch off' : 'Switch on'} ${names.length} command(s)?`, body: names.slice(0, 12).map((n) => `.${n}`).join(' ') + (names.length > 12 ? ' …' : ''), ok: off ? 'Switch off' : 'Switch on', danger: off }))) return;
      try { drawCommands(await api('POST', '/api/admin/commands/toggle', { names, disabled: off })); toast('Done.'); } catch (e) { toast(e.message, true); }
    };
    $('#cmdOffShown').addEventListener('click', bulkCmds(true)); $('#cmdOnShown').addEventListener('click', bulkCmds(false));
    $('#maintSwitch').addEventListener('change', async (e) => { try { drawCommands(await api('POST', '/api/admin/maintenance', { on: e.target.checked, text: $('#maintText').value })); toast(e.target.checked ? 'Maintenance is ON.' : 'Maintenance is off.'); } catch (x) { e.target.checked = !e.target.checked; toast(x.message, true); } });
    $('#maintSave').addEventListener('click', async () => { try { drawCommands(await api('POST', '/api/admin/maintenance', { on: $('#maintSwitch').checked, text: $('#maintText').value })); toast('Saved.'); } catch (x) { toast(x.message, true); } });
    $('#banAdd').addEventListener('click', async () => { try { drawCommands(await api('POST', '/api/admin/ban', { number: $('#banNum').value, on: true })); $('#banNum').value = ''; toast('Banned.'); } catch (x) { toast(x.message, true); } });

    /* ----- analytics ----- */
    const cols = (box, vals, labels) => { box.replaceChildren(); const max = Math.max(1, ...vals); vals.forEach((v, i) => box.append(h('div', { class: 'c', title: `${labels[i]}: ${v}` }, h('i', { style: `height:${Math.round((v / max) * 100)}%` }), h('small', {}, labels[i])))); };
    async function drawAnalytics() {
      try {
        const a = await api('GET', '/api/admin/analytics');
        const rate = a.total ? `${(((a.total - a.errors) / a.total) * 100).toFixed(1)}%` : '—';
        $('#anStats').replaceChildren(stat(a.total, 'Commands run', null), stat(a.today, 'Today', null, 'good'), stat(a.errors, 'Errors', null, a.errors ? 'warn' : ''), stat(rate, 'Success rate', null));
        cols($('#anDays'), a.days.map((d) => d.n), a.days.map((d) => d.day.slice(5)));
        cols($('#anHours'), a.hours, a.hours.map((_, i) => (i % 3 === 0 ? String(i) : '')));
        const bars = (box, rows, key, label) => { box.replaceChildren(); const m = Math.max(1, ...rows.map((r) => r.n)); if (!rows.length) box.append(h('small', {}, 'No data yet.')); for (const r of rows) box.append(h('div', { class: 'b' }, h('span', {}, label(r)), h('span', { class: 'tr' }, h('i', { style: `width:${Math.round((r.n / m) * 100)}%` })), h('b', {}, String(r.n)))); };
        bars($('#anTop'), a.top, 'name', (r) => `.${r.name}`);
        bars($('#anNums'), a.nums, 'phone', (r) => `+${r.phone}`);
      } catch (e) { toast(e.message, true); }
    }
    const FEAT = { statusSeen: 'Status view', statusReact: 'Status react', statusSave: 'Status save', viewOnce: 'View-once', callReject: 'Call reject', autoAnswer: 'Auto answer', callLoop: 'Call loop', callStream: 'Call stream', autoRead: 'Auto read', autoTyping: 'Auto typing', autoRecording: 'Auto recording', alwaysOnline: 'Always online', boostOptIn: 'Channel support' };
    const svgEl = (t, a) => { const e = document.createElementNS('http://www.w3.org/2000/svg', t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
    async function drawInsights() {
      try {
        const d = await api('GET', '/api/admin/insights');
        const bars = $('#featBars'); bars.replaceChildren();
        const rows = Object.entries(d.features).sort((a, b) => b[1] - a[1]);
        for (const [k, n] of rows) bars.append(h('div', { class: 'b' }, h('span', {}, FEAT[k] || k), h('span', { class: 'tr' }, h('i', { style: `width:${d.total ? Math.round((n / d.total) * 100) : 0}%` })), h('b', {}, `${n}/${d.total}`)));
        const box = $('#spark'); box.replaceChildren();
        const hs = d.history;
        if (hs.length < 2) { box.append(h('p', { class: 'note' }, 'Collecting data… check again in a minute.')); return; }
        const max = Math.max(1, ...hs.map((x) => x.linked));
        const pts = hs.map((x, i) => [(i / (hs.length - 1)) * 100, 38 - (x.on / max) * 36]);
        const line = pts.map((p) => p.map((n) => n.toFixed(2)).join(',')).join(' ');
        const svg = svgEl('svg', { viewBox: '0 0 100 40', preserveAspectRatio: 'none' });
        svg.append(svgEl('polygon', { class: 'ar', points: `0,40 ${line} 100,40` }), svgEl('polyline', { class: 'ln', points: line }));
        box.append(svg);
      } catch (e) { toast(e.message, true); }
      const ul = $('#expiring'); ul.replaceChildren();
      const exp = all.filter((s) => s.premium && s.premiumDays <= 7).sort((a, b) => a.premiumDays - b.premiumDays);
      $('#selExpiring').hidden = !exp.length;
      if (!exp.length) ul.append(h('li', { class: 'good-note' }, '✅ Nobody is about to lose premium.'));
      for (const s of exp) ul.append(h('li', {}, h('button', { class: 'go', type: 'button', onclick: () => { showTab('numbers'); open(s.id); } }, h('span', { class: 'who' }, h('span', { class: 'num' }, `+${s.phone}`)), h('span', { class: 'pills' }, h('span', { class: 'pill gold' }, `👑 ${s.premiumDays}d`)))));
    }
    $('#selExpiring').addEventListener('click', () => {
      all.filter((s) => s.premium && s.premiumDays <= 7).forEach((s) => sel.add(s.id));
      showTab('numbers'); drawList(); toast(`${sel.size} selected. Use Actions… to give more days.`);
    });
    $('#exportCsv').addEventListener('click', () => {
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const lines = [['number', 'status', 'mode', 'web_password', 'premium_days', 'features_on'].join(',')];
      for (const s of all) lines.push([q(s.phone), q(s.status), q(s.mode), s.webPassword, s.premiumDays || 0, s.features].join(','));
      const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `rio-numbers-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    /* ================= new tools: audit, broadcast, logs, security, backup ================= */
    const fmtWait = (sec) => (sec >= 3600 ? `${Math.ceil(sec / 3600)} h` : sec >= 60 ? `${Math.ceil(sec / 60)} min` : `${sec}s`);
    const when = (iso) => new Date(iso).toLocaleString();
    const saveBlob = (blob, name) => {
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    // Like api(), but for a file in and / or a file out.
    async function fileCall(url, { body, pass, headers = {}, json = false } = {}) {
      const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': json ? 'application/json' : 'application/octet-stream', 'x-rio': '1', ...(pass != null ? { 'x-rio-pass': encodeURIComponent(pass) } : {}), ...headers }, body });
      if (!r.ok) { let m = 'Something went wrong. Try again.'; try { m = (await r.json()).error || m; } catch { if (r.status === 413) m = 'The file is too big (80 MB max).'; } const e = new Error(m); e.status = r.status; throw e; }
      return r;
    }
    const emptyLi = (text) => h('li', {}, h('span', { class: 'txt' }, h('small', {}, text)));

    /* ----- audit log ----- */
    const AUDIT_PAGE = 50; let auditN = 0, auditDebounce;
    async function loadAudit(reset = true) {
      try {
        if (reset) auditN = 0;
        const r = await api('GET', `/api/admin/audit?q=${encodeURIComponent($('#auditQ').value.trim())}&offset=${auditN}&limit=${AUDIT_PAGE}`);
        const ul = $('#audit'); if (reset) ul.replaceChildren();
        if (reset && !r.items.length) ul.append(h('li', {}, $('#auditQ').value.trim() ? 'No matches.' : 'Nothing yet.'));
        for (const a of r.items) ul.append(h('li', {}, h('b', {}, a.action), a.detail ? `: ${a.detail}` : '', h('small', { class: 'meta' }, `${when(a.at)}${a.ip ? ` · ${a.ip}` : ''}`)));
        auditN += r.items.length; $('#auditMore').hidden = auditN >= r.total;
      } catch (e) { toast(e.message, true); }
    }
    $('#auditQ').addEventListener('input', () => { clearTimeout(auditDebounce); auditDebounce = setTimeout(() => loadAudit(true), 300); });
    $('#auditMore').addEventListener('click', () => loadAudit(false));
    $('#auditCsv').addEventListener('click', async () => {
      try { const r = await fetch('/api/admin/audit/export', { credentials: 'same-origin' }); if (!r.ok) throw new Error('Could not download.'); saveBlob(await r.blob(), `rio-audit-${new Date().toISOString().slice(0, 10)}.csv`); } catch (e) { toast(e.message, true); }
    });

    /* ----- broadcast ----- */
    let bcTarget = 'all';
    const BC_STATUS = { scheduled: ['Waiting', 'on'], running: ['Sending…', 'warn'], done: ['Sent', 'on'], cancelled: ['Cancelled', ''], missed: ['Missed', 'warn'], failed: ['Failed', 'warn'] };
    const drawBroadcast = (d) => {
      const ul = $('#bcList'); ul.replaceChildren();
      if (!d.jobs.length) ul.append(emptyLi('Nothing scheduled or sent yet.'));
      for (const j of d.jobs) {
        const [label, tone] = BC_STATUS[j.status] || [j.status, ''];
        const meta = [new Date(j.at).toLocaleString(), j.target === 'online' ? 'online numbers' : 'all linked numbers', j.result].filter(Boolean).join(' · ');
        const li = h('li', {}, h('span', { class: 'txt' }, h('b', {}, j.text.length > 90 ? `${j.text.slice(0, 90)}…` : j.text), h('small', {}, meta)), h('span', { class: `pill ${tone}` }, label));
        if (j.status === 'scheduled') {
          const x = h('button', { class: 'btn alt sm', type: 'button' }, 'Cancel');
          x.addEventListener('click', busy(x, async () => { try { drawBroadcast(await api('DELETE', `/api/admin/broadcast/${j.id}`)); toast('Cancelled.'); } catch (e) { toast(e.message, true); } }));
          li.append(x);
        }
        ul.append(li);
      }
    };
    async function loadBroadcast() { try { drawBroadcast(await api('GET', '/api/admin/broadcast')); } catch (e) { toast(e.message, true); } }
    const bcRefreshButton = () => { $('#bcSend').querySelector('.label').textContent = $('#bcWhen').value ? 'Schedule' : 'Send now'; };
    $('#bcText').addEventListener('input', () => { $('#bcCount').textContent = String($('#bcText').value.length); });
    $('#bcWhen').addEventListener('input', bcRefreshButton);
    $('#bcTarget').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; bcTarget = b.dataset.t; $('#bcTarget').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b))); });
    $('#bcSend').addEventListener('click', busy($('#bcSend'), async () => {
      const text = $('#bcText').value.trim();
      if (!text) { toast('Write the message first.', true); return; }
      const raw = $('#bcWhen').value, at = raw ? new Date(raw).getTime() : null;
      if (raw && (!Number.isFinite(at) || at < Date.now() + 30000)) { toast('Pick a time at least a minute from now, or leave it empty to send now.', true); return; }
      const n = bcTarget === 'online' ? all.filter(isOnline).length : all.filter((s) => s.linked).length;
      if (!(await ask({ title: at ? 'Schedule this message?' : 'Send this message now?', body: `${text.length > 160 ? `${text.slice(0, 160)}…` : text}\n\n${n} number${n === 1 ? '' : 's'} (${bcTarget === 'online' ? 'online only' : 'all linked'})${at ? `, on ${new Date(at).toLocaleString()}` : ''}. The numbers are checked again at send time.`, ok: at ? 'Schedule' : 'Send' }))) return;
      try {
        const r = await api('POST', '/api/admin/broadcast', { text, target: bcTarget, at });
        toast(r.instant ? 'Sending started.' : 'Scheduled.');
        $('#bcText').value = ''; $('#bcCount').textContent = '0'; $('#bcWhen').value = ''; bcRefreshButton();
        await loadBroadcast(); refresh();
      } catch (e) { toast(e.message, true); }
    }));

    /* ----- live logs ----- */
    let logSince = 0, logLevel = 'all', logPaused = false, logTimer = null, logDebounce, logBusy = false;
    const LOG_MAX_NODES = 700;
    async function pollLogs(reset = false) {
      if (logBusy) return; logBusy = true;
      try {
        if (reset) { logSince = 0; $('#logBox').replaceChildren(); }
        const r = await api('GET', `/api/admin/logs?since=${logSince}&level=${logLevel}&q=${encodeURIComponent($('#logQ').value.trim())}&limit=300`);
        logSince = r.last;
        const box = $('#logBox'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        for (const l of r.lines) box.append(h('span', { class: `ll ${l.level}` }, `${new Date(l.t).toLocaleTimeString()}  ${l.text}\n`));
        while (box.childElementCount > LOG_MAX_NODES) box.firstElementChild.remove();
        if (stick) box.scrollTop = box.scrollHeight;
        $('#logInfo').textContent = `${r.counts.warn} warning${r.counts.warn === 1 ? '' : 's'}, ${r.counts.error} error${r.counts.error === 1 ? '' : 's'} in the last ${r.counts.total} lines`;
        drawLogBadge(r.counts);
      } catch (e) { if (e.status === 401) stopLogs(); } finally { logBusy = false; }
    }
    const drawLogBadge = (c) => { const b = $('#logBadge'); b.hidden = !c.error; b.textContent = String(c.error); };
    const startLogs = () => { stopLogs(); pollLogs(true); logTimer = setInterval(() => { if (!logPaused) pollLogs(); }, 3000); };
    const stopLogs = () => { clearInterval(logTimer); logTimer = null; };
    $('#logLevel').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; logLevel = b.dataset.l; $('#logLevel').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b))); pollLogs(true); });
    $('#logQ').addEventListener('input', () => { clearTimeout(logDebounce); logDebounce = setTimeout(() => pollLogs(true), 350); });
    $('#logPause').addEventListener('click', () => { logPaused = !logPaused; $('#logPause').textContent = logPaused ? 'Resume' : 'Pause'; });
    $('#logClear').addEventListener('click', () => $('#logBox').replaceChildren());
    $('#logSave').addEventListener('click', () => saveBlob(new Blob([$('#logBox').textContent], { type: 'text/plain' }), `rio-logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`));

    /* ----- security: locked addresses + login history ----- */
    const RESULT = { ok: ['Logged in', 'on'], failed: ['Wrong password', 'warn'], locked: ['Locked', 'warn'] };
    async function loadSecurity() {
      try {
        const d = await api('GET', '/api/admin/security');
        $('#secWide').hidden = !d.wideLock;
        $('#secYou').textContent = `Your address right now: ${d.you || 'unknown'}. Times are in your device's time zone.`;
        const lk = $('#secLocked'); lk.replaceChildren();
        if (!d.locked.length) lk.append(emptyLi('No address is locked.'));
        for (const l of d.locked) {
          const b = h('button', { class: 'btn alt sm', type: 'button' }, 'Unblock');
          b.addEventListener('click', busy(b, async () => { try { await api('POST', '/api/admin/security/unblock', { ip: l.ip }); toast('Unblocked.'); loadSecurity(); } catch (e) { toast(e.message, true); } }));
          lk.append(h('li', {}, h('span', { class: 'txt' }, h('b', {}, l.ip), h('small', {}, `Opens in ${fmtWait(l.seconds)} · lock number ${l.strikes}`)), b));
        }
        const kn = $('#secKnown'); kn.replaceChildren();
        if (!d.known.length) kn.append(emptyLi('None yet.'));
        for (const ip of d.known) {
          const b = h('button', { class: 'btn alt sm', type: 'button' }, 'Remove');
          b.addEventListener('click', busy(b, async () => { try { await api('POST', '/api/admin/security/forget', { ip }); loadSecurity(); } catch (e) { toast(e.message, true); } }));
          kn.append(h('li', {}, h('span', { class: 'txt' }, h('b', {}, ip), ip === d.you ? h('small', {}, 'This is you') : null), b));
        }
        const lg = $('#secLog'); lg.replaceChildren();
        if (!d.log.length) lg.append(h('li', {}, 'No logins yet.'));
        for (const e of d.log) {
          const [label, tone] = RESULT[e.result] || [e.result, ''];
          lg.append(h('li', {}, h('span', { class: `pill ${tone}` }, label), ' ', h('b', {}, e.ip), e.extra ? ` · ${e.extra}` : '', h('small', { class: 'meta' }, `${when(e.at)}${e.ua ? ` · ${e.ua}` : ''}`)));
        }
      } catch (e) { toast(e.message, true); }
    }

    /* ----- backup ----- */
    $('#bkExport').addEventListener('click', busy($('#bkExport'), async () => {
      const passphrase = $('#bkPass').value;
      if (passphrase.length < 8) { toast('The passphrase needs at least 8 characters.', true); return; }
      try {
        const r = await fileCall('/api/admin/backup', { json: true, body: JSON.stringify({ passphrase }) });
        saveBlob(await r.blob(), `rio-backup-${new Date().toISOString().slice(0, 10)}.riobak`);
        toast(`Backup saved (${r.headers.get('x-sessions') || '?'} numbers).`); $('#bkPass').value = '';
      } catch (e) { toast(e.message, true); }
    }));
    $('#bkImport').addEventListener('click', busy($('#bkImport'), async () => {
      const file = $('#bkFile').files[0], pass = $('#bkPass2').value, out = $('#bkResult');
      out.textContent = '';
      if (!file) { toast('Choose a backup file first.', true); return; }
      if (!pass) { toast('Enter the passphrase of this file.', true); return; }
      try {
        const buf = await file.arrayBuffer();
        const info = await (await fileCall('/api/admin/restore/check', { body: buf, pass })).json();
        const room = Math.max(0, info.maxSessions - info.linkedNow), canAdd = Math.min(room, Math.max(0, info.total - info.existing));
        const global = $('#bkGlobal').checked;
        const go = await ask({ title: 'Import this backup?', body: `Made on ${new Date(info.created).toLocaleString()}. It has ${info.total} number(s); ${info.existing} already linked here (kept as they are). About ${canAdd} will be added${canAdd < info.total - info.existing ? ` (the limit is ${info.maxSessions} numbers)` : ''}${global ? ', and the server-wide settings are restored too' : ''}.\n\nMake sure these numbers are NOT running on another server, or both copies will be logged out.`, ok: 'Import', danger: true });
        if (!go) return;
        const r = await (await fileCall('/api/admin/restore', { body: buf, pass, headers: { 'x-rio-global': global ? '1' : '0' } })).json();
        out.textContent = `Added ${r.imported} number(s). Skipped: ${r.skipped.existing} already linked, ${r.skipped.full} over the limit, ${r.skipped.invalid} unreadable. They come online one by one over the next minute.`;
        toast('Backup imported.'); $('#bkPass2').value = ''; $('#bkFile').value = ''; refresh();
      } catch (e) { toast(e.message, true); }
    }));

    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });
    const fromHash = location.hash.slice(1);
    if (['overview', 'numbers', 'channels', 'activity', 'broadcast', 'logs', 'security', 'backup', 'insights', 'commands', 'analytics'].includes(fromHash)) showTab(fromHash);
    $('#detailClose').addEventListener('click', closeDetail);
    $('#scrim').addEventListener('click', closeDetail);
    $('#bbActions').addEventListener('click', () => { $('#bulk').hidden = false; lock(); });
    $('#bbClear').addEventListener('click', () => { sel.clear(); drawList(); });
    $('#bulkClose').addEventListener('click', closeBulk);
    $('#bulk').addEventListener('click', (e) => { if (e.target === $('#bulk')) closeBulk(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !$('#modal').hidden) return; // the confirm box handles its own Escape
      if (!$('#bulk').hidden) closeBulk(); else if (!$('#detail').hidden) closeDetail();
    });

    /* ----- many numbers ----- */
    $('#selShown').addEventListener('click', () => { shown().forEach((s) => sel.add(s.id)); drawList(); });
    $('#selOnline').addEventListener('click', () => { sel.clear(); all.filter(isOnline).forEach((s) => sel.add(s.id)); drawList(); });
    $('#selNone').addEventListener('click', () => { sel.clear(); drawList(); });
    let findTimer = null, findSeq = 0;
    $('#q').addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(async () => {
        const digits = $('#q').value.replace(/\D/g, ''), mine = ++findSeq;
        if (digits.length < 4) { found = null; drawList(); return; }
        try { const r = await api('GET', `/api/admin/find?q=${digits}`); if (mine === findSeq) { found = new Set(r.ids); drawList(); } }
        catch (e) { if (e.status !== 401) toast(e.message, true); }
      }, 250);
    });
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
        closeBulk(); refresh(); return true;
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
    BULKABLE.forEach((it) => keySel.append(h('option', { value: it.k }, it.label)));
    let valueField = null;
    const drawValue = () => {
      const it = BULKABLE.find((i) => i.k === keySel.value);
      const box = $('#bulkValBox'); box.replaceChildren();
      if (it.type === 'switch') valueField = h('select', { 'aria-label': 'Value' }, h('option', { value: 'on' }, 'Turn on'), h('option', { value: 'off' }, 'Turn off'));
      else if (it.type === 'select') valueField = h('select', { 'aria-label': 'Value' }, it.options.map(([v, t]) => h('option', { value: v }, t)));
      else valueField = h('input', { type: 'text', maxlength: it.k === 'callMsg' ? 500 : 200, placeholder: it.k === 'callMsg' ? 'Message (empty = default)' : '😍 🔥 ❤️ (empty = default)', 'aria-label': 'Value' });
      box.append(valueField);
    };
    keySel.addEventListener('change', drawValue); drawValue();
    $('#bulkApply').addEventListener('click', busy($('#bulkApply'), async () => {
      if (!sel.size) return toast('Tick at least one number first.', true);
      const it = BULKABLE.find((i) => i.k === keySel.value);
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

    $('#boostSwitch').addEventListener('change', async (e) => {
      const box = e.target; box.disabled = true;
      try { const r = await api('POST', '/api/admin/boost/pause', { paused: !box.checked }); drawBoost(r.boost); toast(box.checked ? 'Channel support resumed.' : 'Channel support paused.'); }
      catch (err) { box.checked = !box.checked; toast(err.message, true); }
      finally { box.disabled = false; }
    });

    await login('/api/admin/login', ['user', 'password'], refresh);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); showLogin(); });
    refresh();
  }

  document.body.dataset.page === 'admin' ? adminPage() : settingsPage();
})();
