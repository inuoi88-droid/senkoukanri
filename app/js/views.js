// 画面の HTML を組み立てる（状態の変更は main.js が行う）
import {
  html, raw, toDate, fmtDate, fmtTime, fmtDateTime, dayLabel, countdown, relTime,
  safeUrl, stars, toLocalInput, isIOS, isStandalone, normalizeName,
} from './util.js';
import * as S from './store.js';
import { pushSupport, permission, savedEndpoint } from './push.js';

const svg = (d, extra = '') =>
  raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`);

export const icons = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  building: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  external: svg('<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  sheet: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'),
};

// ---------- 共通部品 ----------

const TYPE_COLORS = { 面接: 'purple', GD: 'teal', ES締切: 'red', Webテスト締切: 'orange', 説明会: 'blue', その他: '' };

export function typeChip(type) {
  return html`<span class="chip ${TYPE_COLORS[type] ?? ''}">${type || 'その他'}</span>`;
}

export function statusChip(status) {
  if (!status) return html`<span class="chip">未設定</span>`;
  let c = 'indigo';
  if (S.isClosedStatus(status)) c = '';
  else if (/内定/.test(status)) c = 'green';
  else if (/最終/.test(status)) c = 'purple';
  else if (/面接|GD/.test(status)) c = 'purple';
  else if (/テスト/.test(status)) c = 'teal';
  else if (/気になる/.test(status)) c = '';
  return html`<span class="chip ${c}">${status}</span>`;
}

function resultChip(ev) {
  if (ev.result) {
    const c = ev.result === '通過' ? 'green' : ev.result === '不通過' ? 'red' : '';
    return html`<span class="chip ${c}">${ev.result}</span>`;
  }
  if (ev.done) return html`<span class="chip green">完了</span>`;
  return '';
}

function countdownEl(d, now) {
  const c = countdown(d, now);
  return html`<span class="countdown ${c.cls}">${c.text}</span>`;
}

function section(title, count, right = '') {
  return html`<div class="section"><h2>${title}${count != null ? html` <span class="count">(${count})</span>` : ''}</h2>${right}</div>`;
}

/** 予定 1 行。onlyTime=true なら日付は見出し側に出ている前提 */
function eventRow(ev, now, { showCompany = true, onlyTime = false, quick = false } = {}) {
  const d = toDate(ev.datetime);
  const deadline = S.isDeadline(ev.type);
  const future = d && d > now;
  return html`<div class="item" data-href="#/event/${ev.id}" role="link" tabindex="0">
    <div class="time">${d ? fmtTime(d) : '--:--'}${!onlyTime && d ? html`<small>${dayLabel(d, now)}</small>` : ''}${deadline && d ? html`<small>締切</small>` : ''}</div>
    <div class="main">
      <div class="title">${showCompany && ev.company ? ev.company + '　' : ''}${ev.title || ev.type}</div>
      <div class="sub">${typeChip(ev.type)} ${resultChip(ev)} ${!d && ev.datetimeText ? html`<span class="chip amber">日時を読めません: ${ev.datetimeText}</span>` : ''}${ev.place && !deadline ? ' ' + ev.place : ''}</div>
      ${quick && deadline && !ev.done && future
        ? html`<div class="actions"><button class="btn small soft" data-action="event-done" data-id="${ev.id}">${icons.check} 提出・受験した</button></div>`
        : ''}
    </div>
    <div class="side">${d && future && !ev.result ? countdownEl(d, now) : ''}</div>
  </div>`;
}

function groupByDay(list, now, opts) {
  let lastKey = '';
  return list.map((ev) => {
    const d = toDate(ev.datetime);
    const key = d ? d.toDateString() : 'none';
    let label = '日時未定';
    if (d) {
      label = dayLabel(d, now);
      if (['今日', '明日', '明後日', '昨日'].includes(label)) label += '　' + fmtDate(d);
    }
    const head = key !== lastKey ? html`<div class="daylabel">${label}</div>` : '';
    lastKey = key;
    return html`${head}${eventRow(ev, now, { ...opts, onlyTime: true })}`;
  });
}

function mailRow(m, { actions = true } = {}) {
  const d = toDate(m.receivedAt);
  return html`<div class="item">
    <div class="main">
      <div class="title">${m.company || '企業不明'}</div>
      <div class="sub">${m.subject}</div>
      <div class="tiny muted">${d ? dayLabel(d) + ' ' + fmtTime(d) : ''}　${m.from}</div>
      ${actions
        ? html`<div class="actions">
            ${m.link ? html`<a class="btn small ghost" href="${m.link}" target="_blank" rel="noopener">${icons.mail} Gmailで開く</a>` : ''}
            ${!m.confirmed ? html`<button class="btn small soft" data-action="mail-confirm" data-id="${m.id}">${icons.check} 確認済み</button>` : html`<span class="chip green">確認済み</span>`}
          </div>`
        : ''}
    </div>
  </div>`;
}

// ---------- 枠（ヘッダー・下のタブ） ----------

export function shell(ui, { title, back = '', body, fab = true }) {
  const tab = ui.route.name;
  const unconfirmed = S.unconfirmedMails().length;
  const navItem = (href, name, icon, label, dot = 0) =>
    html`<a href="${href}" class="${name.includes(tab) ? 'active' : ''}">${icon}<span>${label}</span>${dot ? html`<span class="dot">${dot}</span>` : ''}</a>`;
  const ago = S.store.lastSync ? relTime(S.store.lastSync) : '';
  const syncText = ui.syncing ? '同期中…' : ui.syncError ? '同期エラー' : ago === 'たった今' ? '同期済み' : ago ? ago + 'に同期' : '';
  return html`
    <header class="topbar">
      ${back ? html`<a class="iconbtn back" href="${back}" aria-label="戻る">${icons.back}</a>` : ''}
      <h1>${title}</h1>
      <span class="sync">${syncText}</span>
      <button class="iconbtn ${ui.syncing ? 'spin' : ''}" data-action="refresh" aria-label="再読み込み">${icons.refresh}</button>
    </header>
    <main>${body}</main>
    ${fab ? html`<button class="fab" data-action="add-menu" aria-label="追加">${icons.plus}</button>` : ''}
    <nav class="bottomnav">
      ${navItem('#/home', ['home', 'mails'], icons.home, 'ホーム', unconfirmed)}
      ${navItem('#/companies', ['companies', 'company'], icons.building, '企業')}
      ${navItem('#/events', ['events', 'event'], icons.calendar, '予定')}
      ${navItem('#/settings', ['settings'], icons.gear, '設定')}
    </nav>`;
}

function statusBanners(ui) {
  const out = [];
  if (ui.syncError) {
    out.push(html`<div class="banner danger"><div class="main"><b>同期できませんでした</b>${ui.syncError}</div></div>`);
  }
  const support = pushSupport();
  if (!support.ok && support.reason === 'ios-browser') {
    out.push(html`<div class="banner warn"><div class="main"><b>ホーム画面に追加してください</b>iPhone は、Safari の共有ボタン（□↑）→「ホーム画面に追加」→ ホーム画面のアイコンから開くと通知を受け取れます。</div></div>`);
  } else if (support.ok && !ui.pushOn) {
    out.push(html`<div class="banner danger"><div class="main"><b>この端末の通知がオフです</b>面接や締切の前、企業からメールが来たときに通知するにはオンにしてください。
      <div><button class="btn small" data-action="push-enable">${icons.bell} 通知をオンにする</button></div></div></div>`);
  }
  return out;
}

// ---------- ホーム ----------

export function homeView(ui) {
  const now = new Date();
  const data = S.store.data;
  const body = [];
  body.push(...statusBanners(ui));

  if (!data) {
    body.push(html`<div class="empty">データを読み込んでいます…</div>`);
    return shell(ui, { title: '選考管理', body });
  }

  const mails = S.unconfirmedMails();
  if (mails.length) {
    body.push(section('📩 未確認の企業メール', mails.length, html`<button class="btn small ghost" data-action="mail-confirm-all">すべて確認済み</button>`));
    body.push(html`<div class="card alert-danger">${mails.slice(0, 5).map((m) => mailRow(m))}${mails.length > 5 ? html`<a class="item" href="#/mails"><div class="main strong">ほか ${mails.length - 5} 件を見る</div></a>` : ''}</div>`);
  }

  const missed = S.missedDeadlines(now);
  if (missed.length) {
    body.push(section('⚠️ 締切を過ぎた未完了の予定', missed.length));
    body.push(html`<div class="card alert-warn">${missed.map((ev) => html`<div class="item">
      <div class="main"><div class="title">${ev.company}　${ev.title || ev.type}</div>
      <div class="sub">${fmtDateTime(toDate(ev.datetime))} 締切　提出済みなら「完了」にしてください</div>
      <div class="actions"><button class="btn small soft" data-action="event-done" data-id="${ev.id}">${icons.check} 提出していた</button>
      <a class="btn small ghost" href="#/event/${ev.id}">詳細</a></div></div></div>`)}</div>`);
  }

  const waiting = S.waitingEvents(now);
  if (waiting.length) {
    body.push(section('📮 結果待ち', waiting.length));
    body.push(html`<div class="card">${waiting.map((ev) => {
      const d = toDate(ev.datetime);
      return html`<div class="item">
        <div class="main" data-href="#/event/${ev.id}" role="link" tabindex="0">
          <div class="title">${ev.company}　${ev.title || ev.type}</div>
          <div class="sub">${typeChip(ev.type)} ${fmtDate(d)}（${countdown(d, now).text}）${ev.resultDue ? '　結果目安 ' + ev.resultDue.slice(5).replace('-', '/') : ''}</div>
          <div class="actions">
            <button class="btn small ok" data-action="event-result" data-id="${ev.id}" data-value="通過">通過</button>
            <button class="btn small ng" data-action="event-result" data-id="${ev.id}" data-value="不通過">不通過</button>
            <button class="btn small ghost" data-action="event-result-menu" data-id="${ev.id}">その他</button>
          </div>
        </div>
      </div>`;
    })}</div>`);
    body.push(html`<div class="tiny muted" style="margin-top:6px">結果メールが届いたら記録しましょう。記録するまで毎晩リマインドします。</div>`);
  }

  const upcoming = S.upcomingEvents(now, { days: 14 });
  body.push(section('🗓 これからの予定（2週間）', upcoming.length, html`<a class="btn small ghost" href="#/events">すべて</a>`));
  if (upcoming.length) {
    body.push(html`<div class="card">${groupByDay(upcoming, now, { quick: true })}</div>`);
  } else if (!S.companies().length) {
    body.push(html`<div class="card"><div class="empty">まずは選考中の企業を登録しましょう。<br>
      <button class="btn" data-action="company-new">${icons.plus} 企業を追加</button></div></div>`);
  } else {
    body.push(html`<div class="card"><div class="empty">2週間以内の予定はありません。<br>
      <button class="btn soft" data-action="event-new">${icons.plus} 予定を追加</button></div></div>`);
  }

  return shell(ui, { title: '選考管理', body });
}

// ---------- 企業一覧 ----------

const COMPANY_FILTERS = [
  ['active', '選考中'],
  ['offer', '内定'],
  ['closed', '終了'],
  ['all', 'すべて'],
];

export function companiesView(ui) {
  const now = new Date();
  const q = normalizeName(ui.companyQuery || '');
  const filter = ui.companyFilter || 'active';
  const list = S.companies()
    .filter((c) => {
      if (q && !normalizeName(`${c.name} ${c.industry} ${c.status} ${c.memo}`).includes(q)) return false;
      const closed = S.isClosedStatus(c.status);
      const offer = /内定/.test(c.status);
      if (filter === 'active') return !closed && !offer;
      if (filter === 'offer') return offer;
      if (filter === 'closed') return closed;
      return true;
    })
    .map((c) => ({ c, next: S.nextEventOf(c, now) }))
    .sort((a, b) => {
      const ca = S.isClosedStatus(a.c.status) ? 1 : 0;
      const cb = S.isClosedStatus(b.c.status) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      if (a.next && b.next) return new Date(a.next.datetime) - new Date(b.next.datetime);
      if (a.next || b.next) return a.next ? -1 : 1;
      const pa = parseInt(a.c.priority, 10) || 0;
      const pb = parseInt(b.c.priority, 10) || 0;
      if (pa !== pb) return pb - pa;
      return a.c.name.localeCompare(b.c.name, 'ja');
    });

  const body = html`
    <input class="search" type="search" placeholder="企業名・業界・メモで検索" value="${ui.companyQuery || ''}" data-input="company-query" enterkeyhint="search">
    <div class="filters">${COMPANY_FILTERS.map(([k, label]) => html`<button class="${filter === k ? 'on' : ''}" data-action="company-filter" data-value="${k}">${label}</button>`)}</div>
    <div class="section"><h2>${list.length} 社</h2></div>
    ${list.length
      ? html`<div class="card">${list.map(({ c, next }) => {
          const url = safeUrl(c.mypageUrl);
          const nd = next ? toDate(next.datetime) : null;
          return html`<div class="item" data-href="#/company/${c.id}" role="link" tabindex="0">
            <div class="main">
              <div class="title">${c.name} ${statusChip(c.status)}</div>
              <div class="sub">${nd ? html`次：${dayLabel(nd, now)} ${fmtTime(nd)} ${next.title || next.type}　${countdownEl(nd, now)}` : '予定なし'}</div>
              ${c.priority || c.industry ? html`<div class="tiny muted"><span class="stars">${stars(c.priority)}</span> ${c.industry}</div>` : ''}
            </div>
            ${url ? html`<a class="btn small ghost" href="${url}" target="_blank" rel="noopener">マイページ</a>` : ''}
          </div>`;
        })}</div>`
      : html`<div class="card"><div class="empty">${S.companies().length ? '該当する企業はありません' : 'まだ企業が登録されていません'}<br>
          <button class="btn" data-action="company-new">${icons.plus} 企業を追加</button></div></div>`}
  `;
  return shell(ui, { title: '企業', body });
}

// ---------- 企業の詳細 ----------

export function companyView(ui, id) {
  const now = new Date();
  const c = S.companyById(id);
  if (!c) {
    return shell(ui, { title: '企業', back: '#/companies', body: html`<div class="empty">企業が見つかりません（スプレッドシートで削除された可能性があります）</div>` });
  }
  const url = safeUrl(c.mypageUrl);
  const evs = S.eventsOfCompany(c);
  const upcoming = evs.filter((e) => toDate(e.datetime) && toDate(e.datetime) >= now);
  const past = evs.filter((e) => !toDate(e.datetime) || toDate(e.datetime) < now).reverse();
  const mails = S.mailsOfCompany(c);
  const statuses = S.options().statuses.includes(c.status) || !c.status ? S.options().statuses : [c.status, ...S.options().statuses];

  const body = html`
    <div class="card hero">
      <h2>${c.name}</h2>
      <div class="row">${statusChip(c.status)} <span class="stars">${stars(c.priority)}</span> <span class="muted small">${c.industry}</span></div>
      <label class="field" style="margin:14px 0 10px"><span>ステータス</span>
        <select data-change="company-status" data-id="${c.id}">
          ${!c.status ? html`<option value="" selected>未設定</option>` : ''}
          ${statuses.map((s) => html`<option value="${s}" ${s === c.status ? 'selected' : ''}>${s}</option>`)}
        </select>
      </label>
      <div class="row">
        ${url ? html`<a class="btn" href="${url}" target="_blank" rel="noopener">${icons.external} マイページを開く</a>` : html`<button class="btn ghost" data-action="company-edit" data-id="${c.id}">マイページURLを登録</button>`}
        ${c.loginId ? html`<button class="btn ghost" data-action="copy" data-text="${c.loginId}">${icons.copy} ログインIDをコピー</button>` : ''}
      </div>
    </div>

    ${section('予定', evs.length, html`<button class="btn small soft" data-action="event-new" data-company="${c.name}">${icons.plus} 追加</button>`)}
    ${evs.length
      ? html`<div class="card">${upcoming.map((e) => eventRow(e, now, { showCompany: false, quick: true }))}${past.map((e) => eventRow(e, now, { showCompany: false }))}</div>`
      : html`<div class="card"><div class="empty">予定はまだありません</div></div>`}

    ${mails.length ? html`${section('メール', mails.length)}<div class="card">${mails.slice(0, 10).map((m) => mailRow(m))}</div>` : ''}

    ${section('情報')}
    <div class="card"><dl class="kv">
      <dt>マイページ</dt><dd>${url ? html`<a href="${url}" target="_blank" rel="noopener">${c.mypageUrl}</a>` : c.mypageUrl || '—'}</dd>
      <dt>ログインID</dt><dd>${c.loginId || '—'}</dd>
      <dt>業界</dt><dd>${c.industry || '—'}</dd>
      <dt>志望度</dt><dd>${c.priority ? html`<span class="stars">${stars(c.priority)}</span>` : '—'}</dd>
      <dt>メール検知</dt><dd>${c.mailKeywords || html`<span class="muted">（企業名「${c.name}」で検知）</span>`}</dd>
      <dt>メモ</dt><dd>${c.memo || '—'}</dd>
    </dl></div>

    <div class="row" style="margin-top:16px">
      <button class="btn ghost grow" data-action="company-edit" data-id="${c.id}">編集</button>
      <button class="btn danger-ghost" data-action="company-delete" data-id="${c.id}">削除</button>
    </div>
  `;
  return shell(ui, { title: c.name, back: '#/companies', body });
}

// ---------- 予定一覧 ----------

const EVENT_FILTERS = [
  ['upcoming', 'これから'],
  ['waiting', '結果待ち'],
  ['past', '過去'],
  ['all', 'すべて'],
];

export function eventsView(ui) {
  const now = new Date();
  const filter = ui.eventFilter || 'upcoming';
  let list;
  if (filter === 'upcoming') list = S.upcomingEvents(now);
  else if (filter === 'waiting') list = S.waitingEvents(now);
  else if (filter === 'past') list = S.events().filter((e) => toDate(e.datetime) && toDate(e.datetime) < now).sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  else list = S.events().slice().sort((a, b) => String(a.datetime || '9').localeCompare(String(b.datetime || '9')));
  const undated = S.events().filter((e) => !toDate(e.datetime));

  const body = html`
    <div class="filters">${EVENT_FILTERS.map(([k, label]) => html`<button class="${filter === k ? 'on' : ''}" data-action="event-filter" data-value="${k}">${label}</button>`)}</div>
    <div class="section"><h2>${list.length} 件</h2></div>
    ${list.length
      ? html`<div class="card">${groupByDay(list.filter((e) => toDate(e.datetime)), now, { quick: filter === 'upcoming' })}</div>`
      : html`<div class="card"><div class="empty">${filter === 'upcoming' ? 'これからの予定はありません' : '該当する予定はありません'}<br>
          <button class="btn soft" data-action="event-new">${icons.plus} 予定を追加</button></div></div>`}
    ${undated.length && filter !== 'past'
      ? html`${section('日時が未設定・読み取れない予定', undated.length)}<div class="card">${undated.map((e) => eventRow(e, now))}</div>
          <div class="tiny muted" style="margin-top:6px">日時が無い予定は通知されません。「2026/10/15 14:00」の形で入力してください。</div>`
      : ''}
  `;
  return shell(ui, { title: '予定', body });
}

// ---------- 予定の詳細 ----------

export function eventView(ui, id) {
  const now = new Date();
  const ev = S.eventById(id);
  if (!ev) {
    return shell(ui, { title: '予定', back: '#/events', body: html`<div class="empty">予定が見つかりません（スプレッドシートで削除された可能性があります）</div>` });
  }
  const d = toDate(ev.datetime);
  const c = S.companyOfEvent(ev);
  const deadline = S.isDeadline(ev.type);
  const placeUrl = safeUrl(ev.place);
  const results = ['', ...S.options().results];
  const mypage = c ? safeUrl(c.mypageUrl) : '';

  const body = html`
    <div class="card hero">
      <div class="row">${typeChip(ev.type)} ${resultChip(ev)}</div>
      <h2 style="margin-top:8px">${ev.title || ev.type}</h2>
      <div>${c ? html`<a href="#/company/${c.id}" class="strong">${ev.company}</a>` : html`<span class="strong">${ev.company}</span>`}</div>
      <div style="margin-top:10px;font-size:17px" class="strong">${d ? html`${fmtDateTime(d)}${deadline ? ' 締切' : ''}　${countdownEl(d, now)}` : html`<span class="muted">日時未設定${ev.datetimeText ? '（' + ev.datetimeText + '）' : ''}</span>`}</div>
      ${ev.place ? html`<div style="margin-top:6px">${placeUrl ? html`<a href="${placeUrl}" target="_blank" rel="noopener">${ev.place}</a>` : ev.place}</div>` : ''}
      ${mypage ? html`<div class="row" style="margin-top:12px"><a class="btn ghost" href="${mypage}" target="_blank" rel="noopener">${icons.external} マイページを開く</a></div>` : ''}
    </div>

    ${section(deadline ? '提出・受験' : '参加')}
    <div class="card pad">
      <label class="check"><input type="checkbox" data-change="event-done" data-id="${ev.id}" ${ev.done ? 'checked' : ''}>
        ${deadline ? '提出・受験した（以降の締切通知を止める）' : '完了した'}</label>
    </div>

    ${S.RESULT_TYPES.includes(ev.type) || ev.result
      ? html`${section('結果')}
        <div class="card pad"><div class="seg">${results.map((r) => html`<label><input type="radio" name="result" value="${r}" data-change="event-result" data-id="${ev.id}" ${r === (ev.result || '') ? 'checked' : ''}><span>${r || '結果待ち'}</span></label>`)}</div>
        <div class="tiny muted" style="margin-top:8px">結果を記録するまで、毎晩「結果メールを確認」とリマインドします。</div></div>`
      : ''}

    ${section('詳細')}
    <div class="card"><dl class="kv">
      <dt>種別</dt><dd>${ev.type}</dd>
      <dt>結果連絡の目安</dt><dd>${ev.resultDue ? ev.resultDue.replace(/-/g, '/') : '—'}</dd>
      <dt>メモ</dt><dd>${ev.memo || '—'}</dd>
    </dl></div>

    <div class="row" style="margin-top:16px">
      <button class="btn ghost grow" data-action="event-edit" data-id="${ev.id}">編集</button>
      <button class="btn danger-ghost" data-action="event-delete" data-id="${ev.id}">削除</button>
    </div>
  `;
  return shell(ui, { title: ev.company || '予定', back: c ? `#/company/${c.id}` : '#/events', body });
}

