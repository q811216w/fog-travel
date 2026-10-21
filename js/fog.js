// 水彩迷霧：畫在地圖上方的一張 canvas。
// 做法：先畫一層較深的「顏料沉積」，再畫一層淺色紙張，兩層挖洞的大小不同，
// 邊緣就會出現水彩乾掉時那圈比較深的痕跡。

const PAPER = [244, 238, 226];
const PIGMENT = [222, 208, 184];

function hash(x, y, i) {
  let h = Math.sin(x * 127.1 + y * 311.7 + i * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

function makeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 384;
  const g = c.getContext('2d');
  // 大片暈染
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 384, y = Math.random() * 384, r = 20 + Math.random() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.6;
    const col = dark ? '150,125,90' : '255,252,244';
    grd.addColorStop(0, `rgba(${col},${dark ? 0.06 : 0.10})`);
    grd.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    // 讓圖案可以無縫重複
    for (const [ox, oy] of [[384, 0], [-384, 0], [0, 384], [0, -384]]) {
      g.save(); g.translate(ox, oy); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.restore();
    }
  }
  // 紙紋顆粒
  const img = g.getImageData(0, 0, 384, 384);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    d[i + 3] = Math.max(d[i + 3], Math.abs(n) * 2.2);
    if (d[i + 3] === Math.abs(n) * 2.2) { d[i] = n < 0 ? 120 : 255; d[i + 1] = n < 0 ? 100 : 252; d[i + 2] = n < 0 ? 70 : 245; }
  }
  g.putImageData(img, 0, 0);
  // 纖維
  g.strokeStyle = 'rgba(140,115,80,0.07)';
  g.lineWidth = 0.6;
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * 384, y = Math.random() * 384, a = Math.random() * Math.PI, l = 4 + Math.random() * 10;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return c;
}

export function createFog(map, getStamps) {
  const container = map.getContainer();
  const canvas = document.createElement('canvas');
  canvas.className = 'fog-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const bandC = document.createElement('canvas');
  const bandX = bandC.getContext('2d');
  const tex = makeTexture();
  let pattern = null;
  let raf = 0;
  let w = 0, h = 0, dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = container.clientWidth; h = container.clientHeight;
    for (const c of [canvas, bandC]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    pattern = ctx.createPattern(tex, 'repeat');
    schedule();
  }

  function blob(g, x, y, R, seedA, seedO, soft) {
    const pts = 16;
    const grd = g.createRadialGradient(x, y, 0, x, y, R);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(soft, 'rgba(0,0,0,1)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    for (let i = 0; i <= pts; i++) {
      const ang = (i % pts) / pts * Math.PI * 2;
      const m = 0.86 + 0.22 * hash(seedA, seedO, i % pts);
      const px = x + Math.cos(ang) * R * m, py = y + Math.sin(ang) * R * m;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
  }

  function draw() {
    raf = 0;
    if (!w) return;
    const zoom = map.getZoom();
    const center = map.getCenter();
    const mpp = 40075016.686 * Math.cos(center.lat * Math.PI / 180) / (512 * Math.pow(2, zoom));
    const stamps = getStamps();
    const b = map.getBounds();
    const padDeg = 0.02 + 300 * mpp / 111320;
    const W = b.getWest() - padDeg, E = b.getEast() + padDeg, S = b.getSouth() - padDeg, N = b.getNorth() + padDeg;

    // 深色顏料層
    bandX.setTransform(dpr, 0, 0, dpr, 0, 0);
    bandX.globalCompositeOperation = 'source-over';
    bandX.clearRect(0, 0, w, h);
    bandX.fillStyle = `rgb(${PIGMENT.join(',')})`;
    bandX.fillRect(0, 0, w, h);
    // 主畫布：淺色紙張
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = `rgb(${PAPER.join(',')})`;
    ctx.fillRect(0, 0, w, h);

    bandX.globalCompositeOperation = 'destination-out';
    ctx.globalCompositeOperation = 'destination-out';
    const seen = new Set();
    for (const s of stamps) {
      if (s.o < W || s.o > E || s.a < S || s.a > N) continue;
      const p = map.project([s.o, s.a]);
      const R = Math.max(2.2, s.r / mpp);
      const gs = Math.max(1, R * 0.45);
      const key = Math.round(p.x / gs) + ',' + Math.round(p.y / gs);
      if (seen.has(key)) continue;
      seen.add(key);
      blob(bandX, p.x, p.y, R * 1.02, s.a, s.o, 0.55);
      blob(ctx, p.x, p.y, R * 1.32, s.o, s.a, 0.62);
    }
    // 合成：深色層放在紙張下面
    ctx.globalCompositeOperation = 'destination-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bandC, 0, 0);
    // 紙紋只畫在還有迷霧的地方
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    if (pattern) {
      const off = map.project([0, 0]);
      ctx.save();
      ctx.translate(off.x % 384, off.y % 384);
      ctx.fillStyle = pattern;
      ctx.fillRect(-384, -384, w + 768, h + 768);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  map.on('move', schedule);
  map.on('resize', resize);
  window.addEventListener('resize', resize);
  resize();
  return { redraw: schedule };
}
