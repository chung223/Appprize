// 匯率模組：以 USD 為基準抓一次全幣別匯率，衍生任意兩幣別交叉匯率。
// 來源（依序備援）：
//   1. fawazahmed0/exchange-api（jsDelivr CDN，免金鑰、每日更新、CORS 開放）
//   2. 同資料的 Cloudflare Pages 鏡像
//   3. open.er-api.com（免金鑰）
//   4. repo 內由爬蟲提交的快照 docs/data/fx.json
// 瀏覽器端以 localStorage 快取 12 小時；過期但 7 天內仍可用（標示「匯率較舊」）。

const CACHE_KEY = 'appprize.fx.v1';
const FRESH_MS = 12 * 60 * 60 * 1000;
const USABLE_MS = 7 * 24 * 60 * 60 * 1000;

const SOURCES = [
  {
    name: 'jsdelivr',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse: (j) => ({ date: j.date, rates: upcaseKeys(j.usd) }),
  },
  {
    name: 'pages.dev',
    url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    parse: (j) => ({ date: j.date, rates: upcaseKeys(j.usd) }),
  },
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (j) => ({ date: j.time_last_update_utc || null, rates: j.rates }),
  },
];

function upcaseKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (typeof v === 'number' && v > 0) out[k.toUpperCase()] = v;
  }
  return out;
}

function storageGet() {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storageSet(data) {
  try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* 忽略 */ }
}

async function fetchWithTimeout(url, ms = 12000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  try {
    const res = await fetch(url, { signal: ctrl?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 取得匯率表（USD 基準）。
 * @param {{ snapshotUrl?: string, force?: boolean }} [opts]
 *   snapshotUrl：repo 內 fx.json 快照的網址（最後備援）
 * @returns {Promise<{rates: Record<string, number>, date: string|null, source: string, fetchedAt: number, stale: boolean}>}
 */
export async function getRates(opts = {}) {
  const now = Date.now();
  const cached = storageGet();
  if (!opts.force && cached && now - cached.fetchedAt < FRESH_MS) {
    return { ...cached, stale: false };
  }
  for (const src of SOURCES) {
    try {
      const j = await fetchWithTimeout(src.url);
      const { date, rates } = src.parse(j);
      if (!rates || !rates.TWD || !rates.TRY) throw new Error('rates incomplete');
      const data = { rates, date: date || null, source: src.name, fetchedAt: now };
      storageSet(data);
      return { ...data, stale: false };
    } catch { /* 換下一個來源 */ }
  }
  // repo 快照備援
  if (opts.snapshotUrl) {
    try {
      const j = await fetchWithTimeout(opts.snapshotUrl);
      if (j && j.rates && j.rates.TWD) {
        return {
          rates: j.rates, date: j.date || null, source: 'snapshot',
          fetchedAt: now, stale: true,
        };
      }
    } catch { /* 繼續 */ }
  }
  // 過期快取備援
  if (cached && now - cached.fetchedAt < USABLE_MS) {
    return { ...cached, stale: true };
  }
  throw new Error('無法取得匯率資料（所有來源皆失敗）');
}

/** 交叉匯率：1 單位 from 幣別 = 多少 to 幣別 */
export function crossRate(rates, from, to) {
  const f = rates[String(from || '').toUpperCase()];
  const t = rates[String(to || '').toUpperCase()];
  if (!f || !t) return null;
  return t / f;
}

/** 將金額由 from 幣別換算為 to 幣別；無匯率時回傳 null */
export function convert(rates, amount, from, to) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const r = crossRate(rates, from, to);
  return r == null ? null : amount * r;
}

/** 格式化金額（依幣別決定小數位） */
export function formatMoney(amount, currency, { approx = false } = {}) {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const cur = String(currency || '').toUpperCase();
  const zeroDec = amount >= 1000 || ['TWD', 'JPY', 'KRW', 'VND', 'IDR', 'CLP'].includes(cur);
  let str;
  try {
    str = new Intl.NumberFormat('zh-TW', {
      style: 'currency', currency: cur,
      minimumFractionDigits: 0,
      maximumFractionDigits: zeroDec ? 0 : 2,
    }).format(amount);
  } catch {
    str = `${cur} ${zeroDec ? Math.round(amount).toLocaleString() : amount.toFixed(2)}`;
  }
  return approx ? `≈ ${str}` : str;
}
