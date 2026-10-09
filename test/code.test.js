// Code.gs（API・通知スケジューラ・Gmail 検知）のテスト
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const vm = require('vm');
const { loadGas } = require('./load-gas');
const { makeEnv, fakeThread } = require('./fake-gas');

const JST = (s) => new Date(s + '+09:00').getTime(); // '2026-10-15T14:00' → epoch ms

function boot(nowMs) {
  const h = makeEnv();
  const ctx = loadGas(['WebPush.gs', 'Code.gs'], h.env);
  vm.runInContext(`(function(){
    var RealDate = Date, fixed = null;
    function FakeDate() {
      if (!(this instanceof FakeDate)) return RealDate();
      var a = Array.prototype.slice.call(arguments);
      if (!a.length) return new RealDate(fixed === null ? RealDate.now() : fixed);
      return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return fixed === null ? RealDate.now() : fixed; };
    FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
    globalThis.Date = FakeDate;
    globalThis.__setNow = function (ms) { fixed = ms; };
  })()`, ctx);
  const setNow = (ms) => ctx.__setNow(ms);
  setNow(nowMs || JST('2026-10-10T12:00'));
  ctx.setup();
  const token = h.props.API_TOKEN;
  const call = (action, params = {}) => {
    const out = ctx.doPost({ postData: { contents: JSON.stringify({ action, token, ...params }) } });
    return JSON.parse(out.text);
  };
  return { ...h, ctx, setNow, call, token };
}

function makeDevice(call, name = 'iPhone') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = 'https://web.push.apple.com/' + crypto.randomBytes(6).toString('hex');
  const res = call('subscribe', {
    subscription: { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    deviceName: name,
  });
  assert.ok(res.ok, JSON.stringify(res));
  return { ua, auth, endpoint };
}

// UrlFetchApp に送られた暗号化ペイロードを復号して中身を見る
function decryptFetch(f, dev) {
  const body = Buffer.from(f.opt.payload.bytes.map((b) => (b < 0 ? b + 256 : b)));
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = dev.ua.computeSecret(asPublic);
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hm(dev.auth, ecdh);
  const ikm = hm(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), dev.ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.length - 1).toString('utf8'));
}

function pushes(h, dev, { withDigest = false } = {}) {
  return h.fetches.filter((f) => f.url === dev.endpoint).map((f) => decryptFetch(f, dev))
    .filter((p) => withDigest || p.tag !== 'digest');
}

test('setup でシート・設定・鍵・トリガーが作られる', () => {
  const h = boot();
  const names = h.ss.getSheets().map((s) => s.name);
  assert.deepStrictEqual(names.sort(), ['予定', '企業', '設定', 'メール', '通知ログ', '通知端末'].sort());
  assert.deepStrictEqual(h.ss.getSheetByName('企業').data[0].slice(0, 3), ['ID', '企業名', 'ステータス']);
  assert.strictEqual(h.ss.tz, 'Asia/Tokyo');
  assert.match(h.props.API_TOKEN, /^[0-9a-f]{64}$/);
  assert.strictEqual(Buffer.from(h.props.VAPID_PUBLIC, 'base64url').length, 65);
  assert.strictEqual(h.triggers.length, 1);
  h.ctx.setup(); // 2 回目でも重複しない
  assert.strictEqual(h.triggers.length, 1);
  assert.strictEqual(h.ss.getSheetByName('設定').objects().length, h.ctx.SETTING_DEFS.length);
});

test('合言葉が違うと拒否、ping は合言葉なしで OK', () => {
  const h = boot();
  const bad = JSON.parse(h.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'data', token: 'x' }) } }).text);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'unauthorized');
  const ping = JSON.parse(h.ctx.doGet({ parameter: { action: 'ping' } }).text);
  assert.deepStrictEqual(ping, { ok: true, app: 'senkoukanri' });
});

