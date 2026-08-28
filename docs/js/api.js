// 資料協調層：搜尋、價格取得（本地快取 → repo 快照 → CORS proxy 即時抓）
// 所有跨網域請求都可能被 CORS 擋下，因此統一走「直連優先、proxy 備援」的策略。

import { parseAppPage, looksLikeNotFound, extractAppId } from './parser.js';
import { storefrontCurrency } from './storefronts.js';
import { getCachedApp, setCachedApp, getSettings } from './db.js';

// 公用 CORS proxy（依序嘗試；使用者可在設定加入自訂 proxy 排最前）
const PUBLIC_PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

function proxyChain() {
  const { customProxy } = getSettings();
  const chain = [...PUBLIC_PROXIES];
  if (customProxy) {
    const p = customProxy.trim();
    chain.unshift((u) =>
      p.includes('{url}') ? p.replace('{url}', encodeURIComponent(u)) : p + encodeURIComponent(u),
    );
  }
  return chain;
}

async function fetchText(url, { timeout = 15000, viaProxy = false } = {}) {
  const attempts = viaProxy ? proxyChain().map((wrap) => wrap(url)) : [url];
  let lastErr = null;
  for (const target of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

/** 直連失敗就走 proxy 的 JSON 請求 */
async function fetchJsonSmart(url, { timeout = 15000 } = {}) {
  try {
    const { status, text } = await fetchText(url, { timeout });
    if (status >= 200 && status < 300) return JSON.parse(text);
    throw new Error(`HTTP ${status}`);
  } catch {
    const { status, text } = await fetchText(url, { timeout, viaProxy: true });
    if (status >= 200 && status < 300) return JSON.parse(text);
    throw new Error(`HTTP ${status}`);
  }
}

/**
 * 以名稱搜尋 App（iTunes Search API）。
 * @returns {Promise<Array<{appId, name, developer, icon, bundleId, genre}>>}
 */
export async function searchApps(term, { country = 'tw', limit = 8 } = {}) {
  const url =
    `https://itunes.apple.com/search?media=software&entity=software,iPadSoftware` +
    `&country=${encodeURIComponent(country)}&limit=${limit}&term=${encodeURIComponent(term)}`;
  let json;
  try {
    json = await fetchJsonSmart(url);
  } catch {
    // 該區搜不到就退回美區
    json = await fetchJsonSmart(url.replace(`country=${country}`, 'country=us'));
  }
  const seen = new Set();
  return (json.results || [])
    .filter((r) => r.trackId && !seen.has(r.trackId) && seen.add(r.trackId))
    .map((r) => ({
      appId: String(r.trackId),
      name: r.trackName,
      developer: r.artistName,
      icon: r.artworkUrl100 || r.artworkUrl60,
      bundleId: r.bundleId,
      genre: r.primaryGenreName,
    }));
}

/** 以 id 查 App 基本資料（名稱／圖示／開發者） */
export async function lookupApp(appId, { country = 'tw' } = {}) {
  const url = (cc) =>
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${cc}`;
  for (const cc of [country, 'us']) {
    try {
      const json = await fetchJsonSmart(url(cc));
      const r = (json.results || [])[0];
      if (r && r.trackId) {
        return {
          appId: String(r.trackId),
          name: r.trackName,
          developer: r.artistName,
          icon: r.artworkUrl100 || r.artworkUrl60,
          genre: r.primaryGenreName,
        };
      }
    } catch { /* 換下一個 */ }
  }
  return null;
}

/** 讀取 repo 內由 GitHub Actions 爬蟲提交的價格快照 */
export async function fetchSnapshot(appId) {
  try {
    const url = new URL(`./data/apps/${appId}.json`, document.baseURI).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 即時抓取單一儲存區的 App Store 頁面並解析 IAP 價格（走 proxy） */
export async function fetchCountryLive(appId, cc) {
  const currency = storefrontCurrency(cc);
  const url = `https://apps.apple.com/${cc}/app/id${appId}`;
  const { status, text } = await fetchText(url, { viaProxy: true, timeout: 20000 });
  if (looksLikeNotFound(text, status)) {
    return { country: cc, currency, unavailable: true, inApps: [], error: null };
  }
  const parsed = parseAppPage(text, { country: cc, currency });
  return {
    country: cc,
    currency,
    unavailable: false,
    inApps: parsed.inApps,
    meta: { name: parsed.name, icon: parsed.icon, developer: parsed.developer },
    source: parsed.source,
    error: parsed.inApps.length ? null : 'no-iap-found',
  };
}

/** 限制並發的即時抓取多個儲存區 */
export async function fetchCountriesLive(appId, countries, { concurrency = 3, onProgress } = {}) {
  const queue = [...countries];
  const results = {};
  let done = 0;
  async function worker() {
    while (queue.length) {
      const cc = queue.shift();
      try {
        results[cc] = await fetchCountryLive(appId, cc);
      } catch (e) {
        results[cc] = {
          country: cc, currency: storefrontCurrency(cc),
          unavailable: false, inApps: [], error: String(e?.message || e),
        };
      }
      done++;
      onProgress?.(done, countries.length, cc);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, countries.length) }, worker));
  return results;
}