// ---------- メール ----------

export function mailsView(ui) {
  const pending = S.unconfirmedMails();
  const done = S.mails().filter((m) => m.confirmed).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))).slice(0, 30);
  const gmailOn = S.options().gmail;
  const body = html`
    ${!gmailOn ? html`<div class="banner info"><div class="main"><b>Gmail検知はオフです</b>スプレッドシートの「設定」シートで「Gmail検知」を ON にすると、登録企業からのメールを通知します。</div></div>` : ''}
    ${section('未確認', pending.length, pending.length ? html`<button class="btn small ghost" data-action="mail-confirm-all">すべて確認済み</button>` : '')}
    ${pending.length ? html`<div class="card alert-danger">${pending.map((m) => mailRow(m))}</div>` : html`<div class="card"><div class="empty">未確認のメールはありません 🎉</div></div>`}
    ${done.length ? html`${section('確認済み（最近）', done.length)}<div class="card">${done.map((m) => mailRow(m))}</div>` : ''}
    <div class="tiny muted" style="margin-top:10px">企業名、または企業の「メール検知キーワード」を含むメールを 5 分おきに探しています。</div>
  `;
  return shell(ui, { title: '企業からのメール', back: '#/home', body });
}

// ---------- 設定 ----------

export function settingsView(ui) {
  const data = S.store.data || {};
  const support = pushSupport();
  const perm = permission();
  const devices = data.devices || [];
  const myEp = savedEndpoint();
  let pushStatus;
  if (!support.ok) {
    pushStatus = support.reason === 'ios-browser'
      ? html`<div class="banner warn"><div class="main"><b>ホーム画面に追加すると通知を使えます</b>
          <ol style="margin:6px 0 0;padding-left:1.2em"><li>Safari の共有ボタン（□↑）をタップ</li><li>「ホーム画面に追加」をタップ</li><li>ホーム画面の「選考管理」アイコンから開く</li><li>この画面で「通知をオンにする」</li></ol>
          ${!isStandalone() ? html`<div style="margin-top:6px">追加したアプリで接続を求められたら、下の「接続コードをコピー」で写したコードを貼り付けてください。</div>` : ''}</div></div>`
      : html`<div class="banner danger"><div class="main"><b>このブラウザは通知に対応していません</b>Android は Chrome、iPhone は Safari（iOS 16.4 以降）で開いてください。</div></div>`;
  } else if (ui.pushOn) {
    pushStatus = html`<div class="banner ok"><div class="main"><b>この端末で通知を受け取ります</b>
      <div class="row"><button class="btn small" data-action="push-test">テスト通知を送る</button><button class="btn small ghost" data-action="push-disable">この端末の通知をオフ</button></div></div></div>`;
  } else {
    pushStatus = html`<div class="banner danger"><div class="main"><b>この端末の通知はオフです</b>${perm === 'denied' ? '通知がブロックされています。端末の設定 → 通知 から許可してください。' : ''}
      <div><button class="btn small" data-action="push-enable">${icons.bell} 通知をオンにする</button></div></div></div>`;
  }

  const body = html`
    ${section('通知')}
    ${pushStatus}
    <div class="card">
      ${devices.length
        ? devices.map((d) => html`<div class="item"><div class="main">
            <div class="title">${d.name || '端末'} ${d.endpoint === myEp ? html`<span class="chip indigo">この端末</span>` : ''}</div>
            <div class="sub">${d.lastSentAt ? '最終送信 ' + relTime(new Date(d.lastSentAt).getTime()) + '：' + (d.lastResult || '') : 'まだ送信していません'}</div>
          </div></div>`)
        : html`<div class="empty">通知を受け取る端末はまだありません</div>`}
    </div>
    <div class="tiny muted" style="margin-top:6px">通知のタイミング（◯日前・◯時間前）や朝のまとめの時刻は、スプレッドシートの「設定」シートで変えられます。</div>

    ${section('データ')}
    <div class="card">
      ${data.spreadsheetUrl ? html`<a class="item" href="${data.spreadsheetUrl}" target="_blank" rel="noopener"><div class="main"><div class="title">スプレッドシートを開く</div><div class="sub">直接編集しても OK。アプリには次の同期で反映されます。</div></div>${icons.external}</a>` : ''}
      <button class="item" data-action="refresh"><div class="main"><div class="title">今すぐ同期</div><div class="sub">${S.store.lastSync ? '最終同期：' + relTime(S.store.lastSync) : ''}</div></div></button>
    </div>

    ${section('接続')}
    <div class="card">
      <button class="item" data-action="copy-connect"><div class="main"><div class="title">接続コードをコピー</div><div class="sub">ホーム画面に追加したアプリや別の端末で接続するときに使います。人には教えないでください。</div></div>${icons.copy}</button>
      <button class="item" data-action="disconnect"><div class="main"><div class="title" style="color:var(--danger)">この端末の接続を解除</div><div class="sub">スプレッドシートのデータは消えません</div></div></button>
    </div>

    ${section('このアプリについて')}
    <div class="card pad small">
      <div>選考管理 v${ui.version}</div>
      <div class="muted">データはあなたの Google スプレッドシートにだけ保存されます。</div>
      <div style="margin-top:6px"><a href="https://github.com/inuoi88-droid/senkoukanri#readme" target="_blank" rel="noopener">使い方・セットアップ手順</a></div>
    </div>
  `;
  return shell(ui, { title: '設定', body, fab: false });
}