test('企業と予定の登録・更新・企業名変更・削除', () => {
  const h = boot();
  let r = h.call('saveCompany', { company: { name: 'IBM', status: '二次面接', mypageUrl: 'https://ibm.example/mypage', loginId: 'u123' } });
  assert.ok(r.ok, r.message);
  const cid = r.savedId;
  assert.strictEqual(r.companies[0].mypageUrl, 'https://ibm.example/mypage');
  assert.strictEqual(h.call('saveCompany', { company: { name: 'ＩＢＭ' } }).ok, false, '全角でも重複扱い');

  r = h.call('saveEvent', { event: { company: 'IBM', type: '面接', title: '三次面接', datetime: '2026-10-15T05:00:00.000Z', place: 'Zoom' } });
  assert.ok(r.ok, r.message);
  const ev = r.events.find((e) => e.id === r.savedId);
  assert.strictEqual(ev.datetime, '2026-10-15T05:00:00.000Z');
  assert.strictEqual(ev.companyId, cid);
  assert.strictEqual(ev.done, false);
  const row = h.ss.getSheetByName('予定').objects()[0];
  assert.strictEqual(row['日時'].toISOString(), '2026-10-15T05:00:00.000Z');

  // 一部の項目だけ更新
  r = h.call('saveEvent', { event: { id: ev.id, result: '通過', resultDue: '2026-10-20' } });
  const ev2 = r.events.find((e) => e.id === ev.id);
  assert.strictEqual(ev2.result, '通過');
  assert.strictEqual(ev2.resultDue, '2026-10-20');
  assert.strictEqual(ev2.title, '三次面接');

  // 企業名を変えると予定の企業名も変わる
  r = h.call('saveCompany', { company: { id: cid, name: '日本IBM' } });
  assert.strictEqual(r.events[0].company, '日本IBM');
  assert.strictEqual(r.companies[0].status, '二次面接');

  r = h.call('deleteCompany', { id: cid });
  assert.strictEqual(r.companies.length, 0);
  assert.strictEqual(r.events.length, 0);
});

test('スプレッドシートに手で入力した行も読める（ID 自動付与・文字列の日時）', () => {
  const h = boot(JST('2026-10-10T12:00'));
  const cs = h.ss.getSheetByName('企業');
  cs.appendRow(['', 'ソニー', 'エントリー済', '', '', 'https://sony.example', '', '', '']);
  const es = h.ss.getSheetByName('予定');
  es.appendRow(['', 'ソニー', 'ES締切', '本選考ES', '10/12 23:59']);
  es.appendRow(['', 'ソニー', '面接', '一次', '2026年10月20日 午後2時']);
  es.appendRow(['', 'ソニー', '面接', '謎', 'そのうち']);
  const r = h.call('data');
  assert.strictEqual(r.companies[0].name, 'ソニー');
  assert.match(r.companies[0].id, /^c-[0-9a-f]{8}$/);
  assert.strictEqual(cs.objects()[0]['ID'], r.companies[0].id, 'ID がシートに書き戻される');
  const [e1, e2, e3] = r.events;
  assert.strictEqual(e1.datetime, new Date(JST('2026-10-12T23:59')).toISOString());
  assert.strictEqual(e1.companyId, r.companies[0].id);
  assert.strictEqual(e2.datetime, new Date(JST('2026-10-20T14:00')).toISOString());
  assert.strictEqual(e3.datetime, '');
  assert.strictEqual(e3.datetimeText, 'そのうち');
});

test('parseOffsets_ / parseDateTime_ / humanizeMinutes_', () => {
  const h = boot();
  const c = h.ctx;
  assert.deepStrictEqual(Array.from(c.parseOffsets_('3日前, 1日前, 6時間前, 30分前')), [4320, 1440, 360, 30]);
  assert.deepStrictEqual(Array.from(c.parseOffsets_('90, 1.5時間')), [90]);
  assert.deepStrictEqual(Array.from(c.parseOffsets_('')), []);
  const now = new Date(JST('2026-12-20T10:00'));
  assert.strictEqual(c.parseDateTime_('1/5 10:00', now).toISOString(), new Date(JST('2027-01-05T10:00')).toISOString());
  assert.strictEqual(c.parseDateTime_('2026/10/15(水) 9:30', now).toISOString(), new Date(JST('2026-10-15T09:30')).toISOString());
  assert.strictEqual(c.parseDateTime_('２０２６／１０／１５　１４：００', now).toISOString(), new Date(JST('2026-10-15T14:00')).toISOString());
  assert.strictEqual(c.parseDateTime_('13/40', now), null);
  assert.strictEqual(c.humanizeMinutes_(59), '59分');
  assert.strictEqual(c.humanizeMinutes_(90), '1時間30分');
  assert.strictEqual(c.humanizeMinutes_(1440 + 120), '1日2時間');
});

