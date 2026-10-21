import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
globalThis.fetch = async (url) => {
  const p = String(url).replace(/^.*?data\//, root + 'data/');
  const txt = await readFile(p, 'utf8');
  return { json: async () => JSON.parse(txt), ok: true };
};

const regions = await import('../js/regions.js');
const model = await import('../js/model.js');
const { state } = model;

function reset() {
  model.load(null);
  state.records = [];
  state.settings = { home: null, mapMode: 'real', test: false };
}

before(async () => {
  await regions.loadTaiwan('x/');
  await regions.loadWorld('x/');
});

test('座標判斷在正確的縣市與國家', () => {
  const cases = [
    [25.0340, 121.5645, '台灣', '台北市'],   // 台北 101
    [22.9971, 120.2127, '台灣', '台南市'],   // 台南車站
    [22.6273, 120.3014, '台灣', '高雄市'],
    [24.4368, 118.3186, '台灣', '金門縣'],
    [23.5711, 119.5793, '台灣', '澎湖縣'],
    [24.8039, 120.9647, '台灣', '新竹市'],
    [35.6812, 139.7671, '日本', null],       // 東京車站
    [37.5665, 126.9780, '韓國', null],       // 首爾
    [48.8584, 2.2945, '法國', null]          // 艾菲爾鐵塔
  ];
  for (const [a, o, k, c] of cases) {
    const r = regions.lookup(a, o);
    assert.equal(r.country, k, `${a},${o} 國家`);
    assert.equal(r.county, c, `${a},${o} 縣市`);
  }
});

test('海上不屬於任何國家', () => {
  const r = regions.lookup(23.5, 122.6);
  assert.equal(r.country, null);
});

test('單點解開的面積接近半徑 60 公尺的圓', () => {
  reset();
  model.reveal(22.9971, 120.2127, 60, Date.now());
  const expected = Math.PI * 60 * 60 / 1e6;
  const got = model.totalKm2();
  assert.ok(Math.abs(got - expected) / expected < 0.15, `面積 ${got} 與預期 ${expected} 差太多`);
  assert.equal(state.byCounty.get('台南市').cells, state.cells.size);
});

test('走 1 公里的面積大約是 0.12 平方公里，重複走不會增加', () => {
  reset();
  const t = Date.now();
  // 往北走 1 公里
  model.revealPath(22.99, 120.21, 22.99 + 1000 / 111320, 120.21, 60, t);
  const a1 = model.totalKm2();
  const expected = (1000 * 120 + Math.PI * 60 * 60) / 1e6;
  assert.ok(Math.abs(a1 - expected) / expected < 0.15, `面積 ${a1} vs ${expected}`);
  model.revealPath(22.99, 120.21, 22.99 + 1000 / 111320, 120.21, 60, t + 1000);
  assert.equal(model.totalKm2(), a1);
});

test('跨縣市行走會分別計算', () => {
  reset();
  // 台南到高雄的交界附近，各走一段
  model.revealPath(22.9971, 120.2127, 22.9990, 120.2127, 60, 1);
  model.revealPath(22.6273, 120.3014, 22.6290, 120.3014, 60, 2);
  assert.ok(state.byCounty.has('台南市'));
  assert.ok(state.byCounty.has('高雄市'));
  assert.equal(state.byCountry.get('台灣').cells, state.cells.size);
});

test('存檔再讀回來，資料完全相同', () => {
  reset();
  model.revealPath(22.9971, 120.2127, 23.0, 120.21, 60, 100);
  model.reveal(35.6812, 139.7671, 60, 200);
  const before = { cells: state.cells.size, stamps: state.stamps.length, jp: state.byCountry.get('日本').cells };
  const saved = JSON.parse(JSON.stringify(model.serialize()));
  model.load(saved);
  assert.equal(state.cells.size, before.cells);
  assert.equal(state.stamps.length, before.stamps);
  assert.equal(state.byCountry.get('日本').cells, before.jp);
});

test('常住地自動判斷：足跡最多的縣市', () => {
  reset();
  model.revealPath(22.6273, 120.3014, 22.6400, 120.3014, 60, 1);
  model.reveal(22.9971, 120.2127, 60, 2);
  assert.equal(model.homeRegion(), '高雄市');
  state.settings.home = '台南市';
  assert.equal(model.homeRegion(), '台南市');
});

test('旅程分組：離開常住地、隔超過 36 小時就是不同趟', () => {
  reset();
  const H = 3600 * 1000, D = 24 * H;
  const t0 = Date.now() - 30 * D;
  model.revealPath(22.6273, 120.3014, 22.6500, 120.3014, 60, t0);          // 高雄（常住地）
  model.revealPath(22.9971, 120.2127, 23.0000, 120.2127, 60, t0 + D, null, t0 + D + 2 * H);   // 台南 第一天
  model.revealPath(23.0010, 120.1660, 23.0030, 120.1600, 60, t0 + 2 * D, null, t0 + 2 * D + 2 * H); // 台南 第二天
  model.reveal(35.6812, 139.7671, 60, t0 + 10 * D);                         // 東京，另一趟
  state.records.push({ id: 'x', t: t0 + D + H, a: 22.998, o: 120.2127, c: '台南市', k: '台灣' });
  // 同一時間在家記的紀錄不算進旅程
  state.records.push({ id: 'y', t: t0 + D + H, a: 22.63, o: 120.30, c: '高雄市', k: '台灣' });
  const trips = model.computeTrips();
  assert.equal(trips.length, 2);
  assert.deepEqual(trips[0].regions, ['日本']);
  assert.deepEqual(trips[1].regions, ['台南市']);
  assert.equal(trips[1].records.length, 1);
  assert.ok(trips[1].km > 0.5, '距離要有算到');
  assert.ok(trips[1].km2 > 0, '面積要有算到');
});

test('移除範例資料只刪範例的足跡', () => {
  reset();
  model.revealPath(22.6273, 120.3014, 22.6300, 120.3014, 60, 1);
  const mine = state.cells.size;
  model.revealPath(22.9971, 120.2127, 23.0000, 120.2127, 60, 2, { d: 1 });
  assert.ok(state.cells.size > mine);
  model.rebuild((s) => !s.d);
  assert.equal(state.cells.size, mine);
  assert.ok(!state.byCounty.has('台南市'));
});

test('國界還沒載入時的國外足跡，之後會補上國家', async () => {
  reset();
  // 模擬：直接塞一筆沒有國家的足跡
  state.stamps.push({ a: 35.6812, o: 139.7671, r: 60, t: 5, c: null, k: null });
  model.rebuild();
  assert.equal(state.stamps[0].k, '日本');
  assert.ok(state.byCountry.get('日本').cells > 0);
});
