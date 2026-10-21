import * as store from './store.js';
import { loadTaiwan, loadWorld, lookup, needWorld, taiwanCounties, TW_ORDER, loadAdmin1, admin1Of, admin1Count, worldReady, zhCountry } from './regions.js';
import { pointsFromPhotos, pointsFromGpx, pointsFromKml, pointsFromTimelineJson } from './importer.js';
import { tripImage } from './journal.js';
import * as social from './social.js';
import { state, reveal, revealPath, rebuild, serialize, load, km2, totalKm2, distM, homeRegion, computeTrips } from './model.js';
import { createFog } from './fog.js';

const BASE = new URL('.', location.href).href;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const WALK_R = 60;      // 走路時解開半徑（公尺）
const RIDE_R = 25;      // 騎車、開車時只解開一條細線
const MAX_SPEED = 45;   // 超過約 160 km/h（高鐵、飛機）不解鎖
const MAX_ACC = 70;     // GPS 誤差超過 70 公尺不解鎖

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v10h16V10"></path><path d="M3 10l2-6h14l2 6c0 1.7-1.3 3-3 3s-3-1.3-3-3c0 1.7-1.3 3-3 3s-3-1.3-3-3c0 1.7-1.3 3-3 3s-3-1.3-3-3z"></path><path d="M10 20v-5h4v5"></path></svg>',
  food: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18a9 9 0 0 1-18 0z"></path><path d="M8 8c0-1.5 1-2 1-3.5M12 8c0-1.5 1-2 1-3.5M16 8c0-1.5 1-2 1-3.5"></path></svg>',
  goods: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>',
  private: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"></path></svg>'
};
const CATS = [
  { id: 'shop', label: '店家' }, { id: 'food', label: '飲食' },
  { id: 'goods', label: '商品' }, { id: 'private', label: '私人地點' }
];
const VIS = [{ id: 'me', label: '只有自己' }, { id: 'friends', label: '好友' }, { id: 'public', label: '公開' }];
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[0];
const visOf = (id) => VIS.find((v) => v.id === id) || VIS[0];

let map, fog;
let myPos = null;        // 目前位置 {a, o, acc, t}
let lastFix = null;      // 上一個拿來解鎖的點
let watchId = null;
let wakeLock = null;
let meMarker = null;
const pinMarkers = new Map();
let currentTab = 'map';
let recFilter = 'all';
let clearArmed = false;
const expandedCountries = new Set();

