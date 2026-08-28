#!/usr/bin/env node
// App Store 價格爬蟲（GitHub Actions 或本機執行；零依賴，Node 20+）
//
// 用法：
//   node scripts/crawl.mjs                          # 依 registry 抓全部
//   node scripts/crawl.mjs --apps 6448311069        # 只抓指定 app（並加入 registry）
//   node scripts/crawl.mjs --countries tw,tr,in     # 覆寫國家清單
//   node scripts/crawl.mjs --dry-run                # 不寫檔
//   node scripts/crawl.mjs --debug-dir /tmp/pages   # 保存原始 HTML 供除錯
//
// 輸出：docs/data/apps/{id}.json、docs/data/index.json、docs/data/fx.json、docs/data/registry.json

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppPage, looksLikeNotFound } from '../docs/js/parser.js';
import { storefrontCurrency, STOREFRONTS, flagEmoji } from '../docs/js/storefronts.js';
import {
  summarizeSnapshot, diffSummaries, appendHistory, planNames,
} from './lib/pricehistory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'data');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

/* ---------- CLI 參數 ---------- */
const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}
const argApps = (argVal('apps') || '').split(',').map((s) => s.trim()).filter(Boolean);
const argCountries = (argVal('countries') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const DRY = argv.includes('--dry-run');
const DEBUG_DIR = argVal('debug-dir');
const SKIP_FX = argv.includes('--no-fx');

for (const id of argApps) {
  if (!/^\d{6,12}$/.test(id)) {
    console.error(`✗ 無效的 app id：${JSON.stringify(id)}`);
    process.exit(2);
  }
}
for (const cc of argCountries) {
  if (!STOREFRONTS[cc]) {
    console.error(`✗ 不支援的儲存區：${JSON.stringify(cc)}`);
    process.exit(2);
  }
}

/* ---------- 小工具 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  if (DRY) {
    console.log(`  (dry-run) 略過寫入 ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

async function fetchWithRetry(url, { tries = 3, timeout = 25000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------- Registry ---------- */
const registryPath = join(DATA, 'registry.json');
// registry 損壞時必須中止，不能默默當成空清單覆寫掉所有追蹤的 app
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (e) {
  if (e?.code === 'ENOENT') {
    registry = { countries: ['tw', 'tr', 'in', 'us', 'jp'], apps: [] };
  } else {
    console.error(`✗ registry.json 無法解析：${e.message}`);
    process.exit(2);
  }
}

const countries = argCountries.length ? argCountries : registry.countries;
let appIds = argApps.length ? argApps : registry.apps.map((a) => a.id);

if (!appIds.length) {
  console.log('registry 內沒有 app，也未以 --apps 指定，結束。');
  process.exit(0);
}
appIds = [...new Set(appIds)];

/* ---------- 抓單一 app ---------- */
async function crawlApp(appId) {
  console.log(`▶ App ${appId}`);
  const result = {
    appId,
    name: null,
    developer: null,
    icon: null,
    fetchedAt: new Date().toISOString(),
    countries: {},
  };
  for (const cc of countries) {
    const currency = storefrontCurrency(cc);
    const url = `https://apps.apple.com/${cc}/app/id${appId}`;
    try {
      let parsed = null;
      let notFound = false;
      // Apple 偶發回傳 isIncomplete 的部分頁面（缺 information shelf）→ 重試
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { status, text } = await fetchWithRetry(url);
        if (DEBUG_DIR) {
          mkdirSync(DEBUG_DIR, { recursive: true });
          writeFileSync(join(DEBUG_DIR, `${appId}-${cc}-${attempt}.html`), text);
        }
        if (looksLikeNotFound(text, status)) {
          notFound = true;
          break;
        }
        parsed = parseAppPage(text, { country: cc, currency });
        if (!parsed.incomplete) break;
        console.log(`  ${cc}: 頁面不完整，重試（${attempt}/3）`);
        await sleep(1200 * attempt);
      }
      if (notFound) {
        result.countries[cc] = { country: cc, currency, unavailable: true, inApps: [], error: null };
        console.log(`  ${cc}: 未上架`);
      } else {
        result.countries[cc] = {
          country: cc,
          currency,
          unavailable: false,
          inApps: parsed.inApps,
          appPrice: parsed.appPrice || undefined,
          source: parsed.source,
          noIap: parsed.definitiveNoIap || undefined,
          error: parsed.inApps.length || parsed.definitiveNoIap ? null : 'incomplete-page',
        };
        if (!result.name && parsed.name) result.name = parsed.name;
        if (!result.developer && parsed.developer) result.developer = parsed.developer;
        if (!result.icon && parsed.icon) result.icon = parsed.icon;
        console.log(
          `  ${cc}: ${parsed.inApps.length} 個 IAP（${parsed.source || (parsed.definitiveNoIap ? '確定無 IAP' : '頁面不完整')}）` +
          (parsed.inApps[0] ? ` 例：${parsed.inApps[0].name} = ${parsed.inApps[0].priceFormatted}` : ''),
        );
      }
    } catch (e) {
      result.countries[cc] = {
        country: cc, currency, unavailable: false, inApps: [],
        error: String(e?.message || e),
      };
      console.log(`  ${cc}: 抓取失敗 — ${e?.message || e}`);
    }
    await sleep(400); // 禮貌間隔
  }
  return result;
}

