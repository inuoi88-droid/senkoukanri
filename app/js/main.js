// 選考管理アプリ：起動・画面遷移・操作の処理
import { callApi } from './api.js';
import { loadConfig, restoreConfig, saveConfig, clearConfig, parseConnectCode, validateConfig, makeConnectCode } from './config.js';
import * as S from './store.js';
import { pushSupport, permission, getSubscription, ensureSubscription, requestAndSubscribe, unsubscribe } from './push.js';
import { copyText, deviceName, fromLocalInput, isIOS, isStandalone, html } from './util.js';
import * as V from './views.js';

const VERSION = '1.0.1';

const ui = {
  version: VERSION,
  route: parseRoute(),
  syncing: false,
  syncError: '',
  pushOn: false,
  companyFilter: 'active',
  companyQuery: '',
  eventFilter: 'upcoming',
  setupError: '',
  setupCode: '',
  setupCheckUrl: '',
  connecting: false,
};

let cfg = loadConfig();

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  const names = ['home', 'companies', 'company', 'events', 'event', 'mails', 'settings'];
  return { name: names.includes(name) ? name : 'home', id: id ? decodeURIComponent(id) : '' };
}

function render() {
  const app = document.getElementById('app');
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.input : '';
  const caret = focusKey ? active.selectionStart : 0;

  let view;
  if (!cfg) {
    view = V.setupView(ui);
  } else {
    const r = ui.route;
    if (r.name === 'companies') view = V.companiesView(ui);
    else if (r.name === 'company') view = V.companyView(ui, r.id);
    else if (r.name === 'events') view = V.eventsView(ui);
    else if (r.name === 'event') view = V.eventView(ui, r.id);
    else if (r.name === 'mails') view = V.mailsView(ui);
    else if (r.name === 'settings') view = V.settingsView(ui);
    else view = V.homeView(ui);
  }
  app.innerHTML = String(view);

  if (focusKey) {
    const el = app.querySelector(`[data-input="${focusKey}"]`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        // type=search などで使えない場合
      }
    }
  }
}

// ---------------------------------------------------------------------------
// モーダル・トースト
// ---------------------------------------------------------------------------

let modalResolve = null;