// ---------- 格式 ----------
function fmtKm2(v) {
  if (v === 0) return '0 km²';
  if (v < 0.01) return '<0.01 km²';
  return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' km²';
}
function fmtPct(v) {
  if (v <= 0) return '0%';
  if (v < 0.01) return '<0.01%';
  return (v < 1 ? v.toFixed(2) : v.toFixed(1)) + '%';
}
function fmtDate(t, withYear) {
  const d = new Date(t);
  return (withYear ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate();
}
function fmtDay(t) {
  const d = new Date(t);
  const wk = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${wk}）`;
}
function regionLabel(c, k) { return c ? `${c} · ${k}` : (k || '未知地區'); }

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- 儲存 ----------
let saveTimer = 0;
function saveFogSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFogNow, 2500);
}
function saveFogNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  return store.set('fog', serialize());
}
const saveRecords = () => store.set('records', state.records);
const saveSettings = () => store.set('settings', state.settings);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) saveFogNow();
  if (document.visibilityState === 'visible' && watchId !== null) requestWake();
});
window.addEventListener('pagehide', () => { if (saveTimer) saveFogNow(); });

// ---------- 地圖 ----------
function zhLabels() {
  const layers = map.getStyle().layers || [];
  for (const l of layers) {
    if (l.type !== 'symbol' || !l.layout || !l.layout['text-field']) continue;
    if (JSON.stringify(l.layout['text-field']).includes('ref')) continue;
    try {
      map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name']]);
    } catch (e) { /* 某些圖層不支援 */ }
  }
}

function watercolor() {
  const layers = map.getStyle().layers || [];
  const set = (id, p, v) => { try { map.setPaintProperty(id, p, v); } catch (e) { /* ignore */ } };
  for (const l of layers) {
    const id = l.id.toLowerCase();
    if (l.type === 'background') set(l.id, 'background-color', '#F1E4C9');
    else if (l.type === 'fill') {
      if (/water|ocean|lake|river/.test(id)) { set(l.id, 'fill-color', '#8DB2CE'); set(l.id, 'fill-opacity', 0.9); }
      else if (/park|wood|forest|grass|scrub|green|cemetery|golf|pitch|landcover/.test(id)) { set(l.id, 'fill-color', '#A6C391'); set(l.id, 'fill-opacity', 0.75); }
      else if (/building/.test(id)) set(l.id, 'fill-color', '#E5C9A4');
      else if (/sand|beach/.test(id)) set(l.id, 'fill-color', '#F0D9A8');
      else set(l.id, 'fill-color', '#EEDCBD');
    } else if (l.type === 'fill-extrusion') {
      try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch (e) { /* ignore */ }
    } else if (l.type === 'line') {
      if (/water|river|stream|canal/.test(id)) set(l.id, 'line-color', '#7AA6C7');
      else if (/boundary|admin/.test(id)) set(l.id, 'line-color', '#B38660');
      else if (/rail/.test(id)) set(l.id, 'line-color', '#B9A487');
      else if (/casing/.test(id)) set(l.id, 'line-color', '#D6B48A');
      else if (/road|highway|street|path|bridge|tunnel|motorway|trunk|primary|secondary|tertiary|minor|service|track/.test(id)) set(l.id, 'line-color', '#FBF1DC');
    } else if (l.type === 'symbol') {
      set(l.id, 'text-color', '#4A3826');
      set(l.id, 'text-halo-color', '#F6EBD6');
    }
  }
}

function applyStyle() {
  zhLabels();
  if (state.settings.mapMode === 'paint') watercolor();
}

function setMapMode(mode) {
  state.settings.mapMode = mode;
  saveSettings();
  $('modeReal').classList.toggle('on', mode === 'real');
  $('modePaint').classList.toggle('on', mode === 'paint');
  $('modeReal').setAttribute('aria-pressed', String(mode === 'real'));
  $('modePaint').setAttribute('aria-pressed', String(mode === 'paint'));
  $('map').classList.toggle('paint', mode === 'paint');
  if (map) map.setStyle(STYLE_URL, { diff: false });
}

function initMap() {
  let center = [120.95, 23.65], zoom = 6.6;
  const last = state.stamps[state.stamps.length - 1];
  if (last) { center = [last.o, last.a]; zoom = 14.5; }
  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URL,
    center, zoom,
    attributionControl: { compact: true },
    localIdeographFontFamily: "'PingFang TC', 'Noto Sans TC', 'Heiti TC', sans-serif",
    minZoom: 1,
    pitchWithRotate: false,
    dragRotate: false
  });
  map.touchZoomRotate.disableRotation();
  // 拉遠看世界時，先把紀錄圖釘藏起來，畫面比較乾淨
  const pinVis = () => $('map').classList.toggle('far', map.getZoom() < 9);
  map.on('zoom', pinVis);
  pinVis();
  map.on('style.load', applyStyle);
  map.on('error', (e) => { if (e && e.error && /Failed to fetch|NetworkError/.test(String(e.error.message))) toast('地圖載入失敗，請確認網路連線'); });
  fog = createFog(map, () => state.stamps);
  if (location.search.includes('debug')) window.__app = { map, fog };
  map.on('click', (e) => {
    if (state.settings.test && !picking) simulateWalk(e.lngLat.lat, e.lngLat.lng);
  });
}

function updateMe() {
  if (!myPos) return;
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me';
    el.setAttribute('aria-label', '我的位置');
    meMarker = new maplibregl.Marker({ element: el }).setLngLat([myPos.o, myPos.a]).addTo(map);
  } else meMarker.setLngLat([myPos.o, myPos.a]);
  meMarker.getElement().classList.toggle('weak', myPos.acc > MAX_ACC);
}

function renderPins() {
  for (const m of pinMarkers.values()) m.remove();
  pinMarkers.clear();
  for (const r of state.records) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin cat-' + r.cat;
    el.setAttribute('aria-label', catOf(r.cat).label + '：' + r.name);
    el.innerHTML = ICON[r.cat] || ICON.shop;
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail(r.id); });
    const m = new maplibregl.Marker({ element: el, anchor: 'bottom-left', offset: [-3, 3] }).setLngLat([r.o, r.a]).addTo(map);
    pinMarkers.set(r.id, m);
  }
}

// ---------- 迷霧解鎖 ----------
async function ensureWorld(lat, lng) {
  if (!needWorld(lat, lng)) return;
  const w = await loadWorld(BASE);
  if (!w) return;
  const reg = lookup(lat, lng);
  if (reg.en) await loadAdmin1(BASE, reg.en);
  fixForeign();
}

// 國界或某國的行政區剛載入：補上之前判斷不出地區的足跡和紀錄（同一批資料只做一次）
let foreignVersion = '';
function fixForeign(force) {
  const v = (worldReady() ? 1 : 0) + ':' + admin1Count();
  if (!force && v === foreignVersion) return;
  foreignVersion = v;
  const needs = (x) => !x.k || (!x.c && x.k !== '台灣' && admin1Of(x.k));
  if (state.stamps.some(needs)) { rebuild(); saveFogSoon(); fog.redraw(); }
  let changed = false;
  for (const r of state.records) {
    if (!needs(r)) continue;
    const g = lookup(r.a, r.o);
    if (g.country !== r.k || g.county !== r.c) { r.k = g.country; r.c = g.county; changed = true; }
  }
  if (changed) { saveRecords(); }
  updateTop();
  if (currentTab === 'badges') renderBadges();
}

// 啟動或匯入後：載入所有到過國家的行政區
async function loadForeignFor(points) {
  const foreign = points.filter((p) => needWorld(p.a, p.o));
  if (!foreign.length) return;
  const w = await loadWorld(BASE);
  if (!w) return;
  const seen = new Set(), cells = new Set();
  for (const p of foreign) {
    const ck = Math.round(p.a * 20) + ',' + Math.round(p.o * 20);   // 約 5 公里檢查一次就夠
    if (cells.has(ck)) continue;
    cells.add(ck);
    const g = lookup(p.a, p.o);
    if (g.en && !seen.has(g.en)) { seen.add(g.en); await loadAdmin1(BASE, g.en); }
  }
}

// ---------- 拉遠時的世界地圖：去過的國家、地區亮燈 ----------
let outline = null;
let ovSig = '';

function geomBbox(g) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// 地名放在面積最大那塊陸地的中央
function labelPoint(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best = null, ba = -1;
  for (const p of polys) {
    const b = geomBbox({ type: 'Polygon', coordinates: p });
    const a = (b[2] - b[0]) * (b[3] - b[1]);
    if (a > ba) { ba = a; best = b; }
  }
  return best ? [(best[0] + best[2]) / 2, (best[1] + best[3]) / 2] : null;
}

async function loadOutline() {
  if (outline) return;
  try {
    const arr = await (await fetch(BASE + 'data/world-outline.json')).json();
    outline = arr.map((c) => ({ name: c.name, zh: zhCountry(c.name), g: c.g, bbox: geomBbox(c.g), label: labelPoint(c.g) }));
  } catch (e) { return; }
  updateOverlay(true);
}

function regionItems(list, lit) {
  return list.map((r) => {
    if (!r.label) r.label = labelPoint(r.g);
    return { name: r.name, g: r.g, bbox: r.bbox || geomBbox(r.g), label: r.label, lit: lit(r.name) };
  });
}

function updateOverlay(force) {
  if (!fog || !fog.setOverlay) return;
  const sig = [...state.byCountry.keys()].sort().join(',') + '|' + [...state.byCounty.keys()].sort().join(',') + '|' + admin1Count() + '|' + (outline ? 1 : 0);
  if (!force && sig === ovSig) return;
  ovSig = sig;
  const has = (n) => state.byCounty.has(n);
  let regions = regionItems(taiwanCounties(), has);
  for (const k of state.byCountry.keys()) {
    if (k === '台灣') continue;
    const list = admin1Of(k);
    if (list) regions = regions.concat(regionItems(list, has));
  }
  const countries = outline ? outline.map((c) => ({ ...c, lit: state.byCountry.has(c.zh) })) : [];
  fog.setOverlay({ countries, regions });
}

// 地區面積：台灣用縣市資料，國外用該國的行政區資料
function regionArea(county, country) {
  if (!county) return 0;
  const list = country === '台灣' ? taiwanCounties() : admin1Of(country);
  const info = list && list.find((c) => c.name === county);
  return info ? info.area : 0;
}

function snapshotRegions() {
  return { countries: new Set(state.byCountry.keys()), counties: new Set(state.byCounty.keys()) };
}

function announceFirsts(before) {
  for (const k of state.byCountry.keys()) {
    if (!before.countries.has(k)) { toast(`第一次來到${k}！國家徽章已點亮`, 4200); return; }
  }
  for (const c of state.byCounty.keys()) {
    if (!before.counties.has(c)) { toast(`第一次來到${c}，台灣徽章多了一格`, 4200); return; }
  }
}

function handleFix(lat, lng, acc, speed, t) {
  myPos = { a: lat, o: lng, acc, t };
  updateMe();
  if (acc > MAX_ACC) {
    social.onPosition(myPos);
    updateTop(`GPS 訊號較弱（誤差約 ${Math.round(acc)} 公尺），到空曠處就會繼續解鎖`);
    return;
  }
  let sp = speed;
  if ((sp == null || Number.isNaN(sp) || sp < 0) && lastFix) {
    const dt = (t - lastFix.t) / 1000;
    sp = dt > 0 ? distM(lastFix.a, lastFix.o, lat, lng) / dt : 0;
  }
  if (sp > MAX_SPEED) { lastFix = { a: lat, o: lng, t }; updateTop('移動速度很快（高鐵或飛機），這段路不解鎖'); return; }
  const r = sp > 7 ? RIDE_R : WALK_R;
  const before = snapshotRegions();
  if (lastFix && t - lastFix.t < 10 * 60 * 1000 && distM(lastFix.a, lastFix.o, lat, lng) < 500) {
    revealPath(lastFix.a, lastFix.o, lat, lng, r, t);
  } else {
    reveal(lat, lng, r, t);
  }
  lastFix = { a: lat, o: lng, t };
  announceFirsts(before);
  ensureWorld(lat, lng);
  saveFogSoon();
  fog.redraw();
  updateTop();
  social.onPosition(myPos);
  social.stampsChanged();
}

function simulateWalk(lat, lng) {
  const now = Date.now();
  const before = snapshotRegions();
  if (myPos && distM(myPos.a, myPos.o, lat, lng) < 8000) {
    revealPath(myPos.a, myPos.o, lat, lng, WALK_R, now);
  } else {
    reveal(lat, lng, WALK_R, now);
  }
  myPos = { a: lat, o: lng, acc: 5, t: now };
  lastFix = { a: lat, o: lng, t: now };
  updateMe();
  announceFirsts(before);
  ensureWorld(lat, lng);
  saveFogSoon();
  fog.redraw();
  updateTop();
  social.onPosition(myPos);
  social.stampsChanged();
}

async function requestWake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { wakeLock = null; }
}

function startExplore() {
  if (!('geolocation' in navigator)) { toast('這個瀏覽器不能定位'); return; }
  let first = true;
  watchId = navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    handleFix(c.latitude, c.longitude, c.accuracy, c.speed, p.timestamp || Date.now());
    if (first) { first = false; map.flyTo({ center: [c.longitude, c.latitude], zoom: Math.max(map.getZoom(), 15.5), duration: 900 }); }
  }, (err) => {
    if (err.code === 1) {
      stopExplore();
      toast('沒有定位權限。請到 iPhone 的「設定 › 隱私權與安全性 › 定位服務 › Safari 網站」改成「使用 App 期間」', 7000);
    } else if (err.code === 3) {
      updateTop('還在找 GPS 訊號，請稍等或到戶外');
    } else {
      updateTop('暫時拿不到位置，會自動再試');
    }
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  requestWake();
  $('btnExplore').classList.add('live');
  $('exploreLabel').textContent = '探索中 · 點一下停止';
  updateTop('探索中：請保持畫面開啟，走過的地方會即時解開');
}

function stopExplore() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastFix = null;
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  $('btnExplore').classList.remove('live');
  $('exploreLabel').textContent = '開始探索';
  saveFogNow();
  updateTop();
}

// ---------- 上方資訊卡 ----------
function updateTop(note) {
  const total = totalKm2();
  const pos = myPos || (state.stamps.length ? { a: state.stamps[state.stamps.length - 1].a, o: state.stamps[state.stamps.length - 1].o } : null);
  const reg = pos ? lookup(pos.a, pos.o) : null;
  const home = homeRegion();
  if (reg && reg.county) {
    const v = state.byCounty.get(reg.county);
    const a = v ? km2(v.cells) : 0;
    const area = regionArea(reg.county, reg.country);
    $('placeName').textContent = (myPos ? '' : '上次在 ') + regionLabel(reg.county, reg.country);
    $('areaHere').textContent = fmtKm2(a);
    $('areaSub').textContent = note || `解開了${reg.county}的 ${fmtPct(area ? a / area * 100 : 0)} · 全部足跡 ${fmtKm2(total)}`;
  } else if (reg && reg.country) {
    const v = state.byCountry.get(reg.country);
    $('placeName').textContent = (myPos ? '' : '上次在 ') + reg.country;
    $('areaHere').textContent = fmtKm2(v ? km2(v.cells) : 0);
    $('areaSub').textContent = note || `在${reg.country}解開的範圍 · 全部足跡 ${fmtKm2(total)}`;
  } else {
    $('placeName').textContent = pos ? '目前位置' : '尚未定位';
    $('areaHere').textContent = fmtKm2(total);
    $('areaSub').textContent = note || (total > 0 ? '全部足跡' : '按下「開始探索」後，走過的地方會從迷霧中解開');
  }
  const rk = reg ? (reg.county || reg.country) : null;
  const trips = computeTrips();
  $('tripChip').hidden = !(rk && home && rk !== home && trips[0] && trips[0].ongoing);
  updateOverlay();
}

// ---------- 面板 ----------
function setTab(tab) {
  currentTab = tab;
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.tab === tab);
  if (tab === 'map') { $('sheet').hidden = true; return; }
  $('sheet').hidden = false;
  renderSheet();
  $('sheetBody').scrollTop = 0;
}

function renderSheet() {
  if (currentTab === 'records') renderRecords();
  else if (currentTab === 'trips') renderTrips();
  else if (currentTab === 'badges') renderBadges();
  else if (currentTab === 'friends') social.render();
}

function recCard(r) {
  const cat = catOf(r.cat);
  const stars = r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '';
  return `<button type="button" class="rec" data-rec="${esc(r.id)}">
    <span class="rec-thumb" data-photo="${esc(r.photo || '')}">${ICON[r.cat] || ''}</span>
    <span class="rec-main">
      <span class="rec-name">${esc(r.name)}</span>
      <span class="rec-meta"><span class="tag cat-${r.cat}">${ICON[r.cat]}${cat.label}</span>${stars ? `<span class="stars-ro" aria-label="${r.rating} 顆星">${stars}</span>` : ''}${r.price ? `<span>${esc(r.price)}</span>` : ''}${r.demo ? '<span class="tag cat-goods">範例</span>' : ''}</span>
      ${r.note ? `<span class="rec-note">${esc(r.note)}</span>` : ''}
      <span class="rec-meta"><span>${esc(regionLabel(r.c, r.k))}</span><span>${visOf(r.vis).label}</span></span>
    </span>
  </button>`;
}

async function fillThumbs(root) {
  for (const el of root.querySelectorAll('[data-photo]')) {
    const id = el.dataset.photo;
    if (!id) continue;
    const blob = await store.getPhoto(id);
    if (!blob) continue;
    const img = document.createElement('img');
    img.className = 'rec-thumb';
    img.alt = '';
    img.src = URL.createObjectURL(blob);
    el.replaceWith(img);
  }
}

function bindRecClicks(root) {
  for (const b of root.querySelectorAll('[data-rec]')) b.addEventListener('click', () => openDetail(b.dataset.rec));
}

function renderRecords() {
  $('sheetTitle').textContent = '紀錄';
  const body = $('sheetBody');
  if (!state.records.length) {
    body.innerHTML = `<div class="card empty">
      <div class="card-title">還沒有紀錄</div>
      <p class="muted">吃到好吃的、逛到喜歡的店、找到私房景點，按「記錄」存下來。<br>每一筆都會釘在地圖上，也會收進當趟旅程。</p>
      <div class="row" style="justify-content:center;flex-wrap:wrap">
        <button type="button" class="btn-small" id="emptyAdd">新增第一筆紀錄</button>
        <button type="button" class="btn-small" id="emptyDemo">載入台南範例</button>
      </div>
    </div>`;
    $('emptyAdd').onclick = () => openForm();
    $('emptyDemo').onclick = loadDemo;
    return;
  }
  const counts = { all: state.records.length };
  for (const r of state.records) counts[r.cat] = (counts[r.cat] || 0) + 1;
  const chips = [{ id: 'all', label: '全部' }, ...CATS].map((c) =>
    `<button type="button" data-f="${c.id}" class="${recFilter === c.id ? 'on' : ''}" aria-pressed="${recFilter === c.id}">${c.label} ${counts[c.id] || 0}</button>`).join('');
  const list = state.records.filter((r) => recFilter === 'all' || r.cat === recFilter).sort((a, b) => b.t - a.t);
  let html = `<div class="chips filter-chips">${chips}</div>`;
  let lastDay = '';
  for (const r of list) {
    const day = fmtDay(r.t);
    if (day !== lastDay) { html += `<div class="group-label">${day}</div>`; lastDay = day; }
    html += recCard(r);
  }
  if (!list.length) html += '<p class="muted">這個類別還沒有紀錄。</p>';
  body.innerHTML = html;
  for (const b of body.querySelectorAll('[data-f]')) b.onclick = () => { recFilter = b.dataset.f; renderRecords(); };
  bindRecClicks(body);
  fillThumbs(body);
}

async function openDetail(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r) return;
  currentTab = 'detail';
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.tab === 'records');
  $('sheet').hidden = false;
  $('sheetTitle').textContent = catOf(r.cat).label;
  const stars = r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '';
  $('sheetBody').innerHTML = `
    <div id="detailPhoto"></div>
    <div class="stack">
      <div class="card-title" style="font-size:24px">${esc(r.name)}</div>
      <div class="rec-meta"><span class="tag cat-${r.cat}">${ICON[r.cat]}${catOf(r.cat).label}</span>${stars ? `<span class="stars-ro" aria-label="${r.rating} 顆星">${stars}</span>` : ''}${r.price ? `<span>${esc(r.price)}</span>` : ''}${r.demo ? '<span class="tag cat-goods">範例</span>' : ''}</div>
    </div>
    ${r.note ? `<p style="margin:0;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.note)}</p>` : ''}
    <div class="card">
      <div class="row"><span class="muted">地點</span><span>${esc(regionLabel(r.c, r.k))}</span></div>
      <div class="row"><span class="muted">時間</span><span>${fmtDay(r.t)}</span></div>
      <div class="row"><span class="muted">誰看得到</span><span>${visOf(r.vis).label}</span></div>
    </div>
    <div class="row" style="gap:10px">
      <button type="button" class="btn-ghost" style="flex:1" id="dBack">回到列表</button>
      <button type="button" class="btn-ghost" style="flex:1" id="dMap">在地圖上看</button>
      <button type="button" class="btn-primary" id="dEdit">編輯</button>
    </div>`;
  $('dBack').onclick = () => setTab('records');
  $('dMap').onclick = () => { setTab('map'); map.flyTo({ center: [r.o, r.a], zoom: Math.max(map.getZoom(), 16), duration: 800 }); };
  $('dEdit').onclick = () => openForm(r.id);
  if (r.photo) {
    const blob = await store.getPhoto(r.photo);
    if (blob && $('detailPhoto')) $('detailPhoto').innerHTML = `<img class="detail-photo" alt="${esc(r.name)}的照片" src="${URL.createObjectURL(blob)}">`;
  }
}

function renderTrips() {
  $('sheetTitle').textContent = '旅程';
  const body = $('sheetBody');
  const home = homeRegion();
  const trips = computeTrips();
  const opts = ['<option value="">自動判斷</option>']
    .concat(TW_ORDER.map((c) => `<option value="${c}" ${state.settings.home === c ? 'selected' : ''}>${c}</option>`))
    .concat([...state.byCountry.keys()].filter((k) => k !== '台灣').map((k) => `<option value="${esc(k)}" ${state.settings.home === k ? 'selected' : ''}>${esc(k)}</option>`))
    .join('');
  let html = `<div class="card">
    <div class="row"><div class="stack"><b>常住地</b><span class="muted">離開這裡就會自動算成一趟旅程</span></div>
    <select id="homeSel" aria-label="常住地">${opts}</select></div>
    <span class="muted">目前：${esc(home || '還沒有足跡')}${state.settings.home ? '' : (home ? '（依足跡最多的地方自動判斷）' : '')}</span>
  </div>
  <div class="card">
    <div class="stack"><b>補登足跡</b><span class="muted">忘了開探索也沒關係：選旅途中拍的照片，會用照片裡的位置解開迷霧；也能匯入運動手錶、Strava 的 GPX，或 Google 地圖時間軸。</span></div>
    <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
      <label class="btn-small" for="impPhotos" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="9" cy="10" r="2"></circle><path d="M21 16l-5-5-8 8"></path></svg>從照片補登</label>
      <input type="file" id="impPhotos" accept="image/*,.heic,.heif" multiple class="visually-hidden">
      <label class="btn-small" for="impTrack" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M4 18c3 0 3-6 6-6s3 4 6 4 3-8 4-10"></path></svg>匯入軌跡檔</label>
      <input type="file" id="impTrack" accept=".gpx,.kml,.json,application/gpx+xml,application/json,application/vnd.google-earth.kml+xml" class="visually-hidden">
    </div>
  </div>`;
  if (!trips.length) {
    html += `<div class="card empty">
      <div class="card-title">還沒有旅程</div>
      <p class="muted">離開常住地、開始探索，就會自動建立一趟旅程。<br>回來之後，這裡會整理出解開的範圍、走過的距離與當趟紀錄。</p>
      ${state.stamps.length ? '' : '<button type="button" class="btn-small" id="tripDemo">載入台南範例</button>'}
    </div>`;
  }
  trips.forEach((tr, i) => {
    const days = Math.max(1, Math.round((new Date(tr.end).setHours(0, 0, 0, 0) - new Date(tr.start).setHours(0, 0, 0, 0)) / 86400000) + 1);
    html += `<button type="button" class="card trip ${tr.ongoing ? 'ongoing' : ''}" data-trip="${i}">
      <div class="row"><span class="muted">${fmtDate(tr.start, true)}${days > 1 ? ' – ' + fmtDate(tr.end) : ''} · ${days} 天</span>${tr.ongoing ? '<span class="chip">進行中</span>' : ''}</div>
      <div class="card-title">${esc(tr.regions.slice(0, 3).join(' · '))}${tr.regions.length > 3 ? ' 等' : ''}</div>
      <div class="stats">
        <div class="stat"><b>${fmtKm2(tr.km2).replace(' km²', '')}</b><small>km² 解開</small></div>
        <div class="stat"><b>${tr.km.toFixed(1)}</b><small>km 移動</small></div>
        <div class="stat"><b>${tr.records.length}</b><small>筆紀錄</small></div>
      </div>
    </button>`;
  });
  body.innerHTML = html;
  $('homeSel').onchange = (e) => { state.settings.home = e.target.value || null; saveSettings(); renderTrips(); updateTop(); };
  $('impPhotos').onchange = importPhotos;
  $('impTrack').onchange = importTrack;
  if ($('tripDemo')) $('tripDemo').onclick = loadDemo;
  for (const b of body.querySelectorAll('[data-trip]')) b.onclick = () => openTrip(trips[+b.dataset.trip]);
}

function openTrip(tr) {
  currentTab = 'trip';
  $('sheetTitle').textContent = '旅程';
  const days = Math.max(1, Math.round((new Date(tr.end).setHours(0, 0, 0, 0) - new Date(tr.start).setHours(0, 0, 0, 0)) / 86400000) + 1);
  let html = `<div class="stack">
      <div class="card-title" style="font-size:26px">${esc(tr.regions.join(' · '))}</div>
      <span class="muted">${fmtDay(tr.start)}${days > 1 ? ' – ' + fmtDay(tr.end) : ''}</span>
    </div>
    <div class="stats">
      <div class="stat"><b>${fmtKm2(tr.km2).replace(' km²', '')}</b><small>km² 解開</small></div>
      <div class="stat"><b>${tr.km.toFixed(1)}</b><small>km 移動</small></div>
      <div class="stat"><b>${days}</b><small>天</small></div>
    </div>
    <div class="row" style="gap:10px">
      <button type="button" class="btn-ghost" style="flex:1" id="tBack">所有旅程</button>
      <button type="button" class="btn-ghost" style="flex:1" id="tMap">在地圖上看</button>
    </div>
    <button type="button" class="btn-primary" id="tJournal">做成手帳分享圖</button>
    <div class="group-label">這趟的紀錄（${tr.records.length}）</div>`;
  if (!tr.records.length) html += '<p class="muted">這趟還沒有紀錄。</p>';
  for (const r of tr.records.slice().sort((a, b) => a.t - b.t)) html += recCard(r);
  $('sheetBody').innerHTML = html;
  $('sheetBody').scrollTop = 0;
  $('tBack').onclick = () => setTab('trips');
  $('tMap').onclick = () => { setTab('map'); map.fitBounds(tr.bounds, { padding: { top: 170, bottom: 190, left: 40, right: 40 }, maxZoom: 16, duration: 900 }); };
  $('tJournal').onclick = () => openJournal(tr);
  bindRecClicks($('sheetBody'));
  fillThumbs($('sheetBody'));
}

function renderBadges() {
  $('sheetTitle').textContent = '徽章';
  const body = $('sheetBody');
  const tw = state.byCountry.get('台灣');
  const visitedCounties = TW_ORDER.filter((c) => state.byCounty.has(c));
  const counties = taiwanCounties();
  const others = [...state.byCountry.entries()].filter(([k]) => k !== '台灣').sort((a, b) => a[1].first - b[1].first);
  let html = `<div class="stats">
    <div class="stat"><b>${state.byCountry.size}</b><small>個國家</small></div>
    <div class="stat"><b>${visitedCounties.length}/22</b><small>台灣縣市</small></div>
    <div class="stat"><b>${fmtKm2(totalKm2()).replace(' km²', '')}</b><small>km² 足跡</small></div>
  </div>`;
  html += `<div class="card ${tw ? '' : 'dashed'}">
    <div class="row" style="justify-content:flex-start;gap:14px">
      <div class="stamp ${tw ? '' : 'locked'}" style="color:var(--clay)" aria-hidden="true">台</div>
      <div class="stack" style="flex:1">
        <div class="row"><div class="card-title">台灣</div><span class="muted">縣市 ${visitedCounties.length} / 22</span></div>
        <div class="bar" aria-hidden="true"><i style="width:${visitedCounties.length / 22 * 100}%"></i></div>
        <span class="muted">${tw ? '第一次足跡 ' + fmtDate(tw.first, true) : '還沒有足跡'}</span>
      </div>
    </div>
    <div class="county-grid">`;
  for (const name of TW_ORDER) {
    const v = state.byCounty.get(name);
    const info = counties.find((c) => c.name === name);
    if (v) {
      const a = km2(v.cells);
      html += `<div class="county on"><b>${name}</b><small>${fmtKm2(a)} · ${fmtPct(info ? a / info.area * 100 : 0)}</small></div>`;
    } else {
      html += `<div class="county locked"><b>${name}</b><small>還在迷霧中</small></div>`;
    }
  }
  html += '</div></div>';
  const toLoad = [];
  for (const [k, v] of others) {
    const list = admin1Of(k);
    const seenRegs = list ? list.filter((r) => state.byCounty.has(r.name)) : [];
    if (!list) toLoad.push(k);
    html += `<div class="card"><div class="row" style="justify-content:flex-start;gap:14px">
      <div class="stamp" style="color:var(--sea)" aria-hidden="true">${esc(k.slice(0, 1))}</div>
      <div class="stack" style="flex:1">
        <div class="row"><div class="card-title">${esc(k)}</div><span class="muted">${list ? `地區 ${seenRegs.length} / ${list.length}` : fmtKm2(km2(v.cells))}</span></div>
        ${list ? `<div class="bar" aria-hidden="true"><i style="width:${seenRegs.length / list.length * 100}%;background:var(--sea)"></i></div>` : ''}
        <span class="muted">第一次到訪 ${fmtDate(v.first, true)} · ${fmtKm2(km2(v.cells))}</span>
      </div></div>`;
    if (list) {
      const open = expandedCountries.has(k);
      const sorted = seenRegs.slice().sort((a, b) => state.byCounty.get(b.name).cells - state.byCounty.get(a.name).cells);
      const rest = list.filter((r) => !state.byCounty.has(r.name));
      html += '<div class="county-grid">';
      for (const r of sorted) {
        const a = km2(state.byCounty.get(r.name).cells);
        html += `<div class="county on sea"><b>${esc(r.name)}</b><small>${fmtKm2(a)} · ${fmtPct(r.area ? a / r.area * 100 : 0)}</small></div>`;
      }
      if (open) for (const r of rest) html += `<div class="county locked"><b>${esc(r.name)}</b><small>還在迷霧中</small></div>`;
      html += '</div>';
      if (rest.length) html += `<button type="button" class="btn-small" data-expand="${esc(k)}">${open ? '只看去過的' : `顯示其他 ${rest.length} 個地區`}</button>`;
    } else {
      html += '<span class="muted">正在載入地區資料…</span>';
    }
    html += '</div>';
  }
  if (!others.length) {
    html += `<div class="card dashed"><div class="row" style="justify-content:flex-start;gap:14px">
      <div class="stamp locked" aria-hidden="true">?</div>
      <div class="stack"><div class="card-title" style="color:var(--ink-2)">下一個國家</div>
      <span class="muted">出國時開始探索，就會點亮該國的徽章</span></div></div></div>`;
  }
  // 設定
  html += `<div class="group-label">設定與資料</div>
  <div class="card settings-list">
    ${native ? bgRow() : ''}
    <div class="row"><div class="stack"><b>測試模式</b><span class="muted">在家也能試：點地圖就模擬走到那裡</span></div>
      <label class="switch"><input type="checkbox" id="testSw" ${state.settings.test ? 'checked' : ''} aria-label="測試模式"><i></i></label></div>
    <div class="row"><div class="stack"><b>範例資料</b><span class="muted">一趟台南小旅行的足跡與紀錄，隨時可以移除</span></div>
      <button type="button" class="btn-small" id="demoBtn">${hasDemo() ? '移除範例' : '載入範例'}</button></div>
    <div class="row"><div class="stack"><b>備份</b><span class="muted">資料只存在這支手機的瀏覽器裡，記得定期備份</span></div>
      <div class="row" style="gap:6px"><button type="button" class="btn-small" id="expBtn">匯出</button>
      <label class="btn-small" for="impFile" style="display:inline-flex;align-items:center;cursor:pointer">匯入</label>
      <input type="file" id="impFile" accept="application/json,.json" class="visually-hidden"></div></div>
    <div class="row"><div class="stack"><b>清除所有資料</b><span class="muted">足跡、紀錄、照片都會刪除，無法復原</span></div>
      <button type="button" class="btn-small" id="clearBtn" style="color:#9E3A2A">清除</button></div>
  </div>
  <p class="muted" style="text-align:center"><a href="about.html">關於霧旅</a> · 霧旅 v0.6 · 地圖資料 © OpenStreetMap 貢獻者、OpenFreeMap</p>`;
  body.innerHTML = html;
  for (const b of body.querySelectorAll('[data-expand]')) b.onclick = () => {
    const k = b.dataset.expand;
    if (expandedCountries.has(k)) expandedCountries.delete(k); else expandedCountries.add(k);
    const y = body.scrollTop; renderBadges(); body.scrollTop = y;
  };
  if (toLoad.length) {
    const pts = state.stamps.filter((s) => toLoad.includes(s.k));
    loadForeignFor(pts).then(() => { if (currentTab === 'badges' && toLoad.some((k) => admin1Of(k))) { fixForeign(true); renderBadges(); } });
  }
  $('testSw').onchange = (e) => setTest(e.target.checked);
  if ($('bgSw')) $('bgSw').onchange = (e) => { nativePost({ type: 'bg-set', on: e.target.checked }); };
  if ($('bgSettings')) $('bgSettings').onclick = () => nativePost({ type: 'open-settings' });
  $('demoBtn').onclick = () => { hasDemo() ? removeDemo() : loadDemo(); };
  $('expBtn').onclick = exportData;
  $('impFile').onchange = importData;
  clearArmed = false;
  $('clearBtn').onclick = async () => {
    if (!clearArmed) { clearArmed = true; $('clearBtn').textContent = '再按一次確認'; return; }
    await store.clearAll();
    location.reload();
  };
}

function bgRow() {
  const st = bgState || { enabled: false, background: 'undetermined', foreground: 'undetermined' };
  let note;
  if (st.enabled) note = '開啟中：手機放口袋也會記錄，打開霧旅時自動解開迷霧';
  else if (st.background === 'denied' || (st.foreground === 'granted' && st.background !== 'granted' && st.background !== 'undetermined')) note = '需要把定位權限改成「永遠」：按「打開設定」› 位置 › 永遠';
  else note = '打開後，iPhone 會詢問定位權限，請選「永遠允許」';
  const needSettings = !st.enabled && st.background !== 'undetermined' && st.background !== 'granted';
  return `<div class="row"><div class="stack"><b>背景自動記錄</b><span class="muted">${note}</span>
      ${needSettings ? '<button type="button" class="btn-small" id="bgSettings" style="align-self:flex-start">打開設定</button>' : ''}</div>
    <label class="switch"><input type="checkbox" id="bgSw" ${st.enabled ? 'checked' : ''} aria-label="背景自動記錄"><i></i></label></div>`;
}

function setTest(on) {
  state.settings.test = on;
  saveSettings();
  $('testBanner').hidden = !on;
  if (on) toast('測試模式已開啟：回到地圖，點一下就會走過去');
}

// ---------- 新增 / 編輯紀錄 ----------
const form = { id: null, cat: 'food', rating: 0, vis: 'friends', photoBlob: null, photoChanged: false, loc: 'here', pick: null };
let picking = false;

function renderFormChips() {
  $('catChips').innerHTML = CATS.map((c) => `<button type="button" data-cat="${c.id}" class="${form.cat === c.id ? 'on' : ''}" aria-pressed="${form.cat === c.id}">${ICON[c.id]}${c.label}</button>`).join('');
  for (const b of $('catChips').querySelectorAll('button')) b.onclick = () => {
    form.cat = b.dataset.cat;
    if (form.cat === 'private' && !form.id) form.vis = 'me';
    renderFormChips();
  };
  $('visChips').innerHTML = VIS.map((v) => `<button type="button" data-vis="${v.id}" class="${form.vis === v.id ? 'on' : ''}" aria-pressed="${form.vis === v.id}">${v.label}</button>`).join('');
  for (const b of $('visChips').querySelectorAll('button')) b.onclick = () => { form.vis = b.dataset.vis; renderFormChips(); };
  $('stars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= form.rating ? 'on' : ''}" aria-label="${n} 顆星">${ICON.star}</button>`).join('');
  for (const b of $('stars').querySelectorAll('button')) b.onclick = () => { const n = +b.dataset.star; form.rating = form.rating === n ? 0 : n; renderFormChips(); };
}

