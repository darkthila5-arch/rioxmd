// Notices: shows the host's news / alerts on the pair site and the settings site, and runs the admin "Notices" tab.
// Text is always set with textContent (never innerHTML). Links are checked again here, the server checks them too.
(() => {
  const PAGE = document.body.dataset.page || 'pair';
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
  const KINDS = { news: ['📰', 'News'], update: ['✨', 'Update'], warning: ['⚠️', 'Important'], success: ['✅', 'Good news'], promo: ['🎁', 'Offer'] };
  const safeUrl = (u) => (/^(https?:\/\/|\/(?!\/))/i.test(u || '') ? u : '#');
  const pad = (x) => String(x).padStart(2, '0');
  const left = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400); return `${d ? `${d}d ` : ''}${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
  setInterval(() => document.querySelectorAll('.nt-count[data-t]').forEach((el) => {
    const ms = Number(el.dataset.t) - Date.now();
    el.querySelector('b').textContent = ms > 0 ? left(ms) : 'Now';
  }), 1000);

  /* ================= shared: one notice as a glass card ================= */
  // o: { preview, onClose, onClick(buttonIndex) }
  function render(n, o = {}) {
    const banner = n.layout === 'banner', img = !!n.image && !banner;
    const el = h('article', {
      class: `nt nt-k-${n.kind} nt-t-${n.titleSize} nt-x-${n.textSize} nt-a-${n.align} nt-img-${n.imageMode}${img ? ' has-img' : ''}${banner ? ' nt-banner' : ''}${o.onClose ? ' has-x' : ''}`,
      role: n.layout === 'popup' ? 'dialog' : 'region', 'aria-label': n.title || 'Notice',
    });
    if (/^#[0-9a-f]{6}$/i.test(n.accent || '')) el.style.setProperty('--nc', n.accent);
    const ico = h('span', { class: 'nt-ico', 'aria-hidden': 'true' }, n.icon || KINDS[n.kind]?.[0] || '📰');
    const btns = (n.buttons || []).length ? h('div', { class: 'nt-btns' }, n.buttons.map((b, i) => h('a', {
      class: `nt-btn ${b.style === 'glass' ? 'glass' : 'solid'}`, href: o.preview ? '#' : safeUrl(b.url), target: /^https?:/i.test(b.url) && !o.preview ? '_blank' : null, rel: 'noopener noreferrer',
      onclick: (e) => { if (o.preview) { e.preventDefault(); return; } o.onClick?.(i); },
    }, b.label))) : null;
    const count = n.countdownTo ? h('div', { class: 'nt-count', 'data-t': String(n.countdownTo) }, '⏳ ', h('b', {}, n.countdownTo > Date.now() ? left(n.countdownTo - Date.now()) : 'Now')) : null;
    const body = h('div', { class: 'nt-body' },
      !banner && h('div', { class: 'nt-head' }, ico, h('span', { class: 'nt-tag' }, KINDS[n.kind]?.[1] || 'News'), n.pinned && h('span', { class: 'nt-pin', title: 'Pinned' }, '📌')),
      n.title && h('h3', {}, n.title), n.body && h('p', { class: 'nt-text' }, n.body), count, !banner && btns);
    el.append(h('div', { class: 'nt-inner' }, img && h('div', { class: 'nt-media' }, h('img', { src: n.image, alt: '', loading: 'lazy', decoding: 'async' })), banner && ico, body, banner && btns));
    if (o.onClose) el.append(h('button', { class: 'nt-close', type: 'button', 'aria-label': 'Close', onclick: o.onClose }, '✕'));
    return el;
  }

  /* ================= pair site + settings site ================= */
  function visitorSide() {
    const host = $('#noticeHost');
    if (!host) return;
    const site = PAGE === 'settings' ? 'settings' : 'pair';
    const vid = (() => {
      try { let v = localStorage.getItem('rio_vid'); if (!/^[a-z0-9]{10,40}$/.test(v || '')) { v = [...crypto.getRandomValues(new Uint8Array(14))].map((b) => (b % 36).toString(36)).join(''); localStorage.setItem('rio_vid', v); } return v; }
      catch { return [...crypto.getRandomValues(new Uint8Array(14))].map((b) => (b % 36).toString(36)).join(''); }
    })();
    const ev = (n, type, btn) => fetch('/api/notices/event', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-rio': '1' }, body: JSON.stringify({ id: n.id, type, btn, site, vid }) }).catch(() => {});
    const ck = (n) => `rio_nt_${n.id}_${n.rev}`;
    const isClosed = (n) => { try { return localStorage.getItem(ck(n)) === '1'; } catch { return false; } };
    const setClosed = (n) => { try { localStorage.setItem(ck(n), '1'); } catch {} };

    // "seen" = at least half of it is on screen; "read" = it stayed 4 seconds, or the visitor pressed a button or closed it
    let trackers = [];
    function track(el, n) {
      let seen = false, read = false, t = 0;
      const doRead = () => { if (!read) { read = true; ev(n, 'read'); } };
      if (!('IntersectionObserver' in window)) { ev(n, 'seen'); return { doRead, stop() {} }; }
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) {
          if (!seen) { seen = true; ev(n, 'seen'); }
          if (!read && !t) t = setTimeout(() => { t = 0; if (document.visibilityState === 'visible') doRead(); }, 4000);
        } else { clearTimeout(t); t = 0; }
      }), { threshold: 0.5 });
      io.observe(el);
      return { doRead, stop() { io.disconnect(); clearTimeout(t); } };
    }

    const popSeen = new Set(); let popOpen = false; const popQueue = [];
    function nextPop() {
      if (popOpen || !popQueue.length) return;
      const n = popQueue.shift(); popOpen = true;
      let tr, wrap;
      const close = () => { setClosed(n); ev(n, 'close'); tr.stop(); wrap.remove(); document.removeEventListener('keydown', onKey); popOpen = false; nextPop(); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      const card = render(n, { onClose: close, onClick: (i) => { ev(n, 'click', i); } });
      wrap = h('div', { class: 'nt-pop', onclick: (e) => { if (e.target === wrap) close(); } }, card);
      document.body.append(wrap); document.addEventListener('keydown', onKey);
      tr = track(card, n); card.querySelector('.nt-close')?.focus();
    }

    let lastSig = '';
    function draw(list) {
      const sig = JSON.stringify(list);
      if (sig === lastSig) return;
      lastSig = sig; trackers.forEach((t) => t.stop()); trackers = []; host.replaceChildren();
      const flat = list.filter((n) => n.layout !== 'popup');
      for (const n of [...flat.filter((x) => x.layout === 'banner'), ...flat.filter((x) => x.layout !== 'banner')]) {
        if (n.dismissible && isClosed(n)) continue;
        let el, tr;
        el = render(n, {
          onClose: n.dismissible ? () => { setClosed(n); ev(n, 'close'); tr.stop(); el.remove(); } : null,
          onClick: (i) => { ev(n, 'click', i); },
        });
        tr = track(el, n); trackers.push(tr); host.append(el);
      }
      for (const n of list.filter((x) => x.layout === 'popup')) {
        const k = ck(n);
        if (isClosed(n) || popSeen.has(k)) continue;
        popSeen.add(k); popQueue.push(n);
      }
      nextPop();
    }
    async function load() {
      try {
        const r = await fetch(`/api/notices?site=${site}`, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) draw((await r.json()).notices || []);
      } catch {}
    }
    let timer = 0;
    const start = () => { if (timer) return; load(); timer = setInterval(load, 60000); };
    const stop = () => { clearInterval(timer); timer = 0; lastSig = ''; trackers.forEach((t) => t.stop()); trackers = []; host.replaceChildren(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && timer) load(); });
    if (PAGE === 'settings') { // only after the visitor logged in
      const panel = $('#panel');
      const sync = () => (panel.hidden ? stop() : start());
      new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
      sync();
    } else start();
  }

  /* ================= admin: the Notices tab ================= */
  function adminSide() {
    const root = $('#ntAdmin'), pane = $('#pane-notices');
    if (!root || !pane) return;
    let toastTimer;
    const toast = (msg, bad) => { const t = $('#toast'); if (!t) return; t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3800); };
    const call = async (method, url, body, raw) => {
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': raw ? (body.type || 'image/jpeg') : 'application/json', 'x-rio': '1' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      let j = {}; try { j = await r.json(); } catch {}
      if (!r.ok) { if (r.status === 401) document.dispatchEvent(new Event('rio:admin-auth-lost')); throw new Error(j.error || 'Something went wrong. Try again.'); }
      return j;
    };
    const busy = (btn, fn) => async (...a) => { btn.disabled = true; try { return await fn(...a); } finally { btn.disabled = false; } };
    function confirmBox({ title, body, ok = 'Confirm', danger = false }) {
      return new Promise((resolve) => {
        const m = $('#modal'), okBtn = $('#mOk'), cancel = $('#mCancel');
        $('#mTitle').textContent = title; $('#mBody').textContent = body; $('#mField').hidden = true;
        okBtn.querySelector('.label').textContent = ok; okBtn.classList.toggle('danger', danger);
        m.hidden = false; cancel.focus();
        const done = (v) => { m.hidden = true; okBtn.onclick = cancel.onclick = m.onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
        const onKey = (e) => { if (e.key === 'Escape') done(false); };
        document.addEventListener('keydown', onKey);
        okBtn.onclick = () => done(true); cancel.onclick = () => done(false); m.onclick = (e) => { if (e.target === m) done(false); };
      });
    }

    const BLANK = () => ({ title: '', body: '', kind: 'news', icon: '📰', audience: ['pair', 'settings'], layout: 'card', titleSize: 'l', textSize: 'm', align: 'left', image: null, imageMode: 'top', buttons: [], accent: '', pinned: false, enabled: true, dismissible: true, startAt: 0, endAt: 0, countdownTo: 0 });
    const TEMPLATES = [
      ['📰 News', { kind: 'news', icon: '📰', title: 'Latest news', body: 'Write your news here.' }],
      ['✨ New feature', { kind: 'update', icon: '✨', layout: 'popup', titleSize: 'xl', align: 'center', title: 'New feature is here!', body: 'Tell people what is new and why they will like it.' }],
      ['🛠️ Maintenance', { kind: 'warning', icon: '🛠️', layout: 'banner', title: 'Scheduled maintenance', body: 'The bot may be offline for a few minutes.' }],
      ['🎁 Offer', { kind: 'promo', icon: '🎁', titleSize: 'xl', title: 'Special offer', body: 'Describe the offer.', buttons: [{ label: 'Open', url: 'https://', style: 'solid' }] }],
    ];
    let data = { notices: [], images: 0, limits: {} }, draft = null;
    const ago = (t) => { if (!t) return 'never'; const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
    const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const localInput = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

    async function load() { try { data = await call('GET', '/api/admin/notices'); draw(); } catch (e) { toast(e.message, true); } }
    const adopt = (r) => { data = r; };

    /* ----- the editor ----- */
    function editor() {
      const d = draft;
      const prevHost = h('div');
      const update = () => {
        prevHost.replaceChildren();
        const n = { ...d, id: 'preview', rev: 1, image: d.image ? `/notice-img/${d.image}` : null, buttons: d.buttons.filter((b) => b.label && b.url) };
        const card = render(n, { preview: true, onClose: n.layout === 'popup' || n.dismissible ? () => {} : null });
        prevHost.append(n.layout === 'popup' ? h('div', { class: 'nt-pop inline' }, card) : card);
      };
      const lbl = (t, hint) => h('span', { class: 'lbl' }, t, hint && h('small', {}, hint));
      const chips = (key, opts, multi) => {
        const row = h('div', { class: 'chips', role: 'group' });
        const sync = () => row.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(multi ? d[key].includes(c.dataset.v) : d[key] === c.dataset.v)));
        for (const [v, t] of opts) row.append(h('button', { class: 'chip', type: 'button', 'data-v': v, onclick: () => {
          if (multi) d[key] = d[key].includes(v) ? d[key].filter((x) => x !== v) : [...d[key], v]; else d[key] = v;
          if (key === 'kind' && (!d.icon || Object.values(KINDS).some(([i]) => i === d.icon))) { d.icon = KINDS[v][0]; iconBox.value = d.icon; }
          sync(); update();
        } }, t));
        sync(); return row;
      };
      const input = (key, o = {}) => {
        const el = o.area ? h('textarea', { maxlength: o.max, placeholder: o.ph || '', 'aria-label': o.label }) : h('input', { type: o.type || 'text', maxlength: o.max, placeholder: o.ph || '', 'aria-label': o.label });
        el.value = d[key] ?? '';
        el.addEventListener('input', () => { d[key] = el.value; update(); });
        return el;
      };
      const field = (el, cls = '') => h('div', { class: `field ${cls}` }, el);
      const dt = (key, label) => { const el = h('input', { type: 'datetime-local', 'aria-label': label }); el.value = localInput(d[key]); el.addEventListener('change', () => { d[key] = el.value ? new Date(el.value).getTime() : 0; update(); }); return field(el, 'sm'); };
      const toggle = (key, title, hint) => { const sw = h('input', { type: 'checkbox', class: 'sw', role: 'switch', 'aria-label': title }); sw.checked = !!d[key]; sw.addEventListener('change', () => { d[key] = sw.checked; update(); }); return h('label', { class: 'toggle' }, h('span', {}, h('b', {}, title), h('small', {}, hint)), sw); };

      const iconBox = input('icon', { max: 8, ph: '📰', label: 'Icon' });
      // pictures
      const imgBox = h('div');
      const fileEl = h('input', { type: 'file', accept: 'image/*', hidden: true });
      const drawImg = () => {
        imgBox.replaceChildren();
        const up = h('button', { class: 'btn alt', type: 'button', onclick: () => fileEl.click() }, d.image ? 'Change picture' : '📷 Add a picture');
        imgBox.append(h('div', { class: 'ntA-up' }, d.image && h('img', { src: `/notice-img/${d.image}`, alt: '' }), up, d.image && h('button', { class: 'btn danger', type: 'button', onclick: () => { d.image = null; drawImg(); update(); } }, 'Remove')));
        if (d.image) imgBox.append(lbl('Where the picture goes'), chips('imageMode', [['top', 'On top'], ['side', 'Beside the text'], ['cover', 'As the background']]));
        imgBox.append(h('p', { class: 'note' }, 'JPG, PNG, WEBP or GIF. It is shrunk to a small WEBP automatically.'));
      };
      fileEl.addEventListener('change', async () => {
        const f = fileEl.files[0]; fileEl.value = '';
        if (!f) return;
        if (f.size > 8 * 1048576) return toast('That picture is over 8 MB.', true);
        try { toast('Uploading…'); const r = await call('POST', '/api/admin/notice-image', f, true); d.image = r.id; drawImg(); update(); toast(`Picture ready (${r.kb} KB).`); }
        catch (e) { toast(e.message, true); }
      });
      // buttons
      const btnBox = h('div');
      const drawBtns = () => {
        btnBox.replaceChildren();
        d.buttons.forEach((b, i) => {
          const name = h('input', { type: 'text', maxlength: 30, placeholder: 'Button name', 'aria-label': 'Button name' }); name.value = b.label;
          const url = h('input', { type: 'text', maxlength: 500, placeholder: 'https://… or /settings', 'aria-label': 'Button link' }); url.value = b.url;
          const st = h('select', { 'aria-label': 'Button style' }, h('option', { value: 'solid' }, 'Solid'), h('option', { value: 'glass' }, 'Glass')); st.value = b.style || 'solid';
          name.addEventListener('input', () => { b.label = name.value; update(); }); url.addEventListener('input', () => { b.url = url.value.trim(); update(); }); st.addEventListener('change', () => { b.style = st.value; update(); });
          btnBox.append(h('div', { class: 'ntA-btn' }, field(name, 'sm'), field(url, 'sm'), field(st, 'sm'), h('button', { class: 'btn alt sm', type: 'button', 'aria-label': 'Remove button', onclick: () => { d.buttons.splice(i, 1); drawBtns(); update(); } }, '✕')));
        });
        if (d.buttons.length < 3) btnBox.append(h('button', { class: 'btn alt sm', type: 'button', onclick: () => { d.buttons.push({ label: '', url: '', style: 'solid' }); drawBtns(); } }, '＋ Add a button'));
      };
      const accent = h('input', { type: 'color', 'aria-label': 'Accent colour' }); accent.value = d.accent || '#25d366';
      const accentOn = h('input', { type: 'checkbox', class: 'sw', role: 'switch', 'aria-label': 'Use my own colour' }); accentOn.checked = !!d.accent;
      accent.addEventListener('input', () => { if (accentOn.checked) { d.accent = accent.value; update(); } });
      accentOn.addEventListener('change', () => { d.accent = accentOn.checked ? accent.value : ''; update(); });

      const save = h('button', { class: 'btn', type: 'button' }, h('span', { class: 'label' }, d.id ? 'Save changes' : 'Publish notice'));
      save.addEventListener('click', busy(save, async () => {
        try { adopt(await call('POST', '/api/admin/notices', d)); draft = null; draw(); toast(d.id ? 'Saved.' : 'Published.'); } catch (e) { toast(e.message, true); }
      }));
      const form = h('div', { class: 'card ntA-form' },
        h('h2', {}, d.id ? 'Edit notice' : 'New notice'),
        lbl('Type'), chips('kind', Object.entries(KINDS).map(([k, [i, t]]) => [k, `${i} ${t}`])),
        lbl('Where it shows'), chips('audience', [['pair', '🔗 Pair site'], ['settings', '⚙️ Settings site']], true),
        lbl('Look'), chips('layout', [['card', 'Card'], ['popup', 'Popup'], ['banner', 'Banner strip']]),
        lbl('Title'), field(input('title', { max: 120, ph: 'Big, short headline', label: 'Title' })),
        lbl('Message', 'line breaks are kept'), field(input('body', { max: 800, area: true, ph: 'What do you want to tell people?', label: 'Message' }), 'area'),
        h('div', { class: 'row2' }, h('div', {}, lbl('Icon', 'any emoji'), field(iconBox, 'sm')), h('div', {}, lbl('Own colour'), h('div', { class: 'ntA-color' }, accentOn, accent))),
        lbl('Title size'), chips('titleSize', [['m', 'M'], ['l', 'L'], ['xl', 'XL'], ['xxl', 'XXL · huge']]),
        lbl('Message size'), chips('textSize', [['s', 'Small'], ['m', 'Normal'], ['l', 'Large']]),
        lbl('Text position'), chips('align', [['left', 'Left'], ['center', 'Centre']]),
        lbl('Picture'), imgBox, fileEl,
        lbl('Buttons', 'up to 3, they open a link'), btnBox,
        lbl('Countdown', 'optional: shows a live timer to this moment'), dt('countdownTo', 'Countdown to'),
        h('div', { class: 'row2' }, h('div', {}, lbl('Start showing at', 'empty = now'), dt('startAt', 'Start')), h('div', {}, lbl('Stop showing at', 'empty = never'), dt('endAt', 'End'))),
        toggle('pinned', '📌 Pin to the top', 'Pinned notices come first.'),
        toggle('dismissible', 'Visitors can close it', 'Closed notices stay closed on that device until you change the text. Popups can always be closed.'),
        toggle('enabled', 'Visible', 'Switch off to keep it as a draft.'),
        h('div', { class: 'ntA-save' }, save, h('button', { class: 'btn alt', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel')));
      drawImg(); drawBtns(); update();
      return h('div', { class: 'ntA-edit' }, form, h('div', { class: 'ntA-prev' }, h('small', {}, 'Live preview'), prevHost));
    }

    /* ----- the list with the read counts ----- */
    function item(n) {
      const s = n.stats, rate = s.seen ? Math.round((s.read / s.seen) * 100) : 0, clicks = s.clicks.reduce((a, b) => a + b, 0);
      const sw = h('input', { type: 'checkbox', class: 'sw', role: 'switch', 'aria-label': 'Visible' }); sw.checked = n.enabled;
      sw.addEventListener('change', async () => { sw.disabled = true; try { adopt(await call('POST', `/api/admin/notices/${n.id}/enabled`, { on: sw.checked })); draw(); } catch (e) { sw.checked = !sw.checked; toast(e.message, true); } finally { sw.disabled = false; } });
      const stat = { live: ['pill on', 'Live now'], scheduled: ['pill warn', `Starts ${when(n.startAt)}`], expired: ['pill', 'Expired'], off: ['pill', 'Switched off'] }[n.status];
      const who = n.audience.includes('settings') && s.who.length ? h('details', {}, h('summary', { class: 'note' }, `Settings site: ${s.who.length} of ${s.linked} linked numbers saw it`),
        h('div', { class: 'ntA-who' }, s.who.map((w) => h('div', {}, h('b', {}, w.p), h('span', {}, w.r ? `read ${ago(w.r)}` : `seen ${ago(w.s)}, not read yet`))))) : null;
      const act = (label, cls, fn) => { const b = h('button', { class: `btn ${cls}`, type: 'button' }, label); b.addEventListener('click', busy(b, fn)); return b; };
      return h('article', { class: 'card ntA-item' },
        h('div', { class: 'top' }, h('div', { style: 'display:flex;gap:12px;min-width:0' }, n.imageUrl && h('img', { class: 'thumb', src: n.imageUrl, alt: '' }),
          h('div', { style: 'min-width:0' }, h('h3', {}, `${n.icon} ${n.title || '(no title)'}`), n.body && h('p', { class: 'note' }, n.body.length > 150 ? `${n.body.slice(0, 150)}…` : n.body),
            h('div', { class: 'meta' }, h('span', { class: stat[0] }, stat[1]), n.audience.map((a) => h('span', { class: 'pill' }, a === 'pair' ? 'Pair site' : 'Settings site')), h('span', { class: 'pill' }, { card: 'Card', popup: 'Popup', banner: 'Banner' }[n.layout]), n.pinned && h('span', { class: 'pill gold' }, '📌 Pinned'), n.endAt ? h('span', { class: 'pill' }, `Ends ${when(n.endAt)}`) : null))), sw),
        h('div', { class: 'ntA-stats' }, h('div', {}, h('b', {}, s.seen), h('small', {}, '👁 Seen by')), h('div', {}, h('b', {}, s.read), h('small', {}, '✅ Read it')), h('div', {}, h('b', {}, clicks), h('small', {}, '🖱 Button clicks')), h('div', {}, h('b', {}, s.closed), h('small', {}, '✕ Closed it'))),
        h('div', { class: 'ntA-bar2', title: `${rate}% of the people who saw it read it` }, h('i', { style: `width:${rate}%` })),
        h('p', { class: 'note' }, s.seen ? `${rate}% read it. Last seen ${ago(s.last)}. Counts are per visitor (one device counts once).` : 'Nobody has seen it yet.'),
        n.buttons.some((_, i) => s.clicks[i]) && h('p', { class: 'note' }, n.buttons.map((b, i) => `“${b.label}” ${s.clicks[i] || 0}×`).join('  ·  ')),
        who,
        h('div', { class: 'ntA-acts' },
          act('Edit', 'alt', async () => { draft = JSON.parse(JSON.stringify(n)); draw(); root.scrollIntoView({ behavior: 'smooth', block: 'start' }); }),
          act('Duplicate', 'alt', async () => { draft = { ...JSON.parse(JSON.stringify(n)), id: undefined, title: `${n.title} (copy)`.slice(0, 120), enabled: false }; draw(); }),
          act('📲 Also send on WhatsApp', 'alt', async () => {
            if (!(await confirmBox({ title: 'Send it on WhatsApp too?', body: 'The text is sent to every linked number, one by one, in its own chat. Pictures are not included.', ok: 'Send' }))) return;
            const text = [`${n.icon} *${n.title || 'Notice'}*`, n.body, ...n.buttons.map((b) => `🔗 ${b.label}: ${b.url.startsWith('/') ? location.origin + b.url : b.url}`)].filter(Boolean).join('\n\n').slice(0, 1000);
            try { const r = await call('POST', '/api/admin/bulk', { action: 'notice', ids: 'all', text }); toast(`Sending to ${r.queued} number(s), one by one.`); } catch (e) { toast(e.message, true); }
          }),
          act('Reset counts', 'alt', async () => { if (await confirmBox({ title: 'Reset the counts?', body: 'Seen, read and click numbers go back to zero.', ok: 'Reset' })) { try { adopt(await call('POST', `/api/admin/notices/${n.id}/reset-stats`, {})); draw(); } catch (e) { toast(e.message, true); } } }),
          act('Delete', 'danger', async () => { if (await confirmBox({ title: 'Delete this notice?', body: 'It disappears from the sites right away.', ok: 'Delete', danger: true })) { try { adopt(await call('DELETE', `/api/admin/notices/${n.id}`)); draw(); toast('Deleted.'); } catch (e) { toast(e.message, true); } } })));
    }

    function draw() {
      root.replaceChildren();
      const bar = h('div', { class: 'ntA-bar' }, h('button', { class: 'btn', type: 'button', onclick: () => { draft = BLANK(); draw(); } }, '＋ New notice'),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick start' }, TEMPLATES.map(([t, v]) => h('button', { class: 'chip', type: 'button', onclick: () => { draft = { ...BLANK(), ...JSON.parse(JSON.stringify(v)) }; draw(); } }, t))));
      root.append(bar);
      if (draft) root.append(editor());
      root.append(h('div', { class: 'ntA-list' }, data.notices.length ? data.notices.map(item) : h('div', { class: 'card ntA-empty' }, 'No notices yet. Press “New notice” or pick a quick start above.')));
    }

    // load when the tab opens, refresh the counts while it is open (never while the editor is open, so nothing is lost)
    const visible = () => !pane.hidden && !$('#panel').hidden;
    const sync = () => { if (visible()) load(); };
    new MutationObserver(sync).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(sync).observe($('#panel'), { attributes: true, attributeFilter: ['hidden'] });
    setInterval(() => { if (visible() && !draft && document.visibilityState === 'visible') load(); }, 15000);
    sync();
  }

  if (PAGE === 'admin') adminSide(); else visitorSide();
})();
