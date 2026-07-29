/**
 * src/Logic.gs の単体テスト。
 * 実行方法: node tests/logic.test.js
 * (Node.js があれば追加のインストールは不要)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Logic.gs'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
const L = mod.exports;

let count = 0;
function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label + ' => ' + JSON.stringify(actual));
  count++;
}

// ---- timeToMin / minToTime ----
eq(L.timeToMin('8:30'), 510, "timeToMin('8:30')");
eq(L.timeToMin('08:30'), 510, "timeToMin('08:30')");
eq(L.timeToMin('17:00'), 1020, "timeToMin('17:00')");
eq(L.timeToMin('0:00'), 0, "timeToMin('0:00')");
eq(L.timeToMin('24:00'), null, "timeToMin('24:00')");
eq(L.timeToMin('8:61'), null, "timeToMin('8:61')");
eq(L.timeToMin('830'), null, "timeToMin('830')");
eq(L.timeToMin(''), null, "timeToMin('')");
eq(L.timeToMin(null), null, 'timeToMin(null)');
eq(L.minToTime(510), '8:30', 'minToTime(510)');
eq(L.minToTime(65), '1:05', 'minToTime(65)');
eq(L.minToTime(1020), '17:00', 'minToTime(1020)');

// ---- 付与時間(勤務時間 8:30〜17:00 = 510〜1020) ----
const WS = 510, WE = 1020;
// 仕様書の例: 8:20〜8:30 の入力 → 10分
eq(L.calcGrantMinutes(L.timeToMin('8:20'), L.timeToMin('8:30'), WS, WE), 10, '付与 8:20-8:30');
// 勤務時間にまたがる場合は勤務時間外の部分だけ
eq(L.calcGrantMinutes(L.timeToMin('8:00'), L.timeToMin('9:00'), WS, WE), 30, '付与 8:00-9:00');
eq(L.calcGrantMinutes(L.timeToMin('17:00'), L.timeToMin('18:00'), WS, WE), 60, '付与 17:00-18:00');
eq(L.calcGrantMinutes(L.timeToMin('16:50'), L.timeToMin('17:10'), WS, WE), 10, '付与 16:50-17:10');
// 朝と夕方の両方にはみ出す場合は両方を合算
eq(L.calcGrantMinutes(L.timeToMin('8:00'), L.timeToMin('17:30'), WS, WE), 60, '付与 8:00-17:30');
// すべて勤務時間内なら 0分(エラーにすべきケース)
eq(L.calcGrantMinutes(L.timeToMin('9:00'), L.timeToMin('10:00'), WS, WE), 0, '付与 9:00-10:00');

// ---- 利用時間 ----
// 仕様書の例: 16:30〜17:00 の入力 → 30分
eq(L.calcUsageMinutes(L.timeToMin('16:30'), L.timeToMin('17:00'), WS, WE), 30, '利用 16:30-17:00');
// 勤務時間外にはみ出した部分は数えない
eq(L.calcUsageMinutes(L.timeToMin('8:00'), L.timeToMin('9:00'), WS, WE), 30, '利用 8:00-9:00');
eq(L.calcUsageMinutes(L.timeToMin('17:00'), L.timeToMin('18:00'), WS, WE), 0, '利用 17:00-18:00');
eq(L.calcUsageMinutes(WS, WE, WS, WE), 510, '利用 8:30-17:00(全日)');

// ---- 入力チェック ----
eq(L.validateTimeRange(null, 600) !== null, true, 'validateTimeRange(null)');
eq(L.validateTimeRange(512, 600) !== null, true, 'validateTimeRange(5分単位でない)');
eq(L.validateTimeRange(600, 600) !== null, true, 'validateTimeRange(開始=終了)');
eq(L.validateTimeRange(610, 600) !== null, true, 'validateTimeRange(開始>終了)');
eq(L.validateTimeRange(510, 600), null, 'validateTimeRange(正常)');

// ---- 充当(繰越優先) ----
// 例: 繰越1時間 + 今年度30分 が残っていて 1時間30分使う
eq(L.allocateUsage(90, 60, 30), { carry: 60, current: 30, ok: true }, 'allocate 90 (60/30)');
// 繰越なしで今年度分を超える利用は不可
eq(L.allocateUsage(90, 0, 30), { carry: 0, current: 90, ok: false }, 'allocate 90 (0/30)');
// 繰越だけで足りる場合は今年度分を使わない
eq(L.allocateUsage(30, 60, 0), { carry: 30, current: 0, ok: true }, 'allocate 30 (60/0)');
eq(L.allocateUsage(90, 120, 0), { carry: 90, current: 0, ok: true }, 'allocate 90 (120/0)');
// 繰越がマイナス表現でも 0 として扱う
eq(L.allocateUsage(30, -10, 40), { carry: 0, current: 30, ok: true }, 'allocate 30 (-10/40)');
// ちょうど使い切る
eq(L.allocateUsage(90, 60, 30).ok, true, 'allocate ちょうど');
eq(L.allocateUsage(95, 60, 30).ok, false, 'allocate 5分超過');

// ---- 重複チェック(通信エラーで申請を押し直したときの二重登録防止) ----
const G = function (targetId, date, start, end, reason, status) {
  return { targetId: targetId, date: date, start: start, end: end, reason: reason, status: status };
};
const existingGrants = [
  G('T001', '2026-07-29', '17:00', '17:30', '職員会議', '承認待ち'),
  G('T002', '2026-07-29', '17:00', '17:30', '職員会議', '承認済み'),
  G('T003', '2026-07-29', '17:00', '17:30', '職員会議', '却下'),
  G('T004', '2026-07-29', '17:00', '17:30', '職員会議', '取消'),
  G('T005', '2026-07-29', '17:00', '17:30', '職員会議', '取下げ'),
];
const cand = function (targetId, over) {
  return Object.assign({ targetId: targetId, date: '2026-07-29', start: '17:00', end: '17:30', reason: '職員会議' }, over || {});
};
// 承認待ち・承認済みは二重登録を防ぐ
eq(L.isDuplicateGrant(cand('T001'), existingGrants), true, '重複(承認待ち)');
eq(L.isDuplicateGrant(cand('T002'), existingGrants), true, '重複(承認済み)');
// 却下・取消・取下げは出し直せる
eq(L.isDuplicateGrant(cand('T003'), existingGrants), false, '却下済みは再申請できる');
eq(L.isDuplicateGrant(cand('T004'), existingGrants), false, '取消済みは再申請できる');
eq(L.isDuplicateGrant(cand('T005'), existingGrants), false, '取下げ済みは再申請できる');
// 対象者・日付・時刻・事由のどれかが違えば別の申請
eq(L.isDuplicateGrant(cand('T009'), existingGrants), false, '別の教職員は重複でない');
eq(L.isDuplicateGrant(cand('T001', { date: '2026-07-30' }), existingGrants), false, '別の日は重複でない');
eq(L.isDuplicateGrant(cand('T001', { start: '17:05' }), existingGrants), false, '別の開始時刻は重複でない');
eq(L.isDuplicateGrant(cand('T001', { end: '18:00' }), existingGrants), false, '別の終了時刻は重複でない');
eq(L.isDuplicateGrant(cand('T001', { reason: '学年会' }), existingGrants), false, '別の事由は重複でない');
eq(L.isDuplicateGrant(cand('T001'), []), false, '記録が無ければ重複でない');

const existingUsages = [
  { memberId: 'T001', date: '2026-07-29', start: '16:30', end: '17:00', status: '承認待ち' },
  { memberId: 'T002', date: '2026-07-29', start: '16:30', end: '17:00', status: '却下' },
];
eq(L.isDuplicateUsage({ memberId: 'T001', date: '2026-07-29', start: '16:30', end: '17:00' }, existingUsages), true, '利用の重複');
eq(L.isDuplicateUsage({ memberId: 'T002', date: '2026-07-29', start: '16:30', end: '17:00' }, existingUsages), false, '却下済みの利用は再申請できる');
eq(L.isDuplicateUsage({ memberId: 'T001', date: '2026-07-29', start: '16:00', end: '16:30' }, existingUsages), false, '別の時間帯は重複でない');

eq(L.isLiveStatus('承認待ち'), true, 'isLiveStatus(承認待ち)');
eq(L.isLiveStatus('承認済み'), true, 'isLiveStatus(承認済み)');
eq(L.isLiveStatus('却下'), false, 'isLiveStatus(却下)');

// ---- 表記 ----
eq(L.fmtMinutes(90), '1時間30分', 'fmtMinutes(90)');
eq(L.fmtMinutes(60), '1時間', 'fmtMinutes(60)');
eq(L.fmtMinutes(5), '5分', 'fmtMinutes(5)');
eq(L.fmtMinutes(0), '0分', 'fmtMinutes(0)');
eq(L.fmtMinutes(-90), '-1時間30分', 'fmtMinutes(-90)');

console.log('OK: ' + count + ' 件のテストにすべて合格しました');
