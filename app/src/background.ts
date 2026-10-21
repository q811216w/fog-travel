// 背景定位：app 在背景時，系統把位置交給這個任務，先存在手機裡，
// 下次打開 app 時再交給網頁解開迷霧。
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const TASK = 'fog-background-location';
const QUEUE_KEY = 'fog-queue';
const ENABLED_KEY = 'fog-bg-enabled';
const MAX_POINTS = 60000;

export type QueuedPoint = { a: number; o: number; acc: number; sp: number | null; t: number };

// 多次寫入時排隊處理，避免同時讀寫把點弄丟
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function readQueue(): Promise<QueuedPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPoint[]) : [];
  } catch {
    return [];
  }
}

export function appendPoints(points: QueuedPoint[]) {
  return serial(async () => {
    const q = await readQueue();
    q.push(...points);
    const trimmed = q.length > MAX_POINTS ? q.slice(q.length - MAX_POINTS) : q;
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
  });
}

// 網頁處理完前 count 個點後，把它們從佇列移除
export function ackPoints(count: number) {
  return serial(async () => {
    const q = await readQueue();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(count)));
  });
}

TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const points: QueuedPoint[] = [];
  for (const l of locations || []) {
    const acc = l.coords.accuracy ?? 999;
    if (acc > 100) continue; // 誤差太大的點不要
    points.push({
      a: l.coords.latitude,
      o: l.coords.longitude,
      acc,
      sp: l.coords.speed != null && l.coords.speed >= 0 ? l.coords.speed : null,
      t: l.timestamp,
    });
  }
  if (points.length) await appendPoints(points);
});

export type BgState = { enabled: boolean; foreground: string; background: string };

export async function getBgState(): Promise<BgState> {
  const [fg, bg, running, flag] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false),
    AsyncStorage.getItem(ENABLED_KEY),
  ]);
  return { enabled: running && flag === '1', foreground: fg.status, background: bg.status };
}

async function startUpdates() {
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High,
    distanceInterval: 20,
    activityType: Location.ActivityType.Fitness,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    // 在背景時把點累積起來一次交付，比較省電
    deferredUpdatesInterval: 60000,
    deferredUpdatesDistance: 150,
    foregroundService: {
      notificationTitle: '霧旅正在記錄足跡',
      notificationBody: '走過的地方會自動從迷霧中解開',
      notificationColor: '#B8603F',
      killServiceOnDestroy: false,
    },
  });
}

export async function setBackground(on: boolean): Promise<BgState> {
  if (on) {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return getBgState();
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return getBgState();
    if (!(await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false))) await startUpdates();
    await AsyncStorage.setItem(ENABLED_KEY, '1');
  } else {
    if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)) await Location.stopLocationUpdatesAsync(TASK);
    await AsyncStorage.setItem(ENABLED_KEY, '0');
  }
  return getBgState();
}

// app 被系統重新啟動後，如果使用者有打開背景記錄，就確保它還在跑
export async function ensureRunning() {
  const flag = await AsyncStorage.getItem(ENABLED_KEY);
  if (flag !== '1') return;
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return;
  if (!(await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false))) await startUpdates();
}
