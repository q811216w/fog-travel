// 雲端：帳號、資料同步、好友。後端是 Supabase，存取規則寫在資料庫裡，
// 所以就算有人改了網頁程式，也拿不到別人沒有分享的東西。
import { stampKey, distM } from './model.js';

const URL_ = 'https://bnunlzlutmaiiwrniksk.supabase.co';
// 這是公開用的金鑰，本來就會放在網頁裡；真正的保護在資料庫的存取規則
const KEY = 'sb_publishable_s0IFuchZ4-PpVXAW-VNm0Q_TYWDIGZB';
const DAY = 86400000;

let sb = null;
export let user = null;

export function client() {
  if (!sb && window.supabase) {
    sb = window.supabase.createClient(URL_, KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'fog-travel-auth' }
    });
  }
  return sb;
}

export async function init(onChange) {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  user = data.session ? data.session.user : null;
  c.auth.onAuthStateChange((_ev, session) => {
    const next = session ? session.user : null;
    const changed = (next && next.id) !== (user && user.id);
    user = next;
    if (changed) onChange(user);
  });
  return user;
}

function zhError(e) {
  const m = (e && e.message) || String(e || '');
  if (/Invalid login credentials/i.test(m)) return 'Email 或密碼不對';
  if (/Email not confirmed/i.test(m)) return '還沒完成 Email 驗證：請先到信箱點確認連結';
  if (/User already registered/i.test(m)) return '這個 Email 已經註冊過了，請直接登入';
  if (/Password should be at least/i.test(m)) return '密碼至少要 6 個字元';
  if (/rate limit|too many/i.test(m)) return '嘗試太多次了，請過幾分鐘再試';
  if (/valid email|invalid format/i.test(m)) return 'Email 格式不正確';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return '連不上伺服器，請確認網路';
  return m || '發生錯誤，請再試一次';
}
export { zhError };

export async function signUp(email, password, name) {
  const { data, error } = await client().auth.signUp({
    email, password,
    options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname }
  });
  if (error) throw new Error(zhError(error));
  return { needConfirm: !data.session };
}

export async function signIn(email, password) {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new Error(zhError(error));
}

export async function signOut() { await client().auth.signOut(); }

// ---------- 自己的資料 ----------
export async function myProfile() {
  const { data, error } = await client().from('profiles').select('*').eq('id', user.id).single();
  if (error) throw new Error(zhError(error));
  return data;
}

export async function updateProfile(patch) {
  const { error } = await client().from('profiles').update(patch).eq('id', user.id);
  if (error) throw new Error(zhError(error));
}

export async function getPrivate() {
  const { data } = await client().from('private_settings').select('*').eq('user_id', user.id).maybeSingle();
  return data || { home_lat: null, home_lng: null, home_r: 500 };
}

export async function setPrivate(patch) {
  const { error } = await client().from('private_settings').upsert({ user_id: user.id, ...patch });
  if (error) throw new Error(zhError(error));
}

export function inHome(home, a, o) {
  return !!(home && home.home_lat != null && distM(home.home_lat, home.home_lng, a, o) < home.home_r);
}

// 上傳足跡：範例資料不上傳，住家保護區裡的不上傳，只存日期不存時間
export async function pushStamps(stamps, from, home, onProgress) {
  const rows = [];
  for (let i = from; i < stamps.length; i++) {
    const s = stamps[i];
    if (s.d || inHome(home, s.a, s.o)) continue;
    rows.push({ user_id: user.id, key: stampKey(s.a, s.o, s.r), a: +s.a.toFixed(6), o: +s.o.toFixed(6), r: s.r, d: Math.floor(s.t / DAY) });
  }
  for (let i = 0; i < rows.length; i += 800) {
    const { error } = await client().from('stamps').upsert(rows.slice(i, i + 800), { onConflict: 'user_id,key', ignoreDuplicates: true });
    if (error) throw new Error(zhError(error));
    if (onProgress) onProgress(Math.min(rows.length, i + 800), rows.length);
  }
  return rows.length;
}

// 設定住家保護區後，刪掉雲端上保護區裡的足跡
export async function deleteStampsInHome(home) {
  if (!home || home.home_lat == null) return 0;
  const dLat = home.home_r / 111320, dLng = dLat / Math.cos(home.home_lat * Math.PI / 180);
  const { data, error } = await client().from('stamps').select('id,a,o').eq('user_id', user.id)
    .gte('a', home.home_lat - dLat).lte('a', home.home_lat + dLat)
    .gte('o', home.home_lng - dLng).lte('o', home.home_lng + dLng).limit(5000);
  if (error) throw new Error(zhError(error));
  const ids = (data || []).filter((s) => inHome(home, s.a, s.o)).map((s) => s.id);
  for (let i = 0; i < ids.length; i += 300) {
    await client().from('stamps').delete().in('id', ids.slice(i, i + 300));
  }
  return ids.length;
}

export async function pullMyStamps() {
  const out = [];
  let last = 0;
  for (;;) {
    const { data, error } = await client().from('stamps').select('id,a,o,r,d').eq('user_id', user.id).gt('id', last).order('id').limit(1000);
    if (error) throw new Error(zhError(error));
    out.push(...data);
    if (data.length < 1000) break;
    last = data[data.length - 1].id;
  }
  return out;
}