function renderLoc() {
  const editing = !!form.id;
  $('locHere').textContent = editing ? '保留原本位置' : '我目前的位置';
  $('locHere').classList.toggle('on', form.loc === 'here');
  $('locCenter').classList.toggle('on', form.loc === 'pick');
  $('locHere').setAttribute('aria-pressed', String(form.loc === 'here'));
  $('locCenter').setAttribute('aria-pressed', String(form.loc === 'pick'));
  $('locCenter').textContent = form.pick ? '已在地圖上選好' : '在地圖上選';
  let hint;
  if (form.loc === 'pick' && form.pick) hint = '使用你在地圖上選的位置：' + regionLabel(lookup(form.pick.a, form.pick.o).county, lookup(form.pick.a, form.pick.o).country);
  else if (editing) hint = '位置不變。';
  else if (myPos && Date.now() - myPos.t < 10 * 60 * 1000) hint = '使用剛剛定位到的位置。';
  else hint = '目前沒有定位，會改用地圖中央的位置。也可以按「在地圖上選」。';
  $('locHint').textContent = hint;
}

async function openForm(id) {
  const r = id ? state.records.find((x) => x.id === id) : null;
  Object.assign(form, { id: r ? r.id : null, cat: r ? r.cat : 'food', rating: r ? r.rating || 0 : 0, vis: r ? r.vis : 'friends', photoBlob: null, photoChanged: false, loc: 'here', pick: null });
  $('formTitle').textContent = r ? '編輯紀錄' : '新增紀錄';
  $('fName').value = r ? r.name : '';
  $('fPrice').value = r ? r.price || '' : '';
  $('fNote').value = r ? r.note || '' : '';
  $('fPhoto').value = '';
  $('photoPreview').hidden = true;
  $('photoLabel').textContent = '拍照或選照片';
  $('btnDelete').hidden = !r;
  $('btnDelete').textContent = '刪除這筆';
  $('btnDelete').dataset.armed = '';
  $('fName').removeAttribute('aria-invalid');
  if (r && r.photo) {
    const blob = await store.getPhoto(r.photo);
    if (blob) { $('photoPreview').src = URL.createObjectURL(blob); $('photoPreview').hidden = false; $('photoLabel').textContent = '換一張'; }
  }
  renderFormChips();
  renderLoc();
  $('formSheet').hidden = false;
  if (!r) setTimeout(() => $('fName').focus(), 250);
}

