// App Store 頁面解析器 — 同時供瀏覽器與 Node.js（GitHub Actions 爬蟲）使用。
// 不依賴 DOM，純字串/JSON 處理。
//
// apps.apple.com 的頁面世代：
//   1. shoebox：<script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">
//      內容是 { "<amp-api URL>": "<JSON 字串>" }，需二次 JSON.parse。
//      應用內購買項目位於 relationships（top-in-apps / in-apps），形如
//      { attributes: { name, offerName, offers: [{ price, priceFormatted, currencyCode?, type }] } }
//   2. serialized-server-data：<script id="serialized-server-data" type="application/json">
//      Svelte 世代，結構不同但一樣內含 name/offers 節點。
//   3. 純 HTML 備援：「App 內購買」資訊列表
//      <li class="list-with-numbers__item">…名稱…<span class="…__item__price…">價格</span></li>
//
// 解析策略：把所有內嵌 JSON 深度展開，遞迴尋找「有 name + offers[].price/priceFormatted」
// 的節點；找不到再退回 HTML 正規表達式。

import { ZERO_DECIMAL_CURRENCIES } from './storefronts.js';

const MAX_JSON_DEPTH = 40;

/** 從任意 App Store 連結/文字取出數字 app id；失敗回傳 null */
export function extractAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/apps\.apple\.com\/[a-z]{2}(?:-[a-z]{2})?\/app\/(?:[^/]+\/)?id(\d{6,12})/i);
  if (m) return m[1];
  m = s.match(/itunes\.apple\.com\/[^\s]*\bid(\d{6,12})/i);
  if (m) return m[1];
  m = s.match(/^id(\d{6,12})$/i);
  if (m) return m[1];
  m = s.match(/^(\d{6,12})$/);
  if (m) return m[1];
  return null;
}

/** 從 App Store 連結取出國碼（tw/tr/in…）；失敗回傳 null */
export function extractCountry(input) {
  const m = String(input || '').match(/apps\.apple\.com\/([a-z]{2})(?:-[a-z]{2})?\//i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 解析價格字串為數字，處理各種地區格式：
 *   "₺1.299,99" → 1299.99   "₹8,900" → 8900     "NT$650" → 650
 *   "US$19.99" → 19.99      "Rp 149.000" → 149000  "¥3,000" → 3000
 * @param {string} str 價格字串
 * @param {string} [currency] 幣別（判斷是否為零小數幣別）
 */
export function parsePriceString(str, currency) {
  if (str == null) return null;
  const s = String(str);
  if (/free|免費|无料|gratis|ücretsiz/i.test(s)) return 0;
  // 抓出數字部分（含 , . 與各種空白）
  const m = s.replace(/[  \s]/g, '').match(/(\d[\d.,]*)/);
  if (!m) return null;
  let num = m[1];
  const zeroDecimal = currency && ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // 兩種符號都有：最後出現者為小數點
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    num = num.split(thouSep).join('').replace(decSep, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = num.split(sep);
    const tail = parts[parts.length - 1];
    // 零小數幣別一律視為千分位（唯 "…,00"/"….00" 結尾視為小數）；
    // 一般幣別：結尾 1–2 位數字且僅一個分隔符 → 小數
    if (zeroDecimal && parts.length === 2 && tail === '00') {
      num = parts[0];
    } else if (!zeroDecimal && parts.length === 2 && tail.length <= 2) {
      num = parts[0] + '.' + tail;
    } else if (parts.every((p, i) => (i === 0 ? p.length <= 3 : p.length === 3))) {
      num = parts.join(''); // 標準千分位
    } else if (!zeroDecimal && tail.length <= 2) {
      num = parts.slice(0, -1).join('') + '.' + tail;
    } else {
      num = parts.join('');
    }
  }
  const v = Number(num);
  return Number.isFinite(v) ? v : null;
}

/** 從 IAP 名稱猜訂閱週期（僅供顯示標籤，不影響比較） */
export function guessPeriod(name) {
  const s = String(name || '').toLowerCase();
  if (/(year|annual|yearly|12\s*mo|年)/i.test(s)) return 'yearly';
  if (/(week|weekly|週|周)/i.test(s)) return 'weekly';
  if (/(month|monthly|1\s*mo|月)/i.test(s)) return 'monthly';
  if (/(lifetime|forever|永久|終身|买断|買斷)/i.test(s)) return 'lifetime';
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 取出頁面上所有內嵌 JSON <script> 區塊並解析（shoebox / serialized-server-data / ld+json） */
function extractJsonBlobs(html) {
  const blobs = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
    const interesting =
      /shoebox/i.test(attrs) ||
      /serialized-server-data/i.test(attrs) ||
      /application\/(ld\+)?json/i.test(attrs) ||
      /fastboot/i.test(attrs);
    if (!interesting) continue;
    try {
      blobs.push(JSON.parse(body));
    } catch {
      /* 忽略無法解析的區塊 */
    }
  }
  return blobs;
}

/** 深度展開：字串值若本身是 JSON（shoebox 為二次序列化）也解析開來 */
function deepParse(node, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return node;
  if (typeof node === 'string') {
    const t = node.trim();
    if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
      try { return deepParse(JSON.parse(t), depth + 1); } catch { return node; }
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => deepParse(v, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = deepParse(node[k], depth + 1);
    return out;
  }
  return node;
}

/**
 * 遞迴收集「像 IAP 的節點」：有字串 name、有 offers 陣列且 offer 帶價格。
 * container 參數用來判斷此節點是否屬於 app 本身（type === 'apps' 的 attributes）。
 */
function collectOfferNodes(root) {
  const found = [];
  const seen = new Set();
  const visit = (node, container) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) visit(v, container);
      return;
    }
    const offers = node.offers;
    if (typeof node.name === 'string' && Array.isArray(offers) && offers.length) {
      const priced = offers.filter(
        (o) => o && (typeof o.price === 'number' || typeof o.priceFormatted === 'string'),
      );
      if (priced.length) {
        found.push({
          name: node.name,
          offerName: typeof node.offerName === 'string' ? node.offerName : null,
          offers: priced,
          containerType: container && typeof container.type === 'string' ? container.type : null,
          isAppNode: !!(node.platformAttributes || (container && container.type === 'apps')),
        });
      }
    }
    for (const k of Object.keys(node)) {
      const child = node[k];
      // attributes 的 container 是帶 type 的外層物件
      visit(child, k === 'attributes' ? node : child && typeof child === 'object' ? node : container);
    }
  };
  visit(root, null);
  return found;
}

