import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ComponentType, Ref } from 'react';

// react-native-webview 14 的型別定義和目前的 React 型別不合（props 會被推成 never），執行上沒有問題
const FogWebView = WebView as unknown as ComponentType<Record<string, unknown> & { ref?: Ref<WebView> }>;

import { ackPoints, ensureRunning, getBgState, readQueue, setBackground } from './src/background';
import { INJECTED, toWeb } from './src/bridge';

// 畫面直接使用霧旅網站：網站更新時，app 打開就是最新版
const SITE_HOST = 'travel-fog.netlify.app';
const SITE = `https://${SITE_HOST}/?app=1`;
const ALLOWED_HOSTS = [SITE_HOST, 'bnunlzlutmaiiwrniksk.supabase.co'];

type Msg = { type: string; id?: number; on?: boolean; count?: number; url?: string; opts?: { enableHighAccuracy?: boolean } };

export default function App() {
  const web = useRef<WebView>(null);
  const watches = useRef(new Map<number, Location.LocationSubscription>());
  const [failed, setFailed] = useState(false);

  const send = useCallback((msg: unknown) => {
    web.current?.injectJavaScript(toWeb(msg));
  }, []);

  const sendQueue = useCallback(async () => {
    const points = await readQueue();
    send({ type: 'queue', points });
  }, [send]);

  const sendBgState = useCallback(async () => {
    send({ type: 'bg-state', ...(await getBgState()) });
  }, [send]);

  // 回到 app 時：把背景期間記下的點交給網頁
  useEffect(() => {
    ensureRunning().catch(() => undefined);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        sendQueue();
        sendBgState();
      }
    });
    return () => sub.remove();
  }, [sendQueue, sendBgState]);

  useEffect(() => () => {
    for (const w of watches.current.values()) w.remove();
  }, []);

  const toCoords = (l: Location.LocationObject) => ({
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    accuracy: l.coords.accuracy ?? 50,
    altitude: l.coords.altitude,
    altitudeAccuracy: l.coords.altitudeAccuracy,
    heading: l.coords.heading,
    speed: l.coords.speed != null && l.coords.speed >= 0 ? l.coords.speed : null,
  });

  const ensureForeground = async () => {
    const cur = await Location.getForegroundPermissionsAsync();
    if (cur.status === 'granted') return true;
    const req = await Location.requestForegroundPermissionsAsync();
    return req.status === 'granted';
  };

  const onMessage = useCallback(async (e: WebViewMessageEvent) => {
    let m: Msg;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    try {
      switch (m.type) {
        case 'geo-once': {
          if (!(await ensureForeground())) { send({ type: 'geo-err', id: m.id, code: 1, message: 'permission denied' }); break; }
          const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          send({ type: 'geo-pos', id: m.id, coords: toCoords(l), timestamp: l.timestamp });
          break;
        }
        case 'geo-watch': {
          if (!(await ensureForeground())) { send({ type: 'geo-err', id: m.id, code: 1, message: 'permission denied' }); break; }
          const sub = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 2000 },
            (l) => send({ type: 'geo-pos', id: m.id, coords: toCoords(l), timestamp: l.timestamp }),
          );
          watches.current.set(m.id!, sub);
          break;
        }
        case 'geo-clear': {
          watches.current.get(m.id!)?.remove();
          watches.current.delete(m.id!);
          break;
        }
        case 'bg-get':
          await sendBgState();
          break;
        case 'bg-set': {
          const st = await setBackground(!!m.on);
          send({ type: 'bg-state', ...st });
          break;
        }
        case 'queue-pull':
          await sendQueue();
          break;
        case 'queue-ack':
          if (m.count) await ackPoints(m.count);
          break;
        case 'open-settings':
          await Linking.openSettings();
          break;
        case 'open-url':
          if (m.url && /^https:\/\//.test(m.url)) await Linking.openURL(m.url);
          break;
      }
    } catch (err) {
      if (m.type.startsWith('geo-') && m.id) send({ type: 'geo-err', id: m.id, code: 2, message: String(err) });
    }
  }, [send, sendBgState, sendQueue]);

  if (failed) {
    return (
      <View style={styles.offline}>
        <StatusBar style="dark" />
        <Text style={styles.title}>連不上霧旅</Text>
        <Text style={styles.body}>請確認網路連線後再試一次。背景記錄不受影響，走過的地方都會先存在手機裡。</Text>
        <Pressable accessibilityRole="button" style={styles.btn} onPress={() => setFailed(false)}>
          <Text style={styles.btnText}>重新連線</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <FogWebView
        ref={web}
        source={{ uri: SITE }}
        style={styles.root}
        originWhitelist={['https://*']}
        injectedJavaScriptBeforeContentLoaded={INJECTED}
        onMessage={onMessage}
        onLoadEnd={() => { sendBgState(); sendQueue(); }}
        onError={() => setFailed(true)}
        onContentProcessDidTerminate={() => web.current?.reload()}
        onShouldStartLoadWithRequest={(req: { url: string }) => {
          try {
            const host = new URL(req.url).host;
            if (req.url.startsWith('blob:') || req.url.startsWith('data:') || req.url === 'about:blank') return true;
            if (ALLOWED_HOSTS.includes(host)) return true;
            Linking.openURL(req.url).catch(() => undefined);
            return false;
          } catch {
            return true;
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        geolocationEnabled={false}
        allowsBackForwardNavigationGestures={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        bounces={false}
        overScrollMode="never"
        pullToRefreshEnabled={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F4EEE2' },
  offline: { flex: 1, backgroundColor: '#F4EEE2', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: '#2E2A24' },
  body: { fontSize: 15, lineHeight: 22, color: '#5A5146', textAlign: 'center' },
  btn: { marginTop: 8, backgroundColor: '#2E2A24', paddingHorizontal: 24, minHeight: 48, borderRadius: 14, justifyContent: 'center' },
  btnText: { color: '#FBF7EE', fontSize: 16, fontWeight: '600' },
});
