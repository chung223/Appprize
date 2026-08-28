import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanGroups, rankPlan, matchOfficialToGroup } from '../docs/js/compare.js';

const RATES = { USD: 1, TWD: 32, TRY: 41, INR: 88 };

const iap = (name, price, currency, priceFormatted) => ({
  name, price, currency, priceFormatted: priceFormatted || String(price), period: null,
});

test('buildPlanGroups：同名方案跨區配對', () => {
  const data = {
    tw: { inApps: [iap('ChatGPT Plus', 650, 'TWD'), iap('ChatGPT Pro', 6590, 'TWD')] },
    tr: { inApps: [iap('ChatGPT Plus', 999.99, 'TRY'), iap('ChatGPT Pro', 9999.99, 'TRY')] },
    in: { inApps: [iap('ChatGPT Plus', 1950, 'INR')] },
  };
  const { groups, baseline } = buildPlanGroups(data, ['tw', 'tr', 'in']);
  assert.equal(baseline, 'tw');
  assert.equal(groups.length, 2);
  const plus = groups.find((g) => g.name === 'ChatGPT Plus');
  assert.deepEqual(Object.keys(plus.entries).sort(), ['in', 'tr', 'tw']);
  const pro = groups.find((g) => g.name === 'ChatGPT Pro');
  assert.deepEqual(Object.keys(pro.entries).sort(), ['tr', 'tw']);
});

test('buildPlanGroups：名稱在地化時依價格順位對齊', () => {
  const data = {
    tw: { inApps: [iap('高級方案', 100, 'TWD'), iap('進階方案', 300, 'TWD')] },
    jp: { inApps: [iap('プレミアム', 500, 'JPY'), iap('アドバンス', 1500, 'JPY')] },
  };
  const { groups } = buildPlanGroups(data, ['tw', 'jp']);
  assert.equal(groups.length, 2);
  const cheap = groups.find((g) => g.name === '高級方案');
  assert.equal(cheap.entries.jp.name, 'プレミアム'); // 便宜對便宜
});

test('buildPlanGroups：基準區沒有 tw 時用第一個有資料的', () => {
  const data = { tr: { inApps: [iap('Plus', 10, 'TRY')] } };
  const { baseline } = buildPlanGroups(data, ['tw', 'tr']);
  assert.equal(baseline, 'tr');
});

test('buildPlanGroups：完全沒資料', () => {
  const { groups, baseline } = buildPlanGroups({}, ['tw']);
  assert.equal(groups.length, 0);
  assert.equal(baseline, null);
});

test('rankPlan：換算排序與差額', () => {
  const group = {
    entries: {
      tw: iap('Plus', 650, 'TWD'),      // 650 TWD
      tr: iap('Plus', 999.99, 'TRY'),   // ≈ 780 → 999.99/41*32 = 780.48 TWD
      in: iap('Plus', 1950, 'INR'),     // 1950/88*32 = 709.09 TWD
      us: iap('Plus', 19.99, 'USD'),    // 639.68 TWD
    },
  };
  const rows = rankPlan(group, RATES, 'TWD', 0);
  assert.equal(rows[0].country, 'us'); // 最便宜
  assert.equal(rows[0].delta, 0);
  assert.equal(rows[3].country, 'tr'); // 最貴
  assert.ok(rows[3].delta > 0.2);
});

test('rankPlan：手續費影響', () => {
  const group = { entries: { us: iap('Plus', 100, 'USD') } };
  const [row] = rankPlan(group, RATES, 'TWD', 1.5);
  assert.ok(Math.abs(row.converted - 3200 * 1.015) < 1e-9);
});

test('rankPlan：缺匯率的排最後', () => {
  const group = {
    entries: {
      tw: iap('Plus', 650, 'TWD'),
      xx: iap('Plus', 10, 'XXX'),
    },
  };
  const rows = rankPlan(group, RATES, 'TWD', 0);
  assert.equal(rows[0].country, 'tw');
  assert.equal(rows[1].converted, null);
});

test('matchOfficialToGroup：關鍵字配對', () => {
  const plans = [
    { match: 'plus', name: 'ChatGPT Plus（官網）', price: 20, currency: 'USD' },
    { match: 'pro', name: 'ChatGPT Pro（官網）', price: 200, currency: 'USD' },
  ];
  const hit = matchOfficialToGroup(plans, { name: 'ChatGPT Plus' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].match, 'plus');
  assert.equal(matchOfficialToGroup(plans, { name: 'Team Plan' }).length, 0);
});