function openModal(content) {
  if (modalResolve) {
    const r = modalResolve;
    modalResolve = null;
    r(undefined);
  }
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="backdrop" data-backdrop><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${content}</div></div>`;
  document.body.style.overflow = 'hidden';
}

function closeModal(value) {
  document.getElementById('modal-root').innerHTML = '';
  document.body.style.overflow = '';
  if (modalResolve) {
    const r = modalResolve;
    modalResolve = null;
    r(value);
  }
}

function modalOpen() {
  return !!document.querySelector('#modal-root .backdrop');
}

function confirmDialog(message, okLabel, danger = false) {
  return new Promise((resolve) => {
    openModal(V.confirmSheet(message, okLabel, danger));
    modalResolve = (v) => resolve(v === true);
  });
}

function choose(title, text, choices) {
  return new Promise((resolve) => {
    openModal(V.choiceSheet(title, text, choices));
    modalResolve = (v) => resolve(typeof v === 'number' ? v : -1);
  });
}

function toast(message, error = false) {
  const root = document.getElementById('toast-root');
  while (root.children.length >= 2) root.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), error ? 5000 : 2500);
}

// ---------------------------------------------------------------------------
// サーバーとの同期
// ---------------------------------------------------------------------------

async function api(action, params) {
  try {
    return await callApi(cfg, action, params);
  } catch (e) {
    if (e.code === 'unauthorized') {
      await clearConfig();
      cfg = null;
      ui.setupError = e.message;
      closeModal();
      render();
    }
    throw e;
  }
}

async function refresh({ silent = false } = {}) {
  if (!cfg || ui.syncing) return;
  ui.syncing = true;
  render();
  try {
    S.setData(await api('data'));
    ui.syncError = '';
    await checkPush();
  } catch (e) {
    ui.syncError = e.message;
    if (!silent) toast(e.message, true);
  } finally {
    ui.syncing = false;
    if (!modalOpen() || !document.querySelector('#modal-root form')) render();
    updateBadge();
  }
}

/** 書き込み系の操作。成功したらサーバーが返した最新データで画面を更新する。 */
async function mutate(action, params, successMessage) {
  const d = await api(action, params);
  S.setData(d);
  ui.syncError = '';
  render();
  updateBadge();
  if (successMessage) toast(successMessage);
  return d;
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = S.unconfirmedMails().length + S.missedDeadlines().length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

/** この端末の購読がサーバーに登録されているかを確認し、消えていれば登録し直す */
async function checkPush() {
  if (!pushSupport().ok || permission() !== 'granted' || !S.store.data) {
    ui.pushOn = false;
    return;
  }
  try {
    let sub = await getSubscription();
    const onServer = (s) => !!s && (S.store.data.devices || []).some((d) => d.endpoint === s.endpoint);
    if (!onServer(sub) && S.store.data.vapidPublicKey) {
      sub = await ensureSubscription(S.store.data.vapidPublicKey);
      const r = await api('subscribe', { subscription: sub.toJSON(), deviceName: deviceName() });
      S.store.data.devices = r.devices;
      S.saveCache();
    }
    ui.pushOn = onServer(sub);
  } catch {
    ui.pushOn = false;
  }
}

async function enablePush() {
  try {
    // iOS では許可ダイアログをタップ直後に出す必要があるので、先に await を挟まない
    const sub = await requestAndSubscribe(S.store.data && S.store.data.vapidPublicKey);
    const r = await api('subscribe', { subscription: sub.toJSON(), deviceName: deviceName() });
    S.store.data.devices = r.devices;
    S.saveCache();
    ui.pushOn = true;
    render();
    toast('通知をオンにしました。テスト通知を送ります…');
    await testPush(sub.endpoint);
  } catch (e) {
    toast(e.message, true);
    await checkPush();
    render();
  }
}

async function testPush(endpoint) {
  try {
    const ep = endpoint || (await getSubscription())?.endpoint;
    const r = await api('testPush', { endpoint: ep || '' });
    S.store.data.devices = r.devices;
    S.saveCache();
    render();
    const res = (r.results || [])[0];
    if (!res) toast('この端末はサーバーに登録されていません。「通知をオンにする」をやり直してください。', true);
    else if (res.ok) toast('テスト通知を送りました。数秒で届きます');
    else toast(`送信に失敗しました（${res.status} ${res.detail || ''}）`, true);
  } catch (e) {
    toast(e.message, true);
  }
}

async function disablePush() {
  try {
    const ep = await unsubscribe();
    if (ep) {
      const r = await api('unsubscribe', { endpoint: ep });
      S.store.data.devices = r.devices;
      S.saveCache();
    }
    ui.pushOn = false;
    render();
    toast('この端末の通知をオフにしました');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// 接続
// ---------------------------------------------------------------------------

async function connect(newCfg) {
  ui.connecting = true;
  ui.setupError = '';
  ui.setupCheckUrl = '';
  render();
  try {
    const d = await callApi(newCfg, 'data');
    cfg = newCfg;
    await saveConfig(cfg);
    S.setData(d);
    ui.connecting = false;
    ui.syncError = '';
    ui.setupCode = '';
    history.replaceState(null, '', location.pathname + location.search + '#/home');
    ui.route = parseRoute();
    await checkPush();
    render();
    toast('スプレッドシートに接続しました');
    if (isIOS() && !isStandalone()) {
      const i = await choose(
        'ホーム画面に追加しましょう',
        'iPhone は、Safari の共有ボタン（□↑）→「ホーム画面に追加」をして、ホーム画面のアイコンから開くと通知を受け取れます。追加したアプリで接続コードを聞かれたら貼り付けてください。',
        [{ label: '接続コードをコピー' }, { label: '閉じる', style: 'ghost' }]
      );
      if (i === 0 && (await copyText(makeConnectCode(cfg)))) toast('接続コードをコピーしました');
    }
  } catch (e) {
    ui.connecting = false;
    ui.setupError = e.message;
    // 通信そのものに失敗したときは、ブラウザで直接開いて原因を確かめられるようにする
    if (e.code === 'network' || e.code === 'bad_response') ui.setupCheckUrl = newCfg.url + '?action=ping';
    render();
  }
}

async function disconnect() {
  const ok = await confirmDialog('この端末の接続を解除しますか？（スプレッドシートのデータは消えません）', '解除する', true);
  if (!ok) return;
  try {
    const ep = await unsubscribe();
    if (ep) await api('unsubscribe', { endpoint: ep });
  } catch {
    // 通知の解除に失敗しても接続解除は続ける
  }
  await clearConfig();
  S.clearCache();
  cfg = null;
  ui.pushOn = false;
  render();
}

/** #connect=… のリンクで開かれたとき */
async function handleConnectLink() {
  const m = location.hash.match(/^#connect=([A-Za-z0-9_\-]+)/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search + '#/home');
  ui.route = parseRoute();
  let next;
  try {
    next = parseConnectCode(m[1]);
  } catch (e) {
    ui.setupError = e.message;
    return false;
  }
  if (cfg && cfg.url === next.url && cfg.token === next.token) return false;
  if (cfg) {
    render();
    const ok = await confirmDialog('別のスプレッドシートに接続し直しますか？', '接続し直す');
    if (!ok) return false;
  }
  await connect(next);
  return true;
}

// ---------------------------------------------------------------------------
// 予定・企業の操作
// ---------------------------------------------------------------------------

/** 楽観的に画面を更新してから保存する（失敗したら戻す） */
async function quickUpdateEvent(id, patch, message) {
  const ev = S.eventById(id);
  if (!ev) return false;
  const backup = { ...ev };
  Object.assign(ev, patch);
  render();
  try {
    await mutate('saveEvent', { event: { id, ...patch } }, message);
    return true;
  } catch (e) {
    Object.assign(ev, backup);
    render();
    toast(e.message, true);
    return false;
  }
}

async function quickUpdateCompany(id, patch, message) {
  const c = S.companyById(id);
  if (!c) return false;
  const backup = { ...c };
  Object.assign(c, patch);
  render();
  try {
    await mutate('saveCompany', { company: { id, ...patch } }, message);
    return true;
  } catch (e) {
    Object.assign(c, backup);
    render();
    toast(e.message, true);
    return false;
  }
}

async function setResult(id, value) {
  if (modalOpen()) closeModal();
  const ev = S.eventById(id);
  if (!ev || (ev.result || '') === value) return;
  const ok = await quickUpdateEvent(id, { result: value }, value ? `結果を「${value}」にしました` : '結果待ちに戻しました');
  if (!ok) return;
  const c = S.companyOfEvent(ev);
  if (!c) return;
  const closedStatus = S.options().closedStatuses[0] || 'お祈り';
  if (value === '不通過' && !S.isClosedStatus(c.status)) {
    const i = await choose('企業のステータスを変えますか？', `${c.name} を「${closedStatus}」にすると、この企業の通知とメール検知が止まります。`, [
      { label: `「${closedStatus}」にする` },
      { label: 'そのまま', style: 'ghost' },
    ]);
    if (i === 0) await quickUpdateCompany(c.id, { status: closedStatus }, `「${closedStatus}」にしました`);
  } else if (value === '通過') {
    const i = await choose('通過おめでとうございます！🎉', '次の選考の日程が決まったら、予定に登録しておきましょう。', [
      { label: '次の予定を追加' },
      { label: 'あとで', style: 'ghost' },
    ]);
    if (i === 0) openModal(V.eventForm(null, { company: c.name, type: '面接' }));
  }
}

async function confirmMails(ids) {
  const list = ids === 'all' ? S.unconfirmedMails() : S.mails().filter((m) => ids.includes(m.id));
  list.forEach((m) => (m.confirmed = true));
  render();
  updateBadge();
  try {
    await mutate('confirmMails', { ids }, '確認済みにしました');
  } catch (e) {
    list.forEach((m) => (m.confirmed = false));
    render();
    toast(e.message, true);
  }
}

function formValues(form) {
  const fd = new FormData(form);
  const out = {};
  fd.forEach((v, k) => (out[k] = typeof v === 'string' ? v.trim() : v));
  return out;
}

async function withBusy(form, fn) {
  const btn = form.querySelector('[type=submit]');
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

const forms = {
  connect: async (form) => {
    const v = formValues(form);
    ui.setupCode = v.code;
    try {
      await connect(parseConnectCode(v.code));
    } catch (e) {
      ui.setupError = e.message;
      ui.setupCheckUrl = '';
      render();
    }
  },

  'connect-manual': async (form) => {
    const v = formValues(form);
    try {
      await connect(validateConfig({ url: v.url, token: v.token }));
    } catch (e) {
      ui.setupError = e.message;
      render();
    }
  },

  company: (form) =>
    withBusy(form, async () => {
      const v = formValues(form);
      const id = form.dataset.id;
      const company = { name: v.name, status: v.status, priority: v.priority || '', mypageUrl: v.mypageUrl, loginId: v.loginId, industry: v.industry, mailKeywords: v.mailKeywords, memo: v.memo };
      if (id) company.id = id;
      const d = await mutate('saveCompany', { company }, id ? '保存しました' : '企業を追加しました');
      closeModal();
      if (!id) location.hash = `#/company/${d.savedId}`;
    }),

  event: (form) =>
    withBusy(form, async () => {
      const v = formValues(form);
      const id = form.dataset.id;
      let company = v.company;
      if (company === '__new__') {
        company = v.newCompany;
        if (!company) throw new Error('新しい企業名を入力してください');
        if (!S.companyByName(company)) await mutate('saveCompany', { company: { name: company, status: 'エントリー済' } });
      }
      if (!company) throw new Error('企業を選んでください');
      const datetime = fromLocalInput(v.datetime);
      if (!datetime) throw new Error('日時を入力してください');
      const event = { company, type: v.type || 'その他', title: v.title, datetime, place: v.place, resultDue: v.resultDue || '', memo: v.memo };
      if (id) event.id = id;
      await mutate('saveEvent', { event }, id ? '保存しました' : '予定を追加しました。通知でお知らせします');
      closeModal();
    }),
};