function closeForm() { $('formSheet').hidden = true; }

function startPick() {
  picking = true;
  $('formSheet').hidden = true;
  $('sheet').hidden = true;
  $('crosshair').hidden = false;
  $('actions').innerHTML = `<button type="button" class="btn-record" id="pickCancel">取消</button>
    <button type="button" class="btn-explore" id="pickOk">用這個位置</button>`;
  $('pickCancel').onclick = () => endPick(false);
  $('pickOk').onclick = () => endPick(true);
  toast('移動地圖，讓圓圈對準要記錄的地方', 3500);
}

const ACTIONS_HTML = document.getElementById('actions').innerHTML;
function endPick(ok) {
  picking = false;
  $('crosshair').hidden = true;
  $('actions').innerHTML = ACTIONS_HTML;
  bindActions();
  if (watchId !== null) { $('btnExplore').classList.add('live'); $('exploreLabel').textContent = '探索中 · 點一下停止'; }
  if (ok) { const c = map.getCenter(); form.pick = { a: c.lat, o: c.lng }; form.loc = 'pick'; }
  $('formSheet').hidden = false;
  renderLoc();
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280;
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('讀不到這張圖片')); };
    img.src = url;
  });
}

async function onPhoto(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    form.photoBlob = await resizeImage(f);
    form.photoChanged = true;
    $('photoPreview').src = URL.createObjectURL(form.photoBlob);
    $('photoPreview').hidden = false;
    $('photoLabel').textContent = '換一張';
  } catch (err) {
    toast(err.message + '，請換一張試試');
  }
}

