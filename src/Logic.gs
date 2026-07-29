/**
 * Logic.gs ― 時間計算などの純粋ロジック
 *
 * スプレッドシートや GAS のサービスに依存しない関数だけを置くファイルです。
 * tests/logic.test.js で Node.js から単体テストできます。
 * このファイルを修正したらテストも実行してください: node tests/logic.test.js
 */

/** "8:30" や "08:30" を 0:00 からの経過分数に変換する(不正な形式は null) */
function timeToMin(str) {
  const m = String(str == null ? '' : str).trim().match(/^([0-9]{1,2}):([0-9]{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 0:00 からの経過分数を "H:MM" 形式に変換する */
function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ':' + (m < 10 ? '0' + m : m);
}

/** 区間 [aStart, aEnd) と [bStart, bEnd) の重なり(分) */
function overlapMin(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * 付与時間の算定: 入力された時間帯のうち「勤務時間の外」にある分数。
 * 例) 勤務 8:30〜17:00 のとき 8:20〜8:30 → 10分、8:00〜9:00 → 30分
 */
function calcGrantMinutes(startMin, endMin, workStartMin, workEndMin) {
  return (endMin - startMin) - overlapMin(startMin, endMin, workStartMin, workEndMin);
}

/**
 * 利用時間の算定: 入力された時間帯のうち「勤務時間の中」にある分数。
 * 例) 勤務 8:30〜17:00 のとき 16:30〜17:00 → 30分
 */
function calcUsageMinutes(startMin, endMin, workStartMin, workEndMin) {
  return overlapMin(startMin, endMin, workStartMin, workEndMin);
}

/** 時間帯入力の共通チェック。問題があればエラーメッセージ、なければ null を返す */
function validateTimeRange(startMin, endMin) {
  if (startMin == null || endMin == null) return '時刻の形式が正しくありません。';
  if (startMin % 5 !== 0 || endMin % 5 !== 0) return '時刻は5分単位で入力してください。';
  if (startMin >= endMin) return '終了時刻は開始時刻より後にしてください。';
  return null;
}

/**
 * 利用時間の充当計算。前年度繰越分から先に消費し、不足分を今年度分から引く。
 * ok が false の場合は残時間不足(承認できない)。
 */
function allocateUsage(minutes, carryRemain, currentRemain) {
  const carry = Math.min(minutes, Math.max(carryRemain, 0));
  const current = minutes - carry;
  return { carry: carry, current: current, ok: current <= currentRemain };
}

/**
 * 重複チェックの対象になる状態か。
 * 却下・取下げ・取消になったものは、同じ内容で出し直せるように対象外とする。
 * (文字列は Code.gs の STATUS と同じ。ずれていないか balance.test.js で検査している)
 */
function isLiveStatus(status) {
  return status === '承認待ち' || status === '承認済み';
}

/** 同じ日・同じ時間帯か */
function isSameSlot(a, b) {
  return a.date === b.date && a.start === b.start && a.end === b.end;
}

/**
 * 同じ内容の付与がすでに登録されているか。
 * 通信エラーで申請ボタンを押し直したときの二重登録を防ぐために使う。
 */
function isDuplicateGrant(candidate, existing) {
  return existing.some(function (g) {
    return isLiveStatus(g.status)
      && g.targetId === candidate.targetId
      && g.reason === candidate.reason
      && isSameSlot(g, candidate);
  });
}

/** 同じ内容の利用がすでに登録されているか */
function isDuplicateUsage(candidate, existing) {
  return existing.some(function (u) {
    return isLiveStatus(u.status)
      && u.memberId === candidate.memberId
      && isSameSlot(u, candidate);
  });
}

/** 分数を「1時間30分」のような表記にする(負の値は先頭に-) */
function fmtMinutes(min) {
  const sign = min < 0 ? '-' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return sign + m + '分';
  if (m === 0) return sign + h + '時間';
  return sign + h + '時間' + m + '分';
}

// Node.js のテストから読み込めるようにする(GAS 上では module は存在しないので無視される)
if (typeof module !== 'undefined') {
  module.exports = {
    timeToMin: timeToMin,
    minToTime: minToTime,
    overlapMin: overlapMin,
    calcGrantMinutes: calcGrantMinutes,
    calcUsageMinutes: calcUsageMinutes,
    validateTimeRange: validateTimeRange,
    allocateUsage: allocateUsage,
    isLiveStatus: isLiveStatus,
    isSameSlot: isSameSlot,
    isDuplicateGrant: isDuplicateGrant,
    isDuplicateUsage: isDuplicateUsage,
    fmtMinutes: fmtMinutes,
  };
}
