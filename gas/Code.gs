/**
 * 選考管理アプリ — Google Apps Script 本体
 *
 * スプレッドシートに紐づけて使います（拡張機能 > Apps Script に貼り付け）。
 * - スプレッドシートがデータベース。手で直接編集しても OK
 * - Web アプリとしてデプロイすると、スマホのアプリ（PWA）から読み書きできる
 * - 5 分おきのトリガーで、面接・締切前の通知 / 結果確認リマインド / Gmail 検知を行い、
 *   スマホへ Web Push で通知する
 *
 * セットアップ手順は README.md を見てください。
 */

var APP_TZ = 'Asia/Tokyo';
var JST_OFFSET_MS = 9 * 3600 * 1000;
var MINUTE_MS = 60 * 1000;
var DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// シート定義（見出しの文字で列を探すので、列の並べ替えや列の追加は自由にできます）
// ---------------------------------------------------------------------------

var SHEETS = {
  companies: {
    name: '企業',
    idPrefix: 'c',
    color: '#4f46e5',
    columns: [
      { key: 'id', label: 'ID', width: 90 },
      { key: 'name', label: '企業名', width: 170 },
      { key: 'status', label: 'ステータス', width: 110 },
      { key: 'priority', label: '志望度', width: 70 },
      { key: 'industry', label: '業界', width: 110 },
      { key: 'mypageUrl', label: 'マイページURL', width: 240 },
      { key: 'loginId', label: 'ログインID', width: 150 },
      { key: 'mailKeywords', label: 'メール検知キーワード', width: 190 },
      { key: 'memo', label: 'メモ', width: 260 },
      { key: 'updatedAt', label: '更新日時', width: 130 }
    ]
  },
  events: {
    name: '予定',
    idPrefix: 'e',
    color: '#0891b2',
    columns: [
      { key: 'id', label: 'ID', width: 90 },
      { key: 'company', label: '企業名', width: 170 },
      { key: 'type', label: '種別', width: 120 },
      { key: 'title', label: '内容', width: 170 },
      { key: 'datetime', label: '日時', width: 170 },
      { key: 'place', label: '場所・URL', width: 220 },
      { key: 'done', label: '完了', width: 60, checkbox: true },
      { key: 'result', label: '結果', width: 90 },
      { key: 'resultDue', label: '結果連絡の目安', width: 120 },
      { key: 'memo', label: 'メモ', width: 240 },
      { key: 'updatedAt', label: '更新日時', width: 130 }
    ]
  },
  mails: {
    name: 'メール',
    color: '#dc2626',
    columns: [
      { key: 'id', label: 'メールID', width: 150 },
      { key: 'receivedAt', label: '受信日時', width: 130 },
      { key: 'company', label: '企業名', width: 150 },
      { key: 'subject', label: '件名', width: 320 },
      { key: 'from', label: '差出人', width: 220 },
      { key: 'link', label: 'Gmailで開く', width: 120 },
      { key: 'confirmed', label: '確認済', width: 60, checkbox: true },
      { key: 'notifyCount', label: '通知回数', width: 70 },
      { key: 'lastNotifiedAt', label: '最終通知', width: 130 }
    ]
  },
  devices: {
    name: '通知端末',
    color: '#64748b',
    columns: [
      { key: 'createdAt', label: '登録日時', width: 130 },
      { key: 'name', label: '端末名', width: 160 },
      { key: 'endpoint', label: 'endpoint', width: 260 },
      { key: 'p256dh', label: 'p256dh', width: 120 },
      { key: 'auth', label: 'auth', width: 100 },
      { key: 'lastSentAt', label: '最終送信', width: 130 },
      { key: 'lastResult', label: '最終結果', width: 200 }
    ]
  },
  calsync: {
    name: 'カレンダー同期',
    hidden: true,
    columns: [
      { key: 'calEventId', label: 'カレンダー予定ID', width: 260 },
      { key: 'rowId', label: '予定ID', width: 100 },
      { key: 'origin', label: '作成元', width: 80 },
      { key: 'rowFp', label: '予定の状態', width: 90 },
      { key: 'calFp', label: 'カレンダーの状態', width: 90 },
      { key: 'state', label: '状態', width: 80 },
      { key: 'syncedAt', label: '同期日時', width: 130 }
    ]
  },
  log: {
    name: '通知ログ',
    color: '#64748b',
    columns: [
      { key: 'sentAt', label: '日時', width: 130 },
      { key: 'key', label: 'キー', width: 220 },
      { key: 'title', label: 'タイトル', width: 260 },
      { key: 'body', label: '本文', width: 360 },
      { key: 'result', label: '送信結果', width: 200 }
    ]
  }
};

var SETTINGS_SHEET = '設定';

var EVENT_TYPES = ['面接', 'GD', 'ES締切', 'Webテスト締切', '説明会', 'その他'];
var RESULT_OPTIONS = ['通過', '不通過', '辞退', '連絡なし'];
/** 結果を待つ（結果確認リマインドの対象になる）種別 */
var RESULT_TYPES = ['面接', 'GD', 'ES締切', 'Webテスト締切'];

var SETTING_DEFS = [
  { key: 'statuses', label: 'ステータスの選択肢', def: '気になる, エントリー済, ES提出済, Webテスト, GD, 一次面接, 二次面接, 三次面接, 最終面接, 内定, 内定承諾, お祈り, 辞退', note: 'カンマ区切り。変更したらメニュー「選考管理 > 入力規則を更新」を実行' },
  { key: 'closedStatuses', label: '終了扱いのステータス', def: 'お祈り, 辞退', note: 'この企業の予定は通知せず、メール検知もしません' },
  { key: 'timing:面接', label: '通知タイミング：面接', def: '1日前, 3時間前, 1時間前', note: '「◯日前」「◯時間前」「◯分前」をカンマ区切りで' },
  { key: 'timing:GD', label: '通知タイミング：GD', def: '1日前, 3時間前, 1時間前', note: '' },
  { key: 'timing:ES締切', label: '通知タイミング：ES締切', def: '3日前, 1日前, 6時間前, 1時間前', note: '「完了」にチェックすると以降は通知しません' },
  { key: 'timing:Webテスト締切', label: '通知タイミング：Webテスト締切', def: '3日前, 1日前, 6時間前, 1時間前', note: '「完了」にチェックすると以降は通知しません' },
  { key: 'timing:説明会', label: '通知タイミング：説明会', def: '1日前, 1時間前', note: '' },
  { key: 'timing:その他', label: '通知タイミング：その他', def: '1日前, 1時間前', note: '上にない種別もこの設定を使います' },
  { key: 'digestHour', label: '朝のまとめ通知（時）', def: '8', note: '今日・明日の予定と近い締切をまとめて通知。空欄で送らない' },
  { key: 'resultHour', label: '結果確認リマインド（時）', def: '21', note: '結果待ちの選考があれば毎日この時刻に「結果メールを確認」と通知。空欄で送らない' },
  { key: 'resultDays', label: '結果確認リマインドの期間（日）', def: '30', note: '面接・締切の何日後までリマインドするか' },
  { key: 'gmail', label: 'Gmail検知', def: 'ON', note: 'ON / OFF。登録企業からのメールが届いたら通知します' },
  { key: 'gmailCommon', label: 'Gmail検知：共通キーワード', def: '', note: '企業を問わず検知したい語をカンマ区切りで（例: 選考結果, 面接のご案内）' },
  { key: 'gmailExclude', label: 'Gmail検知：除外条件', def: '-category:promotions -category:social -category:forums', note: 'Gmail の検索演算子。メルマガを除外しています' },
  { key: 'mailRemindHours', label: '未確認メールの再通知間隔（時間）', def: '2', note: '「確認済」にするまで繰り返し通知します。0 で再通知しない' },
  { key: 'quietHours', label: '再通知しない時間帯', def: '0-7', note: '例: 0-7 → 0:00〜6:59 は未確認メールの再通知を送りません' },
  { key: 'calendarId', label: 'カレンダー連携：カレンダーID', def: '', note: '空欄なら連携しない。メニュー「選考管理 → カレンダーと連携する」で選べます' },
  { key: 'calendarImport', label: 'カレンダー連携：カレンダーから取り込む', def: 'ON', note: 'ON：カレンダーに直接入れた予定もアプリに取り込む / OFF：アプリ → カレンダーの一方向だけ' },
  { key: 'calendarDuration', label: 'カレンダー連携：予定の長さ（分）', def: '60', note: 'アプリで登録した面接などをカレンダーに入れるときの長さ' },
  { key: 'appUrl', label: 'アプリのURL', def: 'https://senkoukanri.vercel.app/', note: 'スマホ接続用リンクに使います' }
];

// ---------------------------------------------------------------------------
// メニュー・初期設定
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('選考管理')
    .addItem('① 初期設定（最初に1回）', 'setup')
    .addItem('② スマホと接続する', 'showConnectDialog')
    .addItem('Google カレンダーと連携する', 'showCalendarDialog')
    .addSeparator()
    .addItem('通知のテスト送信', 'menuTestPush')
    .addItem('今すぐ通知チェックを実行', 'runScheduler')
    .addItem('入力規則を更新', 'applyValidations')
    .addSeparator()
    .addItem('合言葉（トークン）を作り直す', 'resetToken')
    .addToUi();
}

