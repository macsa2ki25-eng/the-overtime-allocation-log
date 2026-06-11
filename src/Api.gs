/**
 * Api.gs ― 一般ユーザー向けAPI(マイページ・利用申請・付与の起案など)
 *
 * すべての関数は第1引数に token(ログイン時に発行される)を受け取る。
 */

/**
 * ログイン後に必要なデータを役割に応じて1回でまとめて返す。
 * 画面側はこの結果を使い回すため、タブを切り替えるたびの通信は発生しない。
 * シートの読み出しは1回分で済むので、画面ごとに個別に取るより速い。
 */
function apiGetAllData(token) {
  return allDataFor_(requireUser_(token));
}

/** 本人の役割に応じた全タブ分のデータを組み立てる(apiLogin からも使う) */
function allDataFor_(user) {
  const settings = getSettings_();
  const roster = getRoster_();
  const grants = getGrants_();
  const usages = getUsages_();
  const res = myDataBlock_(user, settings, roster, grants, usages);
  res.user = publicUser_(user);
  res.settings = publicSettings_(settings);
  if (user.role !== ROLE_TEACHER) {
    res.grantTargets = roster
      .filter(function (m) { return m.status === MEMBER_ACTIVE; })
      .map(function (m) { return { id: m.id, name: m.name, role: m.role }; });
  }
  if (user.role === ROLE_ADMIN) {
    res.admin = adminDataBlock_(settings, roster, grants, usages);
  }
  return res;
}

/** 本人に関するデータ一式(残時間・履歴・承認待ちなど) */
function myDataBlock_(user, settings, roster, grants, usages) {
  const balMap = computeBalanceMap_(settings, roster, grants, usages);
  const myGrants = grants.filter(function (g) { return g.targetId === user.id; });
  const myUsages = usages.filter(function (u) { return u.memberId === user.id; });

  const recent = []
    .concat(myGrants.map(function (g) {
      return { kind: 'grant', id: g.id, status: g.status, date: g.date, start: g.start, end: g.end, minutes: g.minutes, label: g.reason, requestedAt: g.requestedAt };
    }))
    .concat(myUsages.map(function (u) {
      return { kind: 'usage', id: u.id, status: u.status, date: u.date, start: u.start, end: u.end, minutes: u.minutes, label: u.note, requestedAt: u.requestedAt };
    }))
    .sort(function (a, b) { return a.requestedAt < b.requestedAt ? 1 : -1; })
    .slice(0, 10);

  const block = {
    balance: balMap[user.id],
    myGrants: myGrants,
    myUsages: myUsages,
    pendingMine: {
      grants: myGrants.filter(function (g) { return g.status === STATUS.PENDING; }),
      usages: myUsages.filter(function (u) { return u.status === STATUS.PENDING; }),
    },
    recent: recent,
  };
  if (user.role !== ROLE_TEACHER) {
    // 自分が起案して承認待ちになっている付与(取下げ用)
    block.proposedPending = grants.filter(function (g) {
      return g.proposerId === user.id && g.status === STATUS.PENDING && g.targetId !== user.id;
    });
  }
  if (user.role === ROLE_ADMIN) {
    block.adminPending = {
      grants: grants.filter(function (g) { return g.status === STATUS.PENDING; }).length,
      usages: usages.filter(function (u) { return u.status === STATUS.PENDING; }).length,
    };
  }
  return block;
}

/** 旧バージョンの画面との互換用(現在の画面は apiGetAllData を使う) */
function apiGetMyPage(token) {
  const user = requireUser_(token);
  const settings = getSettings_();
  const block = myDataBlock_(user, settings, getRoster_(), getGrants_(), getUsages_());
  return {
    user: publicUser_(user),
    settings: publicSettings_(settings),
    balance: block.balance,
    pendingMine: block.pendingMine,
    recent: block.recent,
    proposedPending: block.proposedPending,
    adminPending: block.adminPending,
  };
}

