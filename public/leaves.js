/* Falling leaves behind the pairing page.
   Leaves tumble (flip + sway), glide sideways in the direction they tilt, fall slower when they face the air,
   and a slow wind with now-and-then gusts pushes them along. Far leaves are small, soft and slow, near ones big and quick.
   Canvas only, no libraries. Pauses when the tab is hidden; does nothing when the visitor prefers reduced motion. */
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.getElementById('leaves');
  const ctx = canvas && canvas.getContext('2d');
  if (!ctx) return;

  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- leaf sprites (drawn once, reused every frame) ---------- */
  const UW = 70, UH = 126, SPR = 2; // sprite size in leaf units, and pixel density of the sprite
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (c, to, t) => c.map((v, i) => Math.round(lerp(v, to[i], t)));
  const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // mostly the site's greens, a few yellow-green and one dry amber
  const PALETTE = ['#1f8f4e', '#25a85a', '#2fb35f', '#4cc26a', '#7dd68a', '#9bcf52', '#b9d54a', '#d7a13c'];
  const WEIGHTS = [3, 3, 3, 3, 2, 2, 1, 1];

  function leafPath(c, L, W) {
    c.beginPath();
    c.moveTo(0, -L / 2);
    c.bezierCurveTo(W * 0.66, -L * 0.30, W * 0.56, L * 0.20, 0, L / 2);
    c.bezierCurveTo(-W * 0.56, L * 0.20, -W * 0.66, -L * 0.30, 0, -L / 2);
    c.closePath();
  }

  function makeSprite(baseHex, back, soft) {
    const cv = document.createElement('canvas');
    cv.width = UW * SPR; cv.height = UH * SPR;
    const c = cv.getContext('2d');
    if (soft && 'filter' in c) c.filter = 'blur(1.4px)'; // far leaves are out of focus (skipped where unsupported)
    c.scale(SPR, SPR);
    c.translate(UW / 2, UH / 2 - 4);
    const L = 100 * 0.9, W = 56 * 0.9;
    let base = hex(baseHex);
    if (back) base = mix(mix(base, [150, 160, 150], 0.45), [255, 255, 255], 0.12); // underside: paler, greyer
    const dark = mix(base, [0, 25, 10], 0.42), light = mix(base, [255, 255, 235], 0.28);

    // stem
    c.strokeStyle = css(mix(base, [90, 70, 30], 0.5)); c.lineWidth = 2.2; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, L / 2 - 2); c.quadraticCurveTo(2, L / 2 + 8, 1, L / 2 + 15); c.stroke();

    // blade, lit from one side
    const g = c.createLinearGradient(-W / 2, 0, W / 2, 0);
    g.addColorStop(0, css(dark)); g.addColorStop(0.55, css(base)); g.addColorStop(1, css(light));
    leafPath(c, L, W); c.fillStyle = g; c.fill();

    // veins
    c.save(); leafPath(c, L, W); c.clip();
    c.strokeStyle = css(mix(base, [255, 255, 230], back ? 0.30 : 0.38), 0.75); c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(0, -L / 2 + 2); c.lineTo(0, L / 2 - 1); c.stroke();
    c.lineWidth = 0.9; c.strokeStyle = css(mix(base, [255, 255, 230], 0.26), 0.55);
    for (let i = 1; i <= 6; i++) {
      const y = -L / 2 + (L * i) / 7.6, run = W * 0.40 * Math.sin((Math.PI * i) / 7.4 + 0.12);
      c.beginPath(); c.moveTo(0, y + 3); c.quadraticCurveTo(run * 0.5, y - 2, run, y - L * 0.075); c.stroke();
      c.beginPath(); c.moveTo(0, y + 3); c.quadraticCurveTo(-run * 0.5, y - 2, -run, y - L * 0.075); c.stroke();
    }
    c.restore();
    // thin darker rim
    leafPath(c, L, W); c.strokeStyle = css(dark, 0.5); c.lineWidth = 0.8; c.stroke();
    return cv;
  }

  const sprites = PALETTE.map((h) => ({
    sharp: [makeSprite(h, false, false), makeSprite(h, true, false)],
    soft: [makeSprite(h, false, true), makeSprite(h, true, true)]
  }));
  const pickColor = () => {
    let r = Math.random() * WEIGHTS.reduce((a, b) => a + b, 0);
    for (let i = 0; i < WEIGHTS.length; i++) { r -= WEIGHTS[i]; if (r <= 0) return i; }
    return 0;
  };

  /* ---------- wind ---------- */
  let gust = { t0: -99, dur: 3, amp: 0 }, nextGust = 5;
  function wind(t, y) {
    if (t > nextGust) { gust = { t0: t, dur: rand(2.4, 4), amp: rand(55, 120) }; nextGust = t + rand(8, 16); }
    const k = clamp((t - gust.t0) / gust.dur, 0, 1);
    const g = gust.amp * Math.sin(Math.PI * k) ** 2;
    const base = 16 + 12 * Math.sin(t * 0.31) + 7 * Math.sin(t * 0.83 + 1.3);
    return { x: base + g + 6 * Math.sin(y * 0.011 + t * 0.55), lift: g * 0.22 };
  }

  /* ---------- leaves ---------- */
  let W = 0, H = 0, dpr = 1, leaves = [];

  function spawn(l, anywhere) {
    l.x = rand(-0.25 * W, W);
    l.y = anywhere ? rand(-H * 0.1, H) : -l.size * 1.5 - rand(0, H * 0.25);
    l.vx = 0; l.vy = 0;
  }
  function makeLeaf() {
    const z = rand(0.3, 1);
    const l = {
      z, color: pickColor(), soft: z < 0.55,
      size: lerp(15, 46, z) * rand(0.85, 1.2),
      fall: lerp(34, 92, z) * rand(0.85, 1.15),
      alpha: lerp(0.38, 0.95, z),
      flutterPhase: rand(0, 6.28), flutterFreq: rand(0.9, 2.1), flutterAmp: rand(0.35, 0.95),
      rot: rand(0, 6.28), spin: rand(-0.5, 0.5),
      flip: rand(0, 6.28), flipSpeed: rand(0.8, 2.6) * (Math.random() < 0.5 ? -1 : 1),
      glide: rand(26, 70)
    };
    spawn(l, true);
    return l;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const want = clamp(Math.round(W / 62), 12, W < 640 ? 16 : 30);
    while (leaves.length < want) leaves.push(makeLeaf());
    leaves.length = want;
    leaves.sort((a, b) => a.z - b.z); // far ones are drawn first
  }

  /* ---------- frame ---------- */
  let last = 0, t = 0, raf = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now; t += dt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const l of leaves) {
      l.flutterPhase += dt * l.flutterFreq;
      l.flip += dt * l.flipSpeed;
      const cosF = Math.cos(l.flip), face = Math.abs(cosF);
      const sway = Math.sin(l.flutterPhase);
      l.rot += l.spin * dt;

      const w = wind(t, l.y);
      const targetVx = w.x * lerp(0.55, 1, l.z) + sway * l.glide;      // glides toward the side it tilts to
      const targetVy = l.fall * (1 - 0.5 * face) - w.lift;             // broadside to the air = slower, gusts lift
      l.vx += (targetVx - l.vx) * Math.min(1, dt * 1.7);
      l.vy += (targetVy - l.vy) * Math.min(1, dt * 2.3);
      l.x += l.vx * dt; l.y += l.vy * dt;

      if (l.y > H + l.size * 1.5) spawn(l, false);
      if (l.x > W + l.size * 2) l.x = -l.size * 2;
      else if (l.x < -l.size * 3) l.x = W + l.size;

      const angle = l.rot + sway * l.flutterAmp;
      const s = l.size / 100, sx = Math.max(face, 0.07) * s, cs = Math.cos(angle), sn = Math.sin(angle);
      ctx.setTransform(cs * sx * dpr, sn * sx * dpr, -sn * s * dpr, cs * s * dpr, l.x * dpr, l.y * dpr);
      ctx.globalAlpha = l.alpha * (0.62 + 0.38 * face);                 // edge-on leaves look thinner and dimmer
      const set = sprites[l.color][l.soft ? 'soft' : 'sharp'];
      ctx.drawImage(set[cosF >= 0 ? 0 : 1], -UW / 2, -UH / 2, UW, UH);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '0', pointerEvents: 'none' });
  resize();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
})();