/** 初期設定。シート作成・鍵の生成・トリガー登録を行う。何度実行しても安全。 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(APP_TZ);

  ensureSettingsSheet_(ss);
  Object.keys(SHEETS).forEach(function (k) {
    if (!ss.getSheetByName(SHEETS[k].name)) createSheet_(ss, SHEETS[k]);
  });
  // 新規スプレッドシートの空の「シート1」を消す
  ['シート1', 'Sheet1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  applyValidations();

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  if (!props.getProperty('VAPID_PUBLIC') || !props.getProperty('VAPID_PRIVATE')) {
    var keys = WebPush.generateVapidKeys();
    props.setProperty('VAPID_PUBLIC', keys.publicKey);
    props.setProperty('VAPID_PRIVATE', keys.privateKey);
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runScheduler') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(5).create();

  var msg = '初期設定が完了しました。\n\n' +
    '次に「デプロイ > 新しいデプロイ」で種類「ウェブアプリ」、' +
    '実行ユーザー「自分」、アクセスできるユーザー「全員」でデプロイし、' +
    'メニュー「選考管理 > ② スマホと接続する」を開いてください。';
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    // エディタから実行した場合など UI が無いときはログだけ
  }
}

function resetToken() {
  var ui = SpreadsheetApp.getUi();
  var ok = ui.alert('合言葉を作り直すと、接続済みのスマホはもう一度接続が必要です。続けますか？', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', newToken_());
  showConnectDialog();
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function createSheet_(ss, def) {
  var sh = ss.insertSheet(def.name);
  var labels = def.columns.map(function (c) { return c.label; });
  sh.getRange(1, 1, 1, labels.length).setValues([labels])
    .setFontWeight('bold').setBackground('#eef2ff').setFontColor('#1e1b4b');
  sh.setFrozenRows(1);
  def.columns.forEach(function (c, i) {
    if (c.width) sh.setColumnWidth(i + 1, c.width);
  });
  if (def.color) sh.setTabColor(def.color);
  if (def.hidden) sh.hideSheet();
  return sh;
}

function ensureSettingsSheet_(ss) {
  var sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['項目', '値', '説明']])
      .setFontWeight('bold').setBackground('#eef2ff').setFontColor('#1e1b4b');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 260);
    sh.setColumnWidth(2, 360);
    sh.setColumnWidth(3, 520);
    sh.setTabColor('#16a34a');
  }
  var existing = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { existing[String(r[0]).trim()] = true; });
  }
  var add = SETTING_DEFS.filter(function (d) { return !existing[d.label]; })
    .map(function (d) { return [d.label, d.def, d.note]; });
  if (add.length) {
    sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
    sh.getRange(2, 2, sh.getLastRow() - 1, 1).setNumberFormat('@');
  }
  return sh;
}

/** プルダウン・チェックボックス・日付の表示形式・色分けを設定する */
function applyValidations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settings = readSettings_();

  var companies = getSheet_(SHEETS.companies);
  var cRows = companies.getMaxRows() - 1;
  var cIdx = headerIndex_(companies, SHEETS.companies);
  setListValidation_(companies, cIdx.status, cRows, settings.statuses);
  setListValidation_(companies, cIdx.priority, cRows, ['5', '4', '3', '2', '1']);
  if (cIdx.updatedAt != null) companies.getRange(2, cIdx.updatedAt + 1, cRows, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  if (cIdx.status != null) {
    var sCol = columnLetter_(cIdx.status + 1);
    var all = companies.getRange(2, 1, cRows, Math.max(companies.getLastColumn(), SHEETS.companies.columns.length));
    var closedFormula = '=OR(' + settings.closedStatuses.map(function (s) { return '$' + sCol + '2="' + s + '"'; }).join(',') + ')';
    companies.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(closedFormula)
        .setFontColor('#9ca3af').setRanges([all]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=REGEXMATCH($' + sCol + '2,"内定")')
        .setBackground('#dcfce7').setRanges([all]).build()
    ]);
  }

  var events = getSheet_(SHEETS.events);
  var eRows = events.getMaxRows() - 1;
  var eIdx = headerIndex_(events, SHEETS.events);
  setListValidation_(events, eIdx.type, eRows, EVENT_TYPES);
  setListValidation_(events, eIdx.result, eRows, RESULT_OPTIONS);
  if (eIdx.company != null) {
    var nameCol = cIdx.name != null ? columnLetter_(cIdx.name + 1) : 'B';
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(companies.getRange(nameCol + '2:' + nameCol), true)
      .setAllowInvalid(true).build();
    events.getRange(2, eIdx.company + 1, eRows, 1).setDataValidation(rule);
  }
  if (eIdx.datetime != null) events.getRange(2, eIdx.datetime + 1, eRows, 1).setNumberFormat('yyyy/mm/dd(ddd) hh:mm');
  if (eIdx.resultDue != null) events.getRange(2, eIdx.resultDue + 1, eRows, 1).setNumberFormat('yyyy/mm/dd');
  if (eIdx.updatedAt != null) events.getRange(2, eIdx.updatedAt + 1, eRows, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  if (eIdx.datetime != null && eIdx.done != null && eIdx.result != null) {
    var d = '$' + columnLetter_(eIdx.datetime + 1) + '2';
    var done = '$' + columnLetter_(eIdx.done + 1) + '2';
    var res = '$' + columnLetter_(eIdx.result + 1) + '2';
    var range = events.getRange(2, 1, eRows, Math.max(events.getLastColumn(), SHEETS.events.columns.length));
    events.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND(ISNUMBER(' + d + '),' + d + '<NOW())')
        .setFontColor('#9ca3af').setRanges([range]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND(ISNUMBER(' + d + '),' + d + '>=NOW(),' + d + '-NOW()<=3,' + done + '<>TRUE,' + res + '="")')
        .setBackground('#fef3c7').setRanges([range]).build()
    ]);
  }

  var mails = getSheet_(SHEETS.mails);
  var mRows = mails.getMaxRows() - 1;
  var mIdx = headerIndex_(mails, SHEETS.mails);
  if (mIdx.receivedAt != null) mails.getRange(2, mIdx.receivedAt + 1, mRows, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  if (mIdx.lastNotifiedAt != null) mails.getRange(2, mIdx.lastNotifiedAt + 1, mRows, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  if (mIdx.confirmed != null) {
    var mRange = mails.getRange(2, 1, mRows, Math.max(mails.getLastColumn(), SHEETS.mails.columns.length));
    var cf = '$' + columnLetter_(mIdx.confirmed + 1) + '2';
    var idc = '$' + columnLetter_((mIdx.id || 0) + 1) + '2';
    mails.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + idc + '<>"",' + cf + '<>TRUE)')
        .setBackground('#fee2e2').setRanges([mRange]).build()
    ]);
  }

  // チェックボックスは入力済みの行だけに付ける（空行に付けると最終行の判定がずれるため）
  [SHEETS.events, SHEETS.mails].forEach(function (def) {
    var sh = getSheet_(def);
    var idx = headerIndex_(sh, def);
    var last = sh.getLastRow();
    def.columns.forEach(function (c) {
      if (c.checkbox && idx[c.key] != null && last >= 2) setCheckbox_(sh, idx[c.key], 2, last - 1);
    });
  });

  ['devices', 'log'].forEach(function (k) {
    var sh = getSheet_(SHEETS[k]);
    var idx = headerIndex_(sh, SHEETS[k]);
    ['createdAt', 'lastSentAt', 'sentAt'].forEach(function (key) {
      if (idx[key] != null) sh.getRange(2, idx[key] + 1, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy/mm/dd hh:mm');
    });
  });
  return ss;
}

function setListValidation_(sh, colIdx, rows, list) {
  if (colIdx == null || !list || !list.length) return;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
  sh.getRange(2, colIdx + 1, rows, 1).setDataValidation(rule);
}

function setCheckbox_(sh, colIdx, fromRow, rows) {
  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sh.getRange(fromRow, colIdx + 1, rows, 1).setDataValidation(rule);
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// スマホ接続ダイアログ
// ---------------------------------------------------------------------------

function showConnectDialog() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) setup();
  var info = getConnectInfo();
  var t = HtmlService.createTemplate(CONNECT_DIALOG_HTML);
  t.info = JSON.stringify(info);
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(460).setHeight(640), 'スマホと接続する');
}

/** ダイアログから呼ばれる。接続に必要な情報を返す。 */
function getConnectInfo() {
  var props = PropertiesService.getScriptProperties();
  return {
    webAppUrl: props.getProperty('WEBAPP_URL') || '',
    token: props.getProperty('API_TOKEN'),
    appUrl: readSettings_().appUrl
  };
}

/**
 * ダイアログから呼ばれる。ウェブアプリを実際に呼び出して確かめてから URL を保存する。
 * skipCheck が true なら確認せずに保存する（確認自体がうまくいかないときの逃げ道）。
 */
function saveWebAppUrl(url, skipCheck) {
  url = String(url || '').trim().replace(/[?#].*$/, '');
  if (/\/dev$/.test(url)) {
    throw new Error('末尾が「/dev」の URL はテスト用です。「デプロイ → デプロイを管理」に表示される、末尾が「/exec」の URL を貼り付けてください。');
  }
  if (!/^https:\/\/script\.google\.com\/(a\/[^\/]+\/)?macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('「https://script.google.com/macros/s/…/exec」の形式の URL を貼り付けてください。');
  }
  if (!skipCheck) {
    var problem = diagnoseWebApp_(url);
    if (problem) throw new Error(problem);
  }
  PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', url);
  return url;
}

/**
 * スマホのブラウザと同じ手順でウェブアプリを呼び出す。
 * POST → 302 リダイレクト → 移動先を GET（ブラウザは 302 の移動先を GET で取りに行く）。
 * 自動リダイレクトに任せると POST のまま移動先に送られて失敗することがあるので、1 段ずつたどる。
 */
function callWebAppLikeBrowser_(url, body) {
  var trace = [];
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(body),
    followRedirects: false,
    muteHttpExceptions: true
  });
  trace.push('POST ' + res.getResponseCode());
  for (var i = 0; i < 5; i++) {
    var code = res.getResponseCode();
    if (code < 300 || code >= 400) break;
    var headers = res.getHeaders() || {};
    var loc = headers.Location || headers.location || '';
    if (!loc) break;
    var host = (String(loc).match(/^https?:\/\/([^\/?#]+)/) || [])[1] || loc;
    trace.push('→ ' + host);
    if (/accounts\.google\.com/.test(host)) return { login: true, trace: trace.join(' ') };
    res = UrlFetchApp.fetch(loc, { followRedirects: false, muteHttpExceptions: true });
    trace.push('GET ' + res.getResponseCode());
  }
  return { res: res, trace: trace.join(' ') };
}

/**
 * スマホと同じように（ログインなしで）ウェブアプリを呼び出し、問題があれば原因を返す。
 * 問題が無ければ空文字。
 */
function diagnoseWebApp_(url) {
  var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  var r;
  try {
    r = callWebAppLikeBrowser_(url, { action: 'data', token: token });
  } catch (e) {
    return 'ウェブアプリを呼び出せませんでした: ' + e.message;
  }
  var detail = '（確認結果: ' + r.trace + '）';
  if (r.login) {
    return '「アクセスできるユーザー」が「全員」になっていません（「Google アカウントを持つ全員」「自分のみ」は不可）。' +
      '「デプロイ → デプロイを管理 → ✏️編集」で、アクセスできるユーザーを「全員」にして「デプロイ」してください。' + detail;
  }
  var code = r.res.getResponseCode();
  var text = r.res.getContentText();
  var json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (json && json.ok) return '';
  if (json && json.error === 'unauthorized') {
    return 'この URL は、このスプレッドシートとは別の Apps Script のウェブアプリです。' +
      'このスプレッドシートの「拡張機能 → Apps Script」を開き、そこの「デプロイ → デプロイを管理」の URL を使ってください。' + detail;
  }
  if (json) return 'ウェブアプリがエラーを返しました: ' + (json.message || json.error) + detail;
  var snippet = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (/accounts\.google\.com|ServiceLogin/i.test(text)) {
    return '「アクセスできるユーザー」が「全員」になっていません。「デプロイ → デプロイを管理 → ✏️編集」で「全員」にしてください。' + detail;
  }
  if (code === 404) {
    return 'この URL のウェブアプリが見つかりません。「デプロイ → デプロイを管理」に表示される URL をそのままコピーして貼り付けてください。' +
      detail + '（応答: ' + snippet + '）';
  }
  return 'ウェブアプリが古いコードのまま動いているか、エラーになっています。' +
    '「デプロイ → デプロイを管理 → ✏️編集 → バージョン：新バージョン → デプロイ」で最新のコードを反映してください。' +
    detail + '（HTTP ' + code + ' 応答: ' + snippet + '）';
}

/** ダイアログから呼ばれる。接続用リンクを自分宛てにメールする。 */
function sendConnectEmail(link, code) {
  var me = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(me, '【選考管理】スマホ接続用リンク',
    'スマホでこのメールを開き、下のリンクをタップしてください。\n\n' + link + '\n\n' +
    'iPhone でホーム画面に追加したアプリから接続するときは、次の接続コードをコピーして貼り付けてください。\n\n' + code + '\n\n' +
    '※このリンクとコードがあれば誰でもあなたの選考データを見られます。他人に共有しないでください。');
  return me;
}

var CONNECT_DIALOG_HTML = [
  '<!doctype html><html><head><base target="_top"><meta charset="utf-8">',
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>',
  '<style>',
  'body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;font-size:13px;color:#1f2937;margin:0;padding:4px 8px}',
  'h3{font-size:14px;margin:14px 0 6px}input,textarea{width:100%;box-sizing:border-box;font-size:12px;padding:6px;border:1px solid #cbd5e1;border-radius:6px}',
  'textarea{height:64px;font-family:monospace}button{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:8px 12px;font-size:13px;cursor:pointer;margin:6px 6px 0 0}',
  'button.sub{background:#e0e7ff;color:#3730a3}#qr{display:flex;justify-content:center;margin:10px 0}.note{color:#64748b;font-size:12px;line-height:1.6}.err{color:#dc2626}',
  '</style></head><body>',
  '<h3>1. ウェブアプリの URL</h3>',
  '<div class="note">「デプロイ &gt; デプロイを管理」に表示される「ウェブアプリ」の URL（…/exec）を貼り付けてください。</div>',
  '<input id="url" placeholder="https://script.google.com/macros/s/xxxxx/exec">',
  '<button id="mk" onclick="make()">接続用 QR コードを作る</button>',
  '<div id="busy" class="note"></div>',
  '<div id="err" class="err"></div>',
  '<div id="skip" style="display:none"><div class="note">URL が正しいのに確認だけ失敗する場合は、確認せずに作ってスマホで試せます。</div>',
  '<button class="sub" onclick="make(true)">確認せずに QR コードを作る</button></div>',
  '<div id="out" style="display:none">',
  '<h3>2. スマホのカメラで読み取る</h3>',
  '<div id="qr"></div>',
  '<div class="note">読み取ると選考管理アプリが開き、自動で接続されます。iPhone は Safari で開いてから「ホーム画面に追加」してください。</div>',
  '<h3>接続コード（手入力・貼り付け用）</h3>',
  '<textarea id="code" readonly onclick="this.select()"></textarea>',
  '<button class="sub" onclick="mail()">リンクを自分にメールする</button><span id="mailed" class="note"></span>',
  '<div class="note" style="margin-top:10px">⚠ この QR コード・接続コードがあれば誰でもデータを読み書きできます。人に見せないでください。</div>',
  '</div>',
  '<script>',
  'var info = <?!= info ?>;',
  'document.getElementById("url").value = info.webAppUrl || "";',
  'function b64url(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}',
  'var link = "", code = "";',
  'function make(skip){',
  '  var url = document.getElementById("url").value.trim();',
  '  document.getElementById("err").textContent = "";',
  '  document.getElementById("skip").style.display = "none";',
  '  document.getElementById("out").style.display = "none";',
  '  document.getElementById("busy").textContent = "ウェブアプリにつながるか確認しています…";',
  '  document.getElementById("mk").disabled = true;',
  '  google.script.run.withFailureHandler(function(e){',
  '      document.getElementById("busy").textContent = "";',
  '      document.getElementById("mk").disabled = false;',
  '      document.getElementById("err").textContent = e.message;',
  '      if (!/形式|テスト用/.test(e.message)) document.getElementById("skip").style.display = "block";',
  '    })',
  '    .withSuccessHandler(function(saved){',
  '      url = saved;',
  '      document.getElementById("url").value = saved;',
  '      document.getElementById("busy").textContent = skip ? "確認せずに作りました" : "✅ ウェブアプリにつながりました";',
  '      document.getElementById("mk").disabled = false;',
  '      code = b64url(JSON.stringify({u:url,t:info.token}));',
  '      link = info.appUrl.replace(/#.*$/,"") + "#connect=" + code;',
  '      document.getElementById("code").value = code;',
  '      var qr = document.getElementById("qr"); qr.innerHTML = "";',
  '      new QRCode(qr, {text: link, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.L});',
  '      document.getElementById("out").style.display = "block";',
  '    }).saveWebAppUrl(url, !!skip);',
  '}',
  'function mail(){',
  '  google.script.run.withSuccessHandler(function(me){document.getElementById("mailed").textContent = " " + me + " に送信しました";})',
  '    .withFailureHandler(function(e){document.getElementById("err").textContent = e.message;}).sendConnectEmail(link, code);',
  '}',
  'if (info.webAppUrl) make();',
  '</script></body></html>'
].join('\n');

// ---------------------------------------------------------------------------
// Web API（スマホのアプリから呼ばれる）
// ---------------------------------------------------------------------------

function doGet(e) {
  return handleRequest_((e && e.parameter) || {});
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'bad_request', message: 'リクエストの形式が不正です' });
  }
  return handleRequest_(body);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest_(p) {
  try {
    var action = p.action || 'ping';
    if (action === 'ping') return jsonOut_({ ok: true, app: 'senkoukanri' });
    var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    if (!token || p.token !== token) {
      return jsonOut_({ ok: false, error: 'unauthorized', message: '合言葉（接続コード）が違います。もう一度接続してください。' });
    }
    var fn = API_[action];
    if (!fn) return jsonOut_({ ok: false, error: 'unknown_action', message: '不明な操作です: ' + action });
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      var result = fn(p) || {};
      result.ok = true;
      return jsonOut_(result);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: 'error', message: String((err && err.message) || err) });
  }
}

