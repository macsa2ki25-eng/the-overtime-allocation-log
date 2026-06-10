/**
 * Admin.gs ― 管理職向けAPI(承認・却下・取消・名簿管理・年次更新・設定)
 */

/** 管理ページ用のまとめデータ(全員分の残時間・全履歴・名簿・設定) */
function apiAdminGetAll(token) {
  const user = requireUser_(token);
  requireAdmin_(user);
  const settings = getSettings_();
  const roster = getRoster_();
  const grants = getGrants_();
  const usages = getUsages_();
  const balMap = computeBalanceMap_(settings, roster, grants, usages);

  const overview = roster.map(function (m) {
    const b = balMap[m.id];
    return {
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      hasEmail: !!m.email,
      carryStart: b.carryStart,
      carryRemain: b.carryRemain,
      grantApproved: b.grantApproved,
      usedTotal: b.carryUsed + b.currentUsed,
      currentRemain: b.currentRemain,
      totalRemain: b.totalRemain,
      pendingGrant: b.pendingGrant,
      pendingUsage: b.pendingUsage,
    };
  });

  return {
    settings: publicSettings_(settings),
    roster: roster.map(function (m) {
      return { id: m.id, name: m.name, role: m.role, pin: m.pin, email: m.email, status: m.status, carryMin: m.carryMin, note: m.note };
    }),
    overview: overview,
    grants: grants,
    usages: usages,
  };
}

/**
 * 承認・却下。ids は付与ID(G〜)または利用ID(U〜)の配列。
 * 利用の承認時は、前年度繰越分から先に充当して内訳を記録する。
 * 一部だけ失敗した場合も処理は続け、{done, errors} で結果を返す。
 */
function apiAdminDecide(token, kind, ids, action, memo) {
  const user = requireUser_(token);
  requireAdmin_(user);
  if (kind !== 'grant' && kind !== 'usage') throw new Error('不正な操作です。');
  if (action !== 'approve' && action !== 'reject') throw new Error('不正な操作です。');
  const idList = (Array.isArray(ids) ? ids : [ids]).map(String);
  if (!idList.length) throw new Error('対象を選択してください。');
  const memoText = String(memo == null ? '' : memo).trim();

  const out = withLock_(function () {
    const settings = getSettings_();
    const roster = getRoster_();
    const grants = getGrants_();
    const usages = getUsages_();
    const records = kind === 'grant' ? grants : usages;
    const sheetName = kind === 'grant' ? SHEET_NAMES.GRANT : SHEET_NAMES.USAGE;
    const COL = kind === 'grant' ? GRANT_COL : USAGE_COL;
    const byId = {};
    records.forEach(function (r) { byId[r.id] = r; });
    const balMap = computeBalanceMap_(settings, roster, grants, usages);
    const now = nowStr_();
    const done = [];
    const errors = [];
    const mailJobs = [];
    const kindLabel = kind === 'grant' ? '付与' : '利用';

    idList.forEach(function (id) {
      const rec = byId[id];
      if (!rec) { errors.push({ id: id, message: id + ': 対象が見つかりません。' }); return; }
      if (rec.status !== STATUS.PENDING) { errors.push({ id: id, message: id + ': すでに処理済みです(' + rec.status + ')。' }); return; }
      const memberId = kind === 'grant' ? rec.targetId : rec.memberId;
      const memberName = kind === 'grant' ? rec.targetName : rec.memberName;
      const pairs = {};

      if (action === 'approve' && kind === 'usage') {
        const b = balMap[memberId];
        if (!b) { errors.push({ id: id, message: memberName + ' さんが名簿に見つかりません。' }); return; }
        const alloc = allocateUsage(rec.minutes, b.carryRemain, b.currentRemain);
        if (!alloc.ok) {
          errors.push({ id: id, message: id + ': ' + memberName + ' さんの残時間が不足しています(残り ' + fmtMinutes(b.carryRemain + b.currentRemain) + ')。' });
          return;
        }
        // 同じ呼び出し内で複数件を承認しても整合するよう、残時間を順次減らす
        b.carryRemain -= alloc.carry;
        b.currentRemain -= alloc.current;
        pairs[USAGE_COL.carryUsed] = alloc.carry;
        pairs[USAGE_COL.currentUsed] = alloc.current;
      }

      pairs[COL.status] = action === 'approve' ? STATUS.APPROVED : STATUS.REJECTED;
      pairs[COL.decidedBy] = user.name;
      pairs[COL.decidedAt] = now;
      pairs[COL.decideMemo] = memoText;
      updateCells_(sheetName, rec.rowIndex, pairs);
      done.push(id);

      mailJobs.push({
        memberId: memberId,
        subject: kindLabel + 'が' + (action === 'approve' ? '承認' : '却下') + 'されました(' + rec.date + ')',
        lines: [
          'あなたの「' + kindLabel + '」が' + (action === 'approve' ? '承認' : '却下') + 'されました。',
          '',
          '日付: ' + rec.date,
          '時間帯: ' + rec.start + '〜' + rec.end + '(' + fmtMinutes(rec.minutes) + ')',
          kind === 'grant' ? '事由: ' + rec.reason : (rec.note ? '備考: ' + rec.note : null),
          '処理者: ' + user.name,
          memoText ? 'メモ: ' + memoText : null,
        ],
      });
    });
    return { settings: settings, roster: roster, done: done, errors: errors, mailJobs: mailJobs };
  });

  // メール送信はロックの外で行う(他の人の操作を待たせないため)
  out.mailJobs.forEach(function (job) {
    const member = out.roster.filter(function (m) { return m.id === job.memberId; })[0];
    notifyMemberResult_(out.settings, member, job.subject, job.lines);
  });
  return { done: out.done, errors: out.errors };
}

