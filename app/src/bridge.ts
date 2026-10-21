// 在網頁載入前注入：讓網頁知道自己在 app 裡，並把網頁的定位改由 app 提供
// （避免 iPhone 每次打開都跳出「網站想使用你的位置」）。
export const INJECTED = `
(function () {
  if (window.__fogNative) return;
  var cbs = {}, seq = 0;
  function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  window.__fogNativeReceive = function (m) {
    if (m.type === 'geo-pos' || m.type === 'geo-err') {
      var c = cbs[m.id];
      if (!c) return;
      if (m.type === 'geo-pos') { if (c.ok) c.ok({ coords: m.coords, timestamp: m.timestamp }); }
      else if (c.err) c.err({ code: m.code, message: m.message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
      if (c.once) delete cbs[m.id];
      return;
    }
    if (window.__fogApp && window.__fogApp.onNative) window.__fogApp.onNative(m);
    else (window.__fogPending = window.__fogPending || []).push(m);
  };
  window.__fogNative = { isApp: true, post: post };
  var geo = {
    getCurrentPosition: function (ok, err, opts) { var id = ++seq; cbs[id] = { ok: ok, err: err, once: true }; post({ type: 'geo-once', id: id, opts: opts || {} }); },
    watchPosition: function (ok, err, opts) { var id = ++seq; cbs[id] = { ok: ok, err: err }; post({ type: 'geo-watch', id: id, opts: opts || {} }); return id; },
    clearWatch: function (id) { delete cbs[id]; post({ type: 'geo-clear', id: id }); }
  };
  try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}
  function mark() { if (document.documentElement) document.documentElement.classList.add('in-app'); }
  if (document.documentElement) mark(); else document.addEventListener('DOMContentLoaded', mark);
})();
true;
`;

export function toWeb(msg: unknown) {
  return `window.__fogNativeReceive && window.__fogNativeReceive(${JSON.stringify(msg)}); true;`;
}