var API_ = {
  data: function () {
    return getAllData_();
  },

  saveCompany: function (p) {
    var id = saveCompany_(p.company || {});
    syncCalendarSafe_();
    var data = getAllData_();
    data.savedId = id;
    return data;
  },

  deleteCompany: function (p) {
    deleteCompany_(String(p.id || ''));
    syncCalendarSafe_();
    return getAllData_();
  },

  saveEvent: function (p) {
    var id = saveEvent_(p.event || {});
    syncCalendarSafe_();
    var data = getAllData_();
    data.savedId = id;
    return data;
  },

  deleteEvent: function (p) {
    var t = readTable_(SHEETS.events);
    var row = findById_(t, p.id);
    if (!row) throw new Error('予定が見つかりません（スプレッドシートで削除された可能性があります）');
    t.sheet.deleteRow(row._row);
    syncCalendarSafe_();
    return getAllData_();
  },

  confirmMails: function (p) {
    confirmMails_(p.ids);
    return getAllData_();
  },

  subscribe: function (p) {
    var sub = p.subscription || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('通知の購読情報が不正です');
    upsertDevice_(sub, String(p.deviceName || '').slice(0, 60));
    return { devices: listDevices_() };
  },

  unsubscribe: function (p) {
    removeDevices_([String(p.endpoint || '')]);
    return { devices: listDevices_() };
  },

  testPush: function (p) {
    var results = deliver_([{
      key: 'test|' + Date.now(),
      title: '✅ 通知テスト',
      body: 'この通知が見えていれば設定は完了です。面接・締切の前にお知らせします。',
      url: '#/settings',
      tag: 'test'
    }], { onlyEndpoint: p.endpoint || '', noFallbackMail: true });
    return { results: results.perDevice, devices: listDevices_() };
  },

  /** Service Worker が暗号化ペイロードを受け取れなかったときのための、直近の通知一覧 */
  recent: function () {
    var t = readTable_(SHEETS.log);
    var since = Date.now() - 15 * MINUTE_MS;
    var items = t.rows.filter(function (r) {
      var d = toDate_(r.sentAt);
      return d && d.getTime() >= since && !/^test\|/.test(str_(r.key));
    }).map(function (r) {
      return { key: str_(r.key), title: str_(r.title), body: str_(r.body) };
    });
    return { notifications: items.slice(-5) };
  }
};

function getAllData_() {
  var settings = readSettings_();
  var companies = readCompanies_();
  var byName = indexByName_(companies);
  var events = readEvents_(byName);
  var mails = readMails_().filter(function (m) {
    var d = m.receivedAt ? new Date(m.receivedAt) : null;
    return !m.confirmed || !d || Date.now() - d.getTime() < 60 * DAY_MS;
  });
  var props = PropertiesService.getScriptProperties();
  var calendar = { on: !!settings.calendarId, name: props.getProperty('CAL_NAME') || '', error: props.getProperty('CAL_LAST_ERROR') || '' };
  if (calendar.on) {
    var linked = {};
    readCalendarLinks_().links.forEach(function (l) {
      if (l.state === 'linked') linked[l.rowId] = true;
    });
    events.forEach(function (e) { e.calendar = !!linked[e.id]; });
  }
  return {
    companies: companies,
    events: events,
    mails: mails,
    devices: listDevices_(),
    options: {
      statuses: settings.statuses,
      closedStatuses: settings.closedStatuses,
      eventTypes: EVENT_TYPES,
      results: RESULT_OPTIONS,
      gmail: settings.gmail,
      calendar: calendar
    },
    vapidPublicKey: props.getProperty('VAPID_PUBLIC') || '',
    spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    serverTime: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// 企業・予定・メールの読み書き
// ---------------------------------------------------------------------------

var COMPANY_FIELDS = ['name', 'status', 'priority', 'industry', 'mypageUrl', 'loginId', 'mailKeywords', 'memo'];
var EVENT_FIELDS = ['company', 'type', 'title', 'datetime', 'place', 'done', 'result', 'resultDue', 'memo'];

function readCompanies_() {
  var t = readTable_(SHEETS.companies, function (r) { return str_(r.name) !== ''; });
  return t.rows.filter(function (r) { return str_(r.name) !== ''; }).map(function (r) {
    return {
      id: str_(r.id),
      name: str_(r.name),
      status: str_(r.status),
      priority: str_(r.priority),
      industry: str_(r.industry),
      mypageUrl: str_(r.mypageUrl),
      loginId: str_(r.loginId),
      mailKeywords: str_(r.mailKeywords),
      memo: str_(r.memo),
      updatedAt: isoOrEmpty_(r.updatedAt)
    };
  });
}

function readEvents_(companiesByName) {
  var t = readTable_(SHEETS.events, function (r) { return str_(r.company) !== '' || str_(r.title) !== ''; });
  return t.rows.filter(function (r) { return str_(r.company) !== '' || str_(r.title) !== ''; }).map(function (r) {
    var dt = parseDateTime_(r.datetime, new Date());
    var due = parseDateTime_(r.resultDue, new Date());
    var company = str_(r.company);
    var c = companiesByName[normalizeName_(company)];
    return {
      id: str_(r.id),
      company: company,
      companyId: c ? c.id : '',
      type: str_(r.type) || 'その他',
      title: str_(r.title),
      datetime: dt ? dt.toISOString() : '',
      datetimeText: dt ? '' : str_(r.datetime),
      place: str_(r.place),
      done: toBool_(r.done),
      result: str_(r.result),
      resultDue: due ? jstDayKey_(due) : '',
      memo: str_(r.memo),
      updatedAt: isoOrEmpty_(r.updatedAt)
    };
  });
}

function readMails_() {
  var t = readTable_(SHEETS.mails);
  return t.rows.filter(function (r) { return str_(r.id) !== ''; }).map(function (r) {
    return {
      id: str_(r.id),
      receivedAt: isoOrEmpty_(r.receivedAt),
      company: str_(r.company),
      subject: str_(r.subject),
      from: str_(r.from),
      link: str_(r.link),
      confirmed: toBool_(r.confirmed),
      notifyCount: Number(r.notifyCount) || 0,
      lastNotifiedAt: isoOrEmpty_(r.lastNotifiedAt)
    };
  });
}

function indexByName_(companies) {
  var m = {};
  companies.forEach(function (c) { m[normalizeName_(c.name)] = c; });
  return m;
}

function normalizeName_(s) {
  return normalizeText_(s).replace(/\s+/g, '');
}

function saveCompany_(c) {
  var name = String(c.name == null ? '' : c.name).trim();
  var t = readTable_(SHEETS.companies, function (r) { return str_(r.name) !== ''; });
  var row = c.id ? findById_(t, c.id) : null;
  if (c.id && !row) throw new Error('企業が見つかりません（スプレッドシートで削除された可能性があります）');
  if (!row || c.name !== undefined) {
    if (!name) throw new Error('企業名を入力してください');
    var dup = t.rows.filter(function (r) {
      return normalizeName_(r.name) === normalizeName_(name) && (!row || r._row !== row._row);
    });
    if (dup.length) throw new Error('「' + name + '」はすでに登録されています');
  }
  var fields = pickFields_(c, COMPANY_FIELDS);
  if (fields.name !== undefined) fields.name = name;
  fields.updatedAt = new Date();
  if (row) {
    var oldName = str_(row.name);
    writeFields_(t, row._row, fields);
    if (fields.name !== undefined && oldName !== name) renameCompanyEverywhere_(oldName, name);
    return str_(row.id);
  }
  fields.id = newId_(SHEETS.companies.idPrefix);
  appendFields_(t, fields);
  return fields.id;
}

function renameCompanyEverywhere_(oldName, newName) {
  [SHEETS.events, SHEETS.mails].forEach(function (def) {
    var t = readTable_(def);
    t.rows.forEach(function (r) {
      if (normalizeName_(r.company) === normalizeName_(oldName)) writeFields_(t, r._row, { company: newName });
    });
  });
}

function deleteCompany_(id) {
  var t = readTable_(SHEETS.companies);
  var row = findById_(t, id);
  if (!row) throw new Error('企業が見つかりません（スプレッドシートで削除された可能性があります）');
  var name = normalizeName_(row.name);
  var ev = readTable_(SHEETS.events);
  ev.rows.filter(function (r) { return normalizeName_(r.company) === name; })
    .sort(function (a, b) { return b._row - a._row; })
    .forEach(function (r) { ev.sheet.deleteRow(r._row); });
  t.sheet.deleteRow(row._row);
}

function saveEvent_(e) {
  var t = readTable_(SHEETS.events, function (r) { return str_(r.company) !== '' || str_(r.title) !== ''; });
  var row = e.id ? findById_(t, e.id) : null;
  if (e.id && !row) throw new Error('予定が見つかりません（スプレッドシートで削除された可能性があります）');
  var fields = pickFields_(e, EVENT_FIELDS);
  if (!row && !String(fields.company || '').trim() && !String(fields.title || '').trim()) {
    throw new Error('企業を選ぶか、内容を入力してください');
  }
  if (fields.datetime !== undefined) {
    if (fields.datetime) {
      var d = new Date(fields.datetime);
      if (isNaN(d.getTime())) throw new Error('日時の形式が不正です');
      fields.datetime = d;
    } else {
      fields.datetime = '';
    }
  }
  if (fields.resultDue !== undefined) {
    var m = String(fields.resultDue || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    fields.resultDue = m ? jstDate_(+m[1], +m[2], +m[3], 0, 0) : '';
  }
  if (fields.done !== undefined) fields.done = !!fields.done;
  fields.updatedAt = new Date();
  if (row) {
    writeFields_(t, row._row, fields);
    return str_(row.id);
  }
  fields.id = newId_(SHEETS.events.idPrefix);
  if (fields.done === undefined) fields.done = false;
  appendFields_(t, fields);
  return fields.id;
}

function confirmMails_(ids) {
  var t = readTable_(SHEETS.mails);
  var all = ids === 'all';
  var set = {};
  (Array.isArray(ids) ? ids : []).forEach(function (id) { set[String(id)] = true; });
  t.rows.forEach(function (r) {
    if (!toBool_(r.confirmed) && (all || set[str_(r.id)])) writeFields_(t, r._row, { confirmed: true });
  });
}

function pickFields_(obj, keys) {
  var out = {};
  keys.forEach(function (k) {
    if (obj[k] !== undefined) out[k] = typeof obj[k] === 'string' ? obj[k].trim() : obj[k];
  });
  return out;
}

function newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

// ---------------------------------------------------------------------------
// シート入出力の共通処理
// ---------------------------------------------------------------------------

function getSheet_(def) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(def.name) || createSheet_(ss, def);
}

/** 見出し行から { key: 0始まりの列番号 } を作る。足りない列は末尾に追加する。 */
function headerIndex_(sh, def) {
  var lastCol = sh.getLastColumn();
  var header = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var idx = {};
  header.forEach(function (h, i) {
    var label = String(h).trim();
    def.columns.forEach(function (c) {
      if (c.label === label && idx[c.key] == null) idx[c.key] = i;
    });
  });
  var missing = def.columns.filter(function (c) { return idx[c.key] == null; });
  if (missing.length) {
    var start = header.length;
    sh.getRange(1, start + 1, 1, missing.length)
      .setValues([missing.map(function (c) { return c.label; })])
      .setFontWeight('bold').setBackground('#eef2ff');
    missing.forEach(function (c, i) { idx[c.key] = start + i; });
  }
  return idx;
}

/**
 * シートを読み込む。
 * @param {Object} def SHEETS の定義
 * @param {function(Object):boolean=} needsId ID が空なら採番する行の条件（手入力の行用）
 */
function readTable_(def, needsId) {
  var sh = getSheet_(def);
  var idx = headerIndex_(sh, def);
  var lastRow = sh.getLastRow();
  var width = sh.getLastColumn();
  var values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, width).getValues() : [];
  var rows = [];
  var assigned = [];
  values.forEach(function (v, i) {
    var blank = v.every(function (x) { return x === '' || x === null || x === false; });
    if (blank) return;
    var obj = { _row: i + 2 };
    def.columns.forEach(function (c) { obj[c.key] = v[idx[c.key]]; });
    if (def.idPrefix && needsId && idx.id != null && str_(obj.id) === '' && needsId(obj)) {
      obj.id = newId_(def.idPrefix);
      assigned.push(obj);
    }
    rows.push(obj);
  });
  assigned.forEach(function (r) { sh.getRange(r._row, idx.id + 1).setValue(r.id); });
  return { sheet: sh, idx: idx, rows: rows, def: def };
}

function findById_(t, id) {
  id = String(id || '');
  if (!id) return null;
  for (var i = 0; i < t.rows.length; i++) {
    if (str_(t.rows[i].id) === id) return t.rows[i];
  }
  return null;
}

function writeFields_(t, rowNum, fields) {
  Object.keys(fields).forEach(function (k) {
    if (t.idx[k] == null) return;
    t.sheet.getRange(rowNum, t.idx[k] + 1).setValue(fields[k]);
  });
}

function appendFields_(t, fields) {
  var width = Math.max(t.sheet.getLastColumn(), 1);
  var arr = [];
  for (var i = 0; i < width; i++) arr.push('');
  Object.keys(fields).forEach(function (k) {
    if (t.idx[k] != null) arr[t.idx[k]] = fields[k];
  });
  t.sheet.appendRow(arr);
  var rowNum = t.sheet.getLastRow();
  t.def.columns.forEach(function (c) {
    if (c.checkbox && t.idx[c.key] != null) setCheckbox_(t.sheet, t.idx[c.key], rowNum, 1);
  });
  return rowNum;
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function readSettings_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SETTINGS_SHEET) || ensureSettingsSheet_(ss);
  var raw = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      raw[String(r[0]).trim()] = r[1];
    });
  }
  var byKey = {};
  var missing = false;
  SETTING_DEFS.forEach(function (d) {
    if (raw[d.label] === undefined) missing = true;
    byKey[d.key] = raw[d.label] !== undefined ? raw[d.label] : d.def;
  });
  if (missing) ensureSettingsSheet_(ss); // コードを更新して増えた設定項目をシートに足す
  return parseSettings_(byKey);
}