/* ---------- FX 快照 ---------- */
async function updateFx() {
  const sources = [
    {
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: (j) => ({ date: j.date, rates: j.usd }),
    },
    {
      url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      parse: (j) => ({ date: j.date, rates: j.usd }),
    },
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (j) => ({ date: j.time_last_update_utc, rates: j.rates }),
    },
  ];
  for (const src of sources) {
    try {
      const { status, text } = await fetchWithRetry(src.url, { timeout: 15000 });
      if (status !== 200) continue;
      const { date, rates } = src.parse(JSON.parse(text));
      const upper = {};
      for (const [k, v] of Object.entries(rates || {})) {
        if (typeof v === 'number' && v > 0) upper[k.toUpperCase()] = v;
      }
      if (!upper.TWD || !upper.TRY || !upper.INR) continue;
      writeJson(join(DATA, 'fx.json'), {
        base: 'USD', date: date || null, rates: upper,
        fetchedAt: new Date().toISOString(),
      });
      console.log(`✓ 匯率快照已更新（${src.url.split('/')[2]}）`);
      return;
    } catch { /* 換下一個來源 */ }
  }
  console.log('⚠ 匯率快照更新失敗（所有來源），保留舊檔');
}

/* ---------- 主流程 ---------- */
let okCount = 0;
const summaries = [];
const allEvents = []; // 跨 app 的價格變動事件
const today = new Date().toISOString().slice(0, 10);

