// 好友頁、同步排程、地圖上的好友圖層。
import * as cloud from './cloud.js';
import { reveal, stampKey } from './model.js';
import { lookup } from './regions.js';

const COLORS = [[63, 111, 148], [122, 79, 120], [85, 127, 80], [176, 122, 42], [47, 127, 122], [160, 74, 106]];
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

let ctx = null;
let me = null;            // 自己的 profile
let priv = null;          // 住家保護區（只有自己看得到）
let net = { friends: [], incoming: [], outgoing: [] };
let fLive = [], fRecords = [], fStamps = new Map(), fStampMax = 0;
const liveMarkers = new Map(), recMarkers = new Map();
let syncing = false, lastPush = 0, lastLivePush = 0, timer = 0;
let view = 'main';        // 好友頁目前顯示：main / friendRecords:<id> / record:<uid>:<id>
let authMode = 'signin';
let unfriendArmed = null;

const S = () => ctx.state.settings;
const cloudState = () => (S().cloud = S().cloud || {});

export function isSignedIn() { return !!cloud.user; }

export async function init(c) {
  ctx = c;
  if (!window.supabase) return;
  await cloud.init(onAuth);
  if (cloud.user) onAuth(cloud.user, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cloud.user) tick(true); });
}

async function onAuth(u, initial) {
  clearInterval(timer);
  if (!u) {
    me = null; priv = null; net = { friends: [], incoming: [], outgoing: [] };
    fLive = []; fRecords = []; fStamps = new Map(); fStampMax = 0;
    drawFriendLayers();
    if (ctx.currentTab() === 'friends') render();
    return;
  }
  try {
    me = await cloud.myProfile();
    priv = await cloud.getPrivate();
  } catch (e) { ctx.toast(e.message); }
  const cs = cloudState();
  if (cs.uid !== u.id) { cs.uid = u.id; cs.stampsSynced = 0; cs.pulled = false; ctx.saveSettings(); }
  if (!initial) ctx.toast(`已登入：${me ? me.display_name : ''}`);
  await fullSync();
  timer = setInterval(() => tick(false), 45000);
  if (ctx.currentTab() === 'friends') render();
}

async function tick(force) {
  if (!cloud.user || document.visibilityState !== 'visible') return;
  await pushChanges(force);
  await refreshFriends();
}

// ---------- 同步 ----------
async function fullSync() {
  if (syncing) return;
  syncing = true;
  try {
    const cs = cloudState();
    if (!cs.pulled) {
      await restoreFromCloud();
      cs.pulled = true;
      ctx.saveSettings();
    }
    await pushChanges(true);
    await refreshFriends();
  } catch (e) {
    ctx.toast('同步失敗：' + e.message);
  } finally {
    syncing = false;
    if (ctx.currentTab() === 'friends' && view === 'main') render();
  }
}

// 換手機或清掉瀏覽器資料後登入：把雲端上自己的足跡和紀錄抓回來
async function restoreFromCloud() {
  const st = ctx.state;
  const [stamps, recs] = await Promise.all([cloud.pullMyStamps(), cloud.pullMyRecords()]);
  const have = new Set(st.stamps.map((s) => stampKey(s.a, s.o, s.r)));
  let added = 0;
  for (const s of stamps) {
    if (have.has(stampKey(s.a, s.o, s.r))) continue;
    reveal(s.a, s.o, s.r, s.d * 86400000 + 12 * 3600000);
    added++;
  }
  const ids = new Set(st.records.map((r) => r.id));
  let radd = 0;
  for (const r of recs) {
    if (ids.has(r.id)) continue;
    const rec = { id: r.id, cat: r.cat, name: r.name, rating: r.rating, price: r.price, note: r.note, vis: r.vis, a: r.a, o: r.o, c: r.c, k: r.k, t: Number(r.t), photo: null, cloudPhoto: r.photo_path };
    if (r.photo_path) {
      const blob = await cloud.downloadPhoto(r.photo_path);
      if (blob) { rec.photo = 'p_' + r.id + '_cloud'; rec.cloudPhotoId = rec.photo; await ctx.store.putPhoto(rec.photo, blob); }
    }
    st.records.push(rec);
    radd++;
  }
  if (added || radd) {
    // 抓回來的足跡已經在雲端，不用再上傳
    cloudState().stampsSynced = st.stamps.length;
    await ctx.saveFogNow();
    await ctx.saveRecords();
    ctx.afterDataChange();
    ctx.toast(`已從雲端取回 ${added} 個足跡、${radd} 筆紀錄`);
  }
}