/** 設定値（文字列）を使いやすい形にする。純粋関数。 */
function parseSettings_(byKey) {
  var timing = {};
  EVENT_TYPES.forEach(function (type) {
    var v = byKey['timing:' + type];
    var def = SETTING_DEFS.filter(function (d) { return d.key === 'timing:' + type; })[0].def;
    timing[type] = parseOffsets_(v === undefined || v === null ? def : v);
  });
  var list = function (v) {
    return String(v == null ? '' : v).split(/[,、，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  };
  var hour = function (v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    var n = parseInt(s, 10);
    return isNaN(n) || n < 0 || n > 23 ? null : n;
  };
  var num = function (v, d) {
    var n = parseFloat(String(v == null ? '' : v));
    return isNaN(n) ? d : n;
  };
  var quiet = String(byKey.quietHours || '').match(/(\d{1,2})\s*[-〜~ー]\s*(\d{1,2})/);
  return {
    statuses: list(byKey.statuses),
    closedStatuses: list(byKey.closedStatuses),
    timing: timing,
    digestHour: hour(byKey.digestHour),
    resultHour: hour(byKey.resultHour),
    resultDays: num(byKey.resultDays, 30),
    gmail: /^(on|true|1|はい|有効)$/i.test(String(byKey.gmail).trim()),
    gmailCommon: list(byKey.gmailCommon),
    gmailExclude: String(byKey.gmailExclude == null ? '' : byKey.gmailExclude).trim(),
    mailRemindHours: num(byKey.mailRemindHours, 2),
    quiet: quiet ? [parseInt(quiet[1], 10), parseInt(quiet[2], 10)] : null,
    calendarId: String(byKey.calendarId == null ? '' : byKey.calendarId).trim(),
    calendarImport: /^(on|true|1|はい|有効)$/i.test(String(byKey.calendarImport).trim()),
    calendarDuration: num(byKey.calendarDuration, 60),
    appUrl: String(byKey.appUrl || '').trim()
  };
}

/** 「3日前, 6時間前, 30分前」→ [4320, 360, 30]（分）。数字だけなら分。 */
function parseOffsets_(text) {
  var out = [];
  String(text == null ? '' : text).replace(/(\d+(?:\.\d+)?)\s*(日|時間|h|分|m)?/gi, function (_, n, unit) {
    var v = parseFloat(n);
    if (unit === '日') v *= 1440;
    else if (unit === '時間' || /^h$/i.test(unit || '')) v *= 60;
    v = Math.round(v);
    if (v > 0 && out.indexOf(v) < 0) out.push(v);
    return _;
  });
  return out.sort(function (a, b) { return b - a; });
}

// ---------------------------------------------------------------------------
// 値の変換（日付は日本時間で扱う）
// ---------------------------------------------------------------------------

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function toDate_(v) {
  if (isDate_(v)) return v;
  if (typeof v === 'string' && v) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (isDate_(v)) return formatJst_(v, true);
  return String(v).trim();
}

function isoOrEmpty_(v) {
  var d = toDate_(v);
  return d ? d.toISOString() : '';
}

function toBool_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  return /^(true|済|済み|完了|○|◯|✓|✔|x|yes|1)$/i.test(String(v).trim());
}

function normalizeText_(s) {
  s = String(s == null ? '' : s);
  try {
    s = s.normalize('NFKC');
  } catch (e) {
    // normalize が無い環境ではそのまま
  }
  return s.toLowerCase().trim();
}

function jstParts_(date) {
  var d = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay()
  };
}

function jstDate_(y, m, d, h, mi) {
  return new Date(Date.UTC(y, m - 1, d, h || 0, mi || 0) - JST_OFFSET_MS);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function jstDayKey_(date) {
  var p = jstParts_(date);
  return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d);
}

function formatJst_(date, withYear) {
  var p = jstParts_(date);
  var s = (withYear ? p.y + '/' : '') + p.m + '/' + p.d;
  if (p.h || p.mi) s += ' ' + p.h + ':' + pad2_(p.mi);
  return s;
}

var WEEKDAYS_ = ['日', '月', '火', '水', '木', '金', '土'];

/** 「今日 14:00」「明日 9:30」「10/15(水) 14:00」 */
function formatWhen_(date, now) {
  var p = jstParts_(date);
  var today = jstDayKey_(now);
  var tomorrow = jstDayKey_(new Date(now.getTime() + DAY_MS));
  var key = jstDayKey_(date);
  var day = key === today ? '今日' : key === tomorrow ? '明日' : p.m + '/' + p.d + '(' + WEEKDAYS_[p.wd] + ')';
  return day + ' ' + p.h + ':' + pad2_(p.mi);
}

function humanizeMinutes_(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return min + '分';
  if (min < 1440) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + '時間' + (h < 3 && m >= 5 ? m + '分' : '');
  }
  var d = Math.floor(min / 1440);
  var hh = Math.floor((min % 1440) / 60);
  return d + '日' + (d < 3 && hh ? hh + '時間' : '');
}

/**
 * セルの値を日時にする。日付型ならそのまま、文字列なら
 * 「2026/10/15 14:00」「10/15 14:00」「10月15日 14時」などを日本時間として解釈する。
 */
