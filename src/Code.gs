/**
 * Code.gs ― エントリポイント・認証・データアクセスの共通処理
 *
 * シート名や列の並びを変更する場合は、このファイルの定数と
 * Setup.gs のヘッダー定義の両方を揃えて変更してください。
 */

const SHEET_NAMES = {
  SETTINGS: '設定',
  ROSTER: '名簿',
  GRANT: '付与記録',
  USAGE: '利用記録',
  LOG: '通知ログ',
};

const STATUS = {
  PENDING: '承認待ち',
  APPROVED: '承認済み',
  REJECTED: '却下',
  CANCELED: '取消',
  WITHDRAWN: '取下げ',
};

const ROLE_ADMIN = '管理職';
const ROLE_LEADER = '主任';
const ROLE_TEACHER = '教員';
const MEMBER_ACTIVE = '在籍';
const MEMBER_INACTIVE = '停止';

const SETTING_KEYS = {
  schoolName: '学校名',
  nendo: '年度',
  workStart: '勤務開始時刻',
  workEnd: '勤務終了時刻',
  expireDate: '繰越失効日',
  mailToAdmins: '管理職への依頼メール',
  mailToMembers: '本人への結果メール',
};

// 各シートの列位置(0始まり)。Setup.gs のヘッダー定義と対応している。
const ROSTER_COL = { id: 0, name: 1, role: 2, pin: 3, email: 4, status: 5, carry: 6, note: 7 };
const GRANT_COL = { id: 0, group: 1, status: 2, date: 3, start: 4, end: 5, minutes: 6, reason: 7, targetId: 8, targetName: 9, proposerId: 10, proposerName: 11, requestedAt: 12, decidedBy: 13, decidedAt: 14, decideMemo: 15, canceledBy: 16, canceledAt: 17 };
const USAGE_COL = { id: 0, status: 1, date: 2, start: 3, end: 4, minutes: 5, carryUsed: 6, currentUsed: 7, memberId: 8, memberName: 9, note: 10, requestedAt: 11, decidedBy: 12, decidedAt: 13, decideMemo: 14, canceledBy: 15, canceledAt: 16 };

const SESSION_SECONDS = 6 * 60 * 60; // ログインの有効時間(操作のたびに延長される)
const PIN_FAIL_LIMIT = 5;            // PIN を連続で間違えられる回数
const PIN_FAIL_LOCK_SECONDS = 300;   // 上限に達したときのロック時間(秒)

// ---------------------------------------------------------------- Webアプリ

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('割り振り変更簿')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** index.html から style.html / script.html を読み込むためのヘルパー */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------- 共通ユーティリティ

function tz_() {
  return Session.getScriptTimeZone() || 'Asia/Tokyo';
}

/** セルの値(Date または文字列)を "yyyy-MM-dd" に正規化する。解釈できなければ null */
function normDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim().replace(/[\/.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return Utilities.formatDate(date, tz_(), 'yyyy-MM-dd');
}

/** セルの値(Date または文字列)を "H:MM" に正規化する。解釈できなければ null */
function normTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'H:mm');
  const min = timeToMin(v);
  return min == null ? null : minToTime(min);
}

/** セルの値を "yyyy-MM-dd HH:mm" の文字列にする(日時欄の表示用) */
function normDateTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm');
  return String(v == null ? '' : v).trim();
}

function nowStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) {
    throw new Error('シート「' + name + '」が見つかりません。スプレッドシートのメニュー「割り振り変更簿」→「初期セットアップ」を実行してください。');
  }
  return sh;
}

