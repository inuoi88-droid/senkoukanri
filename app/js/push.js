// プッシュ通知の購読
import { b64urlToBytes, isIOS, isStandalone } from './util.js';

const ENDPOINT_KEY = 'senkou:endpoint';

/** この端末でプッシュ通知が使えるか。使えない理由も返す。 */
export function pushSupport() {
  const hasSW = 'serviceWorker' in navigator;
  const hasPush = 'PushManager' in window && 'Notification' in window;
  if (hasSW && hasPush) return { ok: true };
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-browser' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  return { ok: false, reason: 'unsupported' };
}

export function permission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export function savedEndpoint() {
  try {
    return localStorage.getItem(ENDPOINT_KEY) || '';
  } catch {
    return '';
  }
}

function rememberEndpoint(ep) {
  try {
    if (ep) localStorage.setItem(ENDPOINT_KEY, ep);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // 無視
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

async function registration() {
  return withTimeout(navigator.serviceWorker.ready, 10000, 'Service Worker の準備ができませんでした。ページを再読み込みしてください。');
}

function sameKey(buf, key) {
  if (!buf) return true;
  const a = new Uint8Array(buf);
  return a.length === key.length && a.every((v, i) => v === key[i]);
}

export async function getSubscription() {
  if (!pushSupport().ok) return null;
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

/** 購読を作る（または既存のものを返す）。サーバーの鍵が変わっていたら作り直す。 */
export async function ensureSubscription(vapidPublicKey) {
  if (!vapidPublicKey) throw new Error('サーバーの通知用の鍵がありません。スプレッドシートで「① 初期設定」を実行してください。');
  const reg = await registration();
  const key = b64urlToBytes(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  rememberEndpoint(sub.endpoint);
  return sub;
}

/** ボタンから呼ぶ：許可を求めてから購読する */
export async function requestAndSubscribe(vapidPublicKey) {
  const support = pushSupport();
  if (!support.ok) {
    throw new Error(
      support.reason === 'ios-browser'
        ? 'iPhone では、共有ボタン →「ホーム画面に追加」をしてから、ホーム画面のアイコンでアプリを開いてください。'
        : 'このブラウザはプッシュ通知に対応していません。'
    );
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(
      perm === 'denied'
        ? '通知がブロックされています。端末の設定 → 通知 から「選考管理」の通知を許可してください。'
        : '通知が許可されませんでした。'
    );
  }
  return ensureSubscription(vapidPublicKey);
}

export async function unsubscribe() {
  const sub = await getSubscription();
  const ep = sub ? sub.endpoint : savedEndpoint();
  if (sub) await sub.unsubscribe();
  rememberEndpoint('');
  return ep;
}
