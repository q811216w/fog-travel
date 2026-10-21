// 判斷一個座標在哪個國家、哪個縣市。
// 台灣用 22 縣市邊界；其他國家用世界國界（離開台灣時才載入）。

export const TW_ORDER = [
  '基隆市', '台北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '台南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'
];

const ZH = {
  Taiwan: '台灣', Japan: '日本', 'South Korea': '韓國', 'North Korea': '北韓', China: '中國',
  'Hong Kong': '香港', Macao: '澳門', Mongolia: '蒙古', Philippines: '菲律賓', Vietnam: '越南',
  Thailand: '泰國', Malaysia: '馬來西亞', Singapore: '新加坡', Indonesia: '印尼', Cambodia: '柬埔寨',
  Laos: '寮國', Myanmar: '緬甸', Brunei: '汶萊', 'Timor-Leste': '東帝汶', India: '印度', Nepal: '尼泊爾',
  Bhutan: '不丹', 'Sri Lanka': '斯里蘭卡', Maldives: '馬爾地夫', Bangladesh: '孟加拉', Pakistan: '巴基斯坦',
  'United Arab Emirates': '阿聯', Qatar: '卡達', 'Saudi Arabia': '沙烏地阿拉伯', Israel: '以色列',
  Jordan: '約旦', Turkey: '土耳其', Iran: '伊朗', Egypt: '埃及', Morocco: '摩洛哥', 'South Africa': '南非',
  Kenya: '肯亞', Tanzania: '坦尚尼亞', Australia: '澳洲', 'New Zealand': '紐西蘭', Fiji: '斐濟', Palau: '帛琉',
  'United States of America': '美國', Canada: '加拿大', Mexico: '墨西哥', Cuba: '古巴', Peru: '秘魯',
  Brazil: '巴西', Argentina: '阿根廷', Chile: '智利', Colombia: '哥倫比亞', 'United Kingdom': '英國',
  Ireland: '愛爾蘭', France: '法國', Germany: '德國', Italy: '義大利', Spain: '西班牙', Portugal: '葡萄牙',
  Netherlands: '荷蘭', Belgium: '比利時', Luxembourg: '盧森堡', Switzerland: '瑞士', Austria: '奧地利',
  Czechia: '捷克', Poland: '波蘭', Hungary: '匈牙利', Slovakia: '斯洛伐克', Slovenia: '斯洛維尼亞',
  Croatia: '克羅埃西亞', Greece: '希臘', Denmark: '丹麥', Norway: '挪威', Sweden: '瑞典', Finland: '芬蘭',
  Iceland: '冰島', Estonia: '愛沙尼亞', Latvia: '拉脫維亞', Lithuania: '立陶宛', Russia: '俄羅斯',
  Ukraine: '烏克蘭', Romania: '羅馬尼亞', Bulgaria: '保加利亞', Serbia: '塞爾維亞', Malta: '馬爾他',
  Monaco: '摩納哥', 'Vatican': '梵蒂岡', Kazakhstan: '哈薩克', Uzbekistan: '烏茲別克', Georgia: '喬治亞'
};

export function zhCountry(name) { return ZH[name] || name; }

let tw = null;       // [{name, area, g, bbox}]
let world = null;    // [{name, g, bbox}]
let worldLoading = null;
const cache = new Map();

function bboxOf(g) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeom(x, y, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) {
    if (inRing(x, y, p[0])) {
      let hole = false;
      for (let i = 1; i < p.length; i++) if (inRing(x, y, p[i])) { hole = true; break; }
      if (!hole) return true;
    }
  }
  return false;
}

export async function loadTaiwan(base) {
  const res = await fetch(base + 'data/tw-counties.json');
  tw = (await res.json()).map((c) => ({ ...c, bbox: bboxOf(c.g) }));
  return tw;
}

export function taiwanCounties() { return tw || []; }

export function loadWorld(base) {
  if (world) return Promise.resolve(world);
  if (!worldLoading) {
    worldLoading = fetch(base + 'data/countries.json')
      .then((r) => r.json())
      .then((arr) => { world = arr.map((c) => ({ name: c.name, g: c.g, bbox: bboxOf(c.g) })); return world; })
      .catch(() => { worldLoading = null; return null; });
  }
  return worldLoading;
}

// 回傳 {country, county}；國外的 county 為 null。找不到時 country 為 null（例如海上）。
export function lookup(lat, lng) {
  // 用約 100 公尺的格子快取結果
  const fine = (Math.round(lat * 1000)) + ',' + (Math.round(lng * 1000));
  if (cache.has(fine)) return cache.get(fine);
  let out = { country: null, county: null };
  if (tw) {
    for (const c of tw) {
      const b = c.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inGeom(lng, lat, c.g)) { out = { country: '台灣', county: c.name }; break; }
    }
  }
  if (!out.country && world) {
    for (const c of world) {
      const b = c.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inGeom(lng, lat, c.g)) { out = { country: zhCountry(c.name), county: null }; break; }
    }
  }
  // 國外的結果要等世界國界載入後才快取
  if (out.country || world) cache.set(fine, out);
  return out;
}

export function needWorld(lat, lng) {
  // 在台灣範圍外，就需要世界國界資料
  return !(lat > 21.7 && lat < 26.5 && lng > 118 && lng < 122.2);
}