async function onSave(e) {
  e.preventDefault();
  const name = $('fName').value.trim();
  if (!name) {
    $('fName').setAttribute('aria-invalid', 'true');
    $('fName').focus();
    toast('請先輸入名稱');
    return;
  }
  const existing = form.id ? state.records.find((x) => x.id === form.id) : null;
  let a, o;
  if (form.loc === 'pick' && form.pick) { a = form.pick.a; o = form.pick.o; }
  else if (existing) { a = existing.a; o = existing.o; }
  else if (myPos && Date.now() - myPos.t < 10 * 60 * 1000) { a = myPos.a; o = myPos.o; }
  else { const c = map.getCenter(); a = c.lat; o = c.lng; }
  await ensureWorld(a, o);
  const reg = lookup(a, o);
  const id = existing ? existing.id : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let photo = existing ? existing.photo || null : null;
  if (form.photoChanged && form.photoBlob) {
    photo = 'p_' + id + '_' + Date.now().toString(36);
    try { await store.putPhoto(photo, form.photoBlob); } catch (err) { toast('照片存不進去，手機空間可能不足'); photo = existing ? existing.photo : null; }
    if (existing && existing.photo && existing.photo !== photo) store.deletePhoto(existing.photo);
  }
  const rec = {
    id, cat: form.cat, name, rating: form.rating, price: $('fPrice').value.trim(), note: $('fNote').value.trim(),
    vis: form.vis, a, o, c: reg.county, k: reg.country, photo,
    t: existing ? existing.t : Date.now(), demo: existing ? existing.demo : undefined
  };
  rec.editedAt = Date.now();
  if (existing) Object.assign(existing, rec); else state.records.push(rec);
  await saveRecords();
  social.recordChanged();
  // 記錄的地方也會解開迷霧
  if (!existing) { reveal(a, o, WALK_R, rec.t); saveFogSoon(); fog.redraw(); }
  renderPins();
  closeForm();
  updateTop();
  toast(existing ? '已更新' : '已記錄「' + name + '」');
  if (currentTab === 'records' || currentTab === 'detail') openDetail(id);
}

