// 接続設定（GAS の URL と合言葉）。Service Worker からも読めるよう IndexedDB にも保存する。
import { b64urlToUtf8, utf8ToB64url } from './util.js';

const KEY = 'senkou:config';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('senkoukanri', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      if (value === undefined) tx.objectStore('kv').delete(key);
      else tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // IndexedDB が使えない環境でもアプリ自体は動かす
  }
}

async function idbGet(key) {
  try {
    const db = await idb();
    const v = await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return v;
  } catch {
    return undefined;
  }
}

export function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    return c && c.url && c.token ? c : null;
  } catch {
    return null;
  }
}

/** localStorage が消えていても IndexedDB に残っていれば復元する */
export async function restoreConfig() {
  const c = loadConfig();
  if (c) {
    idbSet('config', c);
    return c;
  }
  const fromDb = await idbGet('config');
  if (fromDb && fromDb.url && fromDb.token) {
    try {
      localStorage.setItem(KEY, JSON.stringify(fromDb));
    } catch {
      // 保存できなくても続行
    }
    return fromDb;
  }
  return null;
}

export async function saveConfig(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // プライベートブラウズ等
  }
  await idbSet('config', cfg);
}

export async function clearConfig() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 無視
  }
  await idbSet('config', undefined);
}

/**
 * 接続コード（または接続用リンク・JSON）から { url, token } を取り出す。
 * 不正なら Error を投げる。
 */
export function parseConnectCode(text) {
  let s = String(text || '').trim();
  const m = s.match(/#connect=([A-Za-z0-9_\-]+)/);
  if (m) s = m[1];
  let obj = null;
  try {
    obj = s.startsWith('{') ? JSON.parse(s) : JSON.parse(b64urlToUtf8(s.replace(/\s+/g, '')));
  } catch {
    throw new Error('接続コードを読み取れませんでした。コピー漏れがないか確認してください。');
  }
  const url = String(obj.u || obj.url || '').trim();
  const token = String(obj.t || obj.token || '').trim();
  return validateConfig({ url, token });
}

export function validateConfig({ url, token }) {
  url = String(url || '').trim();
  token = String(token || '').trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) {
    throw new Error('ウェブアプリの URL は https://script.google.com/… で始まるものを入れてください。');
  }
  if (token.length < 16) throw new Error('合言葉が短すぎます。');
  return { url, token };
}

export function makeConnectCode(cfg) {
  return utf8ToB64url(JSON.stringify({ u: cfg.url, t: cfg.token }));
}
