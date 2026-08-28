// 比較邏輯：把各儲存區的 IAP 清單配對成「方案群組」，換算並排序。

import { planKey } from './parser.js';
import { convert } from './fx.js';

/**
 * 把一份 IAP 清單依正規化名稱分組，同名者依價格升冪給序號：
 * "chatgpt plus#0"（便宜，通常是月繳）、"chatgpt plus#1"（貴，通常是年繳）…
 * 這樣同名的月/年方案能跨區正確對齊。
 */
function keyedList(inApps) {
  const byName = new Map();
  for (const iap of inApps) {
    const k = planKey(iap.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(iap);
  }
  const out = [];
  for (const [k, arr] of byName) {
    const sorted = [...arr].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    sorted.forEach((iap, i) => out.push({ key: `${k}#${i}`, dupIndex: i, iap }));
  }
  return out;
}

/**
 * 將各國 IAP 配對成方案群組。
 * 配對策略：正規化名稱精確配對（同名的月/年方案依價格排序對齊）；
 * 名稱不同（在地化）時，若兩區清單長度相同，依價格排序位置對齊；
 * 仍無法配對者列為該區獨有。
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
  const baseKeyed = keyedList(base);
  const groups = baseKeyed.map(({ key, dupIndex, iap }) => ({
    key,
    name: dupIndex > 0 ? `${iap.name}（方案 ${dupIndex + 1}）` : iap.name,
    period: iap.period || null,
    entries: { [baseline]: iap },
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));

  for (const cc of withData) {
    if (cc === baseline) continue;
    const list = countriesData[cc].inApps;
    const unmatched = [];
    for (const { key, iap } of keyedList(list)) {
      const g = byKey.get(key);
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

/**
 * 付費 App 的「買斷售價」比較群組：只要有任一儲存區售價 > 0 就建立，
 * 其他儲存區的 0 元（該區免費）也一併列出。全免費 App 回傳 null。
 */
export function buildAppPriceGroup(countriesData, countryOrder) {
  const anyPaid = countryOrder.some((cc) => (countriesData[cc]?.appPrice?.price ?? 0) > 0);
  if (!anyPaid) return null;
  const entries = {};
  for (const cc of countryOrder) {
    const ap = countriesData[cc]?.appPrice;
    if (!ap || ap.price == null) continue;
    entries[cc] = {
      name: 'App 售價',
      price: ap.price,
      currency: ap.currency || countriesData[cc].currency || null,
      priceFormatted: ap.priceFormatted || String(ap.price),
      period: 'lifetime',
    };
  }
  return { key: '__appprice', name: 'App 售價', period: 'lifetime', entries };
}

/** 依名稱把官網方案配對到 App Store 方案群組（match 為小寫關鍵字） */
export function matchOfficialToGroup(officialPlans, group) {
  // 同名的第 2+ 種方案（通常是年繳版）計費週期不明，
  // 不與官網月繳價比較，避免產生錯誤的「官網更便宜」結論
  if (/（方案 \d+）$/.test(group?.name || '')) return [];
  const key = planKey(group?.name);
  return (officialPlans || []).filter((p) => {
    const kw = String(p.match || '').toLowerCase();
    return kw && key.includes(kw);
  });
}