/**
 * 主要入口：取得 App 的跨區價格。
 * 順序：本地快取（新鮮）→ repo 快照（新鮮）→ 即時抓取 → 過期的本地/快照資料。
 * @returns {Promise<{appId, countries: Record<string, object>, fetchedAt, source, partial, missing: string[]}>}
 */
export async function getAppPrices(appId, countries, { force = false, onProgress } = {}) {
  const settings = getSettings();
  const ttlMs = Math.max(1, settings.cacheTtlHours) * 60 * 60 * 1000;
  const now = Date.now();

  const cached = getCachedApp(appId);
  const cachedFresh = cached && now - cached.fetchedAt < ttlMs;
  const cachedCovers =
    cached && countries.every((cc) => cached.data?.countries?.[cc]);

  if (!force && cachedFresh && cachedCovers) {
    return { ...cached.data, fetchedAt: cached.fetchedAt, source: 'local-cache', partial: false, missing: [] };
  }

  // repo 快照
  let snapshot = null;
  if (!force) {
    snapshot = await fetchSnapshot(appId);
    if (snapshot?.fetchedAt) {
      const snapAge = now - Date.parse(snapshot.fetchedAt);
      const snapCovers = countries.every((cc) => snapshot.countries?.[cc]);
      if (snapAge < ttlMs && snapCovers) {
        const data = { appId, name: snapshot.name, countries: snapshot.countries };
        setCachedApp(appId, data);
        return { ...data, fetchedAt: Date.parse(snapshot.fetchedAt), source: 'snapshot', partial: false, missing: [] };
      }
    }
  }

  // 即時抓取（可能部分失敗）
  let live = {};
  try {
    live = await fetchCountriesLive(appId, countries, { onProgress });
  } catch { /* 整體失敗時 live 為空物件 */ }

  const merged = {};
  const missing = [];
  for (const cc of countries) {
    const liveOk = live[cc] && !live[cc].error;
    if (liveOk) {
      merged[cc] = live[cc];
    } else if (snapshot?.countries?.[cc]) {
      merged[cc] = { ...snapshot.countries[cc], staleSource: 'snapshot' };
    } else if (cached?.data?.countries?.[cc]) {
      merged[cc] = { ...cached.data.countries[cc], staleSource: 'local-cache' };
    } else if (live[cc]) {
      merged[cc] = live[cc]; // 帶著 error 的結果
      missing.push(cc);
    } else {
      missing.push(cc);
    }
  }

  const anyData = Object.values(merged).some((c) => c.inApps?.length || c.unavailable);
  if (!anyData && cached) {
    // 全部失敗：退回過期快取
    return { ...cached.data, fetchedAt: cached.fetchedAt, source: 'stale-cache', partial: true, missing };
  }

  const liveMeta = Object.values(live).find((c) => c?.meta?.name)?.meta || null;
  const data = {
    appId,
    name: liveMeta?.name || snapshot?.name || cached?.data?.name || null,
    countries: merged,
  };
  if (anyData) setCachedApp(appId, data);
  return {
    ...data,
    fetchedAt: now,
    source: 'live',
    partial: missing.length > 0,
    missing,
  };
}

export { extractAppId };