/** 書き込みを伴う処理を排他制御の中で実行する(同時操作によるデータ崩れを防ぐ) */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('処理が混み合っています。少し待ってからもう一度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** データ行(2行目以降)を {rowIndex, values} の配列で返す。完全な空行は飛ばす */
function readRows_(sheetName) {
  const sh = sheet_(sheetName);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  const rows = [];
  values.forEach(function (v, i) {
    if (v.join('') === '') return;
    rows.push({ rowIndex: i + 2, values: v });
  });
  return rows;
}

/** 行末に複数行をまとめて追加する */
function appendRows_(sheetName, rows) {
  const sh = sheet_(sheetName);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** 指定行の複数セルを更新する。pairs は {列番号(0始まり): 値} */
function updateCells_(sheetName, rowIndex, pairs) {
  const sh = sheet_(sheetName);
  Object.keys(pairs).forEach(function (k) {
    sh.getRange(rowIndex, parseInt(k, 10) + 1).setValue(pairs[k]);
  });
}

/** データ行をすべて消す(ヘッダー行と書式は残す) */
function clearDataRows_(sheetName) {
  const sh = sheet_(sheetName);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
}

/**
 * 連番IDを発行する。例: nextIds_('利用記録', 0, 'U', 5, 2) → ['U00001', 'U00002']
 * 必ず withLock_ の中から呼ぶこと。
 */
function nextIds_(sheetName, colIndex, prefix, padLen, count) {
  const rows = readRows_(sheetName);
  const re = new RegExp('^' + prefix + '(\\d+)$');
  let max = 0;
  rows.forEach(function (r) {
    const m = String(r.values[colIndex]).trim().match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  const ids = [];
  for (let i = 1; i <= count; i++) {
    ids.push(prefix + String(max + i).padStart(padLen, '0'));
  }
  return ids;
}

// ---------------------------------------------------------------- 設定

function getSettings_() {
  const map = {};
  readRows_(SHEET_NAMES.SETTINGS).forEach(function (r) {
    map[String(r.values[0]).trim()] = r.values[1];
  });
  const s = {
    schoolName: String(map[SETTING_KEYS.schoolName] == null ? '' : map[SETTING_KEYS.schoolName]).trim(),
    nendo: parseInt(map[SETTING_KEYS.nendo], 10) || new Date().getFullYear(),
    workStart: normTimeStr_(map[SETTING_KEYS.workStart]) || '8:30',
    workEnd: normTimeStr_(map[SETTING_KEYS.workEnd]) || '17:00',
    expireDate: normDateStr_(map[SETTING_KEYS.expireDate]) || '',
    mailToAdmins: String(map[SETTING_KEYS.mailToAdmins] == null ? 'ON' : map[SETTING_KEYS.mailToAdmins]).trim().toUpperCase() !== 'OFF',
    mailToMembers: String(map[SETTING_KEYS.mailToMembers] == null ? 'ON' : map[SETTING_KEYS.mailToMembers]).trim().toUpperCase() !== 'OFF',
  };
  s.carryExpired = !!s.expireDate; // 繰越失効日が入っていれば前年度分は失効済み
  return s;
}

function saveSettingValue_(key, value) {
  const sh = sheet_(SHEET_NAMES.SETTINGS);
  const rows = readRows_(SHEET_NAMES.SETTINGS);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].values[0]).trim() === key) {
      sh.getRange(rows[i].rowIndex, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value, '']);
}

/** クライアントへ渡してよい設定情報 */
function publicSettings_(s) {
  return {
    schoolName: s.schoolName,
    nendo: s.nendo,
    workStart: s.workStart,
    workEnd: s.workEnd,
    carryExpired: s.carryExpired,
    expireDate: s.expireDate,
    mailToAdmins: s.mailToAdmins,
    mailToMembers: s.mailToMembers,
  };
}

// ---------------------------------------------------------------- 名簿

function memberFromRow_(r) {
  const v = r.values;
  return {
    rowIndex: r.rowIndex,
    id: String(v[ROSTER_COL.id]).trim(),
    name: String(v[ROSTER_COL.name]).trim(),
    role: String(v[ROSTER_COL.role]).trim(),
    pin: String(v[ROSTER_COL.pin]).trim(),
    email: String(v[ROSTER_COL.email]).trim(),
    status: String(v[ROSTER_COL.status]).trim(),
    carryMin: Number(v[ROSTER_COL.carry]) || 0,
    note: String(v[ROSTER_COL.note]).trim(),
  };
}

function getRoster_() {
  return readRows_(SHEET_NAMES.ROSTER)
    .map(memberFromRow_)
    .filter(function (m) { return m.id !== ''; });
}

function findMember_(id) {
  const list = getRoster_().filter(function (m) { return m.id === id; });
  return list.length ? list[0] : null;
}

/** クライアントへ渡してよい本人情報(PIN等は含めない) */
function publicUser_(m) {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    email: m.email,
    canGrant: m.role !== ROLE_TEACHER, // 管理職・主任は付与の起案ができる
    isAdmin: m.role === ROLE_ADMIN,
  };
}