export async function pushRecord(r, photoBlob) {
  let photo_path = r.cloudPhoto || null;
  if (photoBlob && r.photo && r.cloudPhotoId !== r.photo) {
    const path = `${user.id}/${r.photo}.jpg`;
    const { error } = await client().storage.from('photos').upload(path, photoBlob, { contentType: 'image/jpeg', upsert: true });
    if (!error) { photo_path = path; r.cloudPhoto = path; r.cloudPhotoId = r.photo; }
  }
  if (!r.photo) { photo_path = null; r.cloudPhoto = null; r.cloudPhotoId = null; }
  const row = {
    user_id: user.id, id: r.id, cat: r.cat, name: r.name.slice(0, 60), rating: r.rating || 0,
    price: (r.price || '').slice(0, 20), note: (r.note || '').slice(0, 600), vis: r.vis,
    a: r.a, o: r.o, c: r.c, k: r.k, t: r.t, photo_path, updated_at: new Date().toISOString()
  };
  const { error } = await client().from('records').upsert(row, { onConflict: 'user_id,id' });
  if (error) throw new Error(zhError(error));
}

export async function deleteRecord(r) {
  await client().from('records').delete().eq('user_id', user.id).eq('id', r.id);
  if (r.cloudPhoto) await client().storage.from('photos').remove([r.cloudPhoto]);
}

export async function pullMyRecords() {
  const { data, error } = await client().from('records').select('*').eq('user_id', user.id);
  if (error) throw new Error(zhError(error));
  return data || [];
}

export async function downloadPhoto(path) {
  const { data, error } = await client().storage.from('photos').download(path);
  return error ? null : data;
}

// ---------- 好友 ----------
export async function addFriend(code) {
  const { data, error } = await client().rpc('add_friend', { code });
  if (error) throw new Error(zhError(error));
  return data;
}

export async function acceptFriend(id) {
  const { data, error } = await client().rpc('accept_friend', { req_id: id });
  if (error) throw new Error(zhError(error));
  return data;
}

export async function removeFriendship(id) {
  const { error } = await client().from('friendships').delete().eq('id', id);
  if (error) throw new Error(zhError(error));
}

// 好友、邀請、對方的名字
export async function loadFriends() {
  const { data: fs, error } = await client().from('friendships').select('*');
  if (error) throw new Error(zhError(error));
  const ids = [...new Set(fs.flatMap((f) => [f.requester, f.addressee]).filter((id) => id !== user.id))];
  const profiles = {};
  if (ids.length) {
    const { data } = await client().from('profiles').select('id,display_name,share_footprints').in('id', ids);
    for (const p of data || []) profiles[p.id] = p;
  }
  const { data: shares } = await client().from('live_shares').select('owner,viewer');
  const iShareTo = new Set((shares || []).filter((s) => s.owner === user.id).map((s) => s.viewer));
  const sharesToMe = new Set((shares || []).filter((s) => s.viewer === user.id).map((s) => s.owner));
  const friends = [], incoming = [], outgoing = [];
  for (const f of fs) {
    const other = f.requester === user.id ? f.addressee : f.requester;
    const item = { fid: f.id, id: other, name: (profiles[other] && profiles[other].display_name) || '旅人', shareFoot: profiles[other] ? profiles[other].share_footprints : false, iShare: iShareTo.has(other), sharesToMe: sharesToMe.has(other), since: f.created_at };
    if (f.status === 'accepted') friends.push(item);
    else if (f.addressee === user.id) incoming.push(item);
    else outgoing.push(item);
  }
  return { friends, incoming, outgoing };
}

export async function setLiveShare(viewer, on) {
  const q = client().from('live_shares');
  const { error } = on ? await q.upsert({ owner: user.id, viewer }) : await q.delete().eq('owner', user.id).eq('viewer', viewer);
  if (error) throw new Error(zhError(error));
}

export async function stopAllLive() {
  await client().from('live_shares').delete().eq('owner', user.id);
  await client().from('live_locations').delete().eq('user_id', user.id);
}

export async function pushLive(loc) {
  const { error } = await client().from('live_locations').upsert({ user_id: user.id, ...loc, updated_at: new Date().toISOString() });
  if (error) throw new Error(zhError(error));
}

export async function friendLive() {
  const { data } = await client().from('live_locations').select('*').neq('user_id', user.id);
  return data || [];
}

export async function friendRecords() {
  const { data } = await client().from('records').select('*').neq('user_id', user.id).order('t', { ascending: false }).limit(1000);
  return data || [];
}

// 好友足跡：只抓新的（id 比上次大）
export async function friendStamps(sinceId) {
  const out = [];
  let last = sinceId || 0;
  for (let page = 0; page < 60; page++) {
    const { data, error } = await client().from('stamps').select('id,user_id,a,o,r').neq('user_id', user.id).gt('id', last).order('id').limit(1000);
    if (error) break;
    out.push(...data);
    if (data.length < 1000) break;
    last = data[data.length - 1].id;
  }
  return out;
}

// ---------- 管理員（營運管理）：只有統計、使用者清單和公開紀錄 ----------
export async function amIAdmin() {
  const { data, error } = await client().rpc('am_i_admin');
  return !error && data === true;
}

async function rpcOrThrow(name, args) {
  const { data, error } = await client().rpc(name, args || {});
  if (error) {
    if (/Could not find the function|does not exist/i.test(error.message)) throw new Error('這個管理功能還沒開放');
    if (/cannot_self/.test(error.message)) throw new Error('不能對自己的帳號這樣做');
    if (/not_admin/.test(error.message)) throw new Error('你沒有管理員權限');
    throw new Error(zhError(error));
  }
  return data;
}

export const adminStats = () => rpcOrThrow('admin_stats');
export const adminUsers = () => rpcOrThrow('admin_users');
export const adminPublicRecords = () => rpcOrThrow('admin_public_records');
export const adminSetDisabled = (id, disable) => rpcOrThrow('admin_set_disabled', { target_user: id, disable });
export const adminDeleteUser = (id) => rpcOrThrow('admin_delete_user', { target_user: id });
export const adminDeletePublicRecord = (uid, id) => rpcOrThrow('admin_delete_public_record', { target_user: uid, record_id: id });
