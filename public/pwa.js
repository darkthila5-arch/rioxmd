// Makes the site installable: registers the service worker and powers the "Install app" button (shown only when installing is possible).
// Chrome / Edge / Android: the real install prompt. iPhone / iPad Safari has no prompt, so the button shows how to use "Add to Home Screen".
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* the site works without it */ }); });
  }
  const btn = document.getElementById('installBtn'), tip = document.getElementById('pwaTip');
  if (!btn) return; // pages without the button only register the service worker
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return; // already running as an app
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  window.addEventListener('appinstalled', () => { deferred = null; btn.hidden = true; if (tip) tip.hidden = true; });
  if (ios) btn.hidden = false;
  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null; btn.hidden = true;
      return;
    }
    if (tip) {
      tip.textContent = ios ? 'On iPhone / iPad: tap the Share button, then “Add to Home Screen”.' : 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
      tip.hidden = false;
    }
  });
})();
