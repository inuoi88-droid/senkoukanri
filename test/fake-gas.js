// Apps Script のサービス（SpreadsheetApp など）を最低限まねる偽物（テスト専用）
const crypto = require('crypto');

// 未実装の書式系メソッドは何もせず自分自身を返す（メソッドチェーン用）
function chainable(target) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => proxy;
    },
  });
  return proxy;
}

class FakeRange {
  constructor(sheet, row, col, nr, nc) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${row},${col},${nr},${nc}`);
    if (row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
      throw new Error(`範囲がシートの外です: ${sheet.name} r${row}+${nr} c${col}+${nc} (max ${sheet.maxRows}x${sheet.maxCols})`);
    }
    Object.assign(this, { sheet, row, col, nr, nc });
    return chainable(this);
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() {
    return this.getValues()[0][0];
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((l) => l.length !== this.nc)) throw new Error('setValues のサイズ不一致');
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.set(this.row + r, this.col + c, v);
    return this;
  }
  setDataValidation(rule) {
    this.sheet.validations.push({ row: this.row, col: this.col, nr: this.nr, nc: this.nc, rule });
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.maxRows = 1000;
    this.maxCols = 26;
    this.validations = [];
    return chainable(this);
  }
  getName() { return this.name; }
  set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    this.data[r - 1][c - 1] = v;
  }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.data.forEach((line) => line.forEach((v, i) => { if (v !== '' && v !== undefined && v !== null) m = Math.max(m, i + 1); }));
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
      const col = m[1].charCodeAt(0) - 64;
      return new FakeRange(this, +m[2], col, m[4] ? +m[4] - +m[2] + 1 : this.maxRows - +m[2] + 1, 1);
    }
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  appendRow(arr) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r;
    arr.forEach((v, i) => this.set(r, i + 1, v));
    return this;
  }
  deleteRow(r) {
    this.data.splice(r - 1, 1);
    return this;
  }
  deleteRows(r, n) {
    this.data.splice(r - 1, n);
    return this;
  }
  // テスト用: 見出し行をキーにしたオブジェクト配列
  objects() {
    const [head, ...rows] = this.data;
    return rows.filter((l) => l && l.some((v) => v !== '' && v !== undefined && v !== false))
      .map((l) => Object.fromEntries(head.map((h, i) => [h, l[i] === undefined ? '' : l[i]])));
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [new FakeSheet('シート1')];
    this.tz = 'America/Los_Angeles';
    return chainable(this);
  }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) {
    const s = new FakeSheet(n);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake/edit'; }
}

// ---------- Google カレンダーの偽物（日本時間のカレンダーとして振る舞う） ----------
const JST = 9 * 3600 * 1000;
const dayOf = (d) => new Date(d.getTime() + JST).toISOString().slice(0, 10);
const jstMidnight = (day) => new Date(Date.parse(day + 'T00:00:00Z') - JST);

class FakeCalEvent {
  constructor(cal, data) {
    this.cal = cal;
    Object.assign(this, data);
    this.updated = cal.clock();
  }
  touch() { this.updated = this.cal.clock(); }
  getId() { return this.id; }
  getTitle() { return this.title; }
  setTitle(t) { this.title = t; this.touch(); return this; }
  isAllDayEvent() { return !!this.allDay; }
  getStartTime() { return this.allDay ? jstMidnight(this.startDay) : new Date(this.start); }
  getEndTime() { return this.allDay ? jstMidnight(this.endDay) : new Date(this.end); }
  getAllDayStartDate() { return jstMidnight(this.startDay); }
  getAllDayEndDate() { return jstMidnight(this.endDay); }
  getLocation() { return this.location || ''; }
  setLocation(l) { this.location = l; this.touch(); return this; }
  getDescription() { return this.description || ''; }
  setDescription(d) { this.description = d; this.touch(); return this; }
  setTime(s, e) { Object.assign(this, { allDay: false, start: s.getTime(), end: e.getTime() }); this.touch(); return this; }
  setAllDayDate(d) { Object.assign(this, { allDay: true, startDay: dayOf(d), endDay: dayOf(new Date(d.getTime() + 86400000)) }); this.touch(); return this; }
  setAllDayDates(s, e) { Object.assign(this, { allDay: true, startDay: dayOf(s), endDay: dayOf(e) }); this.touch(); return this; }
  getLastUpdated() { return new Date(this.updated); }
  isRecurringEvent() { return !!this.recurring; }
  deleteEvent() { this.cal.events = this.cal.events.filter((e) => e !== this); }
}

class FakeCalendar {
  constructor(id, name, clock) {
    Object.assign(this, { id, name, clock, events: [], seq: 0 });
  }
  getId() { return this.id; }
  getName() { return this.name; }
  add(data) {
    const ev = new FakeCalEvent(this, { id: `ev${++this.seq}@google.com`, location: '', description: '', ...data });
    this.events.push(ev);
    return ev;
  }
  getEvents(s, e) {
    return this.events.filter((ev) => ev.getStartTime() < e && ev.getEndTime() > s)
      .sort((a, b) => a.getStartTime() - b.getStartTime());
  }
  getEventById(id) { return this.events.find((e) => e.id === id) || null; }
  createEvent(title, s, e, opts = {}) {
    return this.add({ title, allDay: false, start: s.getTime(), end: e.getTime(), location: opts.location, description: opts.description });
  }
  createAllDayEvent(title, s, a, b) {
    const end = a instanceof Date || (a && a.getTime) ? a : null;
    const opts = (end ? b : a) || {};
    return this.add({ title, allDay: true, startDay: dayOf(s), endDay: dayOf(end || new Date(s.getTime() + 86400000)), location: opts.location, description: opts.description });
  }
}

function makeEnv({ now } = {}) {
  const ss = new FakeSpreadsheet();
  const props = {};
  const triggers = [];
  const fetches = [];
  const sentMails = [];
  const gmail = { threads: [], queries: [] };
  let fetchResponder = () => ({ code: 201, body: '' });

  const builder = () => chainable({ build() { return { built: true }; } });
  const clockRef = { now: () => Date.now() };
  const calendars = [new FakeCalendar('job@group.calendar.google.com', '長谷川＿就活カレンダー', () => clockRef.now())];

  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => { throw new Error('UI なし'); },
      newDataValidation: builder,
      newConditionalFormatRule: builder,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => chainable({ create() { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } }),
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'kotonimukae@gmail.com' }), getScriptTimeZone: () => 'Asia/Tokyo' },
    CalendarApp: {
      getCalendarById: (id) => calendars.find((c) => c.id === id) || null,
      getAllCalendars: () => calendars.slice(),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    UrlFetchApp: {
      fetch: (url, opt) => {
        fetches.push({ url, opt });
        const r = fetchResponder(url, opt);
        return { getResponseCode: () => r.code, getContentText: () => r.body || '', getHeaders: () => r.headers || {} };
      },
    },
    GmailApp: {
      search: (q) => { gmail.queries.push(q); return gmail.threads; },
      sendEmail: (to, subject, body) => sentMails.push({ to, subject, body }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, type) => ({ bytes, type }),
      formatDate: (d, tz, fmt) => {
        if (tz !== 'Asia/Tokyo' || fmt !== 'yyyy-MM-dd') throw new Error('未対応の formatDate');
        return dayOf(d);
      },
      parseDate: (str, tz, fmt) => {
        if (tz !== 'Asia/Tokyo' || fmt !== 'yyyy-MM-dd') throw new Error('未対応の parseDate');
        return jstMidnight(str);
      },
    },
    Logger: { log: () => {} },
    HtmlService: {},
  };
  return {
    env, ss, props, triggers, fetches, sentMails, gmail, calendars, clockRef,
    setFetchResponder: (fn) => { fetchResponder = fn; },
  };
}

// Gmail のスレッド・メッセージの偽物
function fakeThread(id, messages) {
  return {
    getId: () => id,
    getMessages: () => messages.map((m) => ({
      getId: () => m.id,
      getDate: () => new Date(m.date),
      getFrom: () => m.from,
      getSubject: () => m.subject,
      getPlainBody: () => m.body || '',
    })),
  };
}

module.exports = { makeEnv, fakeThread };
