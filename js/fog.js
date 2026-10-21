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

// 迷霧用「圖磚」快取：每個縮放層級把迷霧切成 256px 的方塊，畫過就留著，
// 拖動地圖時只要貼上現成的方塊；有新的足跡才重畫受影響的方塊。
const T = 256;
const MAX_TILES = 140;

const mercX = (lng, ws) => (lng + 180) / 360 * ws;
const mercY = (lat, ws) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;
};
const unX = (x, ws) => x / ws * 360 - 180;
const unY = (y, ws) => {
  const n = Math.PI - 2 * Math.PI * y / ws;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export function createFog(map, getStamps) {
  const container = map.getContainer();
  const canvas = document.createElement('canvas');
  canvas.className = 'fog-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const tex = makeTexture();
  let w = 0, h = 0;
  let raf = 0;

  // 預先畫好幾種不規則的柔邊圓形，之後直接貼上
  const SPR = 128, SPR_R = 58;
  function makeSprites(soft, seed) {
    const list = [];
    for (let v = 0; v < 8; v++) {
      const c = document.createElement('canvas');
      c.width = c.height = SPR;
      const g = c.getContext('2d');
      const x = SPR / 2, y = SPR / 2, R = SPR_R;
      const grd = g.createRadialGradient(x, y, 0, x, y, R * 1.08);
      grd.addColorStop(0, 'rgba(0,0,0,1)');
      grd.addColorStop(soft, 'rgba(0,0,0,1)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      const pts = 18;
      for (let i = 0; i <= pts; i++) {
        const ang = (i % pts) / pts * Math.PI * 2;
        const m = 0.86 + 0.22 * hash(v + seed, seed * 3.1, i % pts);
        const px = x + Math.cos(ang) * R * m, py = y + Math.sin(ang) * R * m;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      list.push(c);
    }
    return list;
  }
  const bandSpr = makeSprites(0.55, 1.7);
  const paperSpr = makeSprites(0.62, 5.3);

  // ---- 足跡的空間索引（約 2 公里一格）----
  const B = 50;
  let buckets = new Map();
  let indexed = 0;
  let stampsRef = null;
  function bucketKey(i, j) { return i * 100000 + j; }
  function indexStamp(s) {
    const i = Math.floor(s.a * B), j = Math.floor(s.o * B);
    const k = bucketKey(i, j);
    let arr = buckets.get(k);
    if (!arr) { arr = []; arr.i = i; arr.j = j; buckets.set(k, arr); }
    arr.push(s);
  }
  function syncIndex() {
    const stamps = getStamps();
    if (stamps !== stampsRef || stamps.length < indexed) {
      // 足跡被整批換掉（載入、移除範例）：全部重建
      stampsRef = stamps; buckets = new Map(); indexed = 0; tiles.clear();
    }
    // 一次加入很多點（匯入照片、軌跡）時，直接清掉快取比逐點檢查快
    const bulk = stamps.length - indexed > 300;
    if (bulk) tiles.clear();
    for (; indexed < stamps.length; indexed++) {
      const s = stamps[indexed];
      indexStamp(s);
      if (!bulk) invalidateAround(s);
    }
  }

  // ---- 圖磚快取 ----
  const tiles = new Map();  // 'z/x/y' -> canvas（Map 的順序當作 LRU）
  function invalidateAround(s) {
    for (const key of [...tiles.keys()]) {
      const [z, x, y] = key.split('/').map(Number);
      const ws = 512 * Math.pow(2, z);
      const px = mercX(s.o, ws), py = mercY(s.a, ws);
      const mpp = 40075016.686 * Math.cos(s.a * Math.PI / 180) / ws;
      const m = Math.max(3, s.r / mpp) * 1.6;
      if (px + m >= x * T && px - m <= (x + 1) * T && py + m >= y * T && py - m <= (y + 1) * T) tiles.delete(key);
    }
  }

  function stampsInTile(z, x, y) {
    const ws = 512 * Math.pow(2, z);
    const pad = T * 0.5;
    const west = unX(x * T - pad, ws), east = unX((x + 1) * T + pad, ws);
    const north = unY(y * T - pad, ws), south = unY((y + 1) * T + pad, ws);
    const i0 = Math.floor(south * B), i1 = Math.floor(north * B);
    const j0 = Math.floor(west * B), j1 = Math.floor(east * B);
    const out = [];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > buckets.size) {
      for (const arr of buckets.values()) if (arr.i >= i0 && arr.i <= i1 && arr.j >= j0 && arr.j <= j1) out.push(arr);
    } else {
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const arr = buckets.get(bucketKey(i, j));
        if (arr) out.push(arr);
      }
    }
    return out;
  }

  const bandC = document.createElement('canvas');
  bandC.width = bandC.height = T;
  const bandX = bandC.getContext('2d');
  const pattern = bandX.createPattern(tex, 'repeat');

  function renderTile(z, x, y) {
    const c = document.createElement('canvas');
    c.width = c.height = T;
    const g = c.getContext('2d');
    const ws = 512 * Math.pow(2, z);
    const ox = -x * T, oy = -y * T;
    g.fillStyle = `rgb(${PAPER.join(',')})`;
    g.fillRect(0, 0, T, T);
    bandX.globalCompositeOperation = 'source-over';
    bandX.fillStyle = `rgb(${PIGMENT.join(',')})`;
    bandX.fillRect(0, 0, T, T);
    g.globalCompositeOperation = 'destination-out';
    bandX.globalCompositeOperation = 'destination-out';
    const seen = new Set();
    for (const arr of stampsInTile(z, x, y)) {
      for (const s of arr) {
        const mpp = 40075016.686 * Math.cos(s.a * Math.PI / 180) / ws;
        const R = Math.max(2.2, s.r / mpp);
        const px = mercX(s.o, ws) + ox;
        if (px < -R * 1.5 || px > T + R * 1.5) continue;
        const py = mercY(s.a, ws) + oy;
        if (py < -R * 1.5 || py > T + R * 1.5) continue;
        // 縮小時很多點疊在一起，只畫一個就好；用世界座標分格，相鄰圖磚的結果才會一致
        const gs = Math.max(1.5, R * 0.5);
        const key = Math.round((px - ox) / gs) * 1000003 + Math.round((py - oy) / gs);
        if (seen.has(key)) continue;
        seen.add(key);
        const v = Math.floor(hash(s.a, s.o, 0) * 8);
        let size = SPR * R * 1.02 / SPR_R;
        bandX.drawImage(bandSpr[v], px - size / 2, py - size / 2, size, size);
        size = SPR * R * 1.32 / SPR_R;
        g.drawImage(paperSpr[(v + 3) % 8], px - size / 2, py - size / 2, size, size);
      }
    }
    g.globalCompositeOperation = 'destination-over';
    g.drawImage(bandC, 0, 0);
    // 紙紋對齊世界座標，圖磚之間才接得起來
    g.globalCompositeOperation = 'source-atop';
    g.save();
    g.translate(-(((x * T) % 384) + 384) % 384, -(((y * T) % 384) + 384) % 384);
    g.fillStyle = pattern;
    g.fillRect(0, 0, T + 384, T + 384);
    g.restore();
    drawOverlay(g, z, x, y, ws, ox, oy);
    drawFriends(g, z, x, y, ws, ox, oy);
    return c;
  }

  // ---- 拉遠時的「舊地圖」：迷霧上畫經緯線、國界，去過的國家和地區亮燈 ----
  let overlay = null;   // {countries: [{name, g, bbox, lit, label}], regions: [{name, g, bbox, lit, label}]}
  const HANDF = "'LXGW WenKai TC', 'Kaiti TC', serif";

  function trace(g, geom, ws, ox, oy) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const p of polys) for (const ring of p) {
      for (let i = 0; i < ring.length; i++) {
        const px = mercX(ring[i][0], ws) + ox, py = mercY(ring[i][1], ws) + oy;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    }
  }

  function label(g, text, lng, lat, ws, ox, oy, size, color) {
    const px = mercX(lng, ws) + ox, py = mercY(lat, ws) + oy;
    if (px < -120 || px > T + 120 || py < -30 || py > T + 30) return;
    g.font = `700 ${size}px ${HANDF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(248,243,233,0.9)';
    g.strokeText(text, px, py);
    g.fillStyle = color;
    g.fillText(text, px, py);
  }

  function drawOverlay(g, z, x, y, ws, ox, oy) {
    if (!overlay) return;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const worldA = clamp((8 - z) / 2.5);              // z ≤ 5.5 完整，z 8 消失
    const regA = Math.min(clamp((z - 3.5) / 1.5), clamp((12 - z) / 2.5));
    const litA = clamp((6.2 - z) / 1.7);              // 國家整片亮燈只在拉很遠時，拉近就換成地區亮燈
    if (worldA <= 0 && regA <= 0) return;
    const pad = 2;
    const W = unX(x * T - pad, ws), E = unX((x + 1) * T + pad, ws);
    const N = unY(y * T - pad, ws), S = unY((y + 1) * T + pad, ws);
    const hit = (b) => !(b[2] < W || b[0] > E || b[3] < S || b[1] > N);
    g.save();
    g.globalCompositeOperation = 'source-atop';   // 只畫在迷霧上，不蓋住已解開的地方

    if (worldA > 0) {
      // 經緯線
      if (z <= 5) {
        g.strokeStyle = `rgba(140,115,80,${0.16 * worldA})`;
        g.lineWidth = 1;
        g.setLineDash([3, 5]);
        for (let lng = -180; lng <= 180; lng += 15) {
          const px = mercX(lng, ws) + ox;
          if (px < -1 || px > T + 1) continue;
          g.beginPath(); g.moveTo(px, 0); g.lineTo(px, T); g.stroke();
        }
        for (let lat = -75; lat <= 75; lat += 15) {
          const py = mercY(lat, ws) + oy;
          if (py < -1 || py > T + 1) continue;
          g.beginPath(); g.moveTo(0, py); g.lineTo(T, py); g.stroke();
        }
        g.setLineDash([]);
      }
      for (const c of overlay.countries) {
        if (!hit(c.bbox)) continue;
        g.beginPath();
        trace(g, c.g, ws, ox, oy);
        if (c.lit) {
          if (litA > 0) {
            g.shadowColor = `rgba(232,160,80,${0.75 * litA})`;
            g.shadowBlur = 14;
            g.fillStyle = `rgba(236,178,104,${0.55 * litA})`;
            g.fill('evenodd');
            g.shadowBlur = 0;
          }
          g.strokeStyle = `rgba(184,96,63,${0.85 * worldA})`;
          g.lineWidth = 1.4;
        } else {
          g.fillStyle = `rgba(150,125,90,${0.07 * worldA})`;
          g.fill('evenodd');
          g.strokeStyle = `rgba(110,92,70,${0.42 * worldA})`;
          g.lineWidth = 0.8;
        }
        g.stroke();
      }
    }

    if (regA > 0 && overlay.regions.length) {
      for (const r of overlay.regions) {
        if (!hit(r.bbox)) continue;
        g.beginPath();
        trace(g, r.g, ws, ox, oy);
        if (r.lit) {
          g.fillStyle = `rgba(236,178,104,${0.42 * regA * (1 - litA)})`;
          g.fill('evenodd');
          g.strokeStyle = `rgba(184,96,63,${0.8 * regA})`;
          g.lineWidth = 1.2;
        } else {
          g.strokeStyle = `rgba(110,92,70,${0.3 * regA})`;
          g.lineWidth = 0.8;
        }
        g.stroke();
      }
    }
    g.restore();

    // 地名：去過的國家（拉遠時）、去過的地區（中間縮放）
    g.save();
    if (worldA > 0.3) {
      const size = z <= 2 ? 12 : z <= 4 ? 15 : 18;
      for (const c of overlay.countries) if (c.lit && c.label) label(g, c.zh, c.label[0], c.label[1], ws, ox, oy, size, '#A4502F');
    }
    if (regA > 0.5 && z >= 6.5) {
      for (const r of overlay.regions) if (r.lit && r.label) label(g, r.name, r.label[0], r.label[1], ws, ox, oy, 14, '#A4502F');
    }
    g.restore();
  }

  // ---- 好友的足跡：在迷霧上用每個人的顏色暈染出來 ----
  let friends = [];   // [{color: [r,g,b], stamps: [{a,o,r}], bbox}]
  function drawFriends(g, z, x, y, ws, ox, oy) {
    if (!friends.length) return;
    const W = unX(x * T - 40, ws), E = unX((x + 1) * T + 40, ws);
    const N = unY(y * T - 40, ws), S = unY((y + 1) * T + 40, ws);
    g.save();
    g.globalCompositeOperation = 'source-atop';
    for (const f of friends) {
      const b = f.bbox;
      if (!b || b[2] < W || b[0] > E || b[3] < S || b[1] > N) continue;
      g.fillStyle = `rgba(${f.color.join(',')},0.34)`;
      const seen = new Set();
      g.beginPath();
      for (const s of f.stamps) {
        if (s.o < W || s.o > E || s.a < S || s.a > N) continue;
        const mpp = 40075016.686 * Math.cos(s.a * Math.PI / 180) / ws;
        const R = Math.max(1.8, s.r / mpp) * 1.05;
        const px = mercX(s.o, ws) + ox, py = mercY(s.a, ws) + oy;
        const gs = Math.max(1.5, R * 0.6);
        const key = Math.round((px - ox) / gs) * 1000003 + Math.round((py - oy) / gs);
        if (seen.has(key)) continue;
        seen.add(key);
        g.moveTo(px + R, py);
        g.arc(px, py, R, 0, Math.PI * 2);
      }
      g.fill();
    }
    g.restore();
  }

  function getTile(z, x, y, budget) {
    const key = z + '/' + x + '/' + y;
    let c = tiles.get(key);
    if (c) { tiles.delete(key); tiles.set(key, c); return c; }
    if (budget.n <= 0) return null;
    budget.n--;
    c = renderTile(z, x, y);
    tiles.set(key, c);
    while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
    return c;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = container.clientWidth; h = container.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }

  function draw() {
    raf = 0;
    if (!w) return;
    syncIndex();
    const zoom = map.getZoom();
    const zt = Math.max(2, Math.min(18, Math.round(zoom)));
    const scale = Math.pow(2, zoom - zt);
    const ws = 512 * Math.pow(2, zt);
    const c = map.getCenter();
    const cx = mercX(c.lng, ws), cy = mercY(c.lat, ws);
    // 畫面左上角在 zt 層的世界座標
    const left = cx - w / 2 / scale, top = cy - h / 2 / scale;
    const x0 = Math.floor(left / T), x1 = Math.floor((left + w / scale) / T);
    const y0 = Math.floor(top / T), y1 = Math.floor((top + h / scale) / T);
    const n = Math.pow(2, zt) * 2;
    const budget = { n: 6 };
    let missing = false;
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = `rgb(${PAPER.join(',')})`;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const sx = (tx * T - left) * scale, sy = (ty * T - top) * scale, size = T * scale;
        if (ty < 0 || ty >= n) { ctx.fillRect(sx, sy, size + 1, size + 1); continue; }
        const wx = ((tx % n) + n) % n;
        const tile = getTile(zt, wx, ty, budget);
        if (tile) ctx.drawImage(tile, sx, sy, size + 0.5, size + 0.5);
        else { ctx.fillRect(sx, sy, size + 1, size + 1); missing = true; }
      }
    }
    if (missing) schedule();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  map.on('move', schedule);
  map.on('resize', resize);
  window.addEventListener('resize', resize);
  resize();
  return {
    redraw: schedule,
    setOverlay: (o) => { overlay = o; tiles.clear(); schedule(); },
    setFriends: (list) => {
      friends = list.map((f) => {
        let minX = 180, minY = 90, maxX = -180, maxY = -90;
        for (const s of f.stamps) { minX = Math.min(minX, s.o); maxX = Math.max(maxX, s.o); minY = Math.min(minY, s.a); maxY = Math.max(maxY, s.a); }
        return { ...f, bbox: f.stamps.length ? [minX - 0.01, minY - 0.01, maxX + 0.01, maxY + 0.01] : null };
      });
      tiles.clear(); schedule();
    },
    // 給效能測試用：立即畫一次並回傳花費的毫秒數
    drawNow: () => { const t = performance.now(); draw(); return performance.now() - t; },
    clearCache: () => { tiles.clear(); }
  };
}
