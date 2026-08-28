import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossRate, convert, formatMoney } from '../docs/js/fx.js';

// 模擬 USD 基準匯率
const RATES = { USD: 1, TWD: 32, TRY: 41, INR: 88, JPY: 147 };

test('crossRate：交叉匯率', () => {
  assert.equal(crossRate(RATES, 'USD', 'TWD'), 32);
  assert.equal(crossRate(RATES, 'TRY', 'TWD'), 32 / 41);
  assert.equal(crossRate(RATES, 'twd', 'twd'), 1);
  assert.equal(crossRate(RATES, 'XXX', 'TWD'), null);
});

test('convert：金額換算', () => {
  assert.equal(convert(RATES, 20, 'USD', 'TWD'), 640);
  const v = convert(RATES, 999.99, 'TRY', 'TWD');
  assert.ok(Math.abs(v - (999.99 / 41) * 32) < 1e-9);
  assert.equal(convert(RATES, null, 'USD', 'TWD'), null);
  assert.equal(convert(RATES, 10, 'ZZZ', 'TWD'), null);
});

test('formatMoney：格式化', () => {
  assert.match(formatMoney(640, 'TWD'), /640/);
  assert.match(formatMoney(19.99, 'USD'), /19\.99|20/);
  assert.equal(formatMoney(null, 'TWD'), '—');
  assert.match(formatMoney(640, 'TWD', { approx: true }), /^≈ /);
});