async function pushChanges(force) {
  if (!cloud.user) return;
  if (!force && Date.now() - lastPush < 50000) return;
  lastPush = Date.now();
  const st = ctx.state, cs = cloudState();
  if ((cs.stampsSynced || 0) > st.stamps.length) cs.stampsSynced = 0;   // 足跡重算過，從頭補傳（重複的會自動略過）
  const from = cs.stampsSynced || 0;
  if (from < st.stamps.length) {
    const n = st.stamps.length - from;
    await cloud.pushStamps(st.stamps, from, priv, n > 3000 ? (i, total) => { ctx.toast(`上傳足跡 ${Math.round(i / total * 100)}%`, 4000); } : null);
    cs.stampsSynced = st.stamps.length;
  }
  let changed = false;
  for (const r of st.records) {
    if (r.demo) continue;
    if (r.syncedAt && r.syncedAt >= (r.editedAt || r.t)) continue;
    const blob = r.photo && r.cloudPhotoId !== r.photo ? await ctx.store.getPhoto(r.photo) : null;
    await cloud.pushRecord(r, blob);
    r.syncedAt = Date.now();
    changed = true;
  }
  if (changed) await ctx.saveRecords();
  cs.lastSync = Date.now();
  ctx.saveSettings();
}

export function recordChanged() { if (cloud.user) { lastPush = 0; pushChanges(true).catch(() => {}); } }

export async function recordDeleted(r) {
  if (!cloud.user || r.demo) return;
  try { await cloud.deleteRecord(r); } catch (e) { /* 下次再說 */ }
}

export function stampsChanged() { if (cloud.user) pushChanges(false).catch(() => {}); }

// ---------- 即時位置 ----------
export async function onPosition(pos) {
  if (!cloud.user || !pos) return;
  if (!net.friends.some((f) => f.iShare)) return;
  if (Date.now() - lastLivePush < 30000) return;
  lastLivePush = Date.now();
  try {
    if (cloud.inHome(priv, pos.a, pos.o)) {
      await cloud.pushLive({ lat: null, lng: null, acc: null, label: '位置隱藏中', precise: false });
      return;
    }
    const reg = lookup(pos.a, pos.o);
    const label = reg.county ? reg.county : (reg.country || '');
    if (S().livePrecise === false) {
      await cloud.pushLive({ lat: Math.round(pos.a * 50) / 50, lng: Math.round(pos.o * 50) / 50, acc: 2000, label, precise: false });
    } else {
      await cloud.pushLive({ lat: +pos.a.toFixed(5), lng: +pos.o.toFixed(5), acc: pos.acc || null, label, precise: true });
    }
  } catch (e) { /* 網路不好時略過這次 */ }
}

// ---------- 好友資料 ----------
async function refreshFriends() {
  if (!cloud.user) return;
  try {
    net = await cloud.loadFriends();
    const ids = new Set(net.friends.map((f) => f.id));
    const [live, recs, stamps] = await Promise.all([cloud.friendLive(), cloud.friendRecords(), cloud.friendStamps(fStampMax)]);
    fLive = live.filter((l) => ids.has(l.user_id));
    fRecords = recs.filter((r) => ids.has(r.user_id));
    for (const s of stamps) {
      if (!fStamps.has(s.user_id)) fStamps.set(s.user_id, []);
      fStamps.get(s.user_id).push(s);
      if (s.id > fStampMax) fStampMax = s.id;
    }
    drawFriendLayers();
    if (ctx.currentTab() === 'friends' && view === 'main') render();
  } catch (e) { /* 網路不好時略過 */ }
}