function parseDateTime_(v, now) {
  if (isDate_(v)) return v;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // シリアル値（1899/12/30 起点の日数）
    return new Date(Math.round((v - 25569) * DAY_MS) - JST_OFFSET_MS);
  }
  var s = normalizeText_(v).replace(/\(.\)|（.）/g, ' ');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    var iso = new Date(String(v).trim());
    return isNaN(iso.getTime()) ? null : iso;
  }
  var y, m, d, rest;
  var full = s.match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?(.*)$/);
  var short = s.match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?(.*)$/);
  if (full) {
    y = +full[1]; m = +full[2]; d = +full[3]; rest = full[4];
  } else if (short) {
    m = +short[1]; d = +short[2]; rest = short[3];
    y = jstParts_(now || new Date()).y;
    var guess = jstDate_(y, m, d, 23, 59);
    if ((now || new Date()).getTime() - guess.getTime() > 180 * DAY_MS) y += 1;
  } else {
    return null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var h = 0, mi = 0;
  var t = String(rest || '').match(/(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
  if (t) {
    h = +t[1];
    mi = t[2] ? +t[2] : 0;
    if (/午後|pm/.test(rest) && h < 12) h += 12;
  }
  if (h > 24 || mi > 59) return null;
  return jstDate_(y, m, d, h, mi);
}

// ---------------------------------------------------------------------------
// 通知の計画（純粋関数。シートや Gmail に触れないのでテストしやすい）
// ---------------------------------------------------------------------------

function isDeadlineType_(type) {
  return /締切|締め切り|〆/.test(type);
}

function isQuiet_(settings, now) {
  if (!settings.quiet) return false;
  var h = jstParts_(now).h;
  var s = settings.quiet[0];
  var e = settings.quiet[1];
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

function eventLabel_(ev) {
  var title = ev.title || ev.type;
  if (!ev.company || normalizeName_(title).indexOf(normalizeName_(ev.company)) >= 0) return title;
  return ev.company + ' ' + title;
}

/** 通知対象として生きている予定か（終了した企業・結果が出た予定・完了した締切は除く） */
function isActiveEvent_(ev, closedCompanies) {
  if (!ev.datetime) return false;
  if (closedCompanies[normalizeName_(ev.company)]) return false;
  if (ev.result) return false;
  if (ev.done) return false;
  return true;
}

/**
 * @param {Object} state { settings, companies, events, mails, sentKeys }
 * @param {Date} now
 * @return {Array<Object>} 送る通知 { key, title, body, url, tag, markKeys?, mailIds? }
 */
function planNotifications_(state, now) {
  var settings = state.settings;
  var sent = state.sentKeys || {};
  var notes = [];
  var closed = {};
  (state.companies || []).forEach(function (c) {
    if (settings.closedStatuses.indexOf(c.status) >= 0) closed[normalizeName_(c.name)] = true;
  });
  var nowMs = now.getTime();
  var events = (state.events || []).map(function (e) {
    var copy = {};
    Object.keys(e).forEach(function (k) { copy[k] = e[k]; });
    copy._t = e.datetime ? new Date(e.datetime).getTime() : NaN;
    return copy;
  });

  // 1) 面接・締切などの事前通知
  events.forEach(function (ev) {
    if (!isActiveEvent_(ev, closed) || isNaN(ev._t) || ev._t <= nowMs) return;
    var offsets = settings.timing[ev.type] || settings.timing['その他'] || [];
    var stamp = new Date(ev._t).toISOString();
    var due = offsets.filter(function (o) {
      return ev._t - o * MINUTE_MS <= nowMs && !sent['ev|' + ev.id + '|' + stamp + '|' + o];
    });
    if (!due.length) return;
    var keys = due.map(function (o) { return 'ev|' + ev.id + '|' + stamp + '|' + o; });
    var remain = humanizeMinutes_((ev._t - nowMs) / MINUTE_MS);
    var when = formatWhen_(new Date(ev._t), now);
    var note = { key: keys[keys.length - 1], markKeys: keys, url: '#/event/' + ev.id, tag: 'ev-' + ev.id };
    if (isDeadlineType_(ev.type)) {
      note.title = '📝 締切まであと' + remain + '｜' + eventLabel_(ev);
      note.body = when + ' 締切。まだ「完了」になっていません。\n提出したらアプリで「完了」にしてください。';
    } else {
      note.title = '⏰ あと' + remain + '｜' + eventLabel_(ev);
      note.body = when + '〜' + (ev.place ? '\n' + ev.place : '');
    }
    notes.push(note);
  });

  var hour = jstParts_(now).h;
  var today = jstDayKey_(now);

  // 2) 朝のまとめ（設定時刻から 3 時間以内に 1 回）
  if (settings.digestHour != null && hour >= settings.digestHour && hour < settings.digestHour + 3 && !sent['digest|' + today]) {
    var tomorrow = jstDayKey_(new Date(nowMs + DAY_MS));
    var lines = [];
    var listed = {};
    events.filter(function (ev) { return isActiveEvent_(ev, closed) && !isNaN(ev._t) && ev._t > nowMs; })
      .sort(function (a, b) { return a._t - b._t; })
      .forEach(function (ev) {
        var day = jstDayKey_(new Date(ev._t));
        var p = jstParts_(new Date(ev._t));
        var time = p.h + ':' + pad2_(p.mi) + (isDeadlineType_(ev.type) ? '〆' : '');
        if (day === today) {
          lines.push('今日 ' + time + ' ' + eventLabel_(ev));
        } else if (day === tomorrow) {
          lines.push('明日 ' + time + ' ' + eventLabel_(ev));
        } else if (isDeadlineType_(ev.type) && ev._t - nowMs <= 3 * DAY_MS) {
          lines.push(p.m + '/' + p.d + ' ' + time + ' ' + eventLabel_(ev));
        } else {
          return;
        }
        listed[ev.id] = true;
      });
    var unconfirmed = (state.mails || []).filter(function (m) { return !m.confirmed; });
    if (unconfirmed.length) lines.push('⚠️ 未確認の企業メール ' + unconfirmed.length + '件');
    if (lines.length) {
      notes.push({
        key: 'digest|' + today,
        title: '☀️ 今日の予定と近い締切',
        body: lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\nほか' + (lines.length - 8) + '件' : ''),
        url: '#/home',
        tag: 'digest'
      });
    }
  }

  // 3) 結果メール確認リマインド（設定時刻以降に 1 日 1 回）
  if (settings.resultHour != null && hour >= settings.resultHour && !sent['result|' + today]) {
    var waiting = resultWaitingEvents_(state, now, closed);
    if (waiting.length) {
      notes.push({
        key: 'result|' + today,
        title: '📮 結果メールを確認しましたか？（結果待ち ' + waiting.length + '件）',
        body: waiting.slice(0, 6).map(function (ev) {
          var p = jstParts_(new Date(ev.datetime));
          return '・' + eventLabel_(ev) + '（' + p.m + '/' + p.d + '）';
        }).join('\n') + (waiting.length > 6 ? '\nほか' + (waiting.length - 6) + '件' : '') +
          '\n届いていたらアプリで結果を記録しましょう。',
        url: '#/home',
        tag: 'result'
      });
    }
  }

  // 4) 未確認メールの再通知
  if (settings.mailRemindHours > 0 && !isQuiet_(settings, now)) {
    var pending = (state.mails || []).filter(function (m) { return !m.confirmed; });
    var dueMail = pending.some(function (m) {
      var last = m.lastNotifiedAt || m.receivedAt;
      return !last || nowMs - new Date(last).getTime() >= settings.mailRemindHours * 3600 * 1000 - 60 * 1000;
    });
    if (pending.length && dueMail) {
      notes.push({
        key: 'mailremind|' + now.toISOString(),
        title: '⚠️ 未確認の企業メールが' + pending.length + '件あります',
        body: pending.slice(0, 5).map(function (m) { return '・' + (m.company || '') + '：' + m.subject; }).join('\n') +
          (pending.length > 5 ? '\nほか' + (pending.length - 5) + '件' : '') + '\n確認したら「確認済」にしてください。',
        url: '#/mails',
        tag: 'mail-remind',
        mailIds: pending.map(function (m) { return m.id; }),
        actions: [{ action: 'confirm-mails', title: '確認済みにする' }]
      });
    }
  }
  return notes;
}

/** 結果待ちの予定（結果確認リマインドの対象）。 */
function resultWaitingEvents_(state, now, closed) {
  var settings = state.settings;
  var nowMs = now.getTime();
  return (state.events || []).filter(function (ev) {
    if (!ev.datetime || ev.result) return false;
    if (RESULT_TYPES.indexOf(ev.type) < 0) return false;
    if (closed[normalizeName_(ev.company)]) return false;
    var t = new Date(ev.datetime).getTime();
    if (isDeadlineType_(ev.type) && !ev.done) return false;
    var start = t;
    if (ev.resultDue) {
      var m = ev.resultDue.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) start = jstDate_(+m[1], +m[2], +m[3], 0, 0).getTime();
    }
    if (start > nowMs) return false;
    return nowMs - Math.max(t, start) <= settings.resultDays * DAY_MS;
  }).sort(function (a, b) { return new Date(a.datetime) - new Date(b.datetime); });
}

/** 新着の企業メールの通知（純粋関数） */
function planMailNotifications_(newMails) {
  if (!newMails.length) return [];
  if (newMails.length <= 3) {
    return newMails.map(function (m) {
      return {
        key: 'mail|' + m.id,
        title: '📩 ' + (m.company || '企業') + 'からメール',
        body: m.subject + '\n' + m.from + '\n確認したらアプリで「確認済」にしてください。',
        url: '#/mails',
        tag: 'mail-' + m.id,
        mailIds: [m.id],
        actions: [{ action: 'confirm-mails', title: '確認済みにする' }]
      };
    });
  }
  return [{
    key: 'mail|' + newMails.map(function (m) { return m.id; }).join(','),
    title: '📩 企業からのメールが' + newMails.length + '件届きました',
    body: newMails.slice(0, 5).map(function (m) { return '・' + (m.company || '') + '：' + m.subject; }).join('\n'),
    url: '#/mails',
    tag: 'mail-new',
    mailIds: newMails.map(function (m) { return m.id; }),
    actions: [{ action: 'confirm-mails', title: '確認済みにする' }]
  }];
}

// ---------------------------------------------------------------------------
// Gmail 検知
// ---------------------------------------------------------------------------

/** キーワード一覧と Gmail 検索クエリを作る（純粋関数） */
function buildMailQuery_(companies, settings, afterSec) {
  var terms = [];
  companies.forEach(function (c) {
    if (settings.closedStatuses.indexOf(c.status) >= 0) return;
    var kws = String(c.mailKeywords || '').split(/[,、，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!kws.length && c.name) kws = [c.name];
    kws.forEach(function (k) { terms.push({ keyword: k, company: c.name }); });
  });
  settings.gmailCommon.forEach(function (k) { terms.push({ keyword: k, company: '' }); });
  if (!terms.length) return null;
  var parts = [];
  terms.forEach(function (t) {
    var k = t.keyword.replace(/["()]/g, ' ').trim();
    if (!k) return;
    if (/^@?[\w.-]+\.[a-z]{2,}$/i.test(k)) {
      parts.push('from:' + k.replace(/^@/, ''));
    }
    parts.push('"' + k + '"');
  });
  var q = 'after:' + afterSec + ' -in:sent -in:drafts -in:chats -in:spam -in:trash ' +
    (settings.gmailExclude ? settings.gmailExclude + ' ' : '') + '(' + parts.join(' OR ') + ')';
  return { query: q, terms: terms };
}

/** メールがどの企業のものかを判定する（純粋関数） */
function matchCompany_(terms, from, subject, body) {
  var fromN = normalizeText_(from);
  var text = normalizeText_(subject + '\n' + body);
  for (var i = 0; i < terms.length; i++) {
    var k = normalizeText_(terms[i].keyword).replace(/^@/, '');
    if (!k) continue;
    if (fromN.indexOf(k) >= 0 || text.indexOf(k) >= 0) return terms[i];
  }
  return null;
}

function detectNewMails_(state, now) {
  var props = PropertiesService.getScriptProperties();
  var nowSec = Math.floor(now.getTime() / 1000);
  var last = parseInt(props.getProperty('GMAIL_LAST_CHECK') || '0', 10);
  var afterSec = last ? last - 15 * 60 : nowSec - 24 * 3600;
  var q = buildMailQuery_(state.companies, state.settings, afterSec);
  if (!q) {
    props.setProperty('GMAIL_LAST_CHECK', String(nowSec));
    return [];
  }
  var known = {};
  state.mails.forEach(function (m) { known[m.id] = true; });
  var me = normalizeText_(Session.getEffectiveUser().getEmail());
  var found = [];
  var threads = GmailApp.search(q.query, 0, 30);
  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      var id = msg.getId();
      if (known[id]) return;
      if (msg.getDate().getTime() < afterSec * 1000) return;
      var from = msg.getFrom();
      if (me && normalizeText_(from).indexOf(me) >= 0) return;
      var subject = msg.getSubject() || '(件名なし)';
      var body = '';
      try {
        body = msg.getPlainBody().slice(0, 5000);
      } catch (e) {
        body = '';
      }
      var hit = matchCompany_(q.terms, from, subject, body);
      known[id] = true;
      found.push({
        id: id,
        receivedAt: msg.getDate().toISOString(),
        company: hit ? hit.company || '（共通キーワード）' : '（企業不明）',
        subject: subject,
        from: from,
        link: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + th.getId(),
        confirmed: false,
        notifyCount: 0,
        lastNotifiedAt: ''
      });
    });
  });
  // 検索に成功したときだけ時刻を進める（失敗したら次回同じ範囲を探し直す）
  props.setProperty('GMAIL_LAST_CHECK', String(nowSec));
  return found.sort(function (a, b) { return a.receivedAt < b.receivedAt ? -1 : 1; });
}

// ---------------------------------------------------------------------------
// 定期実行（5 分おきのトリガー）
// ---------------------------------------------------------------------------

function runScheduler() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var now = new Date();
    var settings = readSettings_();
    if (settings.calendarId) syncCalendarSafe_();
    var companies = readCompanies_();
    var events = readEvents_(indexByName_(companies));
    var mails = readMails_();
    var log = readTable_(SHEETS.log);
    var sentKeys = {};
    log.rows.forEach(function (r) { sentKeys[str_(r.key)] = true; });
    var state = { settings: settings, companies: companies, events: events, mails: mails, sentKeys: sentKeys };

    var notes = [];
    if (settings.gmail) {
      var newMails = [];
      try {
        newMails = detectNewMails_(state, now);
      } catch (e) {
        Logger.log('Gmail 検知でエラー: ' + e);
      }
      if (newMails.length) {
        var mt = readTable_(SHEETS.mails);
        newMails.forEach(function (m) {
          appendFields_(mt, {
            id: m.id,
            receivedAt: new Date(m.receivedAt),
            company: m.company,
            subject: m.subject,
            from: m.from,
            link: m.link,
            confirmed: false,
            notifyCount: 1,
            lastNotifiedAt: now
          });
          m.notifyCount = 1;
          m.lastNotifiedAt = now.toISOString();
        });
        state.mails = mails.concat(newMails);
        notes = notes.concat(planMailNotifications_(newMails));
      }
    }
    notes = notes.concat(planNotifications_(state, now));
    if (notes.length) deliver_(notes, { log: log });

    var reminded = {};
    notes.forEach(function (n) {
      if (/^mailremind\|/.test(n.key)) (n.mailIds || []).forEach(function (id) { reminded[id] = true; });
    });
    if (Object.keys(reminded).length) {
      var mt2 = readTable_(SHEETS.mails);
      mt2.rows.forEach(function (r) {
        if (reminded[str_(r.id)]) {
          writeFields_(mt2, r._row, { notifyCount: (Number(r.notifyCount) || 0) + 1, lastNotifiedAt: now });
        }
      });
    }
    pruneLog_(log, now);
  } finally {
    lock.releaseLock();
  }
}

