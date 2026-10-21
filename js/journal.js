// 旅程手帳分享圖：1080×1350 的水彩手帳頁。
const W = 1080, H = 1350;
const HAND = "'LXGW WenKai TC', 'Kaiti TC', serif";
const BODY = "'Noto Sans TC', 'PingFang TC', sans-serif";
const CAT = { shop: ['#3F6F94', '店家'], food: ['#B8603F', '飲食'], goods: ['#557F50', '商品'], private: ['#7A4F78', '私人地點'] };

function merc(lng, lat) {
  const s = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

function rand(seed) {
  let x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function paper(g) {
  g.fillStyle = '#F4EEE2';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {
    const x = rand(i) * W, y = rand(i + 500) * H, r = 40 + rand(i + 900) * 160;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = rand(i + 77) < 0.55;
    grd.addColorStop(0, dark ? 'rgba(170,140,100,0.028)' : 'rgba(255,252,244,0.14)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 7;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);
}

function wrapText(g, text, maxW) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function wash(g, x, y, r, color, alpha, seed) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.beginPath();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const ang = (i % n) / n * Math.PI * 2;
    const m = 0.82 + 0.3 * rand(seed + i * 13.1);
    const px = x + Math.cos(ang) * r * m, py = y + Math.sin(ang) * r * m;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.restore();
}

function fmtD(t) {
  const d = new Date(t);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export async function tripImage(tr) {
  try {
    await Promise.all([
      document.fonts.load(`700 80px ${HAND}`, tr.regions.join('')),
      document.fonts.load(`400 30px ${BODY}`, '解開移動天紀錄'),
      document.fonts.load(`500 30px ${BODY}`, tr.records.map((r) => r.name).join(''))
    ]);
  } catch (e) { /* 字型載入失敗就用系統字型 */ }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  paper(g);

  // 標題
  const days = Math.max(1, Math.round((new Date(tr.end).setHours(0, 0, 0, 0) - new Date(tr.start).setHours(0, 0, 0, 0)) / 86400000) + 1);
  g.fillStyle = '#6B6155';
  g.font = `400 30px ${BODY}`;
  g.fillText(`${fmtD(tr.start)}${days > 1 ? ' — ' + fmtD(tr.end).slice(5) : ''} · ${days} 天`, 84, 122);
  g.fillStyle = '#2E2A24';
  g.font = `700 82px ${HAND}`;
  const title = tr.regions.slice(0, 4).join(' · ') + (tr.regions.length > 4 ? ' 等' : '');
  const tl = wrapText(g, title, W - 168).slice(0, 2);
  tl.forEach((l, i) => g.fillText(l, 84, 222 + i * 96));
  let y = 222 + (tl.length - 1) * 96 + 50;

  // 地圖卡片
  const nList = Math.min(4, tr.records.length) + (tr.records.length > 4 ? 1 : 0);
  const below = 56 + 130 + 50 + nList * 58 + 110;
  const mx = 84, my = y, mw = W - 168, mh = Math.max(380, Math.min(680, H - y - below));
  g.save();
  g.translate(mx + mw / 2, my + mh / 2);
  g.rotate(-0.012);
  g.shadowColor = 'rgba(80,60,30,0.18)'; g.shadowBlur = 28; g.shadowOffsetY = 10;
  g.fillStyle = '#FBF7EE';
  g.fillRect(-mw / 2, -mh / 2, mw, mh);
  g.shadowColor = 'transparent';
  // 紙膠帶
  g.fillStyle = 'rgba(196,175,130,0.5)';
  g.save(); g.translate(-mw / 2 + 110, -mh / 2); g.rotate(-0.1); g.fillRect(-70, -20, 140, 40); g.restore();
  g.fillStyle = 'rgba(143,181,126,0.5)';
  g.save(); g.translate(mw / 2 - 110, -mh / 2 + 4); g.rotate(0.08); g.fillRect(-64, -20, 128, 40); g.restore();
  g.restore();

  const pad = 34;
  const ix = mx + pad, iy = my + pad, iw = mw - pad * 2, ih = mh - pad * 2;
  g.fillStyle = '#F2E8D6';
  g.fillRect(ix, iy, iw, ih);
  // 淡淡的方格，像手帳裡的地圖紙
  g.strokeStyle = 'rgba(150,125,90,0.10)';
  g.lineWidth = 1.5;
  for (let gx = ix + 40; gx < ix + iw; gx += 40) { g.beginPath(); g.moveTo(gx, iy); g.lineTo(gx, iy + ih); g.stroke(); }
  for (let gy = iy + 40; gy < iy + ih; gy += 40) { g.beginPath(); g.moveTo(ix, gy); g.lineTo(ix + iw, gy); g.stroke(); }
  const pts = tr.stamps.map((s) => merc(s.o, s.a));
  const recPts = tr.records.map((r) => merc(r.o, r.a));
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const [x, yy] of pts.concat(recPts)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, yy); maxY = Math.max(maxY, yy); }
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((iw - 120) / spanX, (ih - 120) / spanY);
  const ox = ix + iw / 2 - (minX + spanX / 2) * scale;
  const oy = iy + ih / 2 - (minY + spanY / 2) * scale;
  const P = ([x, yy]) => [ox + x * scale, oy + yy * scale];
  // 公尺換算成畫面上的像素
  const midLat = (tr.bounds[0][1] + tr.bounds[1][1]) / 2;
  const metersPerUnit = 40075016.686 * Math.cos(midLat * Math.PI / 180);
  const rPx = (m) => Math.max(15, Math.min(46, (m / metersPerUnit) * scale * 1.25));

  g.save();
  g.beginPath(); g.rect(ix, iy, iw, ih); g.clip();
  const step = Math.max(1, Math.floor(pts.length / 900));
  for (let i = 0; i < pts.length; i += step) {
    const [x, yy] = P(pts[i]);
    wash(g, x, yy, rPx(tr.stamps[i].r) * 1.3, '#B9D2AE', 0.45, i);
  }
  for (let i = 0; i < pts.length; i += step) {
    const [x, yy] = P(pts[i]);
    wash(g, x, yy, rPx(tr.stamps[i].r), '#7FA9C9', 0.4, i + 0.5);
  }
  // 路線
  g.strokeStyle = '#B8603F';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.setLineDash([2, 14]);
  g.beginPath();
  let prev = null;
  for (let i = 0; i < tr.stamps.length; i++) {
    const s = tr.stamps[i];
    const [x, yy] = P(pts[i]);
    if (prev && Math.hypot(s.a - prev.a, s.o - prev.o) < 0.015) g.lineTo(x, yy); else g.moveTo(x, yy);
    prev = s;
  }
  g.stroke();
  g.setLineDash([]);
  // 紀錄圖釘
  const recs = tr.records.slice().sort((a, b) => a.t - b.t);
  recs.forEach((r, i) => {
    const [x, yy] = P(merc(r.o, r.a));
    g.fillStyle = (CAT[r.cat] || CAT.shop)[0];
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 5;
    g.beginPath(); g.arc(x, yy, 22, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#FFFFFF';
    g.font = `700 24px ${BODY}`;
    g.textAlign = 'center';
    g.fillText(String(i + 1), x, yy + 8.5);
    g.textAlign = 'left';
  });
  g.restore();
  y = my + mh + 56;

  // 數據
  const stats = [
    [tr.km2 < 0.01 ? '<0.01' : tr.km2.toFixed(2), 'km² 解開'],
    [tr.km.toFixed(1), 'km 移動'],
    [String(recs.length), '筆紀錄']
  ];
  const sw = (W - 168 - 40) / 3;
  stats.forEach(([v, l], i) => {
    const sx = 84 + i * (sw + 20);
    g.fillStyle = '#FBF7EE';
    g.strokeStyle = '#D8CAB1';
    g.lineWidth = 2;
    g.beginPath(); g.roundRect(sx, y, sw, 130, 20); g.fill(); g.stroke();
    g.fillStyle = '#2E2A24';
    g.font = `700 52px ${HAND}`;
    g.textAlign = 'center';
    g.fillText(v, sx + sw / 2, y + 68);
    g.fillStyle = '#5A5146';
    g.font = `400 26px ${BODY}`;
    g.fillText(l, sx + sw / 2, y + 108);
    g.textAlign = 'left';
  });
  y += 130 + 70;

  // 紀錄清單
  const list = recs.slice(0, 4);
  list.forEach((r, i) => {
    const col = (CAT[r.cat] || CAT.shop)[0];
    g.fillStyle = col;
    g.beginPath(); g.arc(102, y - 10, 18, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#FFFFFF';
    g.font = `700 21px ${BODY}`;
    g.textAlign = 'center';
    g.fillText(String(i + 1), 102, y - 2);
    g.textAlign = 'left';
    g.fillStyle = '#2E2A24';
    g.font = `500 32px ${BODY}`;
    const name = wrapText(g, r.name, W - 168 - 220)[0];
    g.fillText(name, 138, y);
    g.fillStyle = '#5A5146';
    g.font = `400 26px ${BODY}`;
    g.textAlign = 'right';
    g.fillText((CAT[r.cat] || CAT.shop)[1], W - 84, y);
    g.textAlign = 'left';
    y += 58;
  });
  if (recs.length > 4) {
    g.fillStyle = '#5A5146';
    g.font = `400 26px ${BODY}`;
    g.fillText(`還有 ${recs.length - 4} 筆紀錄`, 138, y);
  }

  // 頁尾
  g.fillStyle = '#B8603F';
  g.font = `700 36px ${HAND}`;
  g.textAlign = 'right';
  g.fillText('霧旅', W - 84, H - 64);
  g.textAlign = 'left';

  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}