function colorOf(id) {
  const i = net.friends.findIndex((f) => f.id === id);
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
}
function nameOf(id) { const f = net.friends.find((x) => x.id === id); return f ? f.name : '好友'; }

function ago(ts) {
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return m + ' 分鐘前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小時前';
  return Math.round(h / 24) + ' 天前';
}

export function drawFriendLayers() {
  const show = S().showFriends !== false && cloud.user;
  const list = [];
  if (show) {
    for (const f of net.friends) {
      if (!f.shareFoot) continue;
      const st = fStamps.get(f.id);
      if (st && st.length) list.push({ color: colorOf(f.id), stamps: st });
    }
  }
  if (ctx.fog() && ctx.fog().setFriends) ctx.fog().setFriends(list);
  const map = ctx.map();
  if (!map) return;
  // 即時位置
  for (const m of liveMarkers.values()) m.remove();
  liveMarkers.clear();
  if (show) {
    for (const l of fLive) {
      if (l.lat == null || Date.now() - new Date(l.updated_at).getTime() > 24 * 3600000) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'friend-live';
      el.style.setProperty('--fc', hex(colorOf(l.user_id)));
      const nm = nameOf(l.user_id);
      el.innerHTML = `<span class="fl-dot">${ctx.esc(nm.slice(0, 1))}</span><span class="fl-label">${ctx.esc(nm)} · ${ago(l.updated_at)}</span>`;
      el.setAttribute('aria-label', `${nm}的位置，${ago(l.updated_at)}更新`);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.toast(`${nm}：${l.label || ''}${l.precise ? '' : '（只分享大概位置）'} · ${ago(l.updated_at)}`, 4000); });
      liveMarkers.set(l.user_id, new window.maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([l.lng, l.lat]).addTo(map));
    }
  }
  // 好友的紀錄
  for (const m of recMarkers.values()) m.remove();
  recMarkers.clear();
  if (show) {
    for (const r of fRecords) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pin friend-pin cat-' + r.cat;
      el.style.setProperty('--fc', hex(colorOf(r.user_id)));
      el.setAttribute('aria-label', `${nameOf(r.user_id)}的${ctx.catOf(r.cat).label}：${r.name}`);
      el.innerHTML = ctx.ICON[r.cat] || ctx.ICON.shop;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); openFriendRecord(r); });
      recMarkers.set(r.user_id + r.id, new window.maplibregl.Marker({ element: el, anchor: 'bottom-left', offset: [-3, 3] }).setLngLat([r.o, r.a]).addTo(map));
    }
  }
}

