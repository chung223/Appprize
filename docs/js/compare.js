// 比較邏輯：把各儲存區的 IAP 清單配對成「方案群組」，換算並排序。

import { planKey } from './parser.js';
import { convert } from './fx.js';

/**
 * 將各國 IAP 配對成方案群組。
 * 配對策略：先用正規化名稱精確配對；名稱不同（在地化）時，若兩區清單長度相同，
 * 依「價格排序後的位置」對齊；仍無法配對者列為該區獨有。
 *
 * @param {Record<string, {inApps?: Array, unavailable?: boolean}>} countriesData
 * @param {string[]} countryOrder 想要的國家順序（第一個有資料者為基準區）
 * @returns {{groups: Array<{key, name, period, entries: Record<string, object>}>, baseline: string|null}}
 */
export function buildPlanGroups(countriesData, countryOrder) {
  const withData = countryOrder.filter((cc) => countriesData[cc]?.inApps?.length);
  if (!withData.length) return { groups: [], baseline: null };
  const baseline = withData.includes('tw') ? 'tw' : withData[0];

  const base = countriesData[baseline].inApps;
  const groups = base.map((iap) => ({
    key: planKey(iap.name),
    name: iap.name,
    period: iap.period || null,
    entries: { [baseline]: iap },
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));

  for (const cc of withData) {
    if (cc === baseline) continue;
    const list = countriesData[cc].inApps;
    const unmatched = [];
    for (const iap of list) {
      const g = byKey.get(planKey(iap.name));
      if (g && !g.entries[cc]) g.entries[cc] = iap;
      else unmatched.push(iap);
    }
    // 名稱在地化：清單長度一致時依價格排序位置對齊
    if (unmatched.length && list.length === base.length) {
      const openGroups = groups.filter((g) => !g.entries[cc]);
      if (openGroups.length === unmatched.length) {
        const sortedGroups = [...openGroups].sort(
          (a, b) => (a.entries[baseline]?.price ?? 0) - (b.entries[baseline]?.price ?? 0),
        );
        const sortedUnmatched = [...unmatched].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        sortedGroups.forEach((g, i) => { g.entries[cc] = sortedUnmatched[i]; });
        unmatched.length = 0;
      }
    }
    // 還是配不上的：自成一組（顯示為該區獨有方案）
    for (const iap of unmatched) {
      const key = `${planKey(iap.name)}@@${cc}`;
      if (!byKey.has(key)) {
        const g = { key, name: iap.name, period: iap.period || null, entries: { [cc]: iap } };
        groups.push(g);
        byKey.set(key, g);
      }
    }
  }
  return { groups, baseline };
}

/**
 * 對單一方案群組做跨區換算與排名。
 * @param {{entries: Record<string, object>}} group
 * @param {Record<string, number>} rates USD 基準匯率表
 * @param {string} target 目標幣別
 * @param {number} feePercent 額外手續費（%）；0 表示不加
 * @returns {Array<{country, iap, local, converted, delta}>} converted 低到高排序
 */
export function rankPlan(group, rates, target, feePercent = 0) {
  const rows = [];
  for (const [cc, iap] of Object.entries(group.entries)) {
    if (!iap || iap.price == null || !iap.currency) {
      rows.push({ country: cc, iap, converted: null });
      continue;
    }
    const raw = convert(rates, iap.price, iap.currency, target);
    const converted = raw == null ? null : raw * (1 + feePercent / 100);
    rows.push({ country: cc, iap, converted });
  }
  rows.sort((a, b) => {
    if (a.converted == null) return 1;
    if (b.converted == null) return -1;
    return a.converted - b.converted;
  });
  const best = rows.find((r) => r.converted != null);
  for (const r of rows) {
    r.delta = best && r.converted != null && best.converted > 0
      ? (r.converted - best.converted) / best.converted
      : null;
  }
  return rows;
}

/**
 * 官網價換算（官網價不加外幣手續費開關 — 海外官網刷卡其實也有，但讓使用者自行判斷；
 * 這裡與 App Store 同樣套用手續費設定，公平比較）。
 */
export function convertOfficialPlan(plan, rates, target, feePercent = 0) {
  const raw = convert(rates, plan.price, plan.currency, target);
  if (raw == null) return null;
  return raw * (1 + feePercent / 100);
}

/** 依名稱把官網方案配對到 App Store 方案群組（match 為小寫關鍵字） */
export function matchOfficialToGroup(officialPlans, group) {
  const key = planKey(group.name);
  return (officialPlans || []).filter((p) => {
    const kw = String(p.match || '').toLowerCase();
    return kw && key.includes(kw);
  });
}
