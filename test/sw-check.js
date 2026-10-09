// Service Worker の確認：全ファイルをキャッシュできるか、プッシュを受けて通知を出せるか
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const APP_DIR = path.join(__dirname, '..', 'app');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(APP_DIR, p);
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const origin = `http://localhost:${server.address().port}`;

  const browser = await chromium.launch({ channel: 'chromium' }); // 通知の表示には新しいヘッドレスモードが必要
  const context = await browser.newContext();
  await context.grantPermissions(['notifications']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/');
  const cached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return { keys, n: (await c.keys()).length };
  });
  assert.strictEqual(cached.keys.length, 1);
  assert.ok(cached.n >= 16, 'すべてのファイルがキャッシュされる: ' + cached.n);
  console.log('・Service Worker がインストールされ、' + cached.n + ' ファイルをキャッシュ');

  // CDP でプッシュメッセージを届ける
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const regId = await new Promise((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const r = e.registrations.find((x) => x.scopeURL.startsWith(origin));
      if (r) resolve(r.registrationId);
    });
  });
  const payload = { title: '⏰ あと1時間｜日本IBM 三次面接', body: '今日 14:00〜', url: '#/event/e-1', tag: 'ev-e-1' };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: regId, data: JSON.stringify(payload) });
  let shown = [];
  for (let i = 0; i < 20 && !shown.length; i++) {
    await page.waitForTimeout(200);
    shown = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
    });
  }
  assert.strictEqual(shown.length, 1, '通知が表示される');
  assert.strictEqual(shown[0].title, payload.title);
  assert.strictEqual(shown[0].data.url, '#/event/e-1');
  console.log('・プッシュを受けると通知が表示される: ' + shown[0].title);

  // オフラインでも開ける
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('form[data-form="connect"]');
  console.log('・オフラインでもアプリが開く');
  assert.deepStrictEqual(errors, []);
  await browser.close();
  server.close();
  console.log('\nService Worker OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