// ---------- 好友頁 ----------
export function render() {
  view = 'main';
  const body = ctx.$('sheetBody');
  ctx.$('sheetTitle').textContent = '好友';
  if (!window.supabase) { body.innerHTML = '<p class="muted">好友功能載入失敗，請重新整理。</p>'; return; }
  if (!cloud.user) return renderAuth(body);
  const esc = ctx.esc;
  const cs = cloudState();
  let html = `<div class="card">
    <div class="row"><div class="stack"><span class="muted">我的名字</span>
      <div class="row" style="justify-content:flex-start;gap:8px"><b style="font-size:18px">${esc(me ? me.display_name : '')}</b><button type="button" class="btn-small" id="renameBtn">改名</button></div></div></div>
    <div class="row"><div class="stack"><span class="muted">我的好友碼（給朋友輸入就能加你）</span>
      <span class="friend-code" id="myCode">${esc(me ? me.friend_code : '……')}</span></div>
      <button type="button" class="btn-small" id="copyCode">複製</button></div>
    <span class="muted">${syncing ? '同步中…' : cs.lastSync ? '上次同步：' + ago(cs.lastSync) : '尚未同步'} · ${esc(cloud.user.email || '')}</span>
  </div>
  <div class="card">
    <b>加好友</b>
    <form class="row" id="addForm" style="gap:8px">
      <label for="codeIn" class="visually-hidden">朋友的好友碼</label>
      <input id="codeIn" class="code-input" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" maxlength="6" placeholder="輸入 6 碼好友碼">
      <button type="submit" class="btn-small">送出邀請</button>
    </form>
  </div>`;
  if (net.incoming.length) {
    html += '<div class="group-label">收到的邀請</div>';
    for (const f of net.incoming) html += `<div class="card"><div class="row"><b>${esc(f.name)}</b>
      <div class="row" style="gap:6px"><button type="button" class="btn-small" data-decline="${f.fid}">婉拒</button><button type="button" class="btn-small primary" data-accept="${f.fid}">接受</button></div></div></div>`;
  }
  if (net.outgoing.length) {
    html += '<div class="group-label">等待對方接受</div>';
    for (const f of net.outgoing) html += `<div class="card"><div class="row"><b>${esc(f.name)}</b><button type="button" class="btn-small" data-decline="${f.fid}">取消邀請</button></div></div>`;
  }
  html += `<div class="row"><div class="group-label">好友（${net.friends.length}）</div>
    <label class="row" style="gap:8px;font-size:13px;color:var(--ink-2)">在地圖上顯示<span class="switch"><input type="checkbox" id="showFr" ${S().showFriends !== false ? 'checked' : ''}><i></i></span></label></div>`;
  if (!net.friends.length) html += '<div class="card dashed"><span class="muted">還沒有好友。把你的好友碼傳給朋友，或輸入朋友的好友碼。</span></div>';
  for (const f of net.friends) {
    const l = fLive.find((x) => x.user_id === f.id);
    const recN = fRecords.filter((r) => r.user_id === f.id).length;
    const stN = (fStamps.get(f.id) || []).length;
    const liveTxt = !f.sharesToMe ? '沒有分享即時位置給你' : l ? `${l.lat == null ? '位置隱藏中' : esc(l.label || '已分享位置')} · ${ago(l.updated_at)}` : '已分享，但還沒有位置';
    html += `<div class="card friend-card" style="--fc:${hex(colorOf(f.id))}">
      <div class="row"><div class="row" style="justify-content:flex-start;gap:10px"><span class="fl-dot">${esc(f.name.slice(0, 1))}</span><b style="font-size:16px">${esc(f.name)}</b></div>
        <button type="button" class="btn-small" data-unfriend="${f.fid}">${unfriendArmed === f.fid ? '確定解除？' : '解除'}</button></div>
      <span class="muted">即時位置：${liveTxt}</span>
      <span class="muted">${f.shareFoot ? `足跡 ${stN.toLocaleString()} 處` : '沒有分享足跡'} · 分享的紀錄 ${recN} 筆</span>
      <div class="row"><span>把我的即時位置分享給${esc(f.name)}</span><span class="switch"><input type="checkbox" data-live="${f.id}" ${f.iShare ? 'checked' : ''} aria-label="分享即時位置給${esc(f.name)}"><i></i></span></div>
      <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn-small" data-find="${f.id}">在地圖上找</button>
        <button type="button" class="btn-small" data-recs="${f.id}" ${recN ? '' : 'disabled'}>看紀錄</button>
      </div>
    </div>`;
  }
  const home = priv && priv.home_lat != null;
  html += `<div class="group-label">隱私</div>
  <div class="card settings-list">
    <div class="row"><div class="stack"><b>分享足跡給好友</b><span class="muted">好友會看到你解開的範圍（只有日期，沒有時間）</span></div>
      <span class="switch"><input type="checkbox" id="shareFoot" ${me && me.share_footprints ? 'checked' : ''} aria-label="分享足跡給好友"><i></i></span></div>
    <div class="stack"><b>即時位置的精確度</b>
      <div class="seg wide" role="group" aria-label="即時位置精確度">
        <button type="button" id="precOn" class="${S().livePrecise !== false ? 'on' : ''}" aria-pressed="${S().livePrecise !== false}">精確位置</button>
        <button type="button" id="precOff" class="${S().livePrecise === false ? 'on' : ''}" aria-pressed="${S().livePrecise === false}">只顯示大概（約 2 公里）</button>
      </div>
      <span class="muted">只會分享給你上面打開開關的好友；網頁開著時才會更新</span></div>
    <div class="row"><div class="stack"><b>住家保護區</b><span class="muted">${home ? `已設定，半徑 ${priv.home_r} 公尺：這裡的足跡不會上傳，人在這附近時即時位置會隱藏` : '設定後，家附近的足跡不會上傳，人在家時即時位置會自動隱藏'}</span></div></div>
    <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
      <label for="homeR" class="visually-hidden">保護區半徑</label>
      <select id="homeR">${[300, 500, 1000, 2000].map((r) => `<option value="${r}" ${(priv ? priv.home_r : 500) === r ? 'selected' : ''}>半徑 ${r >= 1000 ? r / 1000 + ' 公里' : r + ' 公尺'}</option>`).join('')}</select>
      <button type="button" class="btn-small" id="homeHere">設為目前位置</button>
      ${home ? '<button type="button" class="btn-small" id="homeClear">取消保護區</button>' : ''}
    </div>
    <div class="row"><div class="stack"><b>停止所有即時位置分享</b><span class="muted">關掉所有好友的開關，並刪除雲端上的位置</span></div>
      <button type="button" class="btn-small" id="stopLive">全部停止</button></div>
  </div>
  <div class="row" style="justify-content:center;gap:8px">
    <button type="button" class="btn-small" id="syncNow">立即同步</button>
    <button type="button" class="btn-small" id="signOut">登出</button>
  </div>
  <p class="muted" style="text-align:center">「只有自己」的紀錄也會備份到雲端，但只有你看得到。</p>`;
  body.innerHTML = html;
  bindMain(body);
}

