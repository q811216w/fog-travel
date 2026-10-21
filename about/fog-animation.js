// 介紹頁的動畫：走出門，迷霧跟著散開，記下一家店，最後整個縣市亮起來。
(() => {
  const cv = document.getElementById('cv');
  const g = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 世界（地圖座標，像素） ----------
  const WS = 3200, OFF = 800;
  const PAPER = '#F4EEE2', PIGMENT = '#DED0B8';
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();

  // 走路的路線：從家門口出發，穿過老街、公園，走到運河邊
  const route = [[700, 1020], [760, 930], [760, 840], [850, 790], [940, 800], [1000, 730], [990, 640], [1060, 590], [1150, 600]];
  const shift = (pts) => pts.map(([x, y]) => [x + OFF, y + OFF]);
  route.splice(0, route.length, ...shift(route));
  const SEG = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const d = Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
    SEG.push(d); total += d;
  }
  function along(f) {
    let d = f * total;
    for (let i = 0; i < SEG.length; i++) {
      if (d <= SEG[i]) { const t = d / SEG[i]; return [route[i][0] + (route[i + 1][0] - route[i][0]) * t, route[i][1] + (route[i + 1][1] - route[i][1]) * t]; }
      d -= SEG[i];
    }
    return route[route.length - 1];
  }
  const PIN_F = 0.52;            // 走到一半記下牛肉湯
  const pinPos = along(PIN_F);

  // 縣市的形狀（簡化）
  const county = [[420, 1260], [380, 1050], [430, 860], [520, 700], [640, 560], [780, 430], [930, 380], [1080, 400], [1220, 470], [1300, 600], [1290, 760], [1210, 900], [1120, 1040], [1000, 1160], [860, 1250], [700, 1300], [540, 1300]];
  county.splice(0, county.length, ...shift(county));
  const neighbors0 = [
    [[420, 1260], [380, 1050], [430, 860], [520, 700], [300, 640], [160, 820], [140, 1100], [250, 1300]],
    [[640, 560], [780, 430], [930, 380], [900, 200], [700, 150], [520, 300], [520, 700]],
    [[1220, 470], [1300, 600], [1290, 760], [1450, 780], [1520, 560], [1400, 360], [1080, 400]],
    [[1000, 1160], [860, 1250], [700, 1300], [760, 1500], [1100, 1480], [1200, 1300], [1120, 1040]]
  ];

  const neighbors = neighbors0.map(shift);

  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // 底下的地圖
  const map = makeCanvas(WS, WS);
  (function drawMap() {
    const m = map.getContext('2d');
    m.fillStyle = '#ECE6D8'; m.fillRect(0, 0, WS, WS);
    m.save();
    m.translate(WS / 2, WS / 2); m.rotate(-0.24); m.translate(-WS / 2, -WS / 2);
    // 街廓
    for (let x = -400; x < WS + 400; x += 92) for (let y = -400; y < WS + 400; y += 74) {
      m.fillStyle = rnd() < 0.08 ? '#C7D7B4' : '#E2D9C8';
      m.fillRect(x + 9, y + 9, 74, 56);
      if (rnd() < 0.6) { m.fillStyle = '#D6CBB7'; m.fillRect(x + 16 + rnd() * 20, y + 16 + rnd() * 14, 22 + rnd() * 16, 16 + rnd() * 12); }
    }
    // 主要道路
    m.fillStyle = '#F1D9AB';
    for (let x = -400; x < WS + 400; x += 92 * 5) m.fillRect(x, -400, 14, WS + 800);
    for (let y = -400; y < WS + 400; y += 74 * 6) m.fillRect(-400, y, WS + 800, 12);
    m.restore();
    m.translate(OFF, OFF);
    // 公園
    m.fillStyle = '#BCD2A8';
    m.beginPath(); m.ellipse(890, 740, 70, 52, 0.3, 0, Math.PI * 2); m.fill();
    m.beginPath(); m.ellipse(520, 980, 90, 60, -0.2, 0, Math.PI * 2); m.fill();
    // 運河
    m.strokeStyle = '#A9C6D8'; m.lineWidth = 46; m.lineCap = 'round';
    m.beginPath(); m.moveTo(980, 120); m.bezierCurveTo(1120, 360, 1260, 520, 1200, 760); m.bezierCurveTo(1150, 960, 1320, 1180, 1500, 1300); m.stroke();
    // 地名
    m.fillStyle = '#5A5146'; m.font = '700 22px "LXGW WenKai TC", serif';
    m.fillText('老街', 800, 880); m.fillText('公園', 862, 748); m.fillText('運河', 1210, 640);
  })();

  // 迷霧：淺色紙張一層、深色顏料一層，挖洞大小不同，邊緣就有水彩乾掉的痕跡
  const fogPaper = makeCanvas(WS, WS), fogBand = makeCanvas(WS, WS);
  const fp = fogPaper.getContext('2d'), fb = fogBand.getContext('2d');
  const TX = 512, tex = makeCanvas(TX, TX);
  (function makeTex() {
    const t = tex.getContext('2d');
    for (let i = 0; i < 90; i++) {
      const x = rnd() * TX, y = rnd() * TX, r = 30 + rnd() * 110;
      const grd = t.createRadialGradient(x, y, 0, x, y, r);
      const dark = rnd() < 0.6;
      grd.addColorStop(0, dark ? 'rgba(150,125,90,0.035)' : 'rgba(255,252,244,0.10)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      t.fillStyle = grd;
      for (const [ox, oy] of [[0, 0], [TX, 0], [-TX, 0], [0, TX], [0, -TX], [TX, TX], [-TX, -TX], [TX, -TX], [-TX, TX]]) { t.save(); t.translate(ox, oy); t.beginPath(); t.arc(x, y, r, 0, Math.PI * 2); t.fill(); t.restore(); }
    }
    const img = t.getImageData(0, 0, TX, TX);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 12; img.data[i] = 128 + n; img.data[i + 1] = 110 + n; img.data[i + 2] = 80 + n; img.data[i + 3] = Math.max(img.data[i + 3], Math.abs(n) * 0.9); }
    t.putImageData(img, 0, 0);
  })();
  const pattern = fp.createPattern(tex, 'repeat');

  // 不規則的柔邊圓形，用來挖洞
  function makeBlob(soft, seed) {
    const S = 128, c = makeCanvas(S, S), x = c.getContext('2d'), R = 58;
    const grd = x.createRadialGradient(64, 64, 0, 64, 64, R * 1.08);
    grd.addColorStop(0, '#000'); grd.addColorStop(soft, '#000'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = grd; x.beginPath();
    for (let i = 0; i <= 18; i++) {
      const a = (i % 18) / 18 * Math.PI * 2;
      const h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
      const m = 0.86 + 0.22 * (h - Math.floor(h));
      const px = 64 + Math.cos(a) * R * m, py = 64 + Math.sin(a) * R * m;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.closePath(); x.fill();
    return c;
  }
  const bandBlobs = [1, 2, 3, 4, 5, 6].map((s) => makeBlob(0.55, s));
  const paperBlobs = [7, 8, 9, 10, 11, 12].map((s) => makeBlob(0.62, s));

  function resetFog() {
    fp.globalCompositeOperation = 'source-over';
    fp.fillStyle = PAPER; fp.fillRect(0, 0, WS, WS);
    fp.fillStyle = pattern; fp.fillRect(0, 0, WS, WS);
    fb.globalCompositeOperation = 'source-over';
    fb.fillStyle = PIGMENT; fb.fillRect(0, 0, WS, WS);
    fp.globalCompositeOperation = 'destination-out';
    fb.globalCompositeOperation = 'destination-out';
    revealedTo = 0; stampN = 0;
  }
  const R = 46;            // 解開半徑（地圖像素）
  let revealedTo = 0, stampN = 0;
  function revealUpTo(f) {
    const step = 9 / total;
    for (let x = revealedTo; x <= f; x += step) {
      const [px, py] = along(Math.min(x, 1));
      const k = stampN++ % 6;
      let s = 128 * R * 1.02 / 58;
      fb.drawImage(bandBlobs[k], px - s / 2, py - s / 2, s, s);
      s = 128 * R * 1.32 / 58;
      fp.drawImage(paperBlobs[(k + 2) % 6], px - s / 2, py - s / 2, s, s);
    }
    revealedTo = Math.max(revealedTo, f);
  }

  // ---------- 時間軸（秒） ----------
  const T = { walkStart: 1.6, walkEnd: 8.2, zoomStart: 8.6, zoomEnd: 10.6, holdEnd: 13.2, endCard: 13.2, loop: 15.4 };
  const SEGS = [
    { at: 0, step: '1 / 4', title: '一開始，地圖是一片迷霧', body: '還沒去過的地方，都被水彩紙蓋住。' },
    { at: T.walkStart, step: '2 / 4', title: '走出門，迷霧就跟著散開', body: '你走過的每一條路，都會從迷霧裡透出來。' },
    { at: 4.9, step: '3 / 4', title: '吃到好吃的，就記下來', body: '店家、美食、伴手禮，釘在你當時站的地方。' },
    { at: T.zoomStart, step: '4 / 4', title: '拉遠一看，整個縣市亮了', body: '第一次來到一個地方，就會點亮它的徽章。' }
  ];
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  let W = 0, H = 0, dpr = 1;
  function resize() {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  addEventListener('resize', resize);
  resize();

  function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  function polyPath(pts, s, ox, oy) { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * s + ox, y * s + oy) : g.moveTo(x * s + ox, y * s + oy))); g.closePath(); }

  function frame(t) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = PAPER; g.fillRect(0, 0, W, H);

    const walk = clamp01((t - T.walkStart) / (T.walkEnd - T.walkStart));
    const wf = ease(walk) * 0.98 + walk * 0.02;
    if (t >= T.walkStart) revealUpTo(wf);
    const me = along(wf);

    // 鏡頭：先跟著走路的人，最後拉遠看整個縣市
    const z = ease(clamp01((t - T.zoomStart) / (T.zoomEnd - T.zoomStart)));
    const baseS = W / 380;
    const scale = lerp(1.15 * baseS, 0.27 * baseS, z);
    const cx = lerp(me[0], 840 + OFF, z), cy = lerp(me[1] - 40, 840 + OFF, z);
    const ox = W / 2 - cx * scale, oy = H * 0.48 - cy * scale;

    g.imageSmoothingEnabled = true;
    g.drawImage(map, ox, oy, WS * scale, WS * scale);
    g.drawImage(fogBand, ox, oy, WS * scale, WS * scale);
    g.drawImage(fogPaper, ox, oy, WS * scale, WS * scale);

    // 拉遠後：縣市界線浮現、去過的縣市亮燈
    const lit = clamp01((t - (T.zoomStart + 1.2)) / 0.9);
    const outlineA = clamp01((t - T.zoomStart) / 1.0);
    if (outlineA > 0) {
      g.save();
      g.lineJoin = 'round';
      for (const n of neighbors) { polyPath(n, scale, ox, oy); g.strokeStyle = `rgba(110,92,70,${0.35 * outlineA})`; g.lineWidth = 1.2; g.stroke(); }
      polyPath(county, scale, ox, oy);
      if (lit > 0) {
        g.shadowColor = `rgba(232,160,80,${0.8 * lit})`; g.shadowBlur = 22;
        g.fillStyle = `rgba(236,178,104,${0.5 * lit})`; g.fill();
        g.shadowBlur = 0;
      }
      g.strokeStyle = lit > 0 ? `rgba(184,96,63,${0.4 + 0.5 * lit})` : `rgba(110,92,70,${0.35 * outlineA})`;
      g.lineWidth = lit > 0 ? 2 : 1.2; g.stroke();
      if (lit > 0) {
        g.globalAlpha = lit;
        g.font = `700 ${Math.round(W * 0.07)}px "LXGW WenKai TC", serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 5; g.strokeStyle = 'rgba(248,243,233,0.95)';
        const lx = (880 + OFF) * scale + ox, ly = (1040 + OFF) * scale + oy;
        g.strokeText('台南市', lx, ly); g.fillStyle = '#A4502F'; g.fillText('台南市', lx, ly);
      }
      g.restore();
    }

    // 走路的人
    if (t >= T.walkStart - 0.4 && z < 0.98) {
      const px = me[0] * scale + ox, py = me[1] * scale + oy;
      const pulse = (Math.sin(t * 5) + 1) / 2;
      g.save(); g.globalAlpha = 1 - z;
      g.fillStyle = `rgba(184,96,63,${0.14 + 0.12 * pulse})`;
      g.beginPath(); g.arc(px, py, 18 + 6 * pulse, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#B8603F'; g.strokeStyle = '#fff'; g.lineWidth = 4;
      g.beginPath(); g.arc(px, py, 9, 0, Math.PI * 2); g.fill(); g.stroke();
      g.restore();
    }

    // 記錄的圖釘與卡片
    const pinT = clamp01((t - 4.9) / 0.5);
    if (pinT > 0 && wf >= PIN_F - 0.01) {
      const px = pinPos[0] * scale + ox, py = pinPos[1] * scale + oy;
      const drop = 1 - Math.pow(1 - pinT, 3);
      const bounce = pinT < 1 ? Math.sin(pinT * Math.PI) * 6 : 0;
      const ps = lerp(1, 0.6, z);
      g.save();
      g.translate(px, py - (1 - drop) * 40 - bounce);
      g.scale(ps, ps);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#B8603F'; g.strokeStyle = '#fff'; g.lineWidth = 3;
      rr(-2, -32, 30, 30, 15); g.fill(); g.stroke();
      g.restore();
      // 卡片
      const cardA = clamp01((t - 5.3) / 0.4) * (1 - clamp01((t - 8.0) / 0.5));
      if (cardA > 0) {
        const cw = Math.min(W - 40, 250), ch = 76;
        const cxp = Math.min(Math.max(px - cw / 2, 18), W - cw - 18), cyp = py - 150 - (1 - cardA) * 12;
        g.save(); g.globalAlpha = cardA;
        g.shadowColor = 'rgba(60,40,20,0.22)'; g.shadowBlur = 18; g.shadowOffsetY = 6;
        g.fillStyle = '#FBF7EE'; rr(cxp, cyp, cw, ch, 16); g.fill();
        g.shadowColor = 'transparent';
        g.strokeStyle = '#D8CAB1'; g.lineWidth = 1; g.stroke();
        g.fillStyle = '#F3E2D7'; rr(cxp + 12, cyp + 12, 52, 52, 12); g.fill();
        g.strokeStyle = '#B8603F'; g.lineWidth = 2.2; g.lineCap = 'round';
        g.beginPath(); g.moveTo(cxp + 24, cyp + 40); g.lineTo(cxp + 52, cyp + 40); g.arc(cxp + 38, cyp + 40, 14, 0, Math.PI); g.stroke();
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.fillStyle = '#B8603F'; g.font = '500 11.5px "Noto Sans TC", sans-serif';
        g.fillText('已記錄 · 飲食', cxp + 76, cyp + 28);
        g.fillStyle = '#2E2A24'; g.font = '700 17px "LXGW WenKai TC", serif';
        g.fillText('巷口的牛肉湯', cxp + 76, cyp + 50);
        g.fillStyle = '#B8603F'; g.font = '12px sans-serif';
        g.fillText('★★★★★', cxp + 76, cyp + 67);
        g.restore();
      }
    }

    // 上方的資訊卡：解開面積隨著走路增加
    const cardTop = 16;
    const km = (0.02 + wf * 0.36).toFixed(2);
    g.save();
    g.shadowColor = 'rgba(80,60,30,0.12)'; g.shadowBlur = 16; g.shadowOffsetY = 4;
    g.fillStyle = 'rgba(251,247,238,0.96)'; rr(14, cardTop, W - 28, 72, 16); g.fill();
    g.shadowColor = 'transparent'; g.strokeStyle = '#D8CAB1'; g.lineWidth = 1; g.stroke();
    g.textAlign = 'left'; g.fillStyle = '#5A5146'; g.font = '12px "Noto Sans TC", sans-serif';
    g.fillText('台南市 · 台灣', 28, cardTop + 22);
    g.fillStyle = '#2E2A24'; g.font = '700 25px "LXGW WenKai TC", serif';
    g.fillText((t < T.walkStart ? '0.00' : km) + ' km²', 28, cardTop + 54);
    if (lit > 0) {
      g.globalAlpha = lit;
      const bw = 108, bx = W - 28 - bw;
      g.fillStyle = '#F3E2D7'; rr(bx, cardTop + 22, bw, 28, 14); g.fill();
      g.fillStyle = '#A4502F'; g.font = '500 12.5px "Noto Sans TC", sans-serif'; g.textAlign = 'center';
      g.fillText('縣市 +1 · 1 / 22', bx + bw / 2, cardTop + 41);
    }
    g.restore();

    // 結尾
    const endA = clamp01((t - T.endCard) / 0.6) * (1 - clamp01((t - (T.loop - 0.5)) / 0.5));
    if (endA > 0) {
      g.save(); g.globalAlpha = endA;
      g.fillStyle = 'rgba(244,238,226,0.94)'; g.fillRect(0, 0, W, H);
      g.textAlign = 'center'; g.fillStyle = '#2E2A24';
      g.font = `700 ${Math.round(W * 0.13)}px "LXGW WenKai TC", serif`;
      g.fillText('霧旅', W / 2, H * 0.46);
      g.fillStyle = '#5A5146'; g.font = `${Math.round(W * 0.048)}px "LXGW WenKai TC", serif`;
      g.fillText('走過的地方，會從迷霧中解開', W / 2, H * 0.46 + W * 0.11);
      g.restore();
    }
  }

  // ---------- 播放控制 ----------
  const capStep = document.getElementById('capStep'), capTitle = document.getElementById('capTitle'), capBody = document.getElementById('capBody');
  const dots = [...document.querySelectorAll('.dots button')];
  let curSeg = -1;
  function setCaption(t) {
    let i = 0;
    for (let k = 0; k < SEGS.length; k++) if (t >= SEGS[k].at) i = k;
    if (i === curSeg) return;
    curSeg = i;
    capStep.textContent = SEGS[i].step; capTitle.textContent = SEGS[i].title; capBody.textContent = SEGS[i].body;
    dots.forEach((d, k) => { d.classList.toggle('on', k === i); d.setAttribute('aria-pressed', String(k === i)); });
  }

  let playing = !reduce, start = performance.now(), pausedAt = 0, onScreen = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      const v = es[0].isIntersecting;
      if (v && !onScreen) start = performance.now() - pausedAt * 1000;
      onScreen = v;
    }).observe(cv);
  }
  function seek(t) {
    // 往回跳要重畫迷霧
    if (t < revealedTo * (T.walkEnd - T.walkStart) + T.walkStart) resetFog();
    start = performance.now() - t * 1000; pausedAt = t;
    frame(t); setCaption(t);
  }
  function loop(now) {
    if (playing && onScreen) {
      let t = (now - start) / 1000;
      if (t >= T.loop) { resetFog(); start = now; t = 0; }
      frame(t); setCaption(t);
      pausedAt = t;
    }
    requestAnimationFrame(loop);
  }
  const btnPlay = document.getElementById('btnPlay');
  btnPlay.onclick = () => {
    playing = !playing;
    if (playing) start = performance.now() - pausedAt * 1000;
    btnPlay.textContent = playing ? '暫停' : '播放';
  };
  document.getElementById('btnReplay').onclick = () => { resetFog(); seek(0); playing = true; btnPlay.textContent = '暫停'; };
  dots.forEach((d, k) => d.onclick = () => {
    const t = [0.4, T.walkStart + 1.8, 5.6, T.zoomEnd + 0.6][k];
    resetFog(); seek(t);
  });

  resetFog();
  const go = () => {
    if (reduce) { btnPlay.textContent = '播放'; seek(T.zoomEnd + 0.8); }
    else seek(0);
    requestAnimationFrame(loop);
  };
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(go, go);
  addEventListener('resize', () => frame(pausedAt));
})();
