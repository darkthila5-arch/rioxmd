// Admin → Bot media tab. Uses textContent only (never innerHTML).
(() => {
  if (document.body.dataset.page !== 'admin') return;
  const root = document.getElementById('bmAdmin'), pane = document.getElementById('pane-botmedia'), panel = document.getElementById('panel');
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
  const call = async (method, url, body, file) => {
    const headers = { 'x-rio': '1' };
    if (file) { headers['content-type'] = file.type || 'application/octet-stream'; headers['x-rio-name'] = encodeURIComponent(file.name || ''); }
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(url, { method, credentials: 'same-origin', headers, body: file || (body === undefined ? undefined : JSON.stringify(body)) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { if (r.status === 401) document.dispatchEvent(new Event('rio:admin-auth-lost')); throw new Error(j.error || (r.status === 413 ? 'That file is too big.' : 'Something went wrong. Try again.')); }
    return j;
  };

  const ITEMS = [
    { slot: 'aliveImg', icon: '🖼️', title: 'Alive picture', hint: 'Shown with the .alive message. Nothing saved = the built-in picture.', accept: 'image/*', link: 'https://example.com/alive.jpg' },
    { slot: 'menuImg', icon: '📜', title: 'Menu picture', hint: 'Shown with the .menu message. Nothing saved = the built-in picture.', accept: 'image/*', link: 'https://example.com/menu.jpg' },
    { slot: 'aliveVoice', icon: '🎙️', title: 'Alive voice', hint: 'Sent as a voice note right after the alive message. Any audio file works, it is converted to a voice note.', accept: 'audio/*,video/*,.ogg,.opus,.m4a,.mp3,.wav', link: 'https://example.com/alive.mp3', toggle: 'Send after the alive message' },
    { slot: 'aliveNote', icon: '⭕', title: 'Alive video note', hint: 'Sent as a round video note right after the alive voice. Any video works, it is cropped to a square (first 60 seconds).', accept: 'video/*', link: 'https://example.com/note.mp4', toggle: 'Send after the alive voice' },
    { slot: 'callImg', icon: '📵', title: 'Call reject picture', hint: 'Sent with the rejected-call message (as its caption). Nothing saved = text only.', accept: 'image/*', link: 'https://example.com/call.jpg' },
  ];
  let data = null;
  const mode = {}; // slot -> 'gallery' | 'link' (which input is showing)

  const preview = (it, s) => {
    const src = `/api/admin/botmedia/${it.slot}/file?t=${s.at}`;
    if (s.kind === 'image') return h('img', { src, alt: it.title, style: 'max-width:100%;max-height:200px;border-radius:12px;border:2px solid var(--line);object-fit:cover' });
    if (s.kind === 'audio') return h('audio', { src, controls: true, preload: 'metadata', style: 'width:100%;max-width:420px' });
    return h('video', { src, controls: true, preload: 'metadata', playsinline: true, style: 'width:180px;height:180px;border-radius:50%;object-fit:cover;border:2px solid var(--line);background:#000' });
  };

  function card(it) {
    const s = data.slots[it.slot];
    const m = mode[it.slot] || 'gallery';
    const status = !s.set ? h('p', { class: 'note' }, 'Nothing saved yet.')
      : h('p', { class: 'note' }, `Saved (${s.kb} KB): ${s.source === 'link' ? `from a link, ${s.url.length > 60 ? `${s.url.slice(0, 57)}…` : s.url}` : `from your gallery${s.name ? `, ${s.name}` : ''}`}.`);

    const fileIn = h('input', { type: 'file', accept: it.accept, hidden: true });
    const pick = h('button', { class: 'btn alt sm', type: 'button' }, s.set ? 'Choose another file' : 'Choose from gallery');
    const linkIn = h('input', { type: 'url', placeholder: it.link, 'aria-label': `${it.title} link`, maxlength: 1000, autocomplete: 'off' });
    const useLink = h('button', { class: 'btn alt sm', type: 'button' }, 'Use this link');
    const busy = (btn, label, fn) => async () => {
      const old = btn.textContent; btn.disabled = true; pick.disabled = useLink.disabled = true; btn.textContent = label;
      try { data = await fn(); toast(`${it.title} saved.`); draw(); }
      catch (e) { toast(e.message, true); btn.disabled = false; pick.disabled = useLink.disabled = false; btn.textContent = old; }
    };
    const max = data.slots[it.slot].maxMb;
    pick.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', () => {
      const f = fileIn.files?.[0]; if (!f) return;
      if (f.size > max * 1024 * 1024) { toast(`That file is too big (max ${max} MB).`, true); fileIn.value = ''; return; }
      busy(pick, it.slot === 'aliveNote' || it.slot === 'aliveVoice' ? 'Uploading and converting…' : 'Uploading…', () => call('POST', `/api/admin/botmedia/${it.slot}/upload`, undefined, f))();
    });
    useLink.addEventListener('click', () => {
      if (!linkIn.value.trim()) { toast('Paste a link first.', true); return; }
      busy(useLink, 'Downloading…', () => call('POST', `/api/admin/botmedia/${it.slot}/link`, { url: linkIn.value.trim() }))();
    });
    linkIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useLink.click(); } });

    const seg = h('div', { class: 'chips', role: 'group', 'aria-label': `${it.title} source`, style: 'display:flex;gap:8px;flex-wrap:wrap;margin:10px 0' },
      [['gallery', '📁 Gallery'], ['link', '🔗 Link']].map(([k, label]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(m === k), onclick: () => { mode[it.slot] = k; draw(); } }, label)));

    const body = h('div', { class: 'stack' },
      s.set ? h('div', { style: 'margin:6px 0' }, preview(it, s)) : null,
      status, seg,
      m === 'gallery' ? h('div', { class: 'actions' }, fileIn, pick) : h('div', { class: 'stack' }, h('div', { class: 'field sm' }, linkIn), h('div', { class: 'actions' }, useLink)),
      it.toggle && s.set ? h('label', { class: 'row' }, h('span', { class: 'txt' }, h('b', {}, it.toggle), h('small', {}, 'Switch off to keep the file but not send it.')),
        h('input', { type: 'checkbox', class: 'sw', role: 'switch', checked: s.on, 'aria-label': it.toggle, onchange: async (e) => { try { data = await call('POST', `/api/admin/botmedia/${it.slot}/toggle`, { on: e.target.checked }); toast(e.target.checked ? 'Switched on.' : 'Switched off.'); } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; } } })) : null,
      s.set ? h('div', { class: 'actions' }, h('button', { class: 'btn danger sm', type: 'button', onclick: async () => { try { data = await call('POST', `/api/admin/botmedia/${it.slot}/remove`); toast('Removed.'); draw(); } catch (e) { toast(e.message, true); } } }, 'Remove')) : null);
    return h('section', { class: 'card' }, h('h2', {}, `${it.icon} ${it.title}`), h('p', { class: 'note' }, it.hint), body);
  }

  function callMsgCard() {
    const ta = h('textarea', { maxlength: 500, 'aria-label': 'Default rejected-call message', placeholder: data.callMsg.builtin }, data.callMsg.value);
    const save = async (text) => { try { data = await call('POST', '/api/admin/botmedia/callmsg', { text }); toast(text ? 'Message saved.' : 'Back to the built-in message.'); draw(); } catch (e) { toast(e.message, true); } };
    return h('section', { class: 'card' }, h('h2', {}, '💬 Default call reject message'),
      h('p', { class: 'note' }, 'Sent to callers when call reject is on. A number that set its own text with .setcallmsg keeps its own. Empty = the built-in message.'),
      h('div', { class: 'field area' }, ta),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => save(ta.value.trim()) }, 'Save'), h('button', { class: 'btn alt', type: 'button', onclick: () => save('') }, 'Use built-in')));
  }

  function draw() {
    root.replaceChildren(...ITEMS.slice(0, 4).map(card), callMsgCard(), card(ITEMS[4]));
    // order: alive picture, menu picture, alive voice, alive video note, call message, call picture
  }

  const visible = () => !pane.hidden && !panel.hidden;
  let loading = false;
  const load = async () => {
    if (loading) return; loading = true;
    try { data = await call('GET', '/api/admin/botmedia'); draw(); } catch (e) { toast(e.message, true); } finally { loading = false; }
  };
  new MutationObserver(() => { if (visible()) load(); }).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if (visible()) load(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (visible()) load();
})();