function bindMain(body) {
  const $ = ctx.$;
  $('copyCode').onclick = async () => {
    try { await navigator.clipboard.writeText(me.friend_code); ctx.toast('已複製好友碼'); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($('myCode')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ctx.toast('請長按好友碼複製'); }
  };
  $('renameBtn').onclick = () => {
    const card = $('renameBtn').closest('.stack');
    card.innerHTML = `<label class="muted" for="nameIn">我的名字</label><form id="nameForm" class="row" style="gap:8px"><input id="nameIn" class="code-input" style="text-transform:none;letter-spacing:0" maxlength="30" value="${ctx.esc(me.display_name)}"><button type="submit" class="btn-small">儲存</button></form>`;
    $('nameIn').focus();
    $('nameForm').onsubmit = async (e) => {
      e.preventDefault();
      const v = $('nameIn').value.trim();
      if (!v) return;
      try { await cloud.updateProfile({ display_name: v }); me.display_name = v; ctx.toast('已更新名字'); render(); } catch (err) { ctx.toast(err.message); }
    };
  };
  $('addForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('codeIn').value.trim().toUpperCase();
    if (code.length !== 6) { ctx.toast('好友碼是 6 個英文字母或數字'); return; }
    try {
      const r = await cloud.addFriend(code);
      ctx.toast({ sent: '已送出邀請，等對方接受', accepted: '你們已經是好友了！', already: '你們已經是好友了', pending: '已經送過邀請，等對方接受', self: '這是你自己的好友碼', not_found: '找不到這個好友碼，請再確認一次' }[r] || r);
      await refreshFriends();
      render();
    } catch (err) { ctx.toast(err.message); }
  };
  for (const b of body.querySelectorAll('[data-accept]')) b.onclick = async () => {
    try { await cloud.acceptFriend(+b.dataset.accept); ctx.toast('已成為好友'); await refreshFriends(); render(); } catch (err) { ctx.toast(err.message); }
  };
  for (const b of body.querySelectorAll('[data-decline]')) b.onclick = async () => {
    try { await cloud.removeFriendship(+b.dataset.decline); await refreshFriends(); render(); } catch (err) { ctx.toast(err.message); }
  };
  for (const b of body.querySelectorAll('[data-unfriend]')) b.onclick = async () => {
    const id = +b.dataset.unfriend;
    if (unfriendArmed !== id) { unfriendArmed = id; render(); return; }
    unfriendArmed = null;
    try { await cloud.removeFriendship(id); ctx.toast('已解除好友'); await refreshFriends(); render(); } catch (err) { ctx.toast(err.message); }
  };
  for (const i of body.querySelectorAll('[data-live]')) i.onchange = async () => {
    try {
      await cloud.setLiveShare(i.dataset.live, i.checked);
      const f = net.friends.find((x) => x.id === i.dataset.live);
      if (f) f.iShare = i.checked;
      lastLivePush = 0;
      if (i.checked) { ctx.toast(`開始分享即時位置給${f ? f.name : '好友'}`); onPosition(ctx.getMyPos()); if (!ctx.getMyPos()) ctx.toast('按「開始探索」或定位按鈕後，好友就會看到你的位置', 5000); }
      else ctx.toast(`已停止分享給${f ? f.name : '好友'}`);
    } catch (err) { i.checked = !i.checked; ctx.toast(err.message); }
  };
  for (const b of body.querySelectorAll('[data-find]')) b.onclick = () => findFriend(b.dataset.find);
  for (const b of body.querySelectorAll('[data-recs]')) b.onclick = () => renderFriendRecords(b.dataset.recs);
  $('showFr').onchange = (e) => { S().showFriends = e.target.checked; ctx.saveSettings(); drawFriendLayers(); };
  $('shareFoot').onchange = async (e) => {
    try { await cloud.updateProfile({ share_footprints: e.target.checked }); me.share_footprints = e.target.checked; ctx.toast(e.target.checked ? '好友可以看到你的足跡了' : '已停止分享足跡'); }
    catch (err) { e.target.checked = !e.target.checked; ctx.toast(err.message); }
  };
  $('precOn').onclick = () => { S().livePrecise = true; ctx.saveSettings(); lastLivePush = 0; onPosition(ctx.getMyPos()); render(); };
  $('precOff').onclick = () => { S().livePrecise = false; ctx.saveSettings(); lastLivePush = 0; onPosition(ctx.getMyPos()); render(); };
  $('homeHere').onclick = async () => {
    const p = ctx.getMyPos();
    if (!p) { ctx.toast('還沒有定位：請先按地圖上的定位按鈕，再回來設定'); return; }
    const r = +$('homeR').value;
    try {
      priv = { ...priv, home_lat: +p.a.toFixed(5), home_lng: +p.o.toFixed(5), home_r: r };
      await cloud.setPrivate({ home_lat: priv.home_lat, home_lng: priv.home_lng, home_r: r });
      const n = await cloud.deleteStampsInHome(priv);
      lastLivePush = 0; onPosition(p);
      ctx.toast(`住家保護區已設定${n ? `，雲端上刪除了 ${n} 處足跡` : ''}`);
      render();
    } catch (err) { ctx.toast(err.message); }
  };
  $('homeR').onchange = async () => {
    if (!priv || priv.home_lat == null) return;
    priv.home_r = +$('homeR').value;
    try { await cloud.setPrivate({ home_r: priv.home_r, home_lat: priv.home_lat, home_lng: priv.home_lng }); await cloud.deleteStampsInHome(priv); render(); } catch (err) { ctx.toast(err.message); }
  };
  if ($('homeClear')) $('homeClear').onclick = async () => {
    try { priv = { ...priv, home_lat: null, home_lng: null }; await cloud.setPrivate({ home_lat: null, home_lng: null }); cloudState().stampsSynced = 0; ctx.saveSettings(); ctx.toast('已取消住家保護區'); render(); pushChanges(true); }
    catch (err) { ctx.toast(err.message); }
  };
  $('stopLive').onclick = async () => {
    try { await cloud.stopAllLive(); for (const f of net.friends) f.iShare = false; ctx.toast('已停止所有即時位置分享'); render(); } catch (err) { ctx.toast(err.message); }
  };
  $('syncNow').onclick = async () => { ctx.toast('同步中…'); await fullSync(); ctx.toast('同步完成'); };
  $('signOut').onclick = async () => { await cloud.signOut(); ctx.toast('已登出，手機裡的資料都還在'); };
}

function renderAuth(body) {
  const up = authMode === 'signup';
  body.innerHTML = `<div class="card">
    <div class="card-title">和朋友一起解開地圖</div>
    <p class="muted" style="margin:0">登入後可以互相看足跡、看朋友記錄的店家和美食，也能選擇把即時位置分享給特定好友。資料會備份到雲端，換手機也不會不見。</p>
  </div>
  <div class="seg wide" role="group" aria-label="登入或註冊">
    <button type="button" id="modeIn" class="${up ? '' : 'on'}" aria-pressed="${!up}">登入</button>
    <button type="button" id="modeUp" class="${up ? 'on' : ''}" aria-pressed="${up}">註冊新帳號</button>
  </div>
  <form class="form card" id="authForm" novalidate>
    ${up ? `<label class="field" for="aName"><span>名字（朋友會看到）</span><input id="aName" type="text" maxlength="30" autocomplete="nickname" placeholder="例如：小霧"></label>` : ''}
    <label class="field" for="aEmail"><span>Email</span><input id="aEmail" type="text" inputmode="email" autocomplete="email" autocapitalize="off" placeholder="you@example.com"></label>
    <label class="field" for="aPw"><span>密碼${up ? '（至少 6 個字元）' : ''}</span><input id="aPw" type="password" autocomplete="${up ? 'new-password' : 'current-password'}"></label>
    <button type="submit" class="btn-primary" id="authBtn">${up ? '註冊' : '登入'}</button>
    <p class="hint" id="authMsg"></p>
  </form>
  <div class="card">
    <b>隱私承諾</b>
    <span class="muted">・「只有自己」的紀錄，好友和其他人都看不到<br>・即時位置預設不分享，要一個一個好友打開<br>・可以設定住家保護區，家附近的足跡不會上傳<br>・足跡只記日期，不記幾點幾分</span>
  </div>`;
  const $ = ctx.$;
  $('modeIn').onclick = () => { authMode = 'signin'; renderAuth(body); };
  $('modeUp').onclick = () => { authMode = 'signup'; renderAuth(body); };
  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('aEmail').value.trim(), pw = $('aPw').value;
    const msg = $('authMsg');
    if (!email || !pw) { msg.textContent = '請輸入 Email 和密碼'; return; }
    $('authBtn').disabled = true;
    msg.textContent = up ? '註冊中…' : '登入中…';
    try {
      if (up) {
        const name = ($('aName').value || '').trim() || '旅人';
        const r = await cloud.signUp(email, pw, name);
        if (r.needConfirm) {
          authMode = 'signin';
          renderAuth(body);
          ctx.$('aEmail').value = email;
          ctx.$('authMsg').textContent = '已寄出確認信。請到信箱點信裡的連結（打開的網頁如果顯示錯誤也沒關係），再回來這裡登入。';
        }
      } else {
        await cloud.signIn(email, pw);
      }
    } catch (err) {
      msg.textContent = err.message;
      $('authBtn').disabled = false;
    }
  };
}

