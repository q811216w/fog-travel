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
const { pointsFromTimelineJson } = await import('../js/importer.js');

before(async () => {
  await regions.loadTaiwan('x/');
  await regions.loadWorld('x/');
});

test('國外的一級行政區：載入後能判斷都道府縣、道、州', async () => {
  const cases = [
    [35.6812, 139.7671, 'Japan', '日本', '東京都'],
    [34.9858, 135.7588, 'Japan', '日本', '京都府'],
    [43.0687, 141.3508, 'Japan', '日本', '北海道'],
    [37.5665, 126.9780, 'South Korea', '韓國', '首爾特別市'],
    [13.7563, 100.5018, 'Thailand', '泰國', null],
    [40.7484, -73.9857, 'United States of America', '美國', '紐約州']
  ];
  for (const [a, o, en, zh, county] of cases) {
    const before = regions.lookup(a, o);
    assert.equal(before.country, zh, `${a},${o} 國家`);
    assert.equal(before.en, en);
    const list = await regions.loadAdmin1('x/', en);
    assert.ok(list && list.length > 5, `${zh} 有行政區資料`);
    const after = regions.lookup(a, o);
    assert.ok(after.county, `${zh} ${a},${o} 應該判斷出行政區`);
    if (county) assert.equal(after.county, county);
  }
});

test('日本有 47 個都道府縣', async () => {
  const list = await regions.loadAdmin1('x/', 'Japan');
  assert.equal(list.length, 47);
});

test('行政區載入後，重算會補上國外足跡的地區', async () => {
  model.load(null);
  // 先假裝當時還不知道地區
  model.state.stamps.push({ a: 34.9858, o: 135.7588, r: 60, t: 1, c: null, k: '日本' });
  model.rebuild();
  assert.equal(model.state.stamps[0].c, '京都府');
  assert.ok(model.state.byCounty.has('京都府'));
});

test('Google 地圖時間軸（新版手機匯出）', () => {
  const data = {
    semanticSegments: [
      { startTime: '2026-10-18T09:00:00+08:00', endTime: '2026-10-18T10:00:00+08:00',
        timelinePath: [
          { point: '22.9971000°, 120.2127000°', time: '2026-10-18T09:00:00+08:00' },
          { point: '22.9945000°, 120.2085000°', time: '2026-10-18T09:10:00+08:00' }
        ] },
      { startTime: '2026-10-18T10:00:00+08:00', endTime: '2026-10-18T11:00:00+08:00',
        visit: { topCandidate: { placeLocation: { latLng: '22.9973°, 120.1985°' } } } }
    ]
  };
  const pts = pointsFromTimelineJson(data);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[0].a - 22.9971) < 1e-6);
  assert.ok(pts[0].t < pts[2].t);
});

test('Google 地圖時間軸（舊版 Takeout Records.json）', () => {
  const pts = pointsFromTimelineJson({ locations: [
    { latitudeE7: 229971000, longitudeE7: 1202127000, timestamp: '2020-01-01T00:00:00Z' },
    { latitudeE7: 229945000, longitudeE7: 1202085000, timestampMs: '1577836900000' }
  ] });
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[1].o - 120.2085) < 1e-6);
});

test('時間軸 iPhone 匯出格式（geo:lat,lng）', () => {
  const pts = pointsFromTimelineJson([
    { startTime: '2026-10-18T09:00:00+08:00', endTime: '2026-10-18T09:30:00+08:00', activity: { start: 'geo:22.997100,120.212700', end: 'geo:22.994500,120.208500' } }
  ]);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[1].a - 22.9945) < 1e-6);
});