// ---------- 初回接続 ----------

export function setupView(ui) {
  return html`
    <div class="setup">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>選考管理</h1>
      <p class="lead">面接・締切・企業からのメールを<br>見逃さないための就活アプリ</p>
      ${ui.setupError ? html`<div class="banner danger"><div class="main">${ui.setupError}
        ${ui.setupCheckUrl
          ? html`<div style="margin-top:8px">原因を確かめるには、次のリンクを開いてください。<br>
              <a href="${ui.setupCheckUrl}" target="_blank" rel="noopener">ウェブアプリを直接開いて確認</a><br>
              <span class="tiny">・<code>{"ok":true,"app":"senkoukanri"}</code> と出る → 正常です。もう一度「接続する」を押してください<br>
              ・Google のログイン画面が出る → 「アクセスできるユーザー」が「全員」になっていません<br>
              ・「ファイルを開くことができません」→ URL が違うか、デプロイが古いままです</span></div>`
          : ''}</div></div>` : ''}
      <div class="card pad">
        <form data-form="connect">
          <label class="field"><span>接続コード</span>
            <textarea name="code" placeholder="スプレッドシートの「選考管理 > ② スマホと接続する」で表示されるコード" autocapitalize="off" autocomplete="off" spellcheck="false">${ui.setupCode || ''}</textarea>
          </label>
          <div class="row">
            <button class="btn grow" type="submit" ${ui.connecting ? 'disabled' : ''}>${ui.connecting ? '接続中…' : '接続する'}</button>
            ${navigator.clipboard && navigator.clipboard.readText ? html`<button class="btn ghost" type="button" data-action="paste-code">${icons.copy} 貼り付け</button>` : ''}
          </div>
        </form>
        <details>
          <summary>URL と合言葉で接続する</summary>
          <form data-form="connect-manual" style="margin-top:10px">
            <label class="field"><span>ウェブアプリの URL</span><input name="url" type="url" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off"></label>
            <label class="field"><span>合言葉（トークン）</span><input name="token" autocapitalize="off" autocomplete="off"></label>
            <button class="btn ghost block" type="submit">接続する</button>
          </form>
        </details>
      </div>
      <div class="card pad" style="margin-top:12px">
        <div class="strong">はじめての方へ</div>
        <ol>
          <li>Google スプレッドシートを作り、Apps Script にコードを貼り付けて「初期設定」を実行</li>
          <li>ウェブアプリとしてデプロイ</li>
          <li>スプレッドシートのメニュー「選考管理 > ② スマホと接続する」の QR コードをスマホで読み取る</li>
        </ol>
        <div style="margin-top:8px"><a href="https://github.com/inuoi88-droid/senkoukanri#readme" target="_blank" rel="noopener">くわしいセットアップ手順</a></div>
        ${isIOS() && !isStandalone() ? html`<div class="tiny muted" style="margin-top:8px">iPhone は接続後に「ホーム画面に追加」すると通知を受け取れます。</div>` : ''}
      </div>
    </div>`;
}