async function onDelete() {
  const btn = $('btnDelete');
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '再按一次確認刪除'; return; }
  const r = state.records.find((x) => x.id === form.id);
  if (!r) return;
  state.records = state.records.filter((x) => x.id !== r.id);
  if (r.photo) store.deletePhoto(r.photo);
  await saveRecords();
  social.recordDeleted(r);
  renderPins();
  closeForm();
  toast('已刪除');
  setTab('records');
}

// ---------- 補登足跡 ----------
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function revealPoints(points, linkPath) {
  const before = snapshotRegions();
  const c0 = state.cells.size;
  let prev = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let done = false;
    if (linkPath && prev) {
      const dt = (p.t - prev.t) / 1000;
      const d = distM(prev.a, prev.o, p.a, p.o);
      if (dt > 0 && dt < 15 * 60 && d < 1500) {
        const sp = d / dt;
        if (sp <= MAX_SPEED) { revealPath(prev.a, prev.o, p.a, p.o, sp > 7 ? RIDE_R : WALK_R, prev.t, null, p.t); done = true; }
        else done = true; // 太快的那段（飛機、高鐵）不解鎖
      }
    }
    if (!done) reveal(p.a, p.o, WALK_R, p.t);
    prev = p;
    if (i % 1500 === 1499) { $('toast').textContent = `匯入中… ${Math.round(i / points.length * 100)}%`; $('toast').hidden = false; await nextFrame(); }
  }
  await saveFogNow();
  fog.redraw();
  updateTop();
  const gained = km2(state.cells.size - c0);
  announceFirsts(before);
  social.stampsChanged();
  return gained;
}

