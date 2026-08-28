// 本地快取（localStorage，LRU 上限 60 個 app）＋搜尋歷史＋使用者設定

const PRICE_PREFIX = 'appprize.app.';
const HISTORY_KEY = 'appprize.history.v1';
const SETTINGS_KEY = 'appprize.settings.v1';
const MAX_CACHED_APPS = 60;

function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 讀取 app 價格快取；回傳 {data, fetchedAt} 或 null */
export function getCachedApp(appId) {
  return lsGet(PRICE_PREFIX + appId);
}

/** 寫入 app 價格快取（滿了就淘汰最舊的） */
export function setCachedApp(appId, data) {
  const entry = { data, fetchedAt: Date.now() };
  if (!lsSet(PRICE_PREFIX + appId, entry)) {
    evictOldest(10);
    lsSet(PRICE_PREFIX + appId, entry);
  }
  trimCache();
}

function listCacheKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PRICE_PREFIX)) keys.push(k);
    }
  } catch { /* 忽略 */ }
  return keys;
}

function trimCache() {
  const keys = listCacheKeys();
  if (keys.length <= MAX_CACHED_APPS) return;
  evictOldest(keys.length - MAX_CACHED_APPS);
}

function evictOldest(n) {
  const entries = listCacheKeys()
    .map((k) => ({ k, t: lsGet(k)?.fetchedAt || 0 }))
    .sort((a, b) => a.t - b.t);
  for (const e of entries.slice(0, n)) {
    try { localStorage.removeItem(e.k); } catch { /* 忽略 */ }
  }
}

export function clearPriceCache() {
  for (const k of listCacheKeys()) {
    try { localStorage.removeItem(k); } catch { /* 忽略 */ }
  }
}

/** 搜尋歷史：[{appId, name, icon, at}]，最新在前，上限 24 筆 */
export function getHistory() {
  return lsGet(HISTORY_KEY) || [];
}

export function pushHistory(item) {
  const list = getHistory().filter((h) => h.appId !== item.appId);
  list.unshift({ ...item, at: Date.now() });
  lsSet(HISTORY_KEY, list.slice(0, 24));
}

export function removeHistory(appId) {
  lsSet(HISTORY_KEY, getHistory().filter((h) => h.appId !== appId));
}

/** 我的訂閱：[{appId, planKey, planName, appName, icon, useCountry, addedAt}] */
const SUBS_KEY = 'appprize.mysubs.v1';

export function getMySubs() {
  return lsGet(SUBS_KEY) || [];
}

export function saveMySubs(list) {
  lsSet(SUBS_KEY, list.slice(0, 50));
}

/** 使用者設定 */
const DEFAULT_SETTINGS = {
  targetCurrency: 'TWD',
  countries: null,        // null = 使用預設清單
  feePercent: 1.5,        // 外幣交易手續費（%），可關閉
  feeEnabled: false,
  cacheTtlHours: 24,      // 本地快取視為新鮮的時數
  customProxy: '',        // 自訂 CORS proxy 前綴
  githubPat: '',          // 觸發 GitHub Actions 重抓用（選填，只存在本機）
  theme: 'dark',          // 預設深色（Liquid Glass 招牌視覺）；可切換
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(lsGet(SETTINGS_KEY) || {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  lsSet(SETTINGS_KEY, next);
  return next;
}