// ---------- フォーム（下から出るシート） ----------

export function addMenu() {
  return html`<h3>追加する</h3><div class="card menu" style="padding:0 10px">
    <button data-action="company-new">${icons.building} 企業を追加</button>
    <button data-action="event-new">${icons.calendar} 予定（面接・締切など）を追加</button>
  </div>`;
}

export function companyForm(c) {
  const o = S.options();
  const statuses = c && c.status && !o.statuses.includes(c.status) ? [c.status, ...o.statuses] : o.statuses;
  const cur = (c && c.status) || 'エントリー済';
  return html`<h3>${c ? '企業を編集' : '企業を追加'}</h3>
    <form data-form="company" data-id="${c ? c.id : ''}">
      <label class="field"><span>企業名<span class="req">*</span></span><input name="name" required value="${c ? c.name : ''}" placeholder="例：日本IBM" autocomplete="off"></label>
      <label class="field"><span>ステータス</span><select name="status">${statuses.map((s) => html`<option ${s === cur ? 'selected' : ''}>${s}</option>`)}</select></label>
      <div class="field"><span>志望度</span><div class="seg">
        ${['', '5', '4', '3', '2', '1'].map((v) => html`<label><input type="radio" name="priority" value="${v}" ${String((c && c.priority) || '') === v ? 'checked' : ''}><span>${v ? '★' + v : 'なし'}</span></label>`)}
      </div></div>
      <label class="field"><span>マイページURL</span><input name="mypageUrl" type="url" inputmode="url" value="${c ? c.mypageUrl : ''}" placeholder="https://…" autocapitalize="off"></label>
      <label class="field"><span>ログインID</span><input name="loginId" value="${c ? c.loginId : ''}" autocapitalize="off" autocomplete="off">
        <span class="help">パスワードはここに保存せず、パスワード管理アプリを使ってください。</span></label>
      <label class="field"><span>業界</span><input name="industry" value="${c ? c.industry : ''}" placeholder="例：IT・コンサル"></label>
      <label class="field"><span>メール検知キーワード</span><input name="mailKeywords" value="${c ? c.mailKeywords : ''}" placeholder="例：日本アイ・ビー・エム, ibm.com" autocapitalize="off">
        <span class="help">このキーワードを含むメールが Gmail に届いたら通知します（カンマ区切り）。空なら企業名で探します。採用メールの差出人ドメインを入れると確実です。</span></label>
      <label class="field"><span>メモ</span><textarea name="memo">${c ? c.memo : ''}</textarea></label>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-action="close-modal">キャンセル</button>
        <button type="submit" class="btn">保存</button>
      </div>
    </form>`;
}