function fitPoints(points) {
  if (!points.length) return;
  let minA = 90, maxA = -90, minO = 180, maxO = -180;
  for (const p of points) { minA = Math.min(minA, p.a); maxA = Math.max(maxA, p.a); minO = Math.min(minO, p.o); maxO = Math.max(maxO, p.o); }
  setTab('map');
  map.fitBounds([[minO, minA], [maxO, maxA]], { padding: { top: 170, bottom: 190, left: 40, right: 40 }, maxZoom: 15.5, duration: 900 });
}

async function importPhotos(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  if (!window.exifr) { toast('照片讀取工具沒有載入，請重新整理再試'); return; }
  toast(`讀取 ${files.length} 張照片中…`, 60000);
  const { points, skipped } = await pointsFromPhotos(files, (i, n) => { if (i % 5 === 0) $('toast').textContent = `讀取照片 ${i} / ${n}`; });
  if (!points.length) {
    toast(`這 ${files.length} 張照片都沒有位置資訊。iPhone 選照片時，請在上方「選項」打開「位置」；或改從「檔案」App 選。`, 9000);
    return;
  }
  await loadForeignFor(points);
  const gained = await revealPoints(points, false);
  toast(`從 ${points.length} 張照片解開了 ${fmtKm2(gained)}${skipped ? `，${skipped} 張沒有位置資訊` : ''}`, 6000);
  fitPoints(points);
}

async function importTrack(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast('讀取軌跡檔中…', 60000);
  let points;
  try {
    const text = await f.text();
    const name = f.name.toLowerCase();
    if (name.endsWith('.gpx') || /<gpx[\s>]/i.test(text.slice(0, 2000))) points = pointsFromGpx(text);
    else if (name.endsWith('.kml') || /<kml[\s>]/i.test(text.slice(0, 2000))) points = pointsFromKml(text);
    else points = pointsFromTimelineJson(JSON.parse(text));
  } catch (err) {
    toast('讀不懂這個檔案：' + (err.message || '格式不支援') + '。支援 GPX、KML、Google 地圖時間軸 JSON。', 7000);
    return;
  }
  if (!points.length) { toast('檔案裡找不到位置資料', 5000); return; }
  await loadForeignFor(points);
  const gained = await revealPoints(points, true);
  toast(`匯入 ${points.length.toLocaleString()} 個位置點，解開了 ${fmtKm2(gained)}`, 6000);
  fitPoints(points);
}

// ---------- 手帳分享圖 ----------
let journalUrl = null;
async function openJournal(tr) {
  currentTab = 'journal';
  $('sheetTitle').textContent = '手帳分享圖';
  $('sheetBody').innerHTML = '<p class="muted" style="text-align:center;padding:40px 0">正在畫這趟旅程…</p>';
  const blob = await tripImage(tr);
  if (currentTab !== 'journal') return;
  if (journalUrl) URL.revokeObjectURL(journalUrl);
  journalUrl = URL.createObjectURL(blob);
  const fname = `霧旅-${tr.regions[0] || '旅程'}-${fmtDate(tr.start, true).replace(/\//g, '')}.png`;
  const file = new File([blob], fname, { type: 'image/png' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  $('sheetBody').innerHTML = `
    <img class="journal-img" src="${journalUrl}" alt="${esc(tr.regions.join('、'))}旅程手帳圖">
    <p class="hint" style="text-align:center">也可以長按圖片，選「加入照片」存到相簿</p>
    <div class="row" style="gap:10px">
      <button type="button" class="btn-ghost" style="flex:1" id="jBack">回到旅程</button>
      ${canShare ? '<button type="button" class="btn-primary" id="jShare">分享</button>' : '<button type="button" class="btn-primary" id="jSave">下載圖片</button>'}
    </div>`;
  $('jBack').onclick = () => openTrip(tr);
  if ($('jShare')) $('jShare').onclick = async () => {
    try { await navigator.share({ files: [file], title: tr.regions.join(' · ') }); } catch (err) { if (err && err.name !== 'AbortError') toast('分享失敗，可以改用長按圖片儲存'); }
  };
  if ($('jSave')) $('jSave').onclick = () => {
    const a = document.createElement('a');
    a.href = journalUrl; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
  };
}

// ---------- 範例資料 ----------
function hasDemo() { return state.records.some((r) => r.demo) || state.stamps.some((s) => s.d); }

async function loadDemo() {
  if (hasDemo()) { toast('範例已經載入了'); return; }
  const day = 86400000;
  const t0 = Date.now() - 9 * day;
  // 常住地：高雄住家附近的日常散步
  const homeWalk = [[22.6275, 120.2940], [22.6310, 120.2985], [22.6355, 120.3010], [22.6390, 120.2970], [22.6365, 120.2915], [22.6320, 120.2890], [22.6275, 120.2940],
    [22.6240, 120.2990], [22.6215, 120.3050], [22.6260, 120.3085], [22.6305, 120.3060]];
  let t = t0;
  for (let i = 1; i < homeWalk.length; i++) {
    const [a1, o1] = homeWalk[i - 1], [a2, o2] = homeWalk[i];
    revealPath(a1, o1, a2, o2, WALK_R, t, { d: 1 }, t + 10 * 60000);
    t += 10 * 60000;
  }
  // 台南兩天一夜
  const t1 = Date.now() - 3 * day;
  const day1 = [[22.9971, 120.2127], [22.9945, 120.2085], [22.9925, 120.2040], [22.9975, 120.2028], [22.9973, 120.1985], [22.9968, 120.1960]];
  const day2 = [[23.0010, 120.1660], [23.0015, 120.1610], [23.0035, 120.1585], [23.0020, 120.1560], [22.9990, 120.1590], [22.9975, 120.1640]];
  t = t1;
  for (let i = 1; i < day1.length; i++) { revealPath(day1[i - 1][0], day1[i - 1][1], day1[i][0], day1[i][1], WALK_R, t, { d: 1 }, t + 12 * 60000); t += 12 * 60000; }
  t = t1 + day;
  for (let i = 1; i < day2.length; i++) { revealPath(day2[i - 1][0], day2[i - 1][1], day2[i][0], day2[i][1], WALK_R, t, { d: 1 }, t + 12 * 60000); t += 12 * 60000; }
  const mk = (cat, name, rating, price, note, a, o, tt, vis) => {
    const reg = lookup(a, o);
    return { id: 'demo' + name, cat, name, rating, price, note, vis, a, o, c: reg.county, k: reg.country, photo: null, t: tt, demo: true };
  };
  state.records.push(
    mk('food', '虱目魚粥（範例）', 5, 'NT$110', '早上七點就排隊，魚肚很嫩，湯頭清甜。', 22.9930, 120.2050, t1 + 20 * 60000, 'friends'),
    mk('shop', '巷子裡的舊書店（範例）', 4, '', '老闆會推薦台南作家的書，二樓有窗邊座位。', 22.9972, 120.1990, t1 + 50 * 60000, 'public'),
    mk('goods', '蜜餞伴手禮（範例）', 4, 'NT$200', '買了芒果乾和李仔糖，給辦公室的同事。', 23.0016, 120.1615, t1 + day + 20 * 60000, 'friends'),
    mk('private', '看夕陽的堤防（範例）', 5, '', '五點半之後人很少，可以坐在消波塊旁邊。', 22.9985, 120.1575, t1 + day + 50 * 60000, 'me')
  );
  await saveRecords();
  await saveFogNow();
  renderPins();
  fog.redraw();
  updateTop();
  map.fitBounds([[120.154, 22.989], [120.216, 23.006]], { padding: { top: 170, bottom: 190, left: 30, right: 30 }, duration: 1000 });
  toast('已載入範例：一趟台南兩天一夜的小旅行');
  if (currentTab !== 'map') renderSheet();
}

async function removeDemo() {
  state.records = state.records.filter((r) => !r.demo);
  rebuild((s) => !s.d);
  await saveRecords();
  await saveFogNow();
  renderPins();
  fog.redraw();
  updateTop();
  toast('已移除範例資料');
  if (currentTab !== 'map') renderSheet();
}

// ---------- 備份 ----------
function blobToDataURL(b) {
  return new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(b); });
}

