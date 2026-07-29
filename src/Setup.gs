/**
 * Setup.gs ― 初期セットアップ
 *
 * スプレッドシートを開くとメニュー「割り振り変更簿」が追加され、
 * そこから初期セットアップ(シート作成)を実行できる。
 * 何度実行しても既存のデータは消えない(足りないものだけ作られる)。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('割り振り変更簿')
    .addItem('初期セットアップ(初回のみ)', 'initialSetup')
    .addItem('セットアップ状況の確認', 'checkSetup')
    .addItem('たまっている通知メールを今すぐ送信', 'sendQueuedMailsNow')
    .addToUi();
}

/** 通知メールが送られていないときの手動送信(通常は1分ごとに自動で送られる) */
function sendQueuedMailsNow() {
  const sent = processMailQueue();
  let extra = '';
  try {
    if (ensureMailTrigger_()) extra = '\n\n自動送信の設定が入っていなかったため、あわせて設定しました。';
  } catch (e) {
    extra = '\n\n※自動送信の設定ができませんでした。「初期セットアップ」を実行して権限を許可してください。';
  }
  SpreadsheetApp.getUi().alert(sent + ' 件の通知メールを送信しました。' + extra);
}

function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- 設定シート ---
  const settingsSheet = ensureSheet_(ss, SHEET_NAMES.SETTINGS, ['項目', '値', '説明']);
  settingsSheet.getRange('A:B').setNumberFormat('@'); // 値が勝手に日付や数値に変換されないようにする
  const d = new Date();
  const fiscalYear = (d.getMonth() + 1) >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  ensureSettingRow_(settingsSheet, SETTING_KEYS.schoolName, '', '画面の上部に表示される名称(例: ○○小学校)');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.nendo, String(fiscalYear), '現在の年度(西暦)。年次更新の「年度切替」で自動的に+1されます');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.workStart, '8:30', '勤務開始時刻');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.workEnd, '17:00', '勤務終了時刻');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.expireDate, '', '空欄=前年度繰越分は有効。管理画面の「繰越失効」で日付が入ります。誤って失効した場合はこのセルを空に戻してください');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.mailToAdmins, 'ON', '付与・利用の申請時に管理職へ承認依頼メールを送る(ON/OFF)');
  ensureSettingRow_(settingsSheet, SETTING_KEYS.mailToMembers, 'ON', '承認・却下・取消時に本人へ結果メールを送る(ON/OFF)');

  // --- 名簿シート ---
  const rosterSheet = ensureSheet_(ss, SHEET_NAMES.ROSTER, ['ID', '氏名', '役職', 'PIN', 'メールアドレス', '状態', '繰越時間(分)', '備考']);
  rosterSheet.getRange('A:F').setNumberFormat('@'); // PINの先頭の0などが消えないようにする
  if (rosterSheet.getLastRow() === 1) {
    rosterSheet.getRange(2, 1, 2, 8).setValues([
      ['T001', '管理者(氏名に書き換えてください)', ROLE_ADMIN, '0000', '', MEMBER_ACTIVE, 0, '最初のログイン用(PIN: 0000)。ログイン後にPINを必ず変更してください。PINは初回ログイン時に自動で暗号化されます'],
      ['T002', '記入例(この行は削除可)', ROLE_TEACHER, '1234', '', MEMBER_INACTIVE, 0, '状態が「停止」の行はログインできません'],
    ]);
  }

  // --- 付与記録シート ---
  const grantSheet = ensureSheet_(ss, SHEET_NAMES.GRANT, [
    '付与ID', 'グループID', '状態', '発生日', '開始時刻', '終了時刻', '付与分数', '事由',
    '対象者ID', '対象者氏名', '起案者ID', '起案者氏名', '申請日時',
    '処理者氏名', '処理日時', '処理メモ', '取消者氏名', '取消日時',
  ]);
  grantSheet.getRange('A:F').setNumberFormat('@');
  grantSheet.getRange('H:R').setNumberFormat('@'); // G列(付与分数)だけ数値のまま

  // --- 利用記録シート ---
  const usageSheet = ensureSheet_(ss, SHEET_NAMES.USAGE, [
    '利用ID', '状態', '取得日', '開始時刻', '終了時刻', '利用分数', '繰越充当分', '今年度充当分',
    '教員ID', '教員氏名', '備考', '申請日時',
    '処理者氏名', '処理日時', '処理メモ', '取消者氏名', '取消日時',
  ]);
  usageSheet.getRange('A:E').setNumberFormat('@');
  usageSheet.getRange('I:Q').setNumberFormat('@'); // F〜H列(分数・充当)は数値のまま

  // --- 通知キューシート(送信待ちのメール置き場) ---
  ensureSheet_(ss, SHEET_NAMES.QUEUE, QUEUE_HEADERS);

  // --- 通知ログシート ---
  ensureSheet_(ss, SHEET_NAMES.LOG, ['日時', '種別', '宛先', '件名', '結果']);

  // --- メールの自動送信(1分ごと)を設定 ---
  let mailNote = '';
  try {
    ensureMailTrigger_();
  } catch (e) {
    mailNote = '\n\n※通知メールの自動送信を設定できませんでした(' + e.message + ')。\n'
      + 'メニューの「たまっている通知メールを今すぐ送信」から手動で送信できます。';
  }

  // 使われていない初期シート(シート1)が空なら削除する
  ['シート1', 'Sheet1'].forEach(function (name) {
    const def = ss.getSheetByName(name);
    if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) {
      try { ss.deleteSheet(def); } catch (e) { /* 消せなくても問題ない */ }
    }
  });

  SpreadsheetApp.getUi().alert(
    '初期セットアップが完了しました。\n\n' +
    '次の手順:\n' +
    '1.「名簿」シートで自分(管理職)の氏名とPINを設定する\n' +
    '2. Apps Script エディタの「デプロイ」→「新しいデプロイ」でウェブアプリとして公開する\n\n' +
    '詳しくはセットアップ手順書(docs/01_セットアップ手順.md)をご覧ください。' + mailNote
  );
}

