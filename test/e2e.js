// ブラウザでアプリを動かす E2E テスト。
// GAS への通信は横取りし、Node 上で動かした本物の Code.gs（偽スプレッドシート）に渡す。
//   使い方: node test/e2e.js [スクリーンショットの保存先]
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { chromium } = require('playwright');
const { loadGas } = require('./load-gas');
const { makeEnv } = require('./fake-gas');

const APP_DIR = path.join(__dirname, '..', 'app');
const SHOTS = process.argv[2] || path.join(__dirname, '..', 'screenshots');
const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(APP_DIR, p);
      if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

function bootGas() {
  const h = makeEnv();
  const ctx = loadGas(['WebPush.gs', 'Code.gs'], h.env);
  ctx.setup();
  return { ...h, ctx };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}/`;
  const gas = bootGas();
  const token = gas.props.API_TOKEN;
  const code = Buffer.from(JSON.stringify({ u: GAS_URL, t: token })).toString('base64url');

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  let apiCalls = 0;
  await page.route(GAS_URL, async (route) => {
    apiCalls++;
    const out = gas.ctx.doPost({ postData: { contents: route.request().postData() } });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: out.text });
  });

  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
  const step = (msg) => console.log('・' + msg);

  // 1) 未接続 → 接続画面
  await page.goto(base);
  await page.waitForSelector('form[data-form="connect"]');
  await shot('01-setup');
  step('接続画面が表示される');

  // 間違ったコード
  await page.fill('textarea[name=code]', 'でたらめ');
  await page.click('form[data-form="connect"] button[type=submit]');
  await page.waitForSelector('.banner.danger');
  step('不正な接続コードはエラーになる');

  // つながらない URL → 原因確認用のリンクが出る
  const BROKEN = 'https://script.google.com/macros/s/BROKEN/exec';
  await page.route(BROKEN, (route) => route.abort());
  await page.fill('textarea[name=code]', Buffer.from(JSON.stringify({ u: BROKEN, t: token })).toString('base64url'));
  await page.click('form[data-form="connect"] button[type=submit]');
  await page.waitForSelector(`a[href="${BROKEN}?action=ping"]`);
  await shot('01b-setup-network-error');
  step('サーバーにつながらないときは確認用リンクを出す');

  // 2) 接続リンクで開く
  await page.goto(base + '#connect=' + code);
  await page.waitForSelector('.bottomnav');
  assert.ok(!page.url().includes('connect='), '接続コードは URL から消す');
  step('接続リンクで接続できる');

  // 3) 企業を追加
  await page.click('[data-action="add-menu"]');
  await page.click('.sheet [data-action="company-new"]');
  await page.fill('form[data-form="company"] input[name=name]', '日本IBM');
  await page.selectOption('form[data-form="company"] select[name=status]', '二次面接');
  await page.check('form[data-form="company"] input[name=priority][value="5"]', { force: true });
  await page.fill('form[data-form="company"] input[name=mypageUrl]', 'https://ibm.example.com/mypage');
  await page.fill('form[data-form="company"] input[name=loginId]', 'kotoni123');
  await page.fill('form[data-form="company"] input[name=mailKeywords]', '日本アイ・ビー・エム, ibm.com');
  await page.click('form[data-form="company"] button[type=submit]');
  await page.waitForURL(/#\/company\/c-/);
  await page.waitForSelector('text=マイページを開く');
  step('企業を追加すると企業ページに移動する');

  // 4) 予定を追加（明日 14:00 の三次面接）
  const tomorrow = new Date(Date.now() + 86400000);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.click('[data-action="event-new"]');
  await page.fill('form[data-form="event"] input[name=title]', '三次面接');
  await page.fill('form[data-form="event"] input[name=datetime]', `${ymd(tomorrow)}T14:00`);
  await page.fill('form[data-form="event"] input[name=place]', 'https://zoom.example/j/123');
  await page.click('form[data-form="event"] button[type=submit]');
  await page.waitForSelector('.item:has-text("三次面接")');
  step('企業ページから予定を追加できる');

  // 5) 新しい企業ごと締切を追加
  await page.click('[data-action="add-menu"]');
  await page.click('.sheet [data-action="event-new"]');
  await page.selectOption('form[data-form="event"] select[name=company]', '__new__');
  await page.fill('form[data-form="event"] input[name=newCompany]', 'ソニー');
  await page.check('form[data-form="event"] input[name=type][value="ES締切"]', { force: true });
  assert.strictEqual(await page.textContent('[data-dt-label]'), '締切日時*');
  await page.fill('form[data-form="event"] input[name=title]', '本選考ES');
  const in2 = new Date(Date.now() + 2 * 86400000);
  await page.fill('form[data-form="event"] input[name=datetime]', `${ymd(in2)}T23:59`);
  await page.click('form[data-form="event"] button[type=submit]');
  await page.waitForSelector('.backdrop', { state: 'detached' });
  step('予定フォームから新しい企業も作れる');

  // 6) 過去の面接（結果待ち）と Gmail で見つかったメールをシートに直接入れる（手入力を想定）
  const es = gas.ss.getSheetByName('予定');
  es.appendRow(['', '日本IBM', '面接', '二次面接', new Date(Date.now() - 3 * 86400000)]);
  const ms = gas.ss.getSheetByName('メール');
  ms.appendRow(['m-1', new Date(Date.now() - 3600000), '日本IBM', '【日本IBM】三次面接日程のご案内', '採用担当 <recruit@jp.ibm.com>', 'https://mail.google.com/', false, 1, new Date()]);

  await page.goto(base + '#/home');
  await page.click('[data-action="refresh"]');
  await page.waitForSelector('text=未確認の企業メール');
  await page.waitForSelector('text=結果待ち');
  await page.waitForSelector('text=これからの予定');
  assert.strictEqual(await page.textContent('.bottomnav .dot'), '1');
  await shot('02-home');
  step('ホームに未確認メール・結果待ち・予定が出る');

  // 締切の「提出・受験した」
  await page.click('[data-action="event-done"]');
  await page.waitForSelector('.toast:has-text("完了にしました")');
  const sonyRow = gas.ss.getSheetByName('予定').objects().find((r) => r['内容'] === '本選考ES');
  assert.strictEqual(sonyRow['完了'], true);
  step('締切を完了にするとシートに反映される');

  // メールを確認済み
  await page.click('[data-action="mail-confirm"]');
  await page.waitForSelector('.toast:has-text("確認済みにしました")');
  assert.strictEqual(gas.ss.getSheetByName('メール').objects()[0]['確認済'], true);
  step('メールを確認済みにできる');

  // 結果を「通過」→ 次の予定の案内
  await page.click('[data-action="event-result"][data-value="通過"]');
  await page.waitForSelector('text=通過おめでとうございます');
  await page.click('[data-action="choice"][data-index="0"]');
  await page.waitForSelector('form[data-form="event"]');
  assert.strictEqual(await page.inputValue('form[data-form="event"] select[name=company]'), '日本IBM');
  await page.click('[data-action="close-modal"]');
  const ibm2 = gas.ss.getSheetByName('予定').objects().find((r) => r['内容'] === '二次面接');
  assert.strictEqual(ibm2['結果'], '通過');
  step('結果を記録すると次の予定の追加を案内する');

  // 7) 企業一覧・検索
  await page.goto(base + '#/companies');
  await page.waitForSelector('text=2 社');
  await page.fill('[data-input="company-query"]', 'ソニ');
  await page.waitForSelector('text=1 社');
  assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.input), 'company-query', '入力中もフォーカスが外れない');
  await page.fill('[data-input="company-query"]', '');
  await shot('03-companies');
  step('企業一覧と検索');

  // 8) 企業詳細のステータス変更
  await page.click('.item:has-text("日本IBM")');
  await page.waitForURL(/#\/company\//);
  await page.selectOption('select[data-change="company-status"]', '三次面接');
  await page.waitForSelector('.toast:has-text("三次面接")');
  assert.strictEqual(gas.ss.getSheetByName('企業').objects().find((r) => r['企業名'] === '日本IBM')['ステータス'], '三次面接');
  await shot('04-company');
  step('企業ページでステータスを変えられる');

  // 9) 予定の詳細・予定一覧・設定
  await page.click('.item:has-text("三次面接")');
  await page.waitForURL(/#\/event\//);
  await page.waitForSelector('text=マイページを開く');
  await shot('05-event');
  await page.goto(base + '#/events');
  await page.waitForSelector('.filters');
  await shot('06-events');
  await page.goto(base + '#/settings');
  await page.waitForSelector('text=接続コードをコピー');
  await shot('07-settings');
  step('予定の詳細・一覧・設定画面');

  // 10) 企業名の変更が予定にも反映される
  const cid = gas.ss.getSheetByName('企業').objects().find((r) => r['企業名'] === '日本IBM')['ID'];
  await page.goto(base + '#/company/' + cid);
  await page.click('[data-action="company-edit"]');
  await page.fill('form[data-form="company"] input[name=name]', 'IBM Japan');
  await page.click('form[data-form="company"] button[type=submit]');
  await page.waitForSelector('h2:has-text("IBM Japan")');
  assert.ok(gas.ss.getSheetByName('予定').objects().filter((r) => r['企業名'] === 'IBM Japan').length >= 2);
  step('企業名を変えると予定の企業名も変わる');

  // 11) 合言葉が変わったら接続画面に戻る
  gas.props.API_TOKEN = 'x'.repeat(64);
  await page.click('[data-action="refresh"]');
  await page.waitForSelector('form[data-form="connect"]');
  await page.waitForSelector('text=合言葉');
  step('合言葉が違うと接続画面に戻る');

  // 12) ダークモード
  await page.emulateMedia({ colorScheme: 'dark' });
  gas.props.API_TOKEN = token;
  await page.goto(base + '#connect=' + code);
  await page.waitForSelector('.bottomnav');
  await page.waitForSelector('text=これからの予定');
  await shot('08-home-dark');
  step('ダークモード');

  assert.deepStrictEqual(errors.filter((e) => !/Service Worker|serviceWorker|net::ERR_FAILED/.test(e)), [], 'コンソールエラーなし');
  console.log(`\nE2E OK（API 呼び出し ${apiCalls} 回）スクリーンショット: ${SHOTS}`);
  await browser.close();
  server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