/** 旧バージョンの画面との互換用(現在の画面は apiGetAllData を使う) */
function apiGetMyRecords(token) {
  const user = requireUser_(token);
  const settings = getSettings_();
  const block = myDataBlock_(user, settings, getRoster_(), getGrants_(), getUsages_());
  return {
    settings: publicSettings_(settings),
    balance: block.balance,
    grants: block.myGrants,
    usages: block.myUsages,
  };
}

/** 付与申請用: 対象として選べる在籍メンバーの一覧(管理職・主任のみ) */
function apiGetGrantTargets(token) {
  const user = requireUser_(token);
  requireGranter_(user);
  return getRoster_()
    .filter(function (m) { return m.status === MEMBER_ACTIVE; })
    .map(function (m) { return { id: m.id, name: m.name, role: m.role }; });
}

/**
 * 付与の起案(管理職・主任)。
 * 入力された時間帯のうち勤務時間「外」の分数を、選んだ全員に同じ分数で付与する。
 * 承認されるまで残時間には反映されない。
 */
function apiSubmitGrant(token, payload) {
  const user = requireUser_(token);
  requireGranter_(user);
  const p = payload || {};
  const date = normDateStr_(p.date);
  if (!date) throw new Error('発生日を正しく入力してください。');
  const start = timeToMin(p.start);
  const end = timeToMin(p.end);
  const rangeError = validateTimeRange(start, end);
  if (rangeError) throw new Error(rangeError);
  const reason = String(p.reason == null ? '' : p.reason).trim();
  if (!reason) throw new Error('事由(会議名など)を入力してください。');
  const teacherIds = Array.isArray(p.teacherIds) ? p.teacherIds : [];
  if (!teacherIds.length) throw new Error('付与する教職員を1人以上選択してください。');

  const created = withLock_(function () {
    const settings = getSettings_();
    const minutes = calcGrantMinutes(start, end, timeToMin(settings.workStart), timeToMin(settings.workEnd));
    if (minutes <= 0) {
      throw new Error('入力された時間帯はすべて勤務時間(' + settings.workStart + '〜' + settings.workEnd + ')内のため、付与時間が0分になります。勤務時間外の部分のみが付与の対象です。');
    }
    const roster = getRoster_();
    const targets = teacherIds.map(function (id) {
      const found = roster.filter(function (m) { return m.id === String(id).trim() && m.status === MEMBER_ACTIVE; });
      if (!found.length) throw new Error('選択された教職員(' + id + ')が名簿に見つかりません。');
      return found[0];
    });
    const groupId = nextIds_(SHEET_NAMES.GRANT, GRANT_COL.group, 'GG', 4, 1)[0];
    const ids = nextIds_(SHEET_NAMES.GRANT, GRANT_COL.id, 'G', 5, targets.length);
    const now = nowStr_();
    appendRows_(SHEET_NAMES.GRANT, targets.map(function (t, i) {
      return [ids[i], groupId, STATUS.PENDING, date, minToTime(start), minToTime(end), minutes, reason, t.id, t.name, user.id, user.name, now, '', '', '', '', ''];
    }));
    return { groupId: groupId, minutes: minutes, targets: targets, settings: settings };
  });

  notifyAdminsRequest_(created.settings, user, '承認依頼(付与): ' + reason, [
    '割り振り変更簿に「付与」の申請がありました。',
    '',
    '起案者: ' + user.name,
    '発生日: ' + date,
    '時間帯: ' + minToTime(start) + '〜' + minToTime(end) + '(1人あたり ' + fmtMinutes(created.minutes) + ')',
    '事由: ' + reason,
    '対象: ' + created.targets.map(function (t) { return t.name; }).join('、') + '(' + created.targets.length + '名)',
  ]);
  return { groupId: created.groupId, minutes: created.minutes, count: created.targets.length };
}

/**
 * 利用の申請(全員)。
 * 入力された時間帯のうち勤務時間「内」の分数を利用する。
 * 残時間(承認待ちの利用分を除く)を超える申請はできない。
 */