/** セットアップ漏れがないかを確認してダイアログで知らせる */
function checkSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const problems = [];
  Object.keys(SHEET_NAMES).forEach(function (k) {
    if (!ss.getSheetByName(SHEET_NAMES[k])) problems.push('シート「' + SHEET_NAMES[k] + '」がありません');
  });
  if (!problems.length) {
    const admins = getRoster_().filter(function (m) {
      return m.role === ROLE_ADMIN && m.status === MEMBER_ACTIVE && m.pin;
    });
    if (!admins.length) problems.push('名簿に「在籍」状態でPINが設定された管理職がいません');
    const settingsMap = {};
    readRows_(SHEET_NAMES.SETTINGS).forEach(function (r) { settingsMap[String(r.values[0]).trim()] = true; });
    Object.keys(SETTING_KEYS).forEach(function (k) {
      if (!settingsMap[SETTING_KEYS[k]]) problems.push('設定シートに「' + SETTING_KEYS[k] + '」の行がありません');
    });
    try {
      const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
        return t.getHandlerFunction() === MAIL_TRIGGER_HANDLER;
      });
      if (!triggers.length) problems.push('通知メールの自動送信が設定されていません(「初期セットアップ」を実行すると設定されます)');
    } catch (e) {
      problems.push('通知メールの自動送信を確認できませんでした: ' + e.message);
    }
  }
  SpreadsheetApp.getUi().alert(
    problems.length
      ? '次の項目を確認してください:\n・' + problems.join('\n・') + '\n\n「初期セットアップ」を再実行すると不足分が補われます。'
      : '問題は見つかりませんでした。このまま利用できます。'
  );
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureSettingRow_(sheet, key, value, description) {
  const last = sheet.getLastRow();
  if (last >= 2) {
    const keys = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === key) return;
    }
  }
  sheet.appendRow([key, value, description]);
}