/** HTML 備援：解析「App 內購買」資訊列表 */
function parseInAppsFromHtml(html) {
  const items = [];
  const liRe = /<li[^>]*class="[^"]*list-with-numbers__item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const inner = m[1];
    const priceM = inner.match(
      /<span[^>]*class="[^"]*(?:item__price|list-with-numbers__item__price)[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
    if (!priceM) continue;
    const priceText = stripTags(priceM[1]);
    const nameText = stripTags(inner.replace(priceM[0], ''));
    if (!nameText || !priceText) continue;
    items.push({ name: nameText, priceFormatted: priceText });
  }
  return items;
}

function extractMeta(html) {
  const meta = {};
  const og = (prop) => {
    const r = new RegExp(
      `<meta[^>]+(?:property|name)="og:${prop}"[^>]+content="([^"]*)"|<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="og:${prop}"`,
      'i',
    );
    const mm = html.match(r);
    return mm ? decodeEntities(mm[1] || mm[2] || '') : null;
  };
  meta.icon = og('image');
  const title = og('title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  // 標題格式通常是 "ChatGPT on the App Store" / "在 App Store 上的「ChatGPT」"
  meta.name =
    stripTags(title)
      .replace(/\s+(?:on|im|dans|en|su|no|na)\s+(?:the\s+)?App\s*Store.*$/i, '')
      .replace(/^在\s*App\s*Store\s*上的「?/, '')
      .replace(/」?$/, '')
      .trim() || null;
  const canon = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  if (canon) {
    meta.appId = extractAppId(canon[1]);
    meta.country = extractCountry(canon[1]);
  }
  // app-header 裡的開發者連結
  const dev = html.match(
    /class="[^"]*app-header__identity[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
  ) || html.match(/<h2[^>]*class="[^"]*app-header__identity[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  meta.developer = dev ? stripTags(dev[1]) : null;
  return meta;
}

/**
 * 主要入口：解析一個 App Store 頁面 HTML。
 * @param {string} html
 * @param {{country?: string, currency?: string}} [opts] country 供幣別備援推斷
 * @returns {{ appId, name, developer, icon, country, inApps: Array<{name, price, priceFormatted, currency, period}>, source }}
 */
export function parseAppPage(html, opts = {}) {
  const meta = extractMeta(html || '');
  const fallbackCurrency = opts.currency || null;
  const country = opts.country || meta.country || null;

  let inApps = [];
  let source = null;

  const blobs = extractJsonBlobs(html || '');
  const offerNodes = [];
  for (const blob of blobs) offerNodes.push(...collectOfferNodes(deepParse(blob)));

  if (offerNodes.length) {
    const dedup = new Map();
    for (const n of offerNodes) {
      if (n.isAppNode) continue; // app 本身（GET / 價格 0）不是 IAP
      for (const o of n.offers) {
        if (o.type === 'get') continue;
        const price = typeof o.price === 'number' ? o.price : null;
        const priceFormatted = typeof o.priceFormatted === 'string' ? o.priceFormatted : null;
        if (price == null && !priceFormatted) continue;
        const currency =
          (typeof o.currencyCode === 'string' && o.currencyCode) ||
          (typeof o.currency === 'string' && o.currency) ||
          fallbackCurrency;
        const resolved = price != null ? price : parsePriceString(priceFormatted, currency);
        if (resolved == null || resolved <= 0) continue;
        const key = `${n.name}::${resolved}`;
        if (!dedup.has(key)) {
          dedup.set(key, {
            name: n.name,
            offerName: n.offerName,
            price: resolved,
            priceFormatted: priceFormatted || String(resolved),
            currency: currency || null,
            period: guessPeriod(n.name) || guessPeriod(n.offerName),
          });
        }
      }
    }
    inApps = [...dedup.values()];
    if (inApps.length) source = 'embedded-json';
  }

  if (!inApps.length) {
    const htmlItems = parseInAppsFromHtml(html || '');
    inApps = htmlItems
      .map((it) => ({
        name: it.name,
        offerName: null,
        price: parsePriceString(it.priceFormatted, fallbackCurrency),
        priceFormatted: it.priceFormatted,
        currency: fallbackCurrency,
        period: guessPeriod(it.name),
      }))
      .filter((it) => it.price != null && it.price > 0);
    if (inApps.length) source = 'html-list';
  }

  return {
    appId: meta.appId || null,
    name: meta.name,
    developer: meta.developer,
    icon: meta.icon,
    country,
    inApps,
    source,
  };
}

/** 檢查頁面是否為「App 不存在／該區未上架」（404 頁） */
export function looksLikeNotFound(html, status) {
  if (status === 404) return true;
  if (!html) return true;
  return /we're sorry[\s\S]{0,200}?cannot be found|找不到你要的|page-error|error-page-title/i.test(html)
    && !/app-header|shoebox|serialized-server-data/i.test(html);
}

/** 跨儲存區方案配對用的正規化鍵 */
export function planKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s 　]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}
