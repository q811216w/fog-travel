// 迷霧、面積、旅程的計算。
import { lookup } from './regions.js';

const CELL = 25;                 // 面積計算用的格子：25 公尺
const M_PER_DEG = 111320;
export const CELL_KM2 = (CELL * CELL) / 1e6;

export const state = {
  stamps: [],          // {a: lat, o: lng, r: 半徑公尺, t: 時間, c: 縣市, k: 國家}
  cells: new Map(),    // 'iy,ix' -> {t, c, k}
  stampKeys: new Set(),
  byCountry: new Map(),  // 國家 -> {cells, first}
  byCounty: new Map(),   // 縣市 -> {cells, first}
  records: [],
  settings: { home: null, mapMode: 'real', test: false }
};

function rowStep(iy) {
  const lat = (iy + 0.5) * (CELL / M_PER_DEG);
  return CELL / (M_PER_DEG * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
}

function bump(map, key, t) {
  if (!key) return;
  const v = map.get(key);
  if (v) { v.cells++; if (t < v.first) v.first = t; }
  else map.set(key, { cells: 1, first: t });
}

function addCell(key, info) {
  if (state.cells.has(key)) return false;
  state.cells.set(key, info);
  bump(state.byCountry, info.k, info.t);
  bump(state.byCounty, info.c, info.t);
  return true;
}

export function distM(a1, o1, a2, o2) {
  const R = 6371000, toR = Math.PI / 180;
  const dA = (a2 - a1) * toR, dO = (o2 - o1) * toR;
  const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * toR) * Math.cos(a2 * toR) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function stampKey(lat, lng, r) {
  return Math.round(lat * M_PER_DEG / (r * 0.4)) + ',' + Math.round(lng * M_PER_DEG * Math.cos(lat * Math.PI / 180) / (r * 0.4));
}

// 解開一個點周圍的迷霧。回傳新解開的格子數。extra 會存進足跡（例如範例資料的標記）。
export function reveal(lat, lng, r, t, extra) {
  const reg = lookup(lat, lng);
  const sk = stampKey(lat, lng, r);
  if (!state.stampKeys.has(sk)) {
    state.stampKeys.add(sk);
    state.stamps.push(Object.assign({ a: lat, o: lng, r, t, c: reg.county, k: reg.country }, extra || null));
  }
  const added = markCells(lat, lng, r, t, reg);
  return { added, region: reg };
}

function markCells(lat, lng, r, t, reg) {
  let added = 0;
  const dLat = CELL / M_PER_DEG;
  const iy0 = Math.floor(lat / dLat);
  const n = Math.ceil(r / CELL) + 1;
  for (let dy = -n; dy <= n; dy++) {
    const iy = iy0 + dy;
    const step = rowStep(iy);
    const ix0 = Math.floor(lng / step);
    // 以格子中心到這個點的實際距離判斷，面積才會準
    const my = ((iy + 0.5) * dLat - lat) * M_PER_DEG;
    for (let dx = -n; dx <= n; dx++) {
      const ix = ix0 + dx;
      const mx = ((ix + 0.5) * step - lng) / step * CELL;
      if (mx * mx + my * my > r * r) continue;
      if (addCell(iy + ',' + ix, { t, c: reg.county, k: reg.country })) added++;
    }
  }
  return added;
}

// 兩點之間補上路線，避免 GPS 間隔太遠時迷霧斷斷續續。t2 給了就讓時間沿路平均分布。
export function revealPath(a1, o1, a2, o2, r, t, extra, t2) {
  const d = distM(a1, o1, a2, o2);
  const steps = Math.max(1, Math.ceil(d / (r * 0.5)));
  let added = 0, region = null;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const tt = t2 ? Math.round(t + (t2 - t) * f) : t;
    const res = reveal(a1 + (a2 - a1) * f, o1 + (o2 - o1) * f, r, tt, extra);
    added += res.added; region = res.region;
  }
  return { added, region };
}

