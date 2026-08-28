// 價格歷史與變動偵測（純函式，供爬蟲與測試共用）
import { planPriceMap } from '../../docs/js/compare.js';

/**
 * 把一份 app 快照的 countries 摘要成可比對的結構：
 * { tw: { app: 235, plans: { 'chatgpt plus#0': {name, price, currency}, … } }, … }
 * stale（沿用舊資料）與抓取失敗的國家略過，避免誤報。
 */
export function summarizeSnapshot(countries) {
  const out = {};
  for (const [cc, c] of Object.entries(countries || {})) {
    if (!c || c.stale || c.error || c.unavailable) continue;
    out[cc] = {
      app: c.appPrice && c.appPrice.price > 0 ? c.appPrice.price : null,
      currency: c.currency || null,
      plans: planPriceMap(c.inApps),
    };
  }
  return out;
}

/**
 * 比對前後兩份摘要，回傳變動事件清單。
 * 只比對兩邊都有資料的國家與方案（新增/下架不算「調價」，另立 kind）。
 */
export function diffSummaries(prev, next) {
  const events = [];
  for (const [cc, nc] of Object.entries(next || {})) {
    const pc = prev?.[cc];
    if (!pc) continue; // 新增國家不算調價
    // App 買斷價
    if (pc.app != null && nc.app != null && pc.app !== nc.app) {
      events.push({
        cc, kind: 'app', name: 'App 售價',
        old: pc.app, new: nc.app, currency: nc.currency,
        pct: pc.app > 0 ? (nc.app - pc.app) / pc.app : null,
      });
    }
    // 各方案
    for (const [key, np] of Object.entries(nc.plans || {})) {
      const pp = pc.plans?.[key];
      if (!pp) {
        events.push({ cc, kind: 'new-plan', name: np.name, old: null, new: np.price, currency: np.currency, pct: null });
        continue;
      }
      if (pp.price !== np.price) {
        events.push({
          cc, kind: 'plan', name: np.name,
          old: pp.price, new: np.price, currency: np.currency || pp.currency,
          pct: pp.price > 0 ? (np.price - pp.price) / pp.price : null,
        });
      }
    }
    for (const [key, pp] of Object.entries(pc.plans || {})) {
      if (!nc.plans?.[key]) {
        events.push({ cc, kind: 'removed-plan', name: pp.name, old: pp.price, new: null, currency: pp.currency, pct: null });
      }
    }
  }
  return events;
}

/**
 * 把今日摘要附加到歷史（僅在與最後一筆不同時追加）。
 * @returns {boolean} 是否有追加
 */
export function appendHistory(hist, date, summary) {
  if (!hist.entries) hist.entries = [];
  if (!Object.keys(summary).length) return false;
  const last = hist.entries[hist.entries.length - 1];
  const compact = compactSummary(summary);
  if (last && JSON.stringify(last.c) === JSON.stringify(compact)) return false;
  hist.entries.push({ d: date, c: compact });
  if (hist.entries.length > 500) hist.entries = hist.entries.slice(-500);
  return true;
}

/** 歷史檔的精簡形（只留價格數字，名稱另存於 names 映射） */
function compactSummary(summary) {
  const out = {};
  for (const [cc, c] of Object.entries(summary)) {
    const plans = {};
    for (const [k, p] of Object.entries(c.plans || {})) plans[k] = p.price;
    out[cc] = { app: c.app, plans };
  }
  return out;
}

/**
 * 從事件中挑出「值得通知」的：Apple 的 IAP 資訊列是熱門排行、會輪替，
 * 同一 (app, 國家) 若同時出現方案新增/移除，代表清單洗牌，
 * 該國的價格變動很可能只是排序位移 — 降級為僅記錄，不發通知。
 */
export function filterAlertable(events) {
  const shuffled = new Set(
    events
      .filter((e) => e.kind === 'new-plan' || e.kind === 'removed-plan')
      .map((e) => `${e.appId}|${e.cc}`),
  );
  return events.filter(
    (e) => (e.kind === 'plan' || e.kind === 'app') && !shuffled.has(`${e.appId}|${e.cc}`),
  );
}

/** 從摘要收集 key→名稱 映射（歷史檔顯示用） */
export function planNames(summary) {
  const names = {};
  for (const c of Object.values(summary || {})) {
    for (const [k, p] of Object.entries(c.plans || {})) {
      if (!names[k]) names[k] = p.name;
    }
  }
  return names;
}