for (const appId of appIds) {
  const result = await crawlApp(appId);
  const gotAny = Object.values(result.countries).some(
    (c) => c.inApps.length || c.unavailable || c.noIap,
  );
  const prevPath = join(DATA, 'apps', `${appId}.json`);
  const prev = readJson(prevPath, null);

  if (!result.name && prev?.name) result.name = prev.name;
  if (!result.developer && prev?.developer) result.developer = prev.developer;
  if (!result.icon && prev?.icon) result.icon = prev.icon;

  // 全部國家都失敗時保留舊快照，避免覆蓋成空資料
  if (!gotAny && prev) {
    console.log(`  ⚠ ${appId} 全數失敗，保留既有快照`);
    summaries.push({ appId, name: prev.name, ok: false });
    continue;
  }
  // 個別國家失敗時沿用舊資料（標記 stale）
  if (prev) {
    for (const cc of Object.keys(result.countries)) {
      const cur = result.countries[cc];
      const old = prev.countries?.[cc];
      if (cur.error && !cur.inApps.length
          && old && (old.inApps?.length || old.unavailable || old.noIap)) {
        result.countries[cc] = { ...old, stale: true };
      }
    }
    // 沒抓的國家保留舊資料
    for (const cc of Object.keys(prev.countries || {})) {
      if (!result.countries[cc]) result.countries[cc] = prev.countries[cc];
    }
  }

  // 價格變動偵測（只比對兩邊都有新鮮資料的國家/方案）＋歷史記錄
  const nextSummary = summarizeSnapshot(result.countries);
  if (prev) {
    const events = diffSummaries(summarizeSnapshot(prev.countries), nextSummary);
    for (const e of events) {
      allEvents.push({ ...e, appId, appName: result.name || appId, date: today });
      if (e.kind === 'plan' || e.kind === 'app') {
        console.log(`  💰 ${e.cc} ${e.name}: ${e.old} → ${e.new} ${e.currency || ''}` +
          (e.pct != null ? `（${e.pct > 0 ? '+' : ''}${(e.pct * 100).toFixed(0)}%）` : ''));
      }
    }
  }
  const histPath = join(DATA, 'history', `${appId}.json`);
  const hist = readJson(histPath, { appId, names: {}, entries: [] });
  Object.assign(hist.names, planNames(nextSummary));
  hist.name = result.name || hist.name || null;
  if (appendHistory(hist, today, nextSummary)) writeJson(histPath, hist);

  writeJson(prevPath, result);
  okCount += gotAny ? 1 : 0;
  summaries.push({ appId, name: result.name, ok: gotAny });

  // 新 app 加入 registry，之後每日排程會自動更新
  if (!registry.apps.some((a) => a.id === appId)) {
    registry.apps.push({ id: appId, note: result.name || '' });
  }
}

writeJson(registryPath, registry);

// index.json：給前端列出有快照的 app
const index = readJson(join(DATA, 'index.json'), { apps: [] });
const byId = new Map((index.apps || []).map((a) => [a.appId, a]));
for (const s of summaries) {
  const appData = readJson(join(DATA, 'apps', `${s.appId}.json`), null);
  if (appData) {
    byId.set(s.appId, {
      appId: s.appId,
      name: appData.name,
      icon: appData.icon,
      fetchedAt: appData.fetchedAt,
    });
  }
}
writeJson(join(DATA, 'index.json'), { updatedAt: new Date().toISOString(), apps: [...byId.values()] });

if (!SKIP_FX) await updateFx();

/* ---------- 價格變動：滾動記錄 + 通知 issue 內文 ---------- */
const priceEvents = allEvents.filter((e) => e.kind === 'plan' || e.kind === 'app');
if (allEvents.length) {
  const log = readJson(join(DATA, 'changes.json'), { events: [] });
  log.events = [...allEvents, ...(log.events || [])].slice(0, 300);
  log.updatedAt = new Date().toISOString();
  writeJson(join(DATA, 'changes.json'), log);
}
if (priceEvents.length && process.env.CHANGES_MD && !DRY) {
  const fmtPct = (p) => (p == null ? '' : `（${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%）`);
  const byApp = new Map();
  for (const e of priceEvents) {
    if (!byApp.has(e.appName)) byApp.set(e.appName, []);
    byApp.get(e.appName).push(e);
  }
  let md = `AppPrize 每日爬蟲偵測到 ${priceEvents.length} 筆價格變動（${today}）：\n`;
  for (const [appName, evs] of byApp) {
    md += `\n### ${appName}\n`;
    for (const e of evs) {
      const dir = e.new > e.old ? '📈' : '📉';
      md += `- ${dir} ${flagEmoji(e.cc)} ${e.cc.toUpperCase()} — ${e.name}：${e.old} → **${e.new}** ${e.currency || ''} ${fmtPct(e.pct)}\n`;
    }
  }
  md += '\n打開 [AppPrize](https://chung223.github.io/Appprize/) 查看最新比價。\n';
  md += '\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n';
  writeFileSync(process.env.CHANGES_MD, md);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `has_changes=${priceEvents.length > 0}\nchange_count=${priceEvents.length}\n`,
  );
}
if (priceEvents.length) console.log(`\n💰 共 ${priceEvents.length} 筆價格變動`);

console.log(`\n完成：${okCount}/${appIds.length} 個 app 抓到資料`);
if (okCount === 0) process.exit(1);
