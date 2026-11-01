/* Small soft snow drops on the pairing page, behind the card and the leaves.
   Drops fall slowly and wobble sideways; the wind (and gusts) of leaves.js pushes them when that script is loaded.
   Remove the <script src="/snow.js"> line in index.html to switch the snow off.
   Windows with "Show animations" off / battery saver report "reduce motion": calm mode (half as many, half as fast) instead of hidden. */
(() => {
  const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = CALM ? 0.5 : 1;

  const canvas = document.getElementById('snow');
  const ctx = canvas && canvas.getContext('2d');
  if (!ctx) return;

  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // one soft white dot, reused for every drop
  const DROP = document.createElement('canvas'); DROP.width = DROP.height = 32;
  { const c = DROP.getContext('2d'), g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(235,248,255,0.85)'); g.addColorStop(1, 'rgba(235,248,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 32, 32); }

  let W = 0, H = 0, dpr = 1, flakes = [], t = 0, last = 0, raf = 0;

  const windX = () => (typeof window.rioWind === 'function' ? window.rioWind(0) : 16 + 12 * Math.sin(t * 0.31) + 7 * Math.sin(t * 0.83 + 1.3));

  function makeFlake(anywhere) {
    const z = rand(0.2, 1);
    return {
      z, r: lerp(1.4, 4.2, z) * rand(0.8, 1.2),             // diameter in px: small drops
      fall: lerp(18, 52, z) * rand(0.8, 1.2) * SPEED,
      alpha: lerp(0.25, 0.85, z),
      phase: rand(0, 6.28), freq: rand(0.5, 1.4), amp: rand(6, 20),
      x: rand(-0.1 * W, W * 1.05), y: anywhere ? rand(0, H) : -8 - rand(0, H * 0.2)
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const want = Math.round(clamp(Math.round(W / 15), 36, W < 640 ? 50 : 100) * (CALM ? 0.5 : 1));
    while (flakes.length < want) flakes.push(makeFlake(true));
    flakes.length = want;
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now; t += dt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const wx = windX();
    for (const f of flakes) {
      f.phase += dt * f.freq;
      f.y += f.fall * dt;
      f.x += (wx * 0.55 * f.z * (CALM ? 0.5 : 1) + Math.sin(f.phase) * f.amp) * dt;
      if (f.y > H + 8) { f.y = -8; f.x = rand(-0.1 * W, W * 1.05); }
      if (f.x > W + 8) f.x = -8; else if (f.x < -8) f.x = W + 8;
      const d = f.r * 2;
      ctx.setTransform(dpr, 0, 0, dpr, f.x * dpr, f.y * dpr);
      ctx.globalAlpha = f.alpha;
      ctx.drawImage(DROP, -d / 2, -d / 2, d, d);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  Object.assign(canvas.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', zIndex: '0', pointerEvents: 'none' });
  resize();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
})();