/**
 * 承認済みの付与・利用の取消(管理職のみ)。行は消さず状態を「取消」にして記録を残す。
 * 付与の取消で本人の残時間がマイナスになる場合は needConfirm を返し、
 * force=true で呼び直されたときだけ実行する。
 */
function apiAdminCancel(token, kind, id, force) {
  const user = requireUser_(token);
  requireAdmin_(user);
  if (kind !== 'grant' && kind !== 'usage') throw new Error('不正な操作です。');

  const out = withLock_(function () {
    const settings = getSettings_();
    const roster = getRoster_();
    const grants = getGrants_();
    const usages = getUsages_();
    const balMap = computeBalanceMap_(settings, roster, grants, usages);
    const now = nowStr_();

    if (kind === 'grant') {
      const rec = grants.filter(function (g) { return g.id === id; })[0];
      if (!rec) throw new Error('対象が見つかりません。');
      if (rec.status !== STATUS.APPROVED) throw new Error('承認済みの記録のみ取消できます(現在: ' + rec.status + ')。');
      const b = balMap[rec.targetId];
      const after = (b ? b.currentRemain : 0) - rec.minutes;
      if (after < 0 && !force) {
        return {
          needConfirm: true,
          message: '取り消すと ' + rec.targetName + ' さんの今年度残時間が ' + fmtMinutes(after) + ' になります(この付与分がすでに利用されているため)。それでも取り消しますか?',
        };
      }
      const pairs = {};
      pairs[GRANT_COL.status] = STATUS.CANCELED;
      pairs[GRANT_COL.canceledBy] = user.name;
      pairs[GRANT_COL.canceledAt] = now;
      updateCells_(SHEET_NAMES.GRANT, rec.rowIndex, pairs);
      return {
        done: true,
        message: '付与 ' + id + '(' + rec.targetName + ' さん・' + fmtMinutes(rec.minutes) + ')を取り消しました。',
        settings: settings,
        roster: roster,
        mail: {
          memberId: rec.targetId,
          subject: '付与が取り消されました(' + rec.date + ')',
          lines: ['あなたへの「付与」が管理職によって取り消されました。', '', '日付: ' + rec.date, '時間帯: ' + rec.start + '〜' + rec.end + '(' + fmtMinutes(rec.minutes) + ')', '事由: ' + rec.reason, '処理者: ' + user.name],
        },
      };
    }

    const rec = usages.filter(function (u) { return u.id === id; })[0];
    if (!rec) throw new Error('対象が見つかりません。');
    if (rec.status !== STATUS.APPROVED) throw new Error('承認済みの記録のみ取消できます(現在: ' + rec.status + ')。');
    let info = '';
    if (settings.carryExpired && rec.carryUsed > 0) {
      info = '※前年度分の充当 ' + fmtMinutes(rec.carryUsed) + ' は失効済みのため残時間には戻りません。';
    }
    const pairs = {};
    pairs[USAGE_COL.status] = STATUS.CANCELED;
    pairs[USAGE_COL.canceledBy] = user.name;
    pairs[USAGE_COL.canceledAt] = now;
    updateCells_(SHEET_NAMES.USAGE, rec.rowIndex, pairs);
    return {
      done: true,
      message: '利用 ' + id + '(' + rec.memberName + ' さん・' + fmtMinutes(rec.minutes) + ')を取り消しました。' + info,
      settings: settings,
      roster: roster,
      mail: {
        memberId: rec.memberId,
        subject: '利用が取り消されました(' + rec.date + ')',
        lines: ['あなたの「利用」が管理職によって取り消されました。', '', '日付: ' + rec.date, '時間帯: ' + rec.start + '〜' + rec.end + '(' + fmtMinutes(rec.minutes) + ')', '処理者: ' + user.name],
      },
    };
  });

  if (out.needConfirm) return { needConfirm: true, message: out.message };
  if (out.mail) {
    const member = out.roster.filter(function (m) { return m.id === out.mail.memberId; })[0];
    notifyMemberResult_(out.settings, member, out.mail.subject, out.mail.lines);
  }
  return { done: true, message: out.message };
}