function findFriend(id) {
  const l = fLive.find((x) => x.user_id === id && x.lat != null);
  const map = ctx.map();
  if (S().showFriends === false) { S().showFriends = true; ctx.saveSettings(); drawFriendLayers(); }
  if (l) { ctx.setTab('map'); map.flyTo({ center: [l.lng, l.lat], zoom: l.precise ? 15 : 11, duration: 900 }); return; }
  const st = fStamps.get(id) || [];
  if (st.length) {
    let minA = 90, maxA = -90, minO = 180, maxO = -180;
    for (const s of st) { minA = Math.min(minA, s.a); maxA = Math.max(maxA, s.a); minO = Math.min(minO, s.o); maxO = Math.max(maxO, s.o); }
    ctx.setTab('map');
    map.fitBounds([[minO, minA], [maxO, maxA]], { padding: { top: 170, bottom: 190, left: 40, right: 40 }, maxZoom: 15, duration: 900 });
    ctx.toast(`${nameOf(id)}的足跡用這個顏色顯示`, 3000);
    return;
  }
  ctx.toast(`${nameOf(id)}還沒有分享位置或足跡`);
}

function recCard(r) {
  const esc = ctx.esc, cat = ctx.catOf(r.cat);
  const stars = r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '';
  return `<button type="button" class="rec" data-frec="${esc(r.user_id)}|${esc(r.id)}">
    <span class="rec-thumb">${ctx.ICON[r.cat] || ''}</span>
    <span class="rec-main"><span class="rec-name">${esc(r.name)}</span>
      <span class="rec-meta"><span class="tag cat-${r.cat}">${ctx.ICON[r.cat]}${cat.label}</span>${stars ? `<span class="stars-ro">${stars}</span>` : ''}${r.price ? `<span>${esc(r.price)}</span>` : ''}</span>
      ${r.note ? `<span class="rec-note">${esc(r.note)}</span>` : ''}
      <span class="rec-meta"><span>${esc(ctx.regionLabel(r.c, r.k))}</span><span>${ctx.fmtDay(Number(r.t))}</span></span></span>
  </button>`;
}