// 從足跡重新算出所有格子（刪除範例資料、或國界資料載入後補上國家時使用）。
export function rebuild(keep) {
  const stamps = state.stamps.filter(keep || (() => true));
  state.stamps = [];
  state.cells = new Map();
  state.byCountry = new Map();
  state.byCounty = new Map();
  state.stampKeys = new Set();
  for (const s of stamps) {
    if (!s.k || (!s.c && s.k !== '台灣')) { const reg = lookup(s.a, s.o); s.c = reg.county; s.k = reg.country; }
    state.stampKeys.add(stampKey(s.a, s.o, s.r));
    state.stamps.push(s);
    markCells(s.a, s.o, s.r, s.t, { county: s.c, country: s.k });
  }
}

export function km2(cells) { return cells * CELL_KM2; }

export function totalKm2() { return km2(state.cells.size); }

// 序列化（存進手機）
export function serialize() {
  const cells = [];
  for (const [k, v] of state.cells) cells.push([k, v.t, v.c || '', v.k || '']);
  return { stamps: state.stamps, cells };
}

export function load(data) {
  state.stamps = (data && data.stamps) || [];
  state.cells = new Map();
  state.byCountry = new Map();
  state.byCounty = new Map();
  state.stampKeys = new Set();
  for (const s of state.stamps) state.stampKeys.add(stampKey(s.a, s.o, s.r));
  for (const [k, t, c, kk] of ((data && data.cells) || [])) addCell(k, { t, c: c || null, k: kk || null });
}

export function regionKey(s) { return s.c || s.k || null; }

// 常住地：使用者設定的，否則取解開面積最多的地區
export function homeRegion() {
  if (state.settings.home) return state.settings.home;
  let best = null, max = 0;
  for (const [k, v] of state.byCounty) if (v.cells > max) { max = v.cells; best = k; }
  for (const [k, v] of state.byCountry) if (k !== '台灣' && v.cells > max) { max = v.cells; best = k; }
  return best;
}

// 旅程：離開常住地的足跡，間隔不超過 36 小時就算同一趟。
export function computeTrips() {
  const home = homeRegion();
  const away = state.stamps.filter((s) => regionKey(s) && regionKey(s) !== home).sort((a, b) => a.t - b.t);
  const trips = [];
  const GAP = 36 * 3600 * 1000;
  let cur = null;
  for (const s of away) {
    if (!cur || s.t - cur.end > GAP) {
      cur = { start: s.t, end: s.t, stamps: [], regions: [], countries: [] };
      trips.push(cur);
    }
    cur.end = s.t;
    cur.stamps.push(s);
    const rk = regionKey(s);
    if (!cur.regions.includes(rk)) cur.regions.push(rk);
    if (s.k && !cur.countries.includes(s.k)) cur.countries.push(s.k);
  }
  for (const tr of trips) {
    let cells = 0;
    for (const v of state.cells.values()) if (v.t >= tr.start - 60000 && v.t <= tr.end + 60000 && (v.c || v.k) !== home) cells++;
    tr.km2 = km2(cells);
    let d = 0;
    for (let i = 1; i < tr.stamps.length; i++) {
      const p = tr.stamps[i - 1], q = tr.stamps[i];
      const dd = distM(p.a, p.o, q.a, q.o);
      if (dd < 1500 && q.t - p.t < 3600 * 1000) d += dd;
    }
    tr.km = d / 1000;
    // 這段時間內、而且記在這趟去過的地方的紀錄（在家記的不算進去）
    tr.records = state.records.filter((r) => r.t >= tr.start - 3600 * 1000 && r.t <= tr.end + 3600 * 1000 && tr.regions.includes(r.c || r.k));
    let minA = 90, maxA = -90, minO = 180, maxO = -180;
    for (const s of tr.stamps) {
      minA = Math.min(minA, s.a); maxA = Math.max(maxA, s.a);
      minO = Math.min(minO, s.o); maxO = Math.max(maxO, s.o);
    }
    tr.bounds = [[minO, minA], [maxO, maxA]];
    tr.ongoing = Date.now() - tr.end < GAP;
  }
  return trips.reverse();
}