function pruneLog_(log, now) {
  var limit = now.getTime() - 60 * DAY_MS;
  var old = log.rows.filter(function (r) {
    var d = toDate_(r.sentAt);
    return d && d.getTime() < limit;
  });
  if (!old.length) return;
  var maxRow = Math.max.apply(null, old.map(function (r) { return r._row; }));
  if (maxRow === old.length + 1) {
    log.sheet.deleteRows(2, old.length);
  } else {
    old.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { log.sheet.deleteRow(r._row); });
  }
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

function readDevices_() {
  var t = readTable_(SHEETS.devices);
  return {
    table: t,
    list: t.rows.filter(function (r) { return str_(r.endpoint) !== ''; }).map(function (r) {
      return {
        _row: r._row,
        name: str_(r.name),
        endpoint: str_(r.endpoint),
        keys: { p256dh: str_(r.p256dh), auth: str_(r.auth) },
        lastSentAt: isoOrEmpty_(r.lastSentAt),
        lastResult: str_(r.lastResult)
      };
    })
  };
}

function listDevices_() {
  return readDevices_().list.map(function (d) {
    return { name: d.name, endpoint: d.endpoint, lastSentAt: d.lastSentAt, lastResult: d.lastResult };
  });
}

function upsertDevice_(sub, name) {
  var d = readDevices_();
  var hit = d.list.filter(function (x) { return x.endpoint === sub.endpoint; })[0];
  var fields = { name: name || '端末', endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
  if (hit) {
    writeFields_(d.table, hit._row, fields);
  } else {
    fields.createdAt = new Date();
    appendFields_(d.table, fields);
  }
}

function removeDevices_(endpoints) {
  var set = {};
  endpoints.forEach(function (e) { set[e] = true; });
  var d = readDevices_();
  d.list.filter(function (x) { return set[x.endpoint]; })
    .sort(function (a, b) { return b._row - a._row; })
    .forEach(function (x) { d.table.sheet.deleteRow(x._row); });
}

function vapid_() {
  var props = PropertiesService.getScriptProperties();
  var email = '';
  try {
    email = Session.getEffectiveUser().getEmail();
  } catch (e) {
    email = '';
  }
  return {
    publicKey: props.getProperty('VAPID_PUBLIC'),
    privateKey: props.getProperty('VAPID_PRIVATE'),
    subject: email ? 'mailto:' + email : 'https://github.com/inuoi88-droid/senkoukanri'
  };
}

/**
 * 通知を全端末へ送り、通知ログに記録する。
 * 1 台も届かなかったときは自分宛てにメールで送る（通知の取りこぼし防止）。
 */
function deliver_(notes, opt) {
  opt = opt || {};
  var vapid = vapid_();
  var devices = readDevices_();
  var targets = devices.list.filter(function (d) { return !opt.onlyEndpoint || d.endpoint === opt.onlyEndpoint; });
  var log = opt.log || readTable_(SHEETS.log);
  var gone = [];
  var perDevice = {};
  var anyDelivered = false;
  var now = new Date();

  notes.forEach(function (n) {
    var message = { title: n.title, body: n.body, url: n.url || '#/home', tag: n.tag || n.key };
    if (n.mailIds) message.mailIds = n.mailIds;
    if (n.actions) message.actions = n.actions;
    var results = [];
    targets.forEach(function (d) {
      if (gone.indexOf(d.endpoint) >= 0) return;
      var status = 0;
      var detail = '';
      try {
        var res = WebPush.send(d, message, vapid, { ttl: 12 * 3600 });
        status = res.status;
        detail = res.body ? String(res.body).slice(0, 120) : '';
      } catch (e) {
        detail = String((e && e.message) || e);
      }
      var ok = status >= 200 && status < 300;
      if (ok) anyDelivered = true;
      if (status === 404 || status === 410) gone.push(d.endpoint);
      var summary = (d.name || '端末') + ': ' + (ok ? 'OK' : 'NG ' + status + ' ' + detail);
      results.push(summary);
      perDevice[d.endpoint] = { name: d.name, status: status, ok: ok, detail: detail };
      writeFields_(devices.table, d._row, { lastSentAt: now, lastResult: (ok ? 'OK' : 'NG ' + status + ' ' + detail).slice(0, 200) });
    });
    var keys = n.markKeys || [n.key];
    keys.forEach(function (k, i) {
      appendFields_(log, {
        sentAt: now,
        key: k,
        title: i === keys.length - 1 ? n.title : '（まとめて送信済み）',
        body: i === keys.length - 1 ? n.body : '',
        result: results.length ? results.join(' / ') : '端末なし'
      });
    });
  });

  if (gone.length) removeDevices_(gone);

  if (!anyDelivered && !opt.noFallbackMail && notes.length) {
    try {
      var me = Session.getEffectiveUser().getEmail();
      GmailApp.sendEmail(me, '【選考管理】' + notes[0].title + (notes.length > 1 ? ' ほか' : ''),
        notes.map(function (n) { return '■ ' + n.title + '\n' + n.body; }).join('\n\n') +
        '\n\n――\nスマホへの通知が届かない状態のため、メールで送りました。' +
        'アプリを開いて「設定 > 通知をオンにする」をやり直してください。');
    } catch (e) {
      Logger.log('メール送信に失敗: ' + e);
    }
  }
  return { perDevice: Object.keys(perDevice).map(function (k) { return perDevice[k]; }), delivered: anyDelivered };
}

function menuTestPush() {
  var r = deliver_([{ key: 'test|' + Date.now(), title: '✅ 通知テスト', body: 'スプレッドシートから送信したテスト通知です。', url: '#/settings', tag: 'test' }], { noFallbackMail: true });
  var lines = r.perDevice.map(function (d) { return (d.name || '端末') + '：' + (d.ok ? '送信OK' : '失敗 ' + d.status + ' ' + d.detail); });
  SpreadsheetApp.getUi().alert(lines.length ? lines.join('\n') : '通知を受け取る端末が登録されていません。スマホのアプリで「通知をオンにする」を押してください。');
}

// ---------------------------------------------------------------------------
// Google カレンダー連携（双方向）
//
// - アプリ（予定シート）の予定 → カレンダーに作る（作成元: app）
// - カレンダーに直接入れた予定 → アプリに取り込む（作成元: calendar）
// - 紐づいた予定は、変わった側の内容をもう一方へ反映する（両方変わったら新しい方）
// - 同期するのは今日以降の予定だけ。同じ日に同じ企業名の予定が両方にあれば、新しく作らず紐づける
// - アプリで消すと、作成元が app ならカレンダーからも消す。calendar ならカレンダーには残す
// - カレンダーで消すと、結果を記録していない予定はアプリからも消す
// 紐づけの状態は隠しシート「カレンダー同期」に保存する。
// ---------------------------------------------------------------------------

/** 32bit FNV-1a。内容が変わったかを比べるための短い指紋 */
function hash_(s) {
  var h = 0x811c9dc5;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function rowFingerprint_(row) {
  return hash_(JSON.stringify([row.company, row.type, row.title, row.datetime, row.place, row.memo || '']));
}

function calFingerprint_(v) {
  return hash_(JSON.stringify([
    v.title, v.allDay,
    v.allDay ? v.startDay : v.start.toISOString(),
    v.allDay ? v.endDay : v.end.toISOString(),
    v.location || ''
  ]));
}

/** 'yyyy-MM-dd' に日数を足す */
function addDays_(day, n) {
  var d = day.split('-');
  var t = new Date(Date.UTC(+d[0], +d[1] - 1, +d[2] + n));
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}

function dayDiff_(from, to) {
  var a = from.split('-');
  var b = to.split('-');
  return Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / DAY_MS);
}

function jstDayStart_(day) {
  var d = day.split('-');
  return jstDate_(+d[0], +d[1], +d[2], 0, 0);
}

/** カレンダーに出すタイトル。アプリで作った締切は「〆23:59 ソニー 本選考ES」の形 */
function calendarTitle_(row, origin) {
  var label = eventLabel_(row);
  if (origin === 'app' && isDeadlineType_(row.type) && row.datetime) {
    var p = jstParts_(new Date(row.datetime));
    label = '〆' + p.h + ':' + pad2_(p.mi) + ' ' + label;
  }
  return label;
}

/** 予定の行を、カレンダーではどう表すか（純粋関数） */
function calendarTarget_(row, origin, view, settings, company) {
  var start = new Date(row.datetime);
  var allDay = view ? view.allDay : isDeadlineType_(row.type);
  var t = { title: calendarTitle_(row, origin), allDay: allDay, location: row.place || '' };
  if (allDay) {
    var days = view && view.allDay ? Math.max(1, dayDiff_(view.startDay, view.endDay)) : 1;
    t.startDay = jstDayKey_(start);
    t.endDay = addDays_(t.startDay, days);
  } else {
    var dur = view && !view.allDay ? view.end.getTime() - view.start.getTime() : (settings.calendarDuration || 60) * MINUTE_MS;
    t.start = start;
    t.end = new Date(start.getTime() + dur);
  }
  if (origin === 'app') {
    var lines = [];
    if (row.memo) lines.push(row.memo);
    if (company && company.mypageUrl) lines.push('マイページ: ' + company.mypageUrl);
    lines.push('（選考管理アプリと同期しています。日時・場所はどちらで変えても反映されます）');
    t.description = lines.join('\n\n');
  }
  return t;
}

/** カレンダー側の変更を、予定の行のどの項目に反映するか（純粋関数） */
function pullFields_(view, row, origin) {
  var f = {};
  var cur = row.datetime ? new Date(row.datetime) : null;
  if (view.allDay) {
    var p = cur ? jstParts_(cur) : null;
    var deadline = isDeadlineType_(row.type);
    var d = view.startDay.split('-');
    var dt = jstDate_(+d[0], +d[1], +d[2], p ? p.h : deadline ? 23 : 9, p ? p.mi : deadline ? 59 : 0);
    if (!cur || cur.getTime() !== dt.getTime()) f.datetime = dt;
  } else if (!cur || cur.getTime() !== view.start.getTime()) {
    f.datetime = view.start;
  }
  if ((view.location || '') !== (row.place || '')) f.place = view.location || '';
  if (origin === 'calendar' && view.title !== row.title) f.title = view.title;
  return f;
}

/** タイトルに含まれる登録済みの企業（いちばん長い名前で一致したもの） */
function matchCompanyInTitle_(title, companies) {
  var t = normalizeName_(title);
  var best = null;
  companies.forEach(function (c) {
    var n = normalizeName_(c.name);
    if (n && t.indexOf(n) >= 0 && (!best || n.length > normalizeName_(best.name).length)) best = c;
  });
  return best;
}

/** カレンダーの予定のタイトルから種別を推測する */
function guessEventType_(title, allDay) {
  var t = normalizeText_(title);
  if (/webテスト|ウェブテスト|適性検査|spi|玉手箱|tg-?web|受検/.test(t)) return 'Webテスト締切';
  if (/(^|[^a-z])es([^a-z]|$)|エントリーシート|志望動機|シート|書類/.test(t) && (allDay || /締切|締め切り|〆|期限|提出/.test(t))) return 'ES締切';
  if (/(^|[^a-z])gd([^a-z]|$)|グループディスカッション|グループワーク/.test(t)) return 'GD';
  if (/面接/.test(t)) return '面接';
  if (/説明会|セミナー|インターン|internship|オープンカンパニー|1day|座談会/.test(t)) return '説明会';
  return 'その他';
}

/** カレンダーの予定をアプリに取り込むときの内容 */
function importFields_(view, companies) {
  var company = matchCompanyInTitle_(view.title, companies);
  var type = guessEventType_(view.title, view.allDay);
  var dt;
  if (view.allDay) {
    var d = view.startDay.split('-');
    var deadline = isDeadlineType_(type);
    dt = jstDate_(+d[0], +d[1], +d[2], deadline ? 23 : 9, deadline ? 59 : 0);
  } else {
    dt = view.start;
  }
  return { company: company ? company.name : '', type: type, title: view.title || '（タイトルなし）', datetime: dt, place: view.location || '' };
}

/** カレンダーから来た文字をセルに書くとき、数式や日付に化けないようにする */
function textCell_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@']|^[\d\s\/\-.:年月日時分]+$/.test(s) && s !== '' ? "'" + s : s;
}

