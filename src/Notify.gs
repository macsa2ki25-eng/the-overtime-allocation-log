/**
 * Notify.gs ― メール通知(キュー方式)
 *
 * メール送信は1通あたり数秒かかることがあるため、申請や承認の処理中には送らない。
 * いったん「通知キュー」シートに貯めておき、1分ごとに動く自動処理(processMailQueue)が
 * まとめて送信する。これにより、申請ボタンを押してから画面が返るまでが速くなる。
 *
 * メールはこのスプレッドシートの所有者(=ウェブアプリをデプロイしたアカウント)の
 * Gmail から送信される。送信の成否は「通知ログ」シートに記録される。
 */

const MAIL_TRIGGER_HANDLER = 'processMailQueue';
const MAIL_BATCH_LIMIT = 20; // 1回の自動処理で送る上限
const QUEUE_KEEP_ROWS = 200; // 処理済みの行をこの件数まで残して古いものを消す

let APP_URL_CACHE_ = null;

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
  if (APP_URL_CACHE_ !== null) return APP_URL_CACHE_;
  try {
    APP_URL_CACHE_ = ScriptApp.getService().getUrl() || '';
  } catch (e) {
    APP_URL_CACHE_ = '';
  }
  return APP_URL_CACHE_;
}

function queueSheet_() {
  return getOrCreateSheet_(SHEET_NAMES.QUEUE, QUEUE_HEADERS);
}

/** 送信予定のメールをキューに追加する(実際の送信は自動処理が行う) */
function enqueueMails_(jobs) {
  if (!jobs.length) return;
  try {
    const now = nowStr_();
    const rows = jobs.map(function (j) {
      return [now, j.type, j.to, j.subject, j.body, QUEUE_PENDING, ''];
    });
    const sh = queueSheet_();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, QUEUE_HEADERS.length).setValues(rows);
    ensureMailTriggerOccasionally_();
  } catch (e) {
    // キューに入れられない場合でも通知を失わないよう、その場で送る
    jobs.forEach(function (j) { sendMailSafe_(j.type, j.to, j.subject, j.body); });
  }
}

/**
 * 自動送信の仕掛け(トリガー)が入っているか、ときどき確認して無ければ作る。
 * 毎回確認すると遅くなるため、6時間に1回だけ確認する。
 */
function ensureMailTriggerOccasionally_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('mailtrig')) return;
  try {
    ensureMailTrigger_();
    cache.put('mailtrig', '1', 6 * 60 * 60);
  } catch (e) {
    // トリガーを作れない場合(権限不足など)はキューに残る。
    // メニューの「たまっている通知メールを今すぐ送信」で手動送信できる。
  }
}

/** 自動送信のトリガーを用意する。すでにあれば何もしない */
function ensureMailTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === MAIL_TRIGGER_HANDLER) return false;
  }
  ScriptApp.newTrigger(MAIL_TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
  return true;
}

/**
 * キューにたまったメールを送る。1分ごとの自動処理から呼ばれる。
 * 申請や承認の処理(スクリプトロック)を邪魔しないよう、別のロックを使う。
 */
function processMailQueue() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(3000)) return 0; // 前回の処理が動いていれば今回は見送る
  try {
    const sh = queueSheet_();
    const last = sh.getLastRow();
    if (last < 2) return 0;
    const range = sh.getRange(2, 1, last - 1, QUEUE_HEADERS.length);
    const values = range.getValues();
    let sent = 0;
    for (let i = 0; i < values.length && sent < MAIL_BATCH_LIMIT; i++) {
      if (String(values[i][QUEUE_COL.status]).trim() !== QUEUE_PENDING) continue;
      const ok = sendMailSafe_(
        values[i][QUEUE_COL.type], values[i][QUEUE_COL.to],
        values[i][QUEUE_COL.subject], values[i][QUEUE_COL.body]
      );
      values[i][QUEUE_COL.status] = ok ? QUEUE_SENT : QUEUE_FAILED;
      values[i][QUEUE_COL.doneAt] = nowStr_();
      sent++;
    }
    if (sent > 0) range.setValues(values);
    cleanupQueue_(sh);
    return sent;
  } finally {
    lock.releaseLock();
  }
}

/** 処理済みの古い行を消して、キューが際限なく伸びないようにする */
function cleanupQueue_(sh) {
  const last = sh.getLastRow();
  const extra = last - 1 - QUEUE_KEEP_ROWS * 2;
  if (extra <= 0) return;
  const statuses = sh.getRange(2, QUEUE_COL.status + 1, extra, 1).getValues();
  let deletable = 0;
  for (let i = 0; i < statuses.length; i++) {
    if (String(statuses[i][0]).trim() === QUEUE_PENDING) break; // 未送信が現れたらそこで止める
    deletable++;
  }
  if (deletable > 0) sh.deleteRows(2, deletable);
}

/**
 * 付与・利用の申請があったとき、メール登録のある在籍の管理職全員へ承認依頼を送る。
 * 申請者自身が管理職の場合、本人へは送らない。
 */
function notifyAdminsRequest_(settings, requester, subject, bodyLines, roster) {
  if (!settings.mailToAdmins) return;
  const url = appUrl_();
  const body = bodyLines.filter(function (l) { return l != null; }).join('\n')
    + (url ? '\n\n▼ 画面を開く\n' + url : '');
  const jobs = [];
  (roster || getRoster_()).forEach(function (m) {
    if (m.role !== ROLE_ADMIN || m.status !== MEMBER_ACTIVE) return;
    if (!m.email || m.id === requester.id) return;
    jobs.push({ type: '承認依頼', to: m.email, subject: '【割り振り変更簿】' + subject, body: body });
  });
  enqueueMails_(jobs);
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
  enqueueMails_([{ type: '結果通知', to: member.email, subject: '【割り振り変更簿】' + subject, body: body }]);
}

/** 複数の結果通知をまとめてキューに入れる(承認・却下の一括処理用) */
function notifyMemberResults_(settings, jobs) {
  if (!settings.mailToMembers || !jobs.length) return;
  const url = appUrl_();
  const mails = [];
  jobs.forEach(function (job) {
    if (!job.member || !job.member.email) return;
    const body = job.lines.filter(function (l) { return l != null; }).join('\n')
      + (url ? '\n\n▼ 画面を開く\n' + url : '');
    mails.push({ type: '結果通知', to: job.member.email, subject: '【割り振り変更簿】' + job.subject, body: body });
  });
  enqueueMails_(mails);
}
