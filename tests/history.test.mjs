import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSnapshot, diffSummaries, appendHistory, planNames, filterAlertable,
} from '../scripts/lib/pricehistory.mjs';
import { planPriceMap, monthlyEquivalent } from '../docs/js/compare.js';

const iap = (name, price, currency = 'TRY') => ({ name, price, currency, priceFormatted: String(price) });

function snap(price) {
  return {
    tw: {
      currency: 'TWD',
      appPrice: { price: 235, currency: 'TWD' },
      inApps: [iap('Plus', 690, 'TWD')],
    },
    tr: {
      currency: 'TRY',
      inApps: [iap('Plus', price), iap('Plus', price * 10), iap('Go', 249.99)],
    },
    in: { currency: 'INR', error: 'incomplete-page', inApps: [] }, // 失敗的國家要略過
    jp: { currency: 'JPY', stale: true, inApps: [iap('Plus', 3000, 'JPY')] }, // 沿用舊資料也略過
  };
}

test('planPriceMap：同名方案穩定鍵', () => {
  const m = planPriceMap([iap('Plus', 999.99), iap('Go', 249.99), iap('Plus', 9999.99)]);
  assert.equal(m['plus#0'].price, 999.99);
  assert.equal(m['plus#1'].price, 9999.99);
  assert.equal(m['go#0'].price, 249.99);
});

test('monthlyEquivalent', () => {
  assert.equal(monthlyEquivalent(120, 'yearly'), 10);
  assert.equal(monthlyEquivalent(100, 'monthly'), 100);
  assert.equal(monthlyEquivalent(100, null), 100);
  assert.equal(monthlyEquivalent(100, 'lifetime'), null);
  assert.ok(Math.abs(monthlyEquivalent(10, 'weekly') - 43.45) < 1e-9);
});

test('summarizeSnapshot：略過失敗與 stale 國家', () => {
  const s = summarizeSnapshot(snap(999.99));
  assert.deepEqual(Object.keys(s).sort(), ['tr', 'tw']);
  assert.equal(s.tw.app, 235);
  assert.equal(s.tr.plans['plus#0'].price, 999.99);
});

test('diffSummaries：漲價偵測', () => {
  const prev = summarizeSnapshot(snap(999.99));
  const next = summarizeSnapshot(snap(1299.99));
  const events = diffSummaries(prev, next);
  const plus = events.filter((e) => e.kind === 'plan' && e.name === 'Plus');
  assert.equal(plus.length, 2); // plus#0 與 plus#1 都變了
  assert.equal(plus[0].old, 999.99);
  assert.equal(plus[0].new, 1299.99);
  assert.ok(Math.abs(plus[0].pct - 0.3) < 0.01);
  // 沒變的不報
  assert.ok(!events.some((e) => e.name === 'Go'));
  assert.ok(!events.some((e) => e.kind === 'app'));
});

test('diffSummaries：App 售價變動與新方案', () => {
  const prev = summarizeSnapshot(snap(999.99));
  const next = summarizeSnapshot(snap(999.99));
  next.tw.app = 260;
  next.tr.plans['pro#0'] = { name: 'Pro', price: 5000, currency: 'TRY' };
  const events = diffSummaries(prev, next);
  assert.ok(events.some((e) => e.kind === 'app' && e.old === 235 && e.new === 260));
  assert.ok(events.some((e) => e.kind === 'new-plan' && e.name === 'Pro'));
});

test('appendHistory：只在變動時追加', () => {
  const hist = { entries: [] };
  const s1 = summarizeSnapshot(snap(999.99));
  assert.equal(appendHistory(hist, '2026-08-28', s1), true);
  assert.equal(appendHistory(hist, '2026-08-29', summarizeSnapshot(snap(999.99))), false);
  assert.equal(hist.entries.length, 1);
  assert.equal(appendHistory(hist, '2026-08-30', summarizeSnapshot(snap(1299.99))), true);
  assert.equal(hist.entries.length, 2);
  assert.equal(hist.entries[1].c.tr.plans['plus#0'], 1299.99);
  // 空摘要不追加
  assert.equal(appendHistory(hist, '2026-08-31', {}), false);
});

test('filterAlertable：清單洗牌不通知、真調價要通知', () => {
  const events = [
    // us：單純調價 → 通知
    { appId: '1', cc: 'us', kind: 'plan', name: 'Plus', old: 19.99, new: 24.99 },
    // tr：同時有新方案出現 → 該國調價視為清單洗牌，不通知
    { appId: '1', cc: 'tr', kind: 'plan', name: 'Movies', old: 3.99, new: 2.99 },
    { appId: '1', cc: 'tr', kind: 'new-plan', name: 'Movies', old: null, new: 3.99 },
    // 另一 app 的 tr 不受影響
    { appId: '2', cc: 'tr', kind: 'app', name: 'App 售價', old: 100, new: 120 },
  ];
  const alertable = filterAlertable(events);
  assert.equal(alertable.length, 2);
  assert.ok(alertable.some((e) => e.appId === '1' && e.cc === 'us'));
  assert.ok(alertable.some((e) => e.appId === '2' && e.kind === 'app'));
});

test('planNames', () => {
  const names = planNames(summarizeSnapshot(snap(999.99)));
  assert.equal(names['plus#0'], 'Plus');
  assert.equal(names['go#0'], 'Go');
});