function renderFriendRecords(id) {
  view = 'friendRecords:' + id;
  ctx.$('sheetTitle').textContent = nameOf(id) + '的紀錄';
  const list = fRecords.filter((r) => r.user_id === id).sort((a, b) => b.t - a.t);
  ctx.$('sheetBody').innerHTML = `<button type="button" class="btn-ghost" id="frBack">回到好友</button>` + list.map(recCard).join('');
  ctx.$('sheetBody').scrollTop = 0;
  ctx.$('frBack').onclick = () => render();
  bindRecs();
}

function bindRecs() {
  for (const b of ctx.$('sheetBody').querySelectorAll('[data-frec]')) b.onclick = () => {
    const [uid, rid] = b.dataset.frec.split('|');
    const r = fRecords.find((x) => x.user_id === uid && x.id === rid);
    if (r) openFriendRecord(r);
  };
}

async function openFriendRecord(r) {
  ctx.openSheetFor('friends');
  view = 'record';
  const esc = ctx.esc;
  ctx.$('sheetTitle').textContent = nameOf(r.user_id) + '的' + ctx.catOf(r.cat).label;
  const stars = r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : '';
  ctx.$('sheetBody').innerHTML = `<div id="frPhoto"></div>
    <div class="stack"><div class="card-title" style="font-size:24px">${esc(r.name)}</div>
      <div class="rec-meta"><span class="tag cat-${r.cat}">${ctx.ICON[r.cat]}${ctx.catOf(r.cat).label}</span>${stars ? `<span class="stars-ro">${stars}</span>` : ''}${r.price ? `<span>${esc(r.price)}</span>` : ''}</div></div>
    ${r.note ? `<p style="margin:0;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.note)}</p>` : ''}
    <div class="card"><div class="row"><span class="muted">地點</span><span>${esc(ctx.regionLabel(r.c, r.k))}</span></div>
      <div class="row"><span class="muted">時間</span><span>${ctx.fmtDay(Number(r.t))}</span></div>
      <div class="row"><span class="muted">記錄的人</span><span>${esc(nameOf(r.user_id))}</span></div></div>
    <div class="row" style="gap:10px"><button type="button" class="btn-ghost" style="flex:1" id="frBack2">${esc(nameOf(r.user_id))}的所有紀錄</button>
      <button type="button" class="btn-primary" id="frMap">在地圖上看</button></div>`;
  ctx.$('sheetBody').scrollTop = 0;
  ctx.$('frBack2').onclick = () => renderFriendRecords(r.user_id);
  ctx.$('frMap').onclick = () => { ctx.setTab('map'); ctx.map().flyTo({ center: [r.o, r.a], zoom: Math.max(ctx.map().getZoom(), 16), duration: 800 }); };
  if (r.photo_path) {
    const blob = await cloud.downloadPhoto(r.photo_path);
    if (blob && ctx.$('frPhoto')) ctx.$('frPhoto').innerHTML = `<img class="detail-photo" alt="${esc(r.name)}的照片" src="${URL.createObjectURL(blob)}">`;
  }
}

