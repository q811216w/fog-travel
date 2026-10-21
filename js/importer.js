// 補登足跡：從照片的 GPS、GPX 軌跡檔、Google 地圖時間軸匯入。
// 每個解析函式都回傳時間排序的點：[{a, o, t}]

function parseDegString(s) {
  // Google 時間軸新格式："22.9971234°, 120.2127456°"
  const m = /(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)°?/.exec(String(s));
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

export async function pointsFromPhotos(files, onProgress) {
  const out = [];
  let noGps = 0;
  let i = 0;
  for (const f of files) {
    i++;
    if (onProgress) onProgress(i, files.length);
    try {
      const meta = await window.exifr.parse(f, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'] });
      const lat = meta && meta.latitude, lng = meta && meta.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number' || (lat === 0 && lng === 0)) { noGps++; continue; }
      const d = meta.DateTimeOriginal || meta.CreateDate;
      const t = d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : (f.lastModified || Date.now());
      out.push({ a: lat, o: lng, t });
    } catch (e) {
      noGps++;
    }
  }
  out.sort((p, q) => p.t - q.t);
  return { points: out, skipped: noGps };
}

export function pointsFromGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX 檔格式不正確');
  const nodes = doc.querySelectorAll('trkpt, rtept, wpt');
  const out = [];
  let base = Date.now() - nodes.length * 1000;
  for (const n of nodes) {
    const a = parseFloat(n.getAttribute('lat')), o = parseFloat(n.getAttribute('lon'));
    if (Number.isNaN(a) || Number.isNaN(o)) continue;
    const te = n.querySelector('time');
    const t = te ? Date.parse(te.textContent) : NaN;
    out.push({ a, o, t: Number.isNaN(t) ? (base += 1000) : t });
  }
  out.sort((p, q) => p.t - q.t);
  return out;
}

export function pointsFromKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('KML 檔格式不正確');
  const out = [];
  let base = Date.now();
  for (const c of doc.querySelectorAll('coordinates, coord')) {
    const parts = c.textContent.trim().split(/\s+/);
    for (const p of parts) {
      const xyz = p.split(/[ ,]/).map(Number);
      if (xyz.length >= 2 && !Number.isNaN(xyz[0]) && !Number.isNaN(xyz[1])) out.push({ a: xyz[1], o: xyz[0], t: (base += 1000) });
    }
  }
  return out;
}

export function pointsFromTimelineJson(data) {
  const out = [];
  // 舊版 Google Takeout：Records.json
  if (Array.isArray(data.locations)) {
    for (const l of data.locations) {
      if (l.latitudeE7 == null || l.longitudeE7 == null) continue;
      const t = l.timestamp ? Date.parse(l.timestamp) : (l.timestampMs ? +l.timestampMs : NaN);
      out.push({ a: l.latitudeE7 / 1e7, o: l.longitudeE7 / 1e7, t: Number.isNaN(t) ? Date.now() : t });
    }
  }
  // 新版（手機匯出）：Timeline.json 的 semanticSegments
  const segs = Array.isArray(data.semanticSegments) ? data.semanticSegments : (Array.isArray(data) ? data : null);
  if (segs) {
    for (const s of segs) {
      if (Array.isArray(s.timelinePath)) {
        for (const p of s.timelinePath) {
          const ll = parseDegString(p.point);
          const t = Date.parse(p.time);
          if (ll) out.push({ a: ll[0], o: ll[1], t: Number.isNaN(t) ? Date.parse(s.startTime) : t });
        }
      }
      const v = s.visit && s.visit.topCandidate && s.visit.topCandidate.placeLocation;
      if (v) {
        const ll = parseDegString(v.latLng || v);
        const t = Date.parse(s.startTime);
        if (ll) out.push({ a: ll[0], o: ll[1], t: Number.isNaN(t) ? Date.now() : t });
      }
      // iPhone 匯出的格式（startTime / visit.topCandidate.placeLocation 是 "geo:lat,lng"）
      if (s.activity && s.activity.start) {
        const a = parseDegString(String(s.activity.start).replace('geo:', ''));
        const b = parseDegString(String(s.activity.end || '').replace('geo:', ''));
        const t1 = Date.parse(s.startTime), t2 = Date.parse(s.endTime);
        if (a) out.push({ a: a[0], o: a[1], t: t1 || Date.now() });
        if (b) out.push({ a: b[0], o: b[1], t: t2 || Date.now() });
      }
    }
  }
  // 舊版 Takeout 每月的 Semantic Location History
  if (Array.isArray(data.timelineObjects)) {
    for (const o of data.timelineObjects) {
      const pv = o.placeVisit && o.placeVisit.location;
      if (pv && pv.latitudeE7 != null) {
        const t = Date.parse(o.placeVisit.duration && o.placeVisit.duration.startTimestamp);
        out.push({ a: pv.latitudeE7 / 1e7, o: pv.longitudeE7 / 1e7, t: Number.isNaN(t) ? Date.now() : t });
      }
      const as = o.activitySegment;
      if (as && as.simplifiedRawPath && Array.isArray(as.simplifiedRawPath.points)) {
        for (const p of as.simplifiedRawPath.points) {
          const t = Date.parse(p.timestamp);
          out.push({ a: p.latE7 / 1e7, o: p.lngE7 / 1e7, t: Number.isNaN(t) ? Date.now() : t });
        }
      }
    }
  }
  out.sort((p, q) => p.t - q.t);
  return out.filter((p) => Math.abs(p.a) <= 90 && Math.abs(p.o) <= 180);
}