/** 同じ日に同じ企業の予定がアプリにもあれば、それを返す（二重登録を防ぐ） */
function findDuplicateRow_(view, rows, used) {
  var vDay = view.allDay ? view.startDay : jstDayKey_(view.start);
  var vt = normalizeName_(view.title);
  var loose = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (used[r.id]) continue;
    var d = new Date(r.datetime);
    if (jstDayKey_(d) !== vDay) continue;
    var byName = (r.company && vt.indexOf(normalizeName_(r.company)) >= 0) ||
      (r.title && normalizeName_(r.title).length >= 2 && vt.indexOf(normalizeName_(r.title)) >= 0);
    if (!byName) continue;
    if (view.allDay || Math.abs(view.start.getTime() - d.getTime()) < MINUTE_MS) return r;
    if (!loose) loose = r;
  }
  return loose;
}

/**
 * 同期で行う操作の一覧を作る（純粋関数。カレンダーやシートには触れない）。
 * @param {{rows:Array, views:Array, links:Array, frozen:Object, settings:Object, companies:Array, now:Date}} p
 */
function planCalendarSync_(p) {
  var now = p.now;
  var tp = jstParts_(now);
  var todayStart = jstDate_(tp.y, tp.m, tp.d, 0, 0).getTime();
  var closed = {};
  p.companies.forEach(function (c) {
    if (p.settings.closedStatuses.indexOf(c.status) >= 0) closed[normalizeName_(c.name)] = true;
  });
  var rowById = {};
  p.rows.forEach(function (r) { rowById[r.id] = r; });
  var viewById = {};
  p.views.forEach(function (v) { viewById[v.id] = v; });
  var linkByCal = {};
  var linkByRow = {};
  p.links.forEach(function (l) {
    linkByCal[l.calEventId] = l;
    if (l.rowId) linkByRow[l.rowId] = l;
  });
  var actions = [];

  // 1) 紐づいている予定
  p.links.forEach(function (l) {
    if (l.state !== 'linked' || (p.frozen && p.frozen[l.calEventId])) return;
    var row = rowById[l.rowId];
    var view = viewById[l.calEventId];
    if (!row) {
      actions.push({ op: l.origin === 'calendar' ? 'ignore' : 'deleteCal', link: l });
      return;
    }
    if (!view) {
      actions.push({ op: row.result ? 'detach' : 'deleteRow', link: l, row: row });
      return;
    }
    if (!row.datetime) return;
    var rowChanged = rowFingerprint_(row) !== l.rowFp;
    var calChanged = calFingerprint_(view) !== l.calFp;
    if (!rowChanged && !calChanged) return;
    if (rowChanged && calChanged) {
      if ((row.updatedAt ? new Date(row.updatedAt).getTime() : 0) >= view.updated.getTime()) calChanged = false;
      else rowChanged = false;
    }
    actions.push({ op: rowChanged ? 'push' : 'pull', link: l, row: row, view: view });
  });

  // 2) まだ紐づいていない、今日以降のアプリの予定
  var unlinkedRows = p.rows.filter(function (r) {
    return !linkByRow[r.id] && r.datetime && new Date(r.datetime).getTime() >= todayStart &&
      !r.result && !closed[normalizeName_(r.company)];
  });
  var used = {};

  // 3) まだ紐づいていない、今日以降のカレンダーの予定
  p.views.forEach(function (v) {
    if (linkByCal[v.id] || v.recurring) return;
    var startMs = v.allDay ? jstDayStart_(v.startDay).getTime() : v.start.getTime();
    if (startMs < todayStart) return;
    var dup = findDuplicateRow_(v, unlinkedRows, used);
    if (dup) {
      used[dup.id] = true;
      actions.push({ op: 'link', row: dup, view: v });
    } else if (p.settings.calendarImport) {
      actions.push({ op: 'import', view: v, fields: importFields_(v, p.companies) });
    }
  });

  unlinkedRows.forEach(function (r) {
    if (!used[r.id]) actions.push({ op: 'create', row: r });
  });
  return actions;
}

// ---------- ここから下はカレンダー・シートを実際に操作する ----------

function calendarView_(ev) {
  var tz = Session.getScriptTimeZone();
  var allDay = ev.isAllDayEvent();
  var v = {
    id: ev.getId(),
    title: String(ev.getTitle() || '').trim(),
    allDay: allDay,
    location: String(ev.getLocation() || '').trim(),
    updated: ev.getLastUpdated(),
    recurring: ev.isRecurringEvent()
  };
  if (allDay) {
    v.startDay = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd');
    v.endDay = Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd');
  } else {
    v.start = ev.getStartTime();
    v.end = ev.getEndTime();
  }
  return v;
}

function calendarDay_(day) {
  return Utilities.parseDate(day, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function createCalendarEvent_(cal, t) {
  var opts = { location: t.location || '', description: t.description || '' };
  if (t.allDay) {
    if (dayDiff_(t.startDay, t.endDay) > 1) return cal.createAllDayEvent(t.title, calendarDay_(t.startDay), calendarDay_(t.endDay), opts);
    return cal.createAllDayEvent(t.title, calendarDay_(t.startDay), opts);
  }
  return cal.createEvent(t.title, t.start, t.end, opts);
}

function updateCalendarEvent_(ev, t, view) {
  if (view.title !== t.title) ev.setTitle(t.title);
  if ((view.location || '') !== t.location) ev.setLocation(t.location);
  if (t.description !== undefined && String(ev.getDescription() || '') !== t.description) ev.setDescription(t.description);
  if (t.allDay) {
    if (view.startDay !== t.startDay || view.endDay !== t.endDay) {
      if (dayDiff_(t.startDay, t.endDay) > 1) ev.setAllDayDates(calendarDay_(t.startDay), calendarDay_(t.endDay));
      else ev.setAllDayDate(calendarDay_(t.startDay));
    }
  } else if (view.start.getTime() !== t.start.getTime() || view.end.getTime() !== t.end.getTime()) {
    ev.setTime(t.start, t.end);
  }
}

function readCalendarLinks_() {
  var t = readTable_(SHEETS.calsync);
  return {
    table: t,
    links: t.rows.filter(function (r) { return str_(r.calEventId) !== ''; }).map(function (r) {
      return {
        _row: r._row,
        calEventId: str_(r.calEventId),
        rowId: str_(r.rowId),
        origin: str_(r.origin) || 'app',
        rowFp: str_(r.rowFp),
        calFp: str_(r.calFp),
        state: str_(r.state) || 'linked'
      };
    })
  };
}

function clearCalendarLinks_() {
  var t = readTable_(SHEETS.calsync);
  if (t.rows.length) t.sheet.deleteRows(2, t.sheet.getLastRow() - 1);
}

/**
 * 古いコードが別ファイルや同じファイルの後ろに残っていると、新しい設定・シート定義が上書きされてしまう。
 * カレンダー連携の入口でそれを見つけて、分かりやすく知らせる。
 */
function assertLatestCode_() {
  var ok = SHEETS.calsync && SETTING_DEFS.some(function (d) { return d.key === 'calendarId'; });
  if (!ok) {
    throw new Error('古いコードが残っています。Apps Script の左の「ファイル」が「コード.gs」と「WebPush.gs」の 2 つだけで、' +
      '「コード.gs」の中身が最新の全文 1 回分だけ（一番下が 2357 行目）になっているか確認してください。');
  }
}

/**
 * カレンダーと同期する。
 * @param {{calendarId?:string, importOn?:boolean, dryRun?:boolean}=} opt
 * @return {Object|null} 操作ごとの件数と例
 */
function syncCalendar_(opt) {
  assertLatestCode_();
  opt = opt || {};
  var settings = readSettings_();
  var calId = opt.calendarId || settings.calendarId;
  if (!calId) return null;
  if (opt.importOn !== undefined) settings.calendarImport = !!opt.importOn;
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) throw new Error('カレンダーが見つかりません。このアカウントにカレンダーが共有されているか確認してください（ID: ' + calId + '）');

  var props = PropertiesService.getScriptProperties();
  if (!opt.dryRun && props.getProperty('CAL_LINKED_ID') !== calId) {
    // 別のカレンダーに切り替えたら、前の紐づけは使わない
    clearCalendarLinks_();
    props.setProperty('CAL_LINKED_ID', calId);
  }

  var now = new Date();
  var tp = jstParts_(now);
  var todayStart = jstDate_(tp.y, tp.m, tp.d, 0, 0).getTime();
  var companies = readCompanies_();
  var rows = readEvents_(indexByName_(companies));
  var linkData = readCalendarLinks_();
  var links = props.getProperty('CAL_LINKED_ID') === calId ? linkData.links : [];

  var evObjs = {};
  var views = [];
  var from = new Date(todayStart - 31 * DAY_MS);
  var to = new Date(todayStart + 400 * DAY_MS);
  cal.getEvents(from, to).forEach(function (ev) {
    var v = calendarView_(ev);
    if (evObjs[v.id]) return; // 繰り返し予定は同じ ID が並ぶ
    evObjs[v.id] = ev;
    views.push(v);
  });

  // 取得範囲の外に動いた予定を探す（範囲内なのに見つからなければ削除されたとみなす）
  var rowById = {};
  rows.forEach(function (r) { rowById[r.id] = r; });
  var frozen = {};
  links.forEach(function (l) {
    if (l.state !== 'linked' || evObjs[l.calEventId]) return;
    var row = rowById[l.rowId];
    if (row && row.datetime && new Date(row.datetime).getTime() < todayStart - 30 * DAY_MS) {
      frozen[l.calEventId] = true;
      return;
    }
    var ev = null;
    try {
      ev = cal.getEventById(l.calEventId);
    } catch (e) {
      ev = null;
    }
    if (!ev) return;
    var v = calendarView_(ev);
    var s = v.allDay ? jstDayStart_(v.startDay) : v.start;
    if (s >= from && s < to) return; // 範囲内なのに一覧に無い＝削除済み
    evObjs[v.id] = ev;
    views.push(v);
  });

  var actions = planCalendarSync_({ rows: rows, views: views, links: links, frozen: frozen, settings: settings, companies: companies, now: now });
  if (!opt.dryRun) applyCalendarActions_(actions, { cal: cal, evObjs: evObjs, linkTable: linkData.table, settings: settings, companies: companies, now: now });
  return summarizeCalendarActions_(actions);
}

function summarizeCalendarActions_(actions) {
  var out = { create: 0, import: 0, link: 0, push: 0, pull: 0, deleteCal: 0, deleteRow: 0, ignore: 0, detach: 0, samples: { create: [], import: [], link: [] } };
  actions.forEach(function (a) {
    out[a.op]++;
    if (out.samples[a.op] && out.samples[a.op].length < 8) {
      var title = a.op === 'import' ? a.view.title : eventLabel_(a.row);
      var when = a.op === 'import'
        ? (a.view.allDay ? a.view.startDay.slice(5).replace('-', '/') + ' 終日' : formatJst_(a.view.start))
        : formatJst_(new Date(a.row.datetime));
      out.samples[a.op].push(when + '　' + title);
    }
  });
  return out;
}

function applyCalendarActions_(actions, ctx) {
  if (!actions.length) return;
  var now = ctx.now;
  var evTable = readTable_(SHEETS.events);
  var rowNum = {};
  evTable.rows.forEach(function (r) { rowNum[str_(r.id)] = r._row; });
  var companyByName = indexByName_(ctx.companies);
  var deleteEventRows = [];
  var deleteLinkRows = [];
  var errors = [];

  var addLink = function (fields) {
    fields.syncedAt = now;
    appendFields_(ctx.linkTable, fields);
  };
  var updateLink = function (link, fields) {
    fields.syncedAt = now;
    writeFields_(ctx.linkTable, link._row, fields);
  };

  actions.forEach(function (a) {
    try {
      var ev, target, v;
      if (a.op === 'create') {
        target = calendarTarget_(a.row, 'app', null, ctx.settings, companyByName[normalizeName_(a.row.company)]);
        v = calendarView_(createCalendarEvent_(ctx.cal, target));
        addLink({ calEventId: v.id, rowId: a.row.id, origin: 'app', rowFp: rowFingerprint_(a.row), calFp: calFingerprint_(v), state: 'linked' });
      } else if (a.op === 'push') {
        ev = ctx.evObjs[a.view.id];
        target = calendarTarget_(a.row, a.link.origin, a.view, ctx.settings, companyByName[normalizeName_(a.row.company)]);
        updateCalendarEvent_(ev, target, a.view);
        updateLink(a.link, { rowFp: rowFingerprint_(a.row), calFp: calFingerprint_(calendarView_(ev)) });
      } else if (a.op === 'pull') {
        var fields = pullFields_(a.view, a.row, a.link.origin);
        var merged = {};
        Object.keys(a.row).forEach(function (k) { merged[k] = a.row[k]; });
        if (Object.keys(fields).length) {
          Object.keys(fields).forEach(function (k) {
            merged[k] = isDate_(fields[k]) ? fields[k].toISOString() : fields[k];
            if (typeof fields[k] === 'string') fields[k] = textCell_(fields[k]);
          });
          fields.updatedAt = now;
          writeFields_(evTable, rowNum[a.row.id], fields);
        }
        updateLink(a.link, { rowFp: rowFingerprint_(merged), calFp: calFingerprint_(a.view) });
      } else if (a.op === 'link') {
        addLink({ calEventId: a.view.id, rowId: a.row.id, origin: 'calendar', rowFp: rowFingerprint_(a.row), calFp: calFingerprint_(a.view), state: 'linked' });
      } else if (a.op === 'import') {
        var f = a.fields;
        var id = newId_(SHEETS.events.idPrefix);
        appendFields_(evTable, { id: id, company: f.company, type: f.type, title: textCell_(f.title), datetime: f.datetime, place: textCell_(f.place), done: false, updatedAt: now });
        var row = { company: f.company, type: f.type, title: f.title, datetime: f.datetime.toISOString(), place: f.place, memo: '' };
        addLink({ calEventId: a.view.id, rowId: id, origin: 'calendar', rowFp: rowFingerprint_(row), calFp: calFingerprint_(a.view), state: 'linked' });
      } else if (a.op === 'deleteCal') {
        ev = ctx.evObjs[a.link.calEventId] || ctx.cal.getEventById(a.link.calEventId);
        if (ev) ev.deleteEvent();
        deleteLinkRows.push(a.link._row);
      } else if (a.op === 'ignore') {
        updateLink(a.link, { state: 'ignored', rowId: '' });
      } else if (a.op === 'deleteRow') {
        if (rowNum[a.row.id]) deleteEventRows.push(rowNum[a.row.id]);
        deleteLinkRows.push(a.link._row);
      } else if (a.op === 'detach') {
        updateLink(a.link, { state: 'ignored' });
      }
    } catch (e) {
      errors.push(a.op + ': ' + e.message);
    }
  });

  deleteEventRows.sort(function (x, y) { return y - x; }).forEach(function (r) { evTable.sheet.deleteRow(r); });
  deleteLinkRows.sort(function (x, y) { return y - x; }).forEach(function (r) { ctx.linkTable.sheet.deleteRow(r); });
  if (errors.length) throw new Error('カレンダー同期で一部失敗しました: ' + errors.slice(0, 3).join(' / '));
}

/** API や定期実行から呼ぶ。失敗しても他の処理は止めず、エラーはアプリに表示する。 */
function syncCalendarSafe_() {
  var props = PropertiesService.getScriptProperties();
  try {
    var r = syncCalendar_();
    props.setProperty('CAL_LAST_ERROR', '');
    return r;
  } catch (e) {
    props.setProperty('CAL_LAST_ERROR', String(e.message || e).slice(0, 300));
    Logger.log('カレンダー同期でエラー: ' + e);
    return null;
  }
}

function setSetting_(key, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ensureSettingsSheet_(ss);
  var def = SETTING_DEFS.filter(function (d) { return d.key === key; })[0];
  var labels = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < labels.length; i++) {
    if (String(labels[i][0]).trim() === def.label) {
      sh.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([def.label, value, def.note]);
}

// ---------- メニュー「Google カレンダーと連携する」 ----------

function showCalendarDialog() {
  var t = HtmlService.createTemplate(CALENDAR_DIALOG_HTML);
  t.info = JSON.stringify(getCalendarDialogInfo());
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(500).setHeight(620), 'Google カレンダーと連携');
}

function getCalendarDialogInfo() {
  assertLatestCode_();
  var s = readSettings_();
  var cals = CalendarApp.getAllCalendars().filter(function (c) {
    return !/#holiday@|#contacts@|#weeknum@|@import\.calendar\.google\.com$/.test(c.getId());
  }).map(function (c) {
    return { id: c.getId(), name: c.getName() };
  });
  return { calendars: cals, current: s.calendarId, importOn: s.calendarImport };
}

/** ダイアログから呼ばれる。実際には変更せず、何が起きるかだけ返す。 */
function previewCalendarSync(calId, importOn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var props = PropertiesService.getScriptProperties();
    var r = syncCalendar_({ calendarId: calId, importOn: importOn, dryRun: true });
    if (props.getProperty('CAL_LINKED_ID') !== calId) r.switching = true;
    return r;
  } finally {
    lock.releaseLock();
  }
}