const actions = {
  refresh: () => refresh(),
  'add-menu': () => openModal(V.addMenu()),
  'close-modal': () => closeModal(),
  'confirm-yes': () => closeModal(true),
  'confirm-no': () => closeModal(false),
  choice: (el) => closeModal(Number(el.dataset.index)),

  'company-new': () => openModal(V.companyForm(null)),
  'company-edit': (el) => openModal(V.companyForm(S.companyById(el.dataset.id))),
  'company-delete': async (el) => {
    const c = S.companyById(el.dataset.id);
    if (!c) return;
    const n = S.eventsOfCompany(c).length;
    const ok = await confirmDialog(`「${c.name}」を削除しますか？${n ? `（予定 ${n} 件も削除されます）` : ''}`, '削除する', true);
    if (!ok) return;
    try {
      await mutate('deleteCompany', { id: c.id }, '削除しました');
      location.hash = '#/companies';
    } catch (e) {
      toast(e.message, true);
    }
  },
  'company-filter': (el) => {
    ui.companyFilter = el.dataset.value;
    render();
  },

  'event-new': (el) => {
    let company = el.dataset.company || '';
    if (!company && ui.route.name === 'company') company = (S.companyById(ui.route.id) || {}).name || '';
    openModal(V.eventForm(null, { company }));
  },
  'event-edit': (el) => openModal(V.eventForm(S.eventById(el.dataset.id))),
  'event-delete': async (el) => {
    const ev = S.eventById(el.dataset.id);
    if (!ev) return;
    const ok = await confirmDialog(`「${ev.company} ${ev.title || ev.type}」を削除しますか？`, '削除する', true);
    if (!ok) return;
    try {
      const c = S.companyOfEvent(ev);
      await mutate('deleteEvent', { id: ev.id }, '削除しました');
      location.hash = c ? `#/company/${c.id}` : '#/events';
    } catch (e) {
      toast(e.message, true);
    }
  },
  'event-done': (el) => quickUpdateEvent(el.dataset.id, { done: true }, '完了にしました。締切の通知を止めます'),
  'event-result': (el) => setResult(el.dataset.id, el.dataset.value),
  'event-result-menu': (el) => {
    const ev = S.eventById(el.dataset.id);
    if (ev) openModal(V.resultMenu(ev));
  },
  'event-filter': (el) => {
    ui.eventFilter = el.dataset.value;
    render();
  },

  'mail-confirm': (el) => confirmMails([el.dataset.id]),
  'mail-confirm-all': () => confirmMails('all'),

  copy: async (el) => {
    if (await copyText(el.dataset.text)) toast('コピーしました');
  },
  'push-enable': () => enablePush(),
  'push-disable': () => disablePush(),
  'push-test': () => testPush(),
  'copy-connect': async () => {
    if (await copyText(makeConnectCode(cfg))) toast('接続コードをコピーしました（人に教えないでください）');
  },
  disconnect: () => disconnect(),
  'paste-code': async () => {
    try {
      ui.setupCode = await navigator.clipboard.readText();
      ui.setupError = '';
      render();
    } catch {
      toast('貼り付けできませんでした。入力欄を長押しして「ペースト」してください', true);
    }
  },
};