/**
 * 名簿の登録・更新(管理職のみ)。id が空なら新規追加。
 * 繰越時間はここでは変更しない(年次更新で自動計算される)。
 */
function apiAdminSaveMember(token, memberData) {
  const user = requireUser_(token);
  requireAdmin_(user);
  const data = memberData || {};
  const name = String(data.name == null ? '' : data.name).trim();
  if (!name) throw new Error('氏名を入力してください。');
  const role = String(data.role == null ? '' : data.role).trim();
  if ([ROLE_ADMIN, ROLE_LEADER, ROLE_TEACHER].indexOf(role) < 0) throw new Error('役職の指定が正しくありません。');
  const pin = String(data.pin == null ? '' : data.pin).trim();
  if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('PINは4〜8桁の数字で入力してください。');
  const email = String(data.email == null ? '' : data.email).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');
  const status = String(data.status == null ? MEMBER_ACTIVE : data.status).trim();
  if ([MEMBER_ACTIVE, MEMBER_INACTIVE].indexOf(status) < 0) throw new Error('状態の指定が正しくありません。');
  const note = String(data.note == null ? '' : data.note).trim();

  return withLock_(function () {
    const sh = sheet_(SHEET_NAMES.ROSTER);
    if (data.id) {
      const member = findMember_(String(data.id).trim());
      if (!member) throw new Error('対象が見つかりません。');
      if (member.id === user.id && (role !== ROLE_ADMIN || status !== MEMBER_ACTIVE)) {
        throw new Error('誤操作防止のため、自分自身の役職変更・停止はできません。別の管理職アカウントから操作してください。');
      }
      sh.getRange(member.rowIndex, ROSTER_COL.name + 1, 1, 5).setValues([[name, role, pin, email, status]]);
      sh.getRange(member.rowIndex, ROSTER_COL.note + 1).setValue(note);
      return { id: member.id };
    }
    const id = nextIds_(SHEET_NAMES.ROSTER, ROSTER_COL.id, 'T', 3, 1)[0];
    appendRows_(SHEET_NAMES.ROSTER, [[id, name, role, pin, email, status, 0, note]]);
    return { id: id };
  });
}

/** 設定の保存(学校名・勤務時間・メール通知ON/OFF) */
function apiAdminSaveSettings(token, settingsData) {
  const user = requireUser_(token);
  requireAdmin_(user);
  const data = settingsData || {};
  const ws = timeToMin(data.workStart);
  const we = timeToMin(data.workEnd);
  if (ws == null || we == null || ws >= we) throw new Error('勤務時間の設定が正しくありません。');
  return withLock_(function () {
    saveSettingValue_(SETTING_KEYS.schoolName, String(data.schoolName == null ? '' : data.schoolName).trim());
    saveSettingValue_(SETTING_KEYS.workStart, minToTime(ws));
    saveSettingValue_(SETTING_KEYS.workEnd, minToTime(we));
    saveSettingValue_(SETTING_KEYS.mailToAdmins, data.mailToAdmins ? 'ON' : 'OFF');
    saveSettingValue_(SETTING_KEYS.mailToMembers, data.mailToMembers ? 'ON' : 'OFF');
    return publicSettings_(getSettings_());
  });
}