/** ダイアログから呼ばれる。連携を開始して 1 回同期する。 */
function startCalendarSync(calId, importOn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) throw new Error('カレンダーが見つかりません');
    setSetting_('calendarId', calId);
    setSetting_('calendarImport', importOn ? 'ON' : 'OFF');
    PropertiesService.getScriptProperties().setProperty('CAL_NAME', cal.getName());
    var r = syncCalendar_({ calendarId: calId, importOn: importOn });
    PropertiesService.getScriptProperties().setProperty('CAL_LAST_ERROR', '');
    return r;
  } finally {
    lock.releaseLock();
  }
}

/** ダイアログから呼ばれる。連携をやめる（カレンダーの予定・アプリの予定は消さない）。 */
function stopCalendarSync() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    setSetting_('calendarId', '');
    clearCalendarLinks_();
    var props = PropertiesService.getScriptProperties();
    props.setProperty('CAL_LINKED_ID', '');
    props.setProperty('CAL_LAST_ERROR', '');
    return true;
  } finally {
    lock.releaseLock();
  }
}

var CALENDAR_DIALOG_HTML = [
  '<!doctype html><html><head><base target="_top"><meta charset="utf-8">',
  '<style>',
  'body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;font-size:13px;color:#1f2937;margin:0;padding:4px 8px}',
  'h3{font-size:14px;margin:14px 0 6px}label.cal{display:block;padding:7px 8px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer}',
  'label.cal:hover{background:#f5f3ff}button{background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:8px 12px;font-size:13px;cursor:pointer;margin:8px 6px 0 0}',
  'button.sub{background:#e0e7ff;color:#3730a3}button.danger{background:#fee2e2;color:#b91c1c}button:disabled{opacity:.5}',
  '.note{color:#64748b;font-size:12px;line-height:1.6}.err{color:#dc2626;margin-top:8px}.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin-top:10px}',
  'ul{margin:4px 0 0;padding-left:18px}li{margin:2px 0}',
  '</style></head><body>',
  '<h3>1. 同期するカレンダー</h3><div id="list"></div>',
  '<label style="display:block;margin-top:8px"><input type="checkbox" id="imp"> カレンダーに直接入れた予定もアプリに取り込む（双方向）</label>',
  '<div class="note">同期するのは今日以降の予定です。両方にある同じ予定（同じ日・同じ企業名）は二重に作らず紐づけます。</div>',
  '<button id="pv" onclick="preview()">2. 何が変わるか確認する</button>',
  '<div id="busy" class="note"></div><div id="err" class="err"></div>',
  '<div id="out" class="box" style="display:none"></div>',
  '<button id="go" style="display:none" onclick="start()">3. この内容で連携を開始</button>',
  '<div id="stopbox" style="display:none;margin-top:14px"><div class="note">連携をやめても、カレンダーとアプリの予定はどちらも消えません。</div>',
  '<button class="danger" onclick="stop()">連携をやめる</button></div>',
  '<script>',
  'var info = <?!= info ?>;',
  'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
  'document.getElementById("list").innerHTML = info.calendars.map(function(c){',
  '  return "<label class=\\"cal\\"><input type=\\"radio\\" name=\\"cal\\" value=\\"" + esc(c.id) + "\\"" + (c.id === info.current ? " checked" : "") + "> " + esc(c.name) + "</label>";',
  '}).join("") || "<div class=\\"note\\">カレンダーが見つかりません</div>";',
  'document.getElementById("imp").checked = info.importOn !== false;',
  'if (info.current) document.getElementById("stopbox").style.display = "block";',
  'function sel(){var r = document.querySelector("input[name=cal]:checked"); return r ? r.value : "";}',
  'function busy(t){document.getElementById("busy").textContent = t || ""; document.getElementById("pv").disabled = !!t; document.getElementById("go").disabled = !!t;}',
  'function fail(e){busy(""); document.getElementById("err").textContent = e.message;}',
  'function list(title, arr, n){ if (!n) return ""; return "<div style=\\"margin-top:6px\\"><b>" + title + "：" + n + "件</b><ul>" + arr.map(function(s){return "<li>" + esc(s) + "</li>";}).join("") + (n > arr.length ? "<li>ほか" + (n - arr.length) + "件</li>" : "") + "</ul></div>"; }',
  'function show(r, done){',
  '  var h = done ? "<b>✅ 連携しました</b>" : "<b>連携を開始すると次のようになります</b>";',
  '  if (r.switching && !done) h += "<div class=\\"note\\">※ 前の紐づけはリセットされます。</div>";',
  '  h += list("カレンダーからアプリに取り込む", r.samples["import"], r["import"]);',
  '  h += list("アプリからカレンダーに追加する", r.samples.create, r.create);',
  '  h += list("両方にある予定として紐づける", r.samples.link, r.link);',
  '  if (!r["import"] && !r.create && !r.link) h += "<div style=\\"margin-top:6px\\">新しく取り込む・追加する予定はありません。</div>";',
  '  if (done) h += "<div class=\\"note\\" style=\\"margin-top:8px\\">これからは 5 分おきに自動で同期します。アプリで保存したときもすぐ反映します。</div>";',
  '  var o = document.getElementById("out"); o.innerHTML = h; o.style.display = "block";',
  '}',
  'function preview(){',
  '  var id = sel(); document.getElementById("err").textContent = ""; document.getElementById("go").style.display = "none";',
  '  if (!id) { document.getElementById("err").textContent = "カレンダーを選んでください"; return; }',
  '  busy("カレンダーを読み込んでいます…");',
  '  google.script.run.withFailureHandler(fail).withSuccessHandler(function(r){ busy(""); show(r, false); document.getElementById("go").style.display = "inline-block"; })',
  '    .previewCalendarSync(id, document.getElementById("imp").checked);',
  '}',
  'function start(){',
  '  busy("同期しています…（件数が多いと 1 分ほどかかります）");',
  '  google.script.run.withFailureHandler(fail).withSuccessHandler(function(r){ busy(""); show(r, true); document.getElementById("go").style.display = "none"; document.getElementById("stopbox").style.display = "block"; })',
  '    .startCalendarSync(sel(), document.getElementById("imp").checked);',
  '}',
  'function stop(){',
  '  if (!confirm("カレンダー連携をやめますか？（予定は消えません）")) return;',
  '  busy("解除しています…");',
  '  google.script.run.withFailureHandler(fail).withSuccessHandler(function(){ busy(""); document.getElementById("out").innerHTML = "連携をやめました。"; document.getElementById("out").style.display = "block"; document.getElementById("stopbox").style.display = "none"; }).stopCalendarSync();',
  '}',
  '</script></body></html>'
].join('\n');