const changes = {
  'company-status': (el) => quickUpdateCompany(el.dataset.id, { status: el.value }, `ステータスを「${el.value}」にしました`),
  'event-done': (el) => quickUpdateEvent(el.dataset.id, { done: el.checked }, el.checked ? '完了にしました' : '未完了に戻しました'),
  'event-result': (el) => setResult(el.dataset.id, el.value),
  'event-company-select': (el) => {
    const box = el.form.querySelector('[data-new-company]');
    box.hidden = el.value !== '__new__';
    if (!box.hidden) box.querySelector('input').focus();
  },
  'event-type': (el) => {
    const form = el.form;
    const deadline = S.isDeadline(el.value);
    const hints = { 面接: '例：三次面接', GD: '例：グループディスカッション', ES締切: '例：本選考ES', Webテスト締切: '例：玉手箱', 説明会: '例：会社説明会' };
    form.querySelector('[data-title-input]').placeholder = hints[el.value] || '';
    form.querySelector('[data-dt-label]').innerHTML = (deadline ? '締切日時' : '日時') + '<span class="req">*</span>';
    form.querySelector('[data-dt-help]').textContent = deadline ? '締切が「23:59」なら時刻も 23:59 にしてください。' : '';
  },
};

// ---------------------------------------------------------------------------
// イベントの配線
// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const fn = actions[actionEl.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(actionEl, e);
    }
    return;
  }
  if (e.target.matches('[data-backdrop]')) {
    closeModal();
    return;
  }
  if (e.target.closest('a, button, input, select, textarea, label')) return;
  const hrefEl = e.target.closest('[data-href]');
  if (hrefEl) location.hash = hrefEl.dataset.href;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOpen()) closeModal();
  if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-href]')) location.hash = e.target.dataset.href;
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.input === 'company-query') {
    ui.companyQuery = el.value;
    render();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  forms[form.dataset.form](form);
});