/**
 * 年度切替(4月頃に実行)。
 * 1. 承認待ちが残っていれば中止
 * 2. スプレッドシート全体のバックアップコピーを作成(Driveに保存される)
 * 3. 各自の残時間(繰越残+今年度残)を名簿の「繰越時間」に書き込む
 * 4. 付与記録・利用記録・通知ログを全消去し、年度を+1、失効日をリセット
 */
function apiAdminYearSwitch(token, confirmText) {
  const user = requireUser_(token);
  requireAdmin_(user);
  if (String(confirmText == null ? '' : confirmText).trim() !== '年度切替') {
    throw new Error('確認のため、入力欄に「年度切替」と入力してください。');
  }
  return withLock_(function () {
    const settings = getSettings_();
    const roster = getRoster_();
    const grants = getGrants_();
    const usages = getUsages_();
    const pendingGrants = grants.filter(function (g) { return g.status === STATUS.PENDING; }).length;
    const pendingUsages = usages.filter(function (u) { return u.status === STATUS.PENDING; }).length;
    if (pendingGrants + pendingUsages > 0) {
      throw new Error('承認待ちの申請が残っています(付与 ' + pendingGrants + ' 件・利用 ' + pendingUsages + ' 件)。すべて承認・却下・取下げしてから実行してください。');
    }
    const balMap = computeBalanceMap_(settings, roster, grants, usages);

    const backupName = '【バックアップ】割り振り変更簿_' + settings.nendo + '年度_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss');
    SpreadsheetApp.getActiveSpreadsheet().copy(backupName);

    const sh = sheet_(SHEET_NAMES.ROSTER);
    const carried = [];
    roster.forEach(function (m) {
      const b = balMap[m.id];
      const carry = b ? Math.max(b.totalRemain, 0) : 0;
      sh.getRange(m.rowIndex, ROSTER_COL.carry + 1).setValue(carry);
      if (m.status === MEMBER_ACTIVE) carried.push({ name: m.name, minutes: carry });
    });

    clearDataRows_(SHEET_NAMES.GRANT);
    clearDataRows_(SHEET_NAMES.USAGE);
    clearDataRows_(SHEET_NAMES.LOG);
    saveSettingValue_(SETTING_KEYS.nendo, settings.nendo + 1);
    saveSettingValue_(SETTING_KEYS.expireDate, '');

    return { backupName: backupName, newNendo: settings.nendo + 1, carried: carried };
  });
}

/**
 * 前年度繰越分の失効(6月頃に実行)。
 * 設定に失効日を記録するだけで、以後の残時間計算で繰越残が常に0になる。
 * 誤って実行した場合は「設定」シートの「繰越失効日」のセルを空にすると元に戻る。
 */
function apiAdminExpireCarryover(token, confirmText) {
  const user = requireUser_(token);
  requireAdmin_(user);
  if (String(confirmText == null ? '' : confirmText).trim() !== '失効') {
    throw new Error('確認のため、入力欄に「失効」と入力してください。');
  }
  return withLock_(function () {
    const settings = getSettings_();
    if (settings.carryExpired) {
      throw new Error('前年度繰越分はすでに失効済みです(' + settings.expireDate + ')。');
    }
    const roster = getRoster_();
    const balMap = computeBalanceMap_(settings, roster, getGrants_(), getUsages_());
    const affected = roster
      .filter(function (m) { return m.status === MEMBER_ACTIVE; })
      .map(function (m) { return { name: m.name, minutes: balMap[m.id] ? balMap[m.id].carryRemain : 0 }; })
      .filter(function (x) { return x.minutes > 0; });
    const date = todayStr_();
    saveSettingValue_(SETTING_KEYS.expireDate, date);
    return { date: date, affected: affected };
  });
}
