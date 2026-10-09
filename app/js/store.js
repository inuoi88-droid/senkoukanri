// アプリの状態（サーバーから取ったデータ）と、そこから計算する一覧
import { normalizeName, toDate } from './util.js';

const CACHE_KEY = 'senkou:data';

export const RESULT_TYPES = ['面接', 'GD', 'ES締切', 'Webテスト締切'];
export const DEFAULT_OPTIONS = {
  statuses: ['気になる', 'エントリー済', 'ES提出済', 'Webテスト', 'GD', '一次面接', '二次面接', '三次面接', '最終面接', '内定', '内定承諾', 'お祈り', '辞退'],
  closedStatuses: ['お祈り', '辞退'],
  eventTypes: ['面接', 'GD', 'ES締切', 'Webテスト締切', '説明会', 'その他'],
  results: ['通過', '不通過', '辞退', '連絡なし'],
  gmail: true,
};

export const store = {
  data: null,
  lastSync: 0,
};

export function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.data) {
      store.data = c.data;
      store.lastSync = c.lastSync || 0;
    }
  } catch {
    // 壊れたキャッシュは無視
  }
}

export function setData(d) {
  store.data = {
    companies: d.companies || [],
    events: d.events || [],
    mails: d.mails || [],
    devices: d.devices || [],
    options: { ...DEFAULT_OPTIONS, ...(d.options || {}) },
    vapidPublicKey: d.vapidPublicKey || '',
    spreadsheetUrl: d.spreadsheetUrl || '',
  };
  store.lastSync = Date.now();
  saveCache();
}

export function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: store.data, lastSync: store.lastSync }));
  } catch {
    // 容量不足などは無視
  }
}

export function clearCache() {
  store.data = null;
  store.lastSync = 0;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // 無視
  }
}

export const options = () => (store.data && store.data.options) || DEFAULT_OPTIONS;
export const companies = () => (store.data && store.data.companies) || [];
export const events = () => (store.data && store.data.events) || [];
export const mails = () => (store.data && store.data.mails) || [];

export function isDeadline(type) {
  return /締切|締め切り|〆/.test(type || '');
}

export function isClosedStatus(status) {
  return options().closedStatuses.includes(status);
}

export function companyById(id) {
  return companies().find((c) => c.id === id) || null;
}

export function companyByName(name) {
  const n = normalizeName(name);
  return companies().find((c) => normalizeName(c.name) === n) || null;
}

export function eventById(id) {
  return events().find((e) => e.id === id) || null;
}

export function companyOfEvent(ev) {
  return (ev.companyId && companyById(ev.companyId)) || companyByName(ev.company);
}

function closedNames() {
  const s = new Set();
  companies().forEach((c) => {
    if (isClosedStatus(c.status)) s.add(normalizeName(c.name));
  });
  return s;
}

/** これから来る、対応が必要な予定（終了した企業・結果が出た予定・完了した締切を除く） */
export function upcomingEvents(now = new Date(), { days = Infinity } = {}) {
  const closed = closedNames();
  const limit = now.getTime() + days * 86400000;
  return events()
    .filter((e) => {
      const d = toDate(e.datetime);
      if (!d || d < now || d.getTime() > limit) return false;
      if (e.result || e.done) return false;
      return !closed.has(normalizeName(e.company));
    })
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

/** 結果待ちの予定（サーバーの結果確認リマインドと同じ条件、期間の上限なし） */
export function waitingEvents(now = new Date()) {
  const closed = closedNames();
  return events()
    .filter((e) => {
      const d = toDate(e.datetime);
      if (!d || d > now || e.result) return false;
      if (!RESULT_TYPES.includes(e.type)) return false;
      if (isDeadline(e.type) && !e.done) return false;
      return !closed.has(normalizeName(e.company));
    })
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
}

/** 締切を過ぎたのに「完了」になっていないもの */
export function missedDeadlines(now = new Date()) {
  const closed = closedNames();
  return events().filter((e) => {
    const d = toDate(e.datetime);
    return d && d < now && now - d < 3 * 86400000 && isDeadline(e.type) && !e.done && !e.result && !closed.has(normalizeName(e.company));
  });
}

export function unconfirmedMails() {
  return mails()
    .filter((m) => !m.confirmed)
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}

export function eventsOfCompany(c) {
  const n = normalizeName(c.name);
  return events()
    .filter((e) => e.companyId === c.id || normalizeName(e.company) === n)
    .sort((a, b) => String(a.datetime || '9').localeCompare(String(b.datetime || '9')));
}

export function mailsOfCompany(c) {
  const n = normalizeName(c.name);
  return mails()
    .filter((m) => normalizeName(m.company) === n)
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
}

export function nextEventOf(c, now = new Date()) {
  const n = normalizeName(c.name);
  return upcomingEvents(now).find((e) => e.companyId === c.id || normalizeName(e.company) === n) || null;
}
