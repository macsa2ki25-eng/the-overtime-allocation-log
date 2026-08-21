/**
 * src/Code.gs のPINハッシュ処理のテスト。
 * 実行方法: node tests/pin.test.js
 *
 * GASの Utilities.computeDigest は符号付きバイト(-128〜127)を返すため、
 * それを模したスタブで hashPin_ の16進変換が正しいことを確認する。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const crypto = require('crypto');

const propStore = {};
const sandbox = {
  Math: Math, Object: Object, String: String, Number: Number, Array: Array,
  RegExp: RegExp, parseInt: parseInt, Date: Date,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: function (alg, str) {
      const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
      // GASと同じく符号付きバイトの配列にする
      return Array.from(buf).map(function (b) { return b > 127 ? b - 256 : b; });
    },
    // 呼ぶたびに違う値を返す(本物と同じく、用途ごとに別の秘密の値になる)
    getUuid: (function () {
      let n = 0;
      return function () { n++; return 'uuid-for-test-' + n; };
    })(),
  },
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return propStore[k] || null; },
        setProperty: function (k, v) { propStore[k] = v; },
      };
    },
  },
};
vm.createContext(sandbox);
['Logic.gs', 'Code.gs'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
});
const X = vm.runInContext(
  '({ hashPin_: hashPin_, isHashedPin_: isHashedPin_, pinSecret_: pinSecret_,'
  + ' sha256Hex_: sha256Hex_, makeToken_: makeToken_, parseToken_: parseToken_,'
  + ' tokenSignature_: tokenSignature_, SESSION_SECONDS: SESSION_SECONDS })',
  sandbox
);

let count = 0;
function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label + ' => ' + JSON.stringify(actual));
  count++;
}

// ---- pinSecret_: 一度生成したら同じ値が返り続ける ----
const secret1 = X.pinSecret_();
const secret2 = X.pinSecret_();
eq(secret1, secret2, 'pinSecret_ は固定');
eq(secret1.length > 0, true, 'pinSecret_ は空でない');

// ---- hashPin_: 形式・決定性・期待値 ----
const h = X.hashPin_('T001', '1234');
eq(/^#[0-9a-f]{64}$/.test(h), true, 'hashPin_ の形式');
eq(X.hashPin_('T001', '1234'), h, 'hashPin_ は決定的');
const expected = '#' + crypto.createHash('sha256').update('T001:1234:' + secret1, 'utf8').digest('hex');
eq(h, expected, 'hashPin_ の符号付きバイト→16進変換が正しい');

// ---- 同じPINでもIDが違えばハッシュが変わる(レインボーテーブル対策のソルト) ----
eq(X.hashPin_('T002', '1234') !== h, true, 'IDごとに異なるハッシュ');
eq(X.hashPin_('T001', '12345') !== h, true, 'PINごとに異なるハッシュ');

// ---- isHashedPin_ ----
eq(X.isHashedPin_(h), true, 'isHashedPin_(ハッシュ)');
eq(X.isHashedPin_('1234'), false, 'isHashedPin_(平文の数字)');
eq(X.isHashedPin_(''), false, 'isHashedPin_(空)');
eq(X.isHashedPin_('#xyz'), false, 'isHashedPin_(不正な形式)');
eq(X.isHashedPin_(' ' + h + ' '), true, 'isHashedPin_(前後の空白は無視)');

// ---- ログインの合言葉(トークン)----
// キャッシュに保存せず、署名だけで本物か確かめられることを確認する。
{
  const token = X.makeToken_('T001');
  eq(X.parseToken_(token), 'T001', '発行した合言葉から本人が分かる');
  eq(token.split('.').length, 3, '合言葉は3つの部分からなる');

  // 改ざんは通らない
  const parts = token.split('.');
  eq(X.parseToken_('T002.' + parts[1] + '.' + parts[2]), null, '教職員IDのすり替えを拒否');
  eq(X.parseToken_(parts[0] + '.' + parts[1] + '.' + 'a'.repeat(64)), null, '署名の偽造を拒否');
  eq(X.parseToken_(parts[0] + '.' + (Number(parts[1]) + 1) + '.' + parts[2]), null, '発行時刻の書き換えを拒否');

  // 形式が違うものは拒否
  eq(X.parseToken_(''), null, '空文字を拒否');
  eq(X.parseToken_(null), null, 'nullを拒否');
  eq(X.parseToken_('1b2c3d4e-0000-0000-0000-000000000000'), null, '以前のUUID形式を拒否');
  eq(X.parseToken_('T001.abc.' + 'a'.repeat(64)), null, '発行時刻が数字でないものを拒否');
  eq(X.parseToken_('T001.' + parts[1]), null, '部分が足りないものを拒否');

  // 期限切れ・未来の日時は拒否
  const old = String(Date.now() - (X.SESSION_SECONDS * 1000 + 60000));
  eq(X.parseToken_('T001.' + old + '.' + X.tokenSignature_('T001', old)), null, '期限切れを拒否');
  const future = String(Date.now() + 60 * 60 * 1000);
  eq(X.parseToken_('T001.' + future + '.' + X.tokenSignature_('T001', future)), null, '未来の発行時刻を拒否');

  // 期限内なら有効
  const recent = String(Date.now() - 60 * 1000);
  eq(X.parseToken_('T001.' + recent + '.' + X.tokenSignature_('T001', recent)), 'T001', '1分前の合言葉は有効');

  // PIN用とログイン用の秘密の値は別
  eq(X.tokenSignature_('T001', '123') !== X.sha256Hex_('T001:123:' + X.pinSecret_()), true, 'PIN用とログイン用の署名は別');
}

console.log('OK: ' + count + ' 件のテストにすべて合格しました');