const TITLE_HINTS = { 面接: '例：三次面接', GD: '例：グループディスカッション', ES締切: '例：本選考ES', Webテスト締切: '例：玉手箱', 説明会: '例：会社説明会', その他: '例：OB訪問' };

export function eventForm(ev, preset = {}) {
  const o = S.options();
  const companies = S.companies().slice().sort((a, b) => {
    const ca = S.isClosedStatus(a.status) ? 1 : 0;
    const cb = S.isClosedStatus(b.status) ? 1 : 0;
    return ca - cb || a.name.localeCompare(b.name, 'ja');
  });
  const curCompany = ev ? ev.company : preset.company || '';
  const curType = ev ? ev.type : preset.type || '面接';
  const types = o.eventTypes.includes(curType) ? o.eventTypes : [curType, ...o.eventTypes];
  return html`<h3>${ev ? '予定を編集' : '予定を追加'}</h3>
    <form data-form="event" data-id="${ev ? ev.id : ''}">
      <label class="field"><span>企業<span class="req">*</span></span>
        <select name="company" data-change="event-company-select">
          ${!curCompany ? html`<option value="" selected disabled>選んでください</option>` : ''}
          ${curCompany && !companies.some((c) => c.name === curCompany) ? html`<option selected>${curCompany}</option>` : ''}
          ${companies.map((c) => html`<option ${c.name === curCompany ? 'selected' : ''}>${c.name}</option>`)}
          <option value="__new__">＋ 新しい企業を追加…</option>
        </select>
      </label>
      <label class="field" data-new-company hidden><span>新しい企業名</span><input name="newCompany" placeholder="例：日本IBM"></label>
      <div class="field"><span>種別</span><div class="seg">
        ${types.map((t) => html`<label><input type="radio" name="type" value="${t}" data-change="event-type" ${t === curType ? 'checked' : ''}><span>${t}</span></label>`)}
      </div></div>
      <label class="field"><span>内容</span><input name="title" value="${ev ? ev.title : ''}" placeholder="${TITLE_HINTS[curType] || ''}" data-title-input></label>
      <label class="field"><span data-dt-label>${S.isDeadline(curType) ? '締切日時' : '日時'}<span class="req">*</span></span>
        <input name="datetime" type="datetime-local" required value="${ev ? toLocalInput(ev.datetime) : preset.datetime || ''}">
        <span class="help" data-dt-help>${S.isDeadline(curType) ? '締切が「23:59」なら時刻も 23:59 にしてください。' : ''}</span>
      </label>
      <label class="field"><span>場所・URL</span><input name="place" value="${ev ? ev.place : ''}" placeholder="例：Zoom の URL、本社 3F" autocapitalize="off"></label>
      <label class="field"><span>結果連絡の目安（任意）</span><input name="resultDue" type="date" value="${ev ? ev.resultDue : ''}">
        <span class="help">入れるとこの日から「結果メールを確認」のリマインドが始まります。空なら予定の日から。</span></label>
      <label class="field"><span>メモ</span><textarea name="memo">${ev ? ev.memo : ''}</textarea></label>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-action="close-modal">キャンセル</button>
        <button type="submit" class="btn">保存</button>
      </div>
    </form>`;
}

export function resultMenu(ev) {
  return html`<h3>${ev.company}　${ev.title || ev.type} の結果</h3>
    <div class="card menu" style="padding:0 10px">
      ${S.options().results.map((r) => html`<button data-action="event-result" data-id="${ev.id}" data-value="${r}">${r}</button>`)}
    </div>`;
}

export function confirmSheet(message, okLabel, danger) {
  return html`<h3>${message}</h3>
    <div class="sheet-actions">
      <button class="btn ghost" data-action="confirm-no">キャンセル</button>
      <button class="btn ${danger ? 'danger' : ''}" data-action="confirm-yes">${okLabel}</button>
    </div>`;
}

export function choiceSheet(title, text, choices) {
  return html`<h3>${title}</h3>${text ? html`<p class="muted" style="margin-top:-6px">${text}</p>` : ''}
    <div class="sheet-actions" style="flex-direction:column">
      ${choices.map((c, i) => html`<button class="btn ${c.style || ''}" data-action="choice" data-index="${i}">${c.label}</button>`)}
    </div>`;
}
