// 汎用の小さな関数たち

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** html`...` で埋め込み値を自動でエスケープする。raw() で包んだもの・配列はそのまま。 */
export class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Raw(s);

function stringify(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(stringify).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += stringify(values[i]);
  });
  return new Raw(out);
}

// ---------- 日付 ----------

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const DAY = 24 * 3600 * 1000;

export function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dayDiff(d, now = new Date()) {
  return Math.round((startOfDay(d) - startOfDay(now)) / DAY);
}

export function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

export function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDateTime(d) {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

export function dayLabel(d, now = new Date()) {
  const diff = dayDiff(d, now);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return '明後日';
  if (diff === -1) return '昨日';
  const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}/` : '';
  return y + fmtDate(d);
}

/** 「あと3時間」「あと2日」「2日前」など。class 名も返す。 */
export function countdown(d, now = new Date()) {
  const ms = d - now;
  const min = Math.round(ms / 60000);
  if (ms < 0) {
    const past = -min;
    if (past < 60) return { text: `${past}分前`, cls: '' };
    if (past < 1440) return { text: `${Math.floor(past / 60)}時間前`, cls: '' };
    return { text: `${Math.floor(past / 1440)}日前`, cls: '' };
  }
  const cls = min < 180 ? 'urgent' : min < 1440 ? 'soon' : '';
  if (min < 60) return { text: `あと${min}分`, cls };
  if (min < 1440) return { text: `あと${Math.floor(min / 60)}時間`, cls };
  return { text: `あと${Math.floor(min / 1440)}日`, cls };
}

/** ISO → <input type="datetime-local"> 用の文字列 */
export function toLocalInput(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

export function relTime(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  if (min < 1440) return `${Math.floor(min / 60)}時間前`;
  return fmtDateTime(new Date(ts));
}

// ---------- その他 ----------

export function normalizeName(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return 'https://' + s;
  return '';
}

export function stars(n) {
  const v = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
  return v ? '★'.repeat(v) + '☆'.repeat(5 - v) : '';
}

export function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function utf8ToB64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToUtf8(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function deviceName() {
  const ua = navigator.userAgent;
  let os = 'PC';
  if (/iphone/i.test(ua)) os = 'iPhone';
  else if (/ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) os = 'iPad';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/mac os/i.test(ua)) os = 'Mac';
  else if (/windows/i.test(ua)) os = 'Windows';
  let br = '';
  if (/edg\//i.test(ua)) br = 'Edge';
  else if (/crios|chrome/i.test(ua)) br = 'Chrome';
  else if (/fxios|firefox/i.test(ua)) br = 'Firefox';
  else if (/safari/i.test(ua)) br = isStandalone() ? 'ホーム画面' : 'Safari';
  return br ? `${os}（${br}）` : os;
}
