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
    getUuid: function () { return 'uuid-fixed-for-test'; },
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
const X = vm.runInContext('({ hashPin_: hashPin_, isHashedPin_: isHashedPin_, pinSecret_: pinSecret_ })', sandbox);

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

console.log('OK: ' + count + ' 件のテストにすべて合格しました');