// ---------------------------------------------------------------- 認証

/** ログイン画面用: 在籍メンバーの名前一覧(認証不要・名前とID以外は返さない) */
function apiGetLoginList() {
  const settings = getSettings_();
  const members = getRoster_()
    .filter(function (m) { return m.status === MEMBER_ACTIVE; })
    .map(function (m) { return { id: m.id, name: m.name }; });
  return { schoolName: settings.schoolName, nendo: settings.nendo, members: members };
}

function apiLogin(memberId, pin) {
  const member = findMember_(String(memberId == null ? '' : memberId).trim());
  if (!member || member.status !== MEMBER_ACTIVE) {
    throw new Error('名簿に見つかりません。管理者にご確認ください。');
  }
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + member.id;
  const fails = parseInt(cache.get(failKey), 10) || 0;
  if (fails >= PIN_FAIL_LIMIT) {
    throw new Error('PINの誤入力が続いたため、しばらくログインできません。5分ほど待ってからやり直してください。');
  }
  if (!member.pin) {
    throw new Error('PINが設定されていません。管理者にPINの設定を依頼してください。');
  }
  if (String(pin == null ? '' : pin).trim() !== member.pin) {
    cache.put(failKey, String(fails + 1), PIN_FAIL_LOCK_SECONDS);
    throw new Error('PINが正しくありません。');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid();
  cache.put('tok_' + token, member.id, SESSION_SECONDS);
  return { token: token, user: publicUser_(member), settings: publicSettings_(getSettings_()) };
}

function apiLogout(token) {
  CacheService.getScriptCache().remove('tok_' + String(token == null ? '' : token));
  return true;
}

/**
 * token から本人を特定する。無効なら "AUTH:" で始まるエラーを投げる
 * (クライアントはこの接頭辞を見てログイン画面に戻す)。
 */
function requireUser_(token) {
  const t = String(token == null ? '' : token);
  const cache = CacheService.getScriptCache();
  const id = t ? cache.get('tok_' + t) : null;
  if (!id) throw new Error('AUTH:ログインの有効期限が切れました。もう一度ログインしてください。');
  const member = findMember_(id);
  if (!member || member.status !== MEMBER_ACTIVE) {
    throw new Error('AUTH:アカウントが無効になっています。管理者にご確認ください。');
  }
  cache.put('tok_' + t, id, SESSION_SECONDS); // 操作のたびに有効期限を延長
  return member;
}

function requireGranter_(member) {
  if (member.role === ROLE_TEACHER) throw new Error('付与の入力は管理職・主任のみ行えます。');
}

function requireAdmin_(member) {
  if (member.role !== ROLE_ADMIN) throw new Error('この操作は管理職のみ行えます。');
}

function apiChangePin(token, oldPin, newPin) {
  const user = requireUser_(token);
  if (String(oldPin == null ? '' : oldPin).trim() !== user.pin) {
    throw new Error('現在のPINが正しくありません。');
  }
  const np = String(newPin == null ? '' : newPin).trim();
  if (!/^\d{4,8}$/.test(np)) throw new Error('新しいPINは4〜8桁の数字で入力してください。');
  withLock_(function () {
    updateCells_(SHEET_NAMES.ROSTER, user.rowIndex, (function () {
      const p = {}; p[ROSTER_COL.pin] = np; return p;
    })());
  });
  return true;
}

// ---------------------------------------------------------------- 記録の読み出し

function grantFromRow_(r) {
  const v = r.values;
  return {
    rowIndex: r.rowIndex,
    id: String(v[GRANT_COL.id]).trim(),
    groupId: String(v[GRANT_COL.group]).trim(),
    status: String(v[GRANT_COL.status]).trim(),
    date: normDateStr_(v[GRANT_COL.date]) || String(v[GRANT_COL.date]).trim(),
    start: normTimeStr_(v[GRANT_COL.start]) || String(v[GRANT_COL.start]).trim(),
    end: normTimeStr_(v[GRANT_COL.end]) || String(v[GRANT_COL.end]).trim(),
    minutes: Number(v[GRANT_COL.minutes]) || 0,
    reason: String(v[GRANT_COL.reason]).trim(),
    targetId: String(v[GRANT_COL.targetId]).trim(),
    targetName: String(v[GRANT_COL.targetName]).trim(),
    proposerId: String(v[GRANT_COL.proposerId]).trim(),
    proposerName: String(v[GRANT_COL.proposerName]).trim(),
    requestedAt: normDateTimeStr_(v[GRANT_COL.requestedAt]),
    decidedBy: String(v[GRANT_COL.decidedBy]).trim(),
    decidedAt: normDateTimeStr_(v[GRANT_COL.decidedAt]),
    decideMemo: String(v[GRANT_COL.decideMemo]).trim(),
    canceledBy: String(v[GRANT_COL.canceledBy]).trim(),
    canceledAt: normDateTimeStr_(v[GRANT_COL.canceledAt]),
  };
}

function usageFromRow_(r) {
  const v = r.values;
  return {
    rowIndex: r.rowIndex,
    id: String(v[USAGE_COL.id]).trim(),
    status: String(v[USAGE_COL.status]).trim(),
    date: normDateStr_(v[USAGE_COL.date]) || String(v[USAGE_COL.date]).trim(),
    start: normTimeStr_(v[USAGE_COL.start]) || String(v[USAGE_COL.start]).trim(),
    end: normTimeStr_(v[USAGE_COL.end]) || String(v[USAGE_COL.end]).trim(),
    minutes: Number(v[USAGE_COL.minutes]) || 0,
    carryUsed: Number(v[USAGE_COL.carryUsed]) || 0,
    currentUsed: Number(v[USAGE_COL.currentUsed]) || 0,
    memberId: String(v[USAGE_COL.memberId]).trim(),
    memberName: String(v[USAGE_COL.memberName]).trim(),
    note: String(v[USAGE_COL.note]).trim(),
    requestedAt: normDateTimeStr_(v[USAGE_COL.requestedAt]),
    decidedBy: String(v[USAGE_COL.decidedBy]).trim(),
    decidedAt: normDateTimeStr_(v[USAGE_COL.decidedAt]),
    decideMemo: String(v[USAGE_COL.decideMemo]).trim(),
    canceledBy: String(v[USAGE_COL.canceledBy]).trim(),
    canceledAt: normDateTimeStr_(v[USAGE_COL.canceledAt]),
  };
}

function getGrants_() {
  return readRows_(SHEET_NAMES.GRANT).map(grantFromRow_).filter(function (g) { return g.id !== ''; });
}

function getUsages_() {
  return readRows_(SHEET_NAMES.USAGE).map(usageFromRow_).filter(function (u) { return u.id !== ''; });
}

// ---------------------------------------------------------------- 残時間の計算

/**
 * 全員分の残時間を計算する。
 * - 繰越残 = 名簿の繰越時間 − 承認済み利用の繰越充当合計(失効後は常に0)
 * - 今年度残 = 承認済み付与の合計 − 承認済み利用の今年度充当合計
 * - 利用可能 = 繰越残 + 今年度残 − 承認待ち利用の合計
 */
function computeBalanceMap_(settings, roster, grants, usages) {
  const map = {};
  roster.forEach(function (m) {
    map[m.id] = {
      carryStart: m.carryMin,
      carryUsed: 0,
      grantApproved: 0,
      currentUsed: 0,
      pendingGrant: 0,
      pendingUsage: 0,
    };
  });
  grants.forEach(function (g) {
    const b = map[g.targetId];
    if (!b) return;
    if (g.status === STATUS.APPROVED) b.grantApproved += g.minutes;
    else if (g.status === STATUS.PENDING) b.pendingGrant += g.minutes;
  });
  usages.forEach(function (u) {
    const b = map[u.memberId];
    if (!b) return;
    if (u.status === STATUS.APPROVED) {
      b.carryUsed += u.carryUsed;
      b.currentUsed += u.currentUsed;
    } else if (u.status === STATUS.PENDING) {
      b.pendingUsage += u.minutes;
    }
  });
  Object.keys(map).forEach(function (id) {
    const b = map[id];
    b.carryRemain = settings.carryExpired ? 0 : Math.max(b.carryStart - b.carryUsed, 0);
    b.currentRemain = b.grantApproved - b.currentUsed;
    b.totalRemain = b.carryRemain + b.currentRemain;
    b.available = b.totalRemain - b.pendingUsage;
  });
  return map;
}