function apiSubmitUsage(token, payload) {
  const user = requireUser_(token);
  const p = payload || {};
  const date = normDateStr_(p.date);
  if (!date) throw new Error('取得日を正しく入力してください。');
  const start = timeToMin(p.start);
  const end = timeToMin(p.end);
  const rangeError = validateTimeRange(start, end);
  if (rangeError) throw new Error(rangeError);
  const note = String(p.note == null ? '' : p.note).trim();

  const created = withLock_(function () {
    const settings = getSettings_();
    const minutes = calcUsageMinutes(start, end, timeToMin(settings.workStart), timeToMin(settings.workEnd));
    if (minutes <= 0) {
      throw new Error('入力された時間帯に勤務時間(' + settings.workStart + '〜' + settings.workEnd + ')が含まれていません。勤務時間内の部分のみが利用の対象です。');
    }
    const bal = computeBalanceMap_(settings, getRoster_(), getGrants_(), getUsages_())[user.id];
    const available = bal ? bal.available : 0;
    if (minutes > available) {
      throw new Error('残り時間が足りません。現在の利用可能時間(承認待ちの利用分を除く)は ' + fmtMinutes(available) + ' です。');
    }
    const id = nextIds_(SHEET_NAMES.USAGE, USAGE_COL.id, 'U', 5, 1)[0];
    appendRows_(SHEET_NAMES.USAGE, [[id, STATUS.PENDING, date, minToTime(start), minToTime(end), minutes, '', '', user.id, user.name, note, nowStr_(), '', '', '', '', '']]);
    return { id: id, minutes: minutes, settings: settings };
  });

  notifyAdminsRequest_(created.settings, user, '承認依頼(利用): ' + user.name, [
    '割り振り変更簿に「利用」の申請がありました。',
    '',
    '申請者: ' + user.name,
    '取得日: ' + date,
    '時間帯: ' + minToTime(start) + '〜' + minToTime(end) + '(' + fmtMinutes(created.minutes) + ')',
    note ? '備考: ' + note : null,
  ]);
  return { id: created.id, minutes: created.minutes };
}

/**
 * 承認待ちの申請を本人(または付与の起案者)が取り下げる。
 */
function apiWithdraw(token, kind, id) {
  const user = requireUser_(token);
  return withLock_(function () {
    if (kind === 'grant') {
      const rec = getGrants_().filter(function (g) { return g.id === id; })[0];
      if (!rec || (rec.targetId !== user.id && rec.proposerId !== user.id)) {
        throw new Error('対象の申請が見つかりません。');
      }
      if (rec.status !== STATUS.PENDING) throw new Error('承認待ちの申請のみ取り下げできます。');
      const pairs = {};
      pairs[GRANT_COL.status] = STATUS.WITHDRAWN;
      pairs[GRANT_COL.decidedBy] = user.name;
      pairs[GRANT_COL.decidedAt] = nowStr_();
      pairs[GRANT_COL.decideMemo] = '本人取下げ';
      updateCells_(SHEET_NAMES.GRANT, rec.rowIndex, pairs);
    } else if (kind === 'usage') {
      const rec = getUsages_().filter(function (u) { return u.id === id; })[0];
      if (!rec || rec.memberId !== user.id) throw new Error('対象の申請が見つかりません。');
      if (rec.status !== STATUS.PENDING) throw new Error('承認待ちの申請のみ取り下げできます。');
      const pairs = {};
      pairs[USAGE_COL.status] = STATUS.WITHDRAWN;
      pairs[USAGE_COL.decidedBy] = user.name;
      pairs[USAGE_COL.decidedAt] = nowStr_();
      pairs[USAGE_COL.decideMemo] = '本人取下げ';
      updateCells_(SHEET_NAMES.USAGE, rec.rowIndex, pairs);
    } else {
      throw new Error('不正な操作です。');
    }
    return true;
  });
}
