/**
 * src/Code.gs の残時間計算(computeBalanceMap_)のテスト。
 * 実行方法: node tests/balance.test.js
 *
 * 前年度繰越分と今年度分を区別して管理する仕組みが、
 * 「繰越失効後に今年度残がマイナスになる」問題を起こさないことを確認する。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

// Code.gs は読み込み時には GAS のサービスを呼ばないため、そのまま vm で評価できる
const sandbox = { Math: Math, Object: Object, String: String, Number: Number, Array: Array, RegExp: RegExp, parseInt: parseInt, Date: Date };
vm.createContext(sandbox);
['Logic.gs', 'Code.gs'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
});

// const 宣言はサンドボックスのプロパティにならないため、コンテキスト内の式で取り出す
const exported = vm.runInContext('({ compute: computeBalanceMap_, STATUS: STATUS })', sandbox);
const compute = exported.compute;
const STATUS = exported.STATUS;

let count = 0;
function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label + ' => ' + JSON.stringify(actual));
  count++;
}

function member(id, carryMin) {
  return { id: id, name: id, role: '教員', status: '在籍', carryMin: carryMin || 0 };
}
function grant(targetId, minutes, status) {
  return { targetId: targetId, minutes: minutes, status: status };
}
function usage(memberId, minutes, status, carryUsed, currentUsed) {
  return { memberId: memberId, minutes: minutes, status: status, carryUsed: carryUsed || 0, currentUsed: currentUsed || 0 };
}

const ACTIVE = { carryExpired: false };
const EXPIRED = { carryExpired: true };

// ---- 基本: 付与・利用なし ----
{
  const b = compute(ACTIVE, [member('A', 60)], [], [])['A'];
  eq([b.carryRemain, b.currentRemain, b.totalRemain, b.available], [60, 0, 60, 60], '繰越のみ');
}

// ---- 承認済み付与だけが残時間に入る(承認待ち・却下・取消は入らない) ----
{
  const grants = [
    grant('A', 30, STATUS.APPROVED),
    grant('A', 40, STATUS.PENDING),
    grant('A', 50, STATUS.REJECTED),
    grant('A', 60, STATUS.CANCELED),
    grant('A', 70, STATUS.WITHDRAWN),
  ];
  const b = compute(ACTIVE, [member('A', 0)], grants, [])['A'];
  eq([b.grantApproved, b.pendingGrant, b.totalRemain], [30, 40, 30], '付与の状態別集計');
}

// ---- 利用は承認時の充当内訳どおりに引く ----
{
  const b = compute(ACTIVE, [member('A', 60)],
    [grant('A', 30, STATUS.APPROVED)],
    [usage('A', 90, STATUS.APPROVED, 60, 30)])['A'];
  eq([b.carryRemain, b.currentRemain, b.totalRemain], [0, 0, 0], '繰越60+今年度30を90分利用');
}

// ---- 要件にあった事故シナリオ:
// 前年度1時間が未利用、今年度30分が未利用。5月に1時間30分利用(繰越60+今年度30で充当)。
// 6月に繰越を失効させても、今年度残がマイナス1時間になったりしない。 ----
{
  const roster = [member('A', 60)];
  const grants = [grant('A', 30, STATUS.APPROVED)];
  const usages = [usage('A', 90, STATUS.APPROVED, 60, 30)];
  const before = compute({ carryExpired: false }, roster, grants, usages)['A'];
  const after = compute({ carryExpired: true }, roster, grants, usages)['A'];
  eq([before.totalRemain, after.totalRemain, after.currentRemain], [0, 0, 0], '失効してもマイナスにならない');
}

// ---- 失効すると未利用の繰越分だけが消え、今年度分は残る ----
{
  const roster = [member('A', 120)];
  const grants = [grant('A', 45, STATUS.APPROVED)];
  const usages = [usage('A', 30, STATUS.APPROVED, 30, 0)];
  const before = compute({ carryExpired: false }, roster, grants, usages)['A'];
  const after = compute({ carryExpired: true }, roster, grants, usages)['A'];
  eq([before.carryRemain, before.totalRemain], [90, 135], '失効前');
  eq([after.carryRemain, after.currentRemain, after.totalRemain], [0, 45, 45], '失効後は今年度分のみ');
}

// ---- 承認待ちの利用は「利用可能時間」からは引くが残時間は変えない ----
{
  const b = compute(ACTIVE, [member('A', 0)],
    [grant('A', 60, STATUS.APPROVED)],
    [usage('A', 25, STATUS.PENDING)])['A'];
  eq([b.totalRemain, b.pendingUsage, b.available], [60, 25, 35], '承認待ち利用と利用可能時間');
}

// ---- 付与の取消で今年度残がマイナスになるケースは数値として現れる(管理職への警告用) ----
{
  const b = compute(ACTIVE, [member('A', 0)],
    [grant('A', 30, STATUS.CANCELED)],
    [usage('A', 30, STATUS.APPROVED, 0, 30)])['A'];
  eq([b.currentRemain, b.totalRemain], [-30, -30], '取消によるマイナスの可視化');
}

// ---- 名簿にいない人の記録は無視される(エラーにならない) ----
{
  const map = compute(ACTIVE, [member('A', 0)], [grant('X', 30, STATUS.APPROVED)], [usage('Y', 10, STATUS.APPROVED, 0, 10)]);
  eq(Object.keys(map), ['A'], '名簿外の記録は無視');
}

// ---- Logic.gs の状態文字列が Code.gs の STATUS とずれていないこと ----
// (重複チェックの isLiveStatus は文字列を直接書いているため、定数側の変更を検知する)
{
  const L = vm.runInContext('({ isLiveStatus: isLiveStatus })', sandbox);
  eq(L.isLiveStatus(STATUS.PENDING), true, 'isLiveStatus(STATUS.PENDING)');
  eq(L.isLiveStatus(STATUS.APPROVED), true, 'isLiveStatus(STATUS.APPROVED)');
  eq(L.isLiveStatus(STATUS.REJECTED), false, 'isLiveStatus(STATUS.REJECTED)');
  eq(L.isLiveStatus(STATUS.CANCELED), false, 'isLiveStatus(STATUS.CANCELED)');
  eq(L.isLiveStatus(STATUS.WITHDRAWN), false, 'isLiveStatus(STATUS.WITHDRAWN)');
}

console.log('OK: ' + count + ' 件のテストにすべて合格しました');
