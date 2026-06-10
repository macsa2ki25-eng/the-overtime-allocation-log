/**
 * Notify.gs ― メール通知と通知ログ
 *
 * メールはこのスプレッドシートの所有者(=ウェブアプリをデプロイしたアカウント)の
 * Gmail から送信される。送信の成否は「通知ログ」シートに記録される。
 */

function logNotify_(type, to, subject, result) {
  try {
    sheet_(SHEET_NAMES.LOG).appendRow([nowStr_(), type, to, subject, result]);
  } catch (e) {
    // ログが書けなくても本処理は止めない
  }
}

function sendMailSafe_(type, to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
    logNotify_(type, to, subject, '送信');
    return true;
  } catch (e) {
    logNotify_(type, to, subject, '失敗: ' + e.message);
    return false;
  }
}

/** ウェブアプリのURL(メール本文に載せる)。取得できない場合は空文字 */
function appUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/**
 * 付与・利用の申請があったとき、メール登録のある在籍の管理職全員へ承認依頼を送る。
 * 申請者自身が管理職の場合、本人へは送らない。
 */
function notifyAdminsRequest_(settings, requester, subject, bodyLines) {
  if (!settings.mailToAdmins) return;
  const url = appUrl_();
  const body = bodyLines.filter(function (l) { return l != null; }).join('\n')
    + (url ? '\n\n▼ 画面を開く\n' + url : '');
  getRoster_().forEach(function (m) {
    if (m.role !== ROLE_ADMIN || m.status !== MEMBER_ACTIVE) return;
    if (!m.email || m.id === requester.id) return;
    sendMailSafe_('承認依頼', m.email, '【割り振り変更簿】' + subject, body);
  });
}

/**
 * 承認・却下・取消の結果を本人へ送る(メール登録がある場合のみ)。
 */
function notifyMemberResult_(settings, member, subject, bodyLines) {
  if (!settings.mailToMembers) return;
  if (!member || !member.email) return;
  const url = appUrl_();
  const body = bodyLines.filter(function (l) { return l != null; }).join('\n')
    + (url ? '\n\n▼ 画面を開く\n' + url : '');
  sendMailSafe_('結果通知', member.email, '【割り振り変更簿】' + subject, body);
}