window.addEventListener('hashchange', async () => {
  if (await handleConnectLink()) return;
  ui.route = parseRoute();
  if (modalOpen()) closeModal();
  window.scrollTo(0, 0);
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg && Date.now() - S.store.lastSync > 60 * 1000) refresh({ silent: true });
});

window.addEventListener('online', () => cfg && refresh({ silent: true }));

// 残り時間の表示を 1 分ごとに更新（入力中・モーダル表示中は除く）
setInterval(() => {
  if (!cfg || modalOpen() || document.visibilityState !== 'visible') return;
  const a = document.activeElement;
  if (a && a.matches && a.matches('input, textarea, select')) return;
  render();
}, 60 * 1000);

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (e) {
    console.warn('Service Worker の登録に失敗', e);
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'open' && msg.url) {
      if (location.hash !== msg.url) location.hash = msg.url;
      refresh({ silent: true });
    }
    if (msg.type === 'refresh') refresh({ silent: true });
  });
}

async function start() {
  registerServiceWorker();
  cfg = await restoreConfig();
  if (await handleConnectLink()) return;
  if (cfg) {
    S.loadCache();
    render();
    await refresh({ silent: !!S.store.data });
  } else {
    render();
  }
}

start();

// テスト・デバッグ用
window.__senkou = { ui, store: S.store, render, html };