async function exportData() {
  if (saveTimer) await saveFogNow();
  const photos = [];
  for (const [k, v] of await store.allPhotos()) photos.push([k, await blobToDataURL(v)]);
  const data = { app: 'fog-travel', v: 1, exported: Date.now(), fog: serialize(), records: state.records, settings: state.settings, photos };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `霧旅備份-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('備份檔已產生，請存到「檔案」或傳給自己');
}

async function importData(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'fog-travel') throw new Error('這不是霧旅的備份檔');
    await store.clearAll();
    await store.set('fog', data.fog);
    await store.set('records', data.records || []);
    await store.set('settings', data.settings || {});
    for (const [k, url] of data.photos || []) {
      const blob = await (await fetch(url)).blob();
      await store.putPhoto(k, blob);
    }
    toast('匯入完成，重新整理中…');
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    toast('匯入失敗：' + err.message);
  }
}

// ---------- 綁定 ----------
function bindActions() {
  $('btnExplore').onclick = () => (watchId === null ? startExplore() : stopExplore());
  $('btnRecord').onclick = () => openForm();
}

function bind() {
  bindActions();
  $('modeReal').onclick = () => setMapMode('real');
  $('modePaint').onclick = () => setMapMode('paint');
  $('btnLocate').onclick = () => {
    if (myPos) { map.flyTo({ center: [myPos.o, myPos.a], zoom: Math.max(map.getZoom(), 15.5), duration: 700 }); return; }
    if (!('geolocation' in navigator)) { toast('這個瀏覽器不能定位'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      myPos = { a: p.coords.latitude, o: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      updateMe();
      ensureWorld(myPos.a, myPos.o);
      updateTop();
      social.onPosition(myPos);
      map.flyTo({ center: [myPos.o, myPos.a], zoom: 15.5, duration: 700 });
    }, (err) => {
      toast(err.code === 1 ? '沒有定位權限，請到 iPhone 設定允許 Safari 網站使用定位' : '暫時拿不到位置，請到戶外再試一次', 5000);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  };
  for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => { if (picking) return; setTab(b.dataset.tab); };
  $('sheetClose').onclick = () => setTab('map');
  $('formClose').onclick = closeForm;
  $('recForm').addEventListener('submit', onSave);
  $('fPhoto').addEventListener('change', onPhoto);
  $('locHere').onclick = () => { form.loc = 'here'; renderLoc(); };
  $('locCenter').onclick = startPick;
  $('btnDelete').onclick = onDelete;
  $('fName').addEventListener('input', () => $('fName').removeAttribute('aria-invalid'));
}

// ---------- 在 iPhone app 裡：背景記錄 ----------
const native = window.__fogNative || null;
let bgState = null;
let queueBusy = false;

function nativePost(m) { if (native) native.post(m); }

async function onNative(m) {
  if (m.type === 'bg-state') {
    bgState = m;
    $('bgChip').hidden = !m.enabled;
    if (m.enabled && /背景自動記錄/.test($('toast').textContent)) $('toast').hidden = true;
    if (currentTab === 'badges') renderBadges();
    if (!m.enabled && !state.settings.bgAsked) {
      state.settings.bgAsked = true;
      saveSettings();
      setTimeout(() => toast('想讓手機放口袋也能自動解開迷霧？到「徽章 › 設定」打開「背景自動記錄」', 7000), 2500);
    }
  } else if (m.type === 'queue') {
    if (queueBusy) return;
    const pts = (m.points || []);
    if (!pts.length) return;
    queueBusy = true;
    try {
      const last = state.settings.lastQueueT || 0;
      const fresh = pts.filter((p) => p.t > last).sort((a, b) => a.t - b.t);
      if (fresh.length) {
        await loadForeignFor(fresh);
        const gained = await revealPoints(fresh.map((p) => ({ a: p.a, o: p.o, t: p.t })), true);
        state.settings.lastQueueT = fresh[fresh.length - 1].t;
        saveSettings();
        const lp = fresh[fresh.length - 1];
        if (Date.now() - lp.t < 10 * 60 * 1000) {
          myPos = { a: lp.a, o: lp.o, acc: lp.acc || 30, t: lp.t };
          updateMe();
          social.onPosition(myPos);
        }
        if (gained > 0.0005) toast(`背景記錄幫你解開了 ${fmtKm2(gained)}`, 4000);
      }
      nativePost({ type: 'queue-ack', count: pts.length });
    } finally {
      queueBusy = false;
    }
  }
}

function initNative() {
  if (!native) return;
  window.__fogApp = { onNative };
  for (const m of window.__fogPending || []) onNative(m);
  window.__fogPending = [];
  nativePost({ type: 'bg-get' });
  nativePost({ type: 'queue-pull' });
}

// ---------- 啟動 ----------
async function boot() {
  try { await loadTaiwan(BASE); } catch (e) { console.warn('county data', e); }
  const settings = await store.get('settings', null);
  if (settings) Object.assign(state.settings, settings);
  load(await store.get('fog', null));
  state.records = await store.get('records', []);
  const pts = state.stamps.concat(state.records);
  if (pts.some((p) => needWorld(p.a, p.o))) loadForeignFor(pts).then(() => fixForeign(true));
  $('map').classList.toggle('paint', state.settings.mapMode === 'paint');
  $('modeReal').classList.toggle('on', state.settings.mapMode !== 'paint');
  $('modePaint').classList.toggle('on', state.settings.mapMode === 'paint');
  $('testBanner').hidden = !state.settings.test;
  initMap();
  bind();
  renderPins();
  updateTop();
  loadOutline();
  social.init({
    state, store, $, esc, toast, ICON, catOf, regionLabel, fmtDay,
    saveSettings, saveRecords, saveFogNow,
    afterDataChange: () => { renderPins(); fog.redraw(); updateTop(); },
    map: () => map, fog: () => fog, getMyPos: () => myPos,
    currentTab: () => currentTab, setTab,
    openSheetFor: (tab) => {
      currentTab = tab;
      for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.tab === tab);
      $('sheet').hidden = false;
    }
  });
  initNative();
  if (!state.stamps.length && !state.records.length) {
    setTimeout(() => toast('歡迎！按「開始探索」走一走，或到「徽章 › 設定」載入範例、開啟測試模式', 6000), 900);
  }
}

boot();
