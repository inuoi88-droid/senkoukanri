// Service Worker：オフライン用キャッシュとプッシュ通知の表示
const VERSION = '1.0.0';
const CACHE = 'senkou-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/api.js',
  './js/config.js',
  './js/push.js',
  './js/store.js',
  './js/util.js',
  './js/views.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-72.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('senkou-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同じサイトのファイルは「ネット優先・だめならキャッシュ」。GAS への通信には触れない。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

// ---------- 接続設定（アプリが IndexedDB に保存したもの） ----------

function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('senkoukanri', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const g = db.transaction('kv').objectStore('kv').get(key);
        g.onsuccess = () => {
          resolve(g.result);
          db.close();
        };
        g.onerror = () => {
          resolve(undefined);
          db.close();
        };
      } catch {
        resolve(undefined);
      }
    };
  });
}

async function callApi(action, params) {
  const cfg = await idbGet('config');
  if (!cfg || !cfg.url) throw new Error('not connected');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...params, action, token: cfg.token }),
    redirect: 'follow',
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message || json.error);
  return json;
}

// ---------- プッシュ通知 ----------

self.addEventListener('push', (event) => {
  event.waitUntil(onPush(event));
});

async function onPush(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data || !data.title) {
    // 暗号化ペイロードを読めなかった場合はサーバーに直近の通知を聞きに行く
    try {
      const r = await callApi('recent', {});
      const last = (r.notifications || []).slice(-1)[0];
      if (last) data = { title: last.title, body: last.body, tag: last.key, url: '#/home' };
    } catch {
      // 取得できなければ汎用の文言
    }
  }
  if (!data || !data.title) data = { title: '選考管理', body: '新しいお知らせがあります。アプリを開いて確認してください。', url: '#/home' };

  const maxActions = (self.Notification && self.Notification.maxActions) || 0;
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-72.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: /^mail/.test(data.tag || ''),
    timestamp: Date.now(),
    data: { url: data.url || '#/home', mailIds: data.mailIds || null },
  };
  if (maxActions && Array.isArray(data.actions)) options.actions = data.actions.slice(0, maxActions);
  await self.registration.showNotification(data.title, options);

  if (data.mailIds && self.navigator.setAppBadge) {
    self.navigator.setAppBadge(data.mailIds.length).catch(() => {});
  }
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  if (event.action === 'confirm-mails' && d.mailIds) {
    event.waitUntil(
      callApi('confirmMails', { ids: d.mailIds })
        .then(() => notifyClients({ type: 'refresh' }))
        .catch(() => openApp('#/mails'))
    );
    return;
  }
  event.waitUntil(openApp(d.url || '#/home'));
});

async function notifyClients(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach((c) => c.postMessage(msg));
}

async function openApp(hash) {
  const scope = self.registration.scope;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (c.url.startsWith(scope)) {
      await c.focus();
      c.postMessage({ type: 'open', url: hash });
      return;
    }
  }
  await self.clients.openWindow(new URL(hash, scope).href);
}