test('面接 1 時間前に通知し、同じ通知は二度送らない', () => {
  const h = boot(JST('2026-10-15T12:00'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'IBM', status: '二次面接' } });
  h.call('saveEvent', { event: { company: 'IBM', type: '面接', title: '三次面接', datetime: new Date(JST('2026-10-15T14:00')).toISOString(), place: 'https://zoom.example/j/1' } });

  h.ctx.runScheduler(); // 12:00 → 3時間前(11:00)を過ぎているので「あと2時間」を送る
  let got = pushes(h, dev);
  assert.strictEqual(got.length, 1);
  assert.match(got[0].title, /あと2時間｜IBM 三次面接/);
  assert.match(got[0].body, /今日 14:00〜\nhttps:\/\/zoom.example/);
  assert.match(got[0].url, /^#\/event\/e-/);

  h.setNow(JST('2026-10-15T12:30'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 1, '重複しない');

  h.setNow(JST('2026-10-15T13:02'));
  h.ctx.runScheduler();
  got = pushes(h, dev);
  assert.strictEqual(got.length, 2);
  assert.match(got[1].title, /あと58分/);

  // 面接が終わったら事前通知は無い
  h.setNow(JST('2026-10-15T14:30'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 2);
  const log = h.ss.getSheetByName('通知ログ').objects();
  assert.ok(log.length >= 2);
  assert.match(log[log.length - 1]['送信結果'], /iPhone: OK/);
});

test('締切通知: 遅れて登録しても溜まった分をまとめて 1 通、完了にすると止まる', () => {
  const h = boot(JST('2026-10-10T12:00'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'ソニー' } });
  const r = h.call('saveEvent', { event: { company: 'ソニー', type: 'ES締切', title: '本選考ES', datetime: new Date(JST('2026-10-11T23:59')).toISOString() } });
  h.ctx.runScheduler();
  let got = pushes(h, dev);
  assert.strictEqual(got.length, 1);
  assert.match(got[0].title, /📝 締切まであと1日11時間｜ソニー 本選考ES/);
  h.setNow(JST('2026-10-11T00:00'));
  h.ctx.runScheduler();
  got = pushes(h, dev);
  assert.strictEqual(got.length, 2, '1日前');
  h.call('saveEvent', { event: { id: r.savedId, done: true } });
  h.setNow(JST('2026-10-11T18:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 2, '完了後は通知しない');
});

test('お祈り・辞退の企業の予定は通知しない', () => {
  const h = boot(JST('2026-10-15T13:30'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'A社', status: 'お祈り' } });
  h.call('saveEvent', { event: { company: 'A社', type: '面接', datetime: new Date(JST('2026-10-15T14:00')).toISOString() } });
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 0);
});

test('結果確認リマインドは 21 時に 1 日 1 回、結果を入れると止まる', () => {
  const h = boot(JST('2026-10-15T20:50'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'IBM' } });
  const r = h.call('saveEvent', { event: { company: 'IBM', type: '面接', title: '三次面接', datetime: new Date(JST('2026-10-15T14:00')).toISOString() } });
  h.call('saveEvent', { event: { company: 'IBM', type: 'ES締切', title: '未提出のES', datetime: new Date(JST('2026-10-14T23:59')).toISOString() } });
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 0, '21時前');
  h.setNow(JST('2026-10-15T21:03'));
  h.ctx.runScheduler();
  let got = pushes(h, dev);
  assert.strictEqual(got.length, 1);
  assert.match(got[0].title, /結果メールを確認しましたか？（結果待ち 1件）/);
  assert.match(got[0].body, /IBM 三次面接（10\/15）/);
  h.setNow(JST('2026-10-15T22:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 1, '同じ日は 1 回');
  h.setNow(JST('2026-10-16T21:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 2, '翌日もう一度');
  h.call('saveEvent', { event: { id: r.savedId, result: '通過' } });
  h.setNow(JST('2026-10-17T21:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 2, '結果を入れたら止まる');
});

test('朝のまとめ通知', () => {
  const h = boot(JST('2026-10-15T08:01'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'IBM' } });
  h.call('saveEvent', { event: { company: 'IBM', type: '面接', title: '三次面接', datetime: new Date(JST('2026-10-15T14:00')).toISOString() } });
  h.call('saveEvent', { event: { company: 'IBM', type: 'Webテスト締切', title: '玉手箱', datetime: new Date(JST('2026-10-17T23:59')).toISOString() } });
  h.call('saveEvent', { event: { company: 'IBM', type: '説明会', title: 'ずっと先', datetime: new Date(JST('2026-11-30T10:00')).toISOString() } });
  h.ctx.runScheduler();
  const got = pushes(h, dev, { withDigest: true }).filter((p) => p.tag === 'digest');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].body, '今日 14:00 IBM 三次面接\n10/17 23:59〆 IBM 玉手箱');
});

test('Gmail 検知: 新着を通知し、確認済にするまで再通知する', () => {
  const h = boot(JST('2026-10-15T10:00'));
  const dev = makeDevice(h.call);
  h.call('saveCompany', { company: { name: 'IBM', mailKeywords: '日本アイ・ビー・エム, ibm.com' } });
  h.call('saveCompany', { company: { name: 'ソニー' } });
  h.call('saveCompany', { company: { name: '落ちた社', status: 'お祈り' } });
  h.gmail.threads = [
    fakeThread('t1', [{ id: 'm1', date: JST('2026-10-15T09:55'), from: '採用担当 <recruit@jp.ibm.com>', subject: '三次面接のご案内', body: '...' }]),
    fakeThread('t2', [{ id: 'm2', date: JST('2026-10-15T09:58'), from: 'noreply@i-webs.jp', subject: '選考のご連絡', body: 'ソニーグループ株式会社 新卒採用担当です' }]),
    fakeThread('t3', [{ id: 'm3', date: JST('2026-10-15T09:59'), from: 'kotonimukae@gmail.com', subject: 'IBM メモ', body: '' }]),
  ];
  h.ctx.runScheduler();
  const q = h.gmail.queries[0];
  assert.match(q, /^after:\d+ -in:sent/);
  assert.match(q, /from:ibm\.com OR "ibm\.com"/);
  assert.match(q, /"日本アイ・ビー・エム"/);
  assert.match(q, /"ソニー"/);
  assert.doesNotMatch(q, /落ちた社/);
  assert.match(q, /-category:promotions/);
  let got = pushes(h, dev);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].title, '📩 IBMからメール');
  assert.strictEqual(got[1].title, '📩 ソニーからメール');
  assert.deepStrictEqual(got[0].mailIds, ['m1']);
  const mailRows = h.ss.getSheetByName('メール').objects();
  assert.strictEqual(mailRows.length, 2, '自分が送ったメールは除外');
  assert.match(mailRows[0]['Gmailで開く'], /authuser=kotonimukae%40gmail\.com#all\/t1$/);

  // 同じメールは二度通知しない
  h.setNow(JST('2026-10-15T10:05'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).length, 2);
  assert.match(h.gmail.queries[1], new RegExp('^after:' + (Math.floor(JST('2026-10-15T10:00') / 1000) - 900)));

  // 2 時間後に再通知
  h.setNow(JST('2026-10-15T12:00'));
  h.gmail.threads = [];
  h.ctx.runScheduler();
  got = pushes(h, dev);
  assert.strictEqual(got.length, 3);
  assert.strictEqual(got[2].title, '⚠️ 未確認の企業メールが2件あります');
  assert.deepStrictEqual(got[2].actions, [{ action: 'confirm-mails', title: '確認済みにする' }]);
  assert.strictEqual(h.ss.getSheetByName('メール').objects()[0]['通知回数'], 2);

  // 1 件だけ確認済 → 残り 1 件を再通知
  h.call('confirmMails', { ids: ['m1'] });
  h.setNow(JST('2026-10-15T14:01'));
  h.ctx.runScheduler();
  got = pushes(h, dev);
  assert.strictEqual(got.length, 4);
  assert.strictEqual(got[3].title, '⚠️ 未確認の企業メールが1件あります');

  // 夜中は再通知しない
  h.setNow(JST('2026-10-16T03:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).filter((p) => p.tag === 'mail-remind').length, 2);

  // 全部確認済 → 止まる
  const r = h.call('confirmMails', { ids: 'all' });
  assert.ok(r.mails.every((m) => m.confirmed));
  h.setNow(JST('2026-10-16T09:00'));
  h.ctx.runScheduler();
  assert.strictEqual(pushes(h, dev).filter((p) => p.tag === 'mail-remind').length, 2);
});

test('購読が切れた端末(410)は削除し、届く端末が無ければメールで知らせる', () => {
  const h = boot(JST('2026-10-15T13:30'));
  const dev = makeDevice(h.call);
  h.setFetchResponder(() => ({ code: 410, body: 'expired' }));
  h.call('saveCompany', { company: { name: 'IBM' } });
  h.call('saveEvent', { event: { company: 'IBM', type: '面接', title: '三次面接', datetime: new Date(JST('2026-10-15T14:00')).toISOString() } });
  h.ctx.runScheduler();
  assert.strictEqual(h.ss.getSheetByName('通知端末').objects().length, 0);
  assert.strictEqual(h.sentMails.length, 1);
  assert.match(h.sentMails[0].subject, /【選考管理】⏰ あと30分｜IBM 三次面接/);
  assert.match(h.sentMails[0].body, /通知が届かない状態/);
  assert.ok(dev);
});

test('testPush は登録端末に送り結果を返す', () => {
  const h = boot();
  const dev = makeDevice(h.call);
  const r = h.call('testPush', { endpoint: dev.endpoint });
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(pushes(h, dev)[0].title, '✅ 通知テスト');
  const f = h.fetches[0];
  assert.strictEqual(f.opt.headers['Content-Encoding'], 'aes128gcm');
  assert.match(f.opt.headers.Authorization, /^vapid t=/);
  const jwt = JSON.parse(Buffer.from(f.opt.headers.Authorization.split('t=')[1].split('.')[1], 'base64url'));
  assert.strictEqual(jwt.aud, 'https://web.push.apple.com');
  assert.strictEqual(jwt.sub, 'mailto:kotonimukae@gmail.com');
  assert.strictEqual(h.call('unsubscribe', { endpoint: dev.endpoint }).devices.length, 0);
});

test('接続ダイアログはウェブアプリを呼び出して設定ミスを見つける', () => {
  const h = boot();
  const url = 'https://script.google.com/macros/s/AKfycbxTEST_123-abc/exec';
  const tryUrl = (u) => {
    try {
      return { ok: h.ctx.saveWebAppUrl(u) };
    } catch (e) {
      return { error: e.message };
    }
  };
  // 正常（ping に JSON で応答）
  h.setFetchResponder((u, opt) => {
    assert.strictEqual(u, url);
    assert.strictEqual(opt.method, 'post');
    assert.deepStrictEqual(JSON.parse(opt.payload), { action: 'ping' });
    return { code: 200, body: JSON.stringify({ ok: true, app: 'senkoukanri' }) };
  });
  assert.deepStrictEqual(tryUrl(url + '?foo=1 '), { ok: url });
  assert.strictEqual(h.props.WEBAPP_URL, url);

  // 「Google アカウントを持つ全員」→ ログイン画面
  h.setFetchResponder(() => ({ code: 200, body: '<html><a href="https://accounts.google.com/ServiceLogin">ログイン</a></html>' }));
  assert.match(tryUrl(url).error, /「全員」になっていません/);

  // URL 違い
  h.setFetchResponder(() => ({ code: 404, body: '<html>現在、ファイルを開くことができません。</html>' }));
  assert.match(tryUrl(url).error, /見つかりません/);

  // 古いバージョン・エラー
  h.setFetchResponder(() => ({ code: 200, body: '<html><body>エラー: SyntaxError: Unexpected end of input</body></html>' }));
  assert.match(tryUrl(url).error, /新バージョン.*SyntaxError/);

  // 形式チェック
  assert.match(tryUrl('https://script.google.com/macros/s/AKfycbx/dev').error, /テスト用/);
  assert.match(tryUrl('https://example.com/exec').error, /形式/);
  assert.strictEqual(h.ctx.getConnectInfo().webAppUrl, url, '失敗した URL では上書きしない');
});
