// AppPrize 主控制器
import {
  STOREFRONTS, DEFAULT_COUNTRIES, CURRENCY_NAMES,
  flagEmoji, countryName,
} from './storefronts.js';
import { extractAppId } from './parser.js';
import { getRates, convert, formatMoney } from './fx.js';
import {
  buildPlanGroups, buildAppPriceGroup, rankPlan, convertOfficialPlan, matchOfficialToGroup,
  planPriceMap, monthlyEquivalent,
} from './compare.js';
import {
  searchApps, lookupApp, getAppPrices, fetchHistory, pollCloudSnapshot,
} from './api.js';
import { getOfficialPricing } from './official.js';
import {
  getHistory, pushHistory, getSettings, saveSettings, clearPriceCache,
  getMySubs, saveMySubs, setCachedApp,
} from './db.js';

const REPO = 'chung223/Appprize';

const $ = (id) => document.getElementById(id);
const els = {
  heroView: $('heroView'), resultView: $('resultView'),
  searchForm: $('searchForm'), searchInput: $('searchInput'), searchMenu: $('searchMenu'),
  historySection: $('historySection'), historyGrid: $('historyGrid'),
  cloudSection: $('cloudSection'), cloudGrid: $('cloudGrid'),
  backBtn: $('backBtn'), appIcon: $('appIcon'), appName: $('appName'), appDev: $('appDev'),
  appLinks: $('appLinks'), refreshBtn: $('refreshBtn'),
  loadingBox: $('loadingBox'), loadingText: $('loadingText'),
  summaryBanner: $('summaryBanner'), planTabs: $('planTabs'), board: $('board'),
  officialBox: $('officialBox'), metaLine: $('metaLine'), historyBox: $('historyBox'),
  mySubsBtn: $('mySubsBtn'), mysubsView: $('mysubsView'), mysubsBackBtn: $('mysubsBackBtn'),
  mysubsTotals: $('mysubsTotals'), mysubsList: $('mysubsList'),
  currencyBtn: $('currencyBtn'), currencyLabel: $('currencyLabel'), currencyMenu: $('currencyMenu'),
  themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'), settingsDialog: $('settingsDialog'),
  countryGrid: $('countryGrid'), feeEnabled: $('feeEnabled'), feePercent: $('feePercent'),
  cacheTtl: $('cacheTtl'), customProxy: $('customProxy'), githubPat: $('githubPat'),
  clearCacheBtn: $('clearCacheBtn'), toast: $('toast'),
};

const state = {
  settings: getSettings(),
  rates: null,
  ratesInfo: null,
  app: null,          // {appId, name, developer, icon}
  prices: null,       // getAppPrices 回傳
  groups: [],
  baseline: null,
  selectedPlanKey: null,
  official: null,
  loadToken: 0,
};

/* ---------------- 工具 ---------------- */

let toastTimer = null;
function toast(msg, ms = 3600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function activeCountries() {
  const list = state.settings.countries;
  const valid = (arr) => arr.filter((cc) => STOREFRONTS[cc]);
  return list && list.length ? valid(list) : [...DEFAULT_COUNTRIES];
}

function periodLabel(p) {
  return { monthly: '月', yearly: '年', weekly: '週', lifetime: '買斷' }[p] || '';
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return '剛剛';
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
}

/* ---------------- 主題 ---------------- */

function applyTheme() {
  const pref = state.settings.theme;
  const dark = pref === 'auto'
    ? !window.matchMedia('(prefers-color-scheme: light)').matches
    : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

els.themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  state.settings = saveSettings({ theme: cur === 'dark' ? 'light' : 'dark' });
  applyTheme();
});

/* ---------------- 路由（hash） ---------------- */

function navigate(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function route() {
  const m = location.hash.match(/^#app\/(\d{6,12})/);
  if (m) {
    showResult();
    loadApp(m[1]);
  } else if (location.hash.startsWith('#mysubs')) {
    showMySubs();
  } else {
    showHero();
  }
}

function showHero() {
  els.heroView.hidden = false;
  els.resultView.hidden = true;
  els.mysubsView.hidden = true;
  state.loadToken++;
  renderHistory();
  renderCloudList();
}

function showResult() {
  els.heroView.hidden = true;
  els.resultView.hidden = false;
  els.mysubsView.hidden = true;
}

function showMySubs() {
  els.heroView.hidden = true;
  els.resultView.hidden = true;
  els.mysubsView.hidden = false;
  state.loadToken++;
  renderMySubs();
}

els.backBtn.addEventListener('click', () => navigate('#'));
els.mysubsBackBtn.addEventListener('click', () => navigate('#'));
els.mySubsBtn.addEventListener('click', () => navigate('#mysubs'));
window.addEventListener('hashchange', route);

/* ---------------- 搜尋 ---------------- */

let searchDebounce = null;

els.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q) return;
  const id = extractAppId(q);
  if (id) {
    hideMenu();
    navigate(`#app/${id}`);
  } else {
    runNameSearch(q, { immediate: true });
  }
});

els.searchInput.addEventListener('input', () => {
  const q = els.searchInput.value.trim();
  clearTimeout(searchDebounce);
  if (!q || extractAppId(q)) { hideMenu(); return; }
  searchDebounce = setTimeout(() => runNameSearch(q), 420);
});

document.addEventListener('click', (e) => {
  if (!els.searchForm.contains(e.target)) hideMenu();
  if (!els.currencyMenu.hidden
      && !els.currencyMenu.contains(e.target) && !els.currencyBtn.contains(e.target)) {
    els.currencyMenu.hidden = true;
  }
});

function hideMenu() { els.searchMenu.hidden = true; els.searchMenu.innerHTML = ''; }

async function runNameSearch(q, { immediate = false } = {}) {
  els.searchMenu.hidden = false;
  els.searchMenu.innerHTML = '<div class="search__item" aria-disabled="true">搜尋中…</div>';
  try {
    const results = await searchApps(q);
    if (els.searchInput.value.trim() !== q) return; // 已輸入新字串
    if (!results.length) {
      els.searchMenu.innerHTML = '<div class="search__item" aria-disabled="true">找不到相關 App，試試貼上 App Store 連結</div>';
      return;
    }
    els.searchMenu.innerHTML = results.map((r) => `
      <button type="button" class="search__item" role="option" data-id="${esc(r.appId)}">
        <img src="${esc(r.icon || '')}" alt="" loading="lazy" />
        <span><b>${esc(r.name)}</b><small>${esc(r.developer || '')}${r.genre ? ' · ' + esc(r.genre) : ''}${r.priceLabel ? ' · ' + esc(r.priceLabel) : ''}</small></span>
      </button>`).join('');
    els.searchMenu.querySelectorAll('[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        hideMenu();
        navigate(`#app/${btn.dataset.id}`);
      });
    });
    if (immediate && results.length === 1) {
      hideMenu();
      navigate(`#app/${results[0].appId}`);
    }
  } catch {
    els.searchMenu.innerHTML = '<div class="search__item" aria-disabled="true">搜尋失敗，請直接貼上 App Store 連結</div>';
  }
}

document.querySelectorAll('.hero__hint-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    els.searchInput.value = chip.dataset.example;
    els.searchForm.requestSubmit();
  });
});

/* ---------------- 歷史 ---------------- */

function renderHistory() {
  const list = getHistory();
  els.historySection.hidden = !list.length;
  els.historyGrid.innerHTML = list.map((h) => `
    <button type="button" class="history__card" data-id="${esc(h.appId)}">
      ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy" />` : ''}
      <span style="min-width:0"><b>${esc(h.name || h.appId)}</b><small>${timeAgo(h.at)}</small></span>
    </button>`).join('');
  els.historyGrid.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(`#app/${btn.dataset.id}`));
  });
}

/** 雲端追蹤清單（repo 的 index.json — 跨裝置共用的「查過紀錄」） */
async function renderCloudList() {
  try {
    if (!state.cloudIndex) {
      const url = new URL('./data/index.json', document.baseURI).href;
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return;
      state.cloudIndex = await res.json();
    }
    const localIds = new Set(getHistory().map((h) => h.appId));
    const apps = (state.cloudIndex.apps || [])
      .filter((a) => a.appId && a.name && !localIds.has(a.appId))
      .sort((a, b) => Date.parse(b.fetchedAt || 0) - Date.parse(a.fetchedAt || 0))
      .slice(0, 24);
    if (!apps.length) { els.cloudSection.hidden = true; return; }
    els.cloudGrid.innerHTML = apps.map((a) => `
      <button type="button" class="history__card" data-id="${esc(a.appId)}">
        ${a.icon ? `<img src="${esc(a.icon)}" alt="" loading="lazy" />` : ''}
        <span style="min-width:0"><b>${esc(a.name)}</b><small>☁️ 雲端快照</small></span>
      </button>`).join('');
    els.cloudGrid.querySelectorAll('[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => navigate(`#app/${btn.dataset.id}`));
    });
    els.cloudSection.hidden = false;
  } catch { /* 離線等情況：略過 */ }
}

/* ---------------- 載入 App ---------------- */

async function ensureRates() {
  if (state.rates) return;
  const snapshotUrl = new URL('./data/fx.json', document.baseURI).href;
  const info = await getRates({ snapshotUrl });
  state.rates = info.rates;
  state.ratesInfo = info;
}

async function loadApp(appId, { force = false } = {}) {
  const token = ++state.loadToken;
  state.app = { appId, name: null, developer: null, icon: null };
  state.prices = null;
  state.groups = [];
  state.official = null;
  state.cloudHintUrl = null;
  state.history = null;

  // 重置畫面
  els.appName.textContent = '載入中…';
  els.appDev.textContent = '';
  els.appIcon.removeAttribute('src');
  els.appLinks.innerHTML = '';
  els.summaryBanner.hidden = true;
  els.planTabs.innerHTML = '';
  els.officialBox.hidden = true;
  els.metaLine.textContent = '';
  els.loadingBox.hidden = false;
  els.loadingText.textContent = '正在準備…';
  els.board.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';

  const countries = activeCountries();

  // 平行：中繼資料 / 匯率 / 官網價
  lookupApp(appId).then((meta) => {
    if (token !== state.loadToken || !meta) return;
    state.app = { ...state.app, ...meta };
    renderAppHeader();
  }).catch(() => {});
  getOfficialPricing(appId).then((o) => {
    if (token !== state.loadToken) return;
    state.official = o;
    if (state.prices) renderAll();
  }).catch(() => {});
  fetchHistory(appId).then((h) => {
    if (token !== state.loadToken) return;
    state.history = h;
    if (state.prices) renderPriceHistory();
  }).catch(() => {});

  // 漸進式渲染：哪個國家先抓到就先顯示，不必等全部完成
  const provisional = {};
  let ratesReady = false;
  const ratesPromise = ensureRates().then(() => { ratesReady = true; });

  try {
    const [prices] = await Promise.all([
      getAppPrices(appId, countries, {
        force,
        onProgress: (done, total, cc) => {
          if (token !== state.loadToken) return;
          els.loadingText.textContent = `正在抓取各區價格… ${done}/${total}（${flagEmoji(cc)} ${countryName(cc)}）`;
        },
        onCountry: (cc, res) => {
          if (token !== state.loadToken || !ratesReady) return;
          provisional[cc] = res;
          applyPrices({
            appId, name: state.app.name, countries: { ...provisional },
            fetchedAt: Date.now(), source: 'live-partial', partial: true, missing: [],
          }, countries, { keepSelection: true });
        },
      }),
      ratesPromise,
    ]);
    if (token !== state.loadToken) return;
    if (!state.app.name && prices.name) state.app.name = prices.name;
    renderAppHeader(); // 就算 meta 查詢失敗也要脫離「載入中…」狀態
    els.loadingBox.hidden = true;
    // 新 App（雲端還沒有快照）：有 Token 就自動觸發雲端爬蟲入庫並輪詢結果，
    // 沒有就在資料列附上一鍵開 issue 的連結，讓每日排程接手
    if (prices.hadSnapshot === false) maybeRequestCloudCrawl(appId);
    applyPrices(prices, countries);
    if (state.app.name) {
      pushHistory({ appId, name: state.app.name, icon: state.app.icon });
    }
  } catch (e) {
    if (token !== state.loadToken) return;
    els.loadingBox.hidden = true;
    els.board.innerHTML = `
      <div class="row-card row-card--muted" style="grid-template-columns: 1fr">
        <div>抓不到價格資料：${esc(e?.message || e)}。<br>
        可能是 CORS proxy 暫時無法使用 — 稍後再試，或在設定中填入自訂 proxy。</div>
      </div>`;
  }
}

/** 預設選「像主要訂閱」的方案：出現國家數最多，同數取最貴（通常是主訂閱而非加值包） */
function pickDefaultPlan(groups) {
  if (!groups.length) return null;
  const score = (g) => Object.keys(g.entries).length * 1000
    + Math.min(999, Math.max(...Object.values(g.entries).map((e) => e.price || 0)));
  return [...groups].sort((a, b) => score(b) - score(a))[0].key;
}

/** 套用一份價格資料：重建方案群組並重新渲染（keepSelection 保留使用者選中的分頁） */
function applyPrices(prices, countries, { keepSelection = false } = {}) {
  state.prices = prices;
  const { groups, baseline } = buildPlanGroups(prices.countries, countries);
  const priceGroup = buildAppPriceGroup(prices.countries, countries);
  if (priceGroup) groups.unshift(priceGroup);
  state.groups = groups;
  state.baseline = baseline;
  const stillExists = keepSelection && groups.some((g) => g.key === state.selectedPlanKey);
  if (!stillExists) state.selectedPlanKey = pickDefaultPlan(groups);
  renderAll();
}

/* ---------------- 渲染 ---------------- */

function renderAppHeader() {
  const { appId, name, developer, icon } = state.app;
  els.appName.textContent = name || `App ${appId}`;
  els.appDev.textContent = developer || '';
  if (icon) els.appIcon.src = icon.replace(/100x100/, '176x176');
  els.appLinks.innerHTML = activeCountries().slice(0, 8).map((cc) =>
    `<a class="applink" href="https://apps.apple.com/${esc(cc)}/app/id${esc(appId)}" target="_blank" rel="noopener">${flagEmoji(cc)} ${esc(countryName(cc))}</a>`,
  ).join('');
}

function renderAll() {
  renderPlanTabs();
  renderBoard();
  renderOfficial();
  renderPriceHistory();
  renderMeta();
}

function renderPlanTabs() {
  const groups = state.groups;
  if (!groups.length) { els.planTabs.innerHTML = ''; return; }
  const group = currentGroup();
  const subbed = group && state.app?.appId && isSubbed(state.app.appId, group.key);
  els.planTabs.innerHTML = groups.map((g) => `
    <button type="button" class="plantab" role="tab" data-key="${esc(g.key)}"
      aria-selected="${g.key === state.selectedPlanKey}">
      ${esc(g.name)}${g.period ? `<span class="plantab__period">/${periodLabel(g.period)}</span>` : ''}
    </button>`).join('')
    + (group ? `
    <button type="button" id="subToggleBtn" class="plantab plantab--star${subbed ? ' is-on' : ''}">
      ${subbed ? '★ 已在我的訂閱' : '☆ 加入我的訂閱'}
    </button>` : '');
  els.planTabs.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedPlanKey = btn.dataset.key;
      renderAll();
    });
  });
  document.getElementById('subToggleBtn')?.addEventListener('click', () => {
    const g = currentGroup();
    if (g) toggleSub(g);
  });
}

function currentGroup() {
  return state.groups.find((g) => g.key === state.selectedPlanKey) || state.groups[0] || null;
}

function feePct() {
  return state.settings.feeEnabled ? Number(state.settings.feePercent) || 0 : 0;
}

function renderBoard() {
  const group = currentGroup();
  const target = state.settings.targetCurrency;
  const countries = activeCountries();

  if (!group) {
    const anyNoIap = countries.some((cc) => state.prices?.countries?.[cc]?.noIap);
    const anyUnavailable = countries.some((cc) => state.prices?.countries?.[cc]?.unavailable);
    els.board.innerHTML = `
      <div class="row-card row-card--muted" style="grid-template-columns:1fr">
        <div>${anyNoIap
          ? '這個 App 是免費下載且沒有應用內購買項目 — 訂閱可能只在官網提供（見下方官網價，若有）。'
          : anyUnavailable
            ? '這個 App 在所選的儲存區找不到應用內購買項目（可能未上架或不提供訂閱）。'
            : '沒有解析到應用內購買項目 — 頁面暫時抓不到，請按「更新價格」重試。'}
        </div>
      </div>`;
    els.summaryBanner.hidden = true;
    return;
  }

  const rows = rankPlan(group, state.rates, target, feePct());
  // 沒有此方案資料的國家也要列出（顯示原因），不能無聲消失
  const present = new Set(rows.map((r) => r.country));
  for (const cc of countries) {
    if (!present.has(cc)) rows.push({ country: cc, iap: null, converted: null, delta: null });
  }
  const valid = rows.filter((r) => r.converted != null);
  const maxConv = valid.length ? Math.max(...valid.map((r) => r.converted)) : 1;

  const rowsHtml = rows.map((r, i) => {
    if (r.converted == null) {
      const cData = state.prices?.countries?.[r.country];
      const why = cData?.unavailable ? '未在此區上架'
        : cData?.noIap ? '此區無應用內購買'
        : cData?.error ? '抓取失敗'
        : r.iap ? '無法換算（缺匯率）' : '此區無對應方案';
      return `
        <div class="row-card row-card--muted" style="--i:${i}">
          <div class="row-card__rank">–</div>
          <div class="row-card__who">
            <span class="row-card__flag">${flagEmoji(r.country)}</span>
            <div><span class="row-card__country">${esc(countryName(r.country))}</span></div>
          </div>
          <div class="row-card__err">${esc(why)}</div>
        </div>`;
    }
    const best = i === 0 || r.delta === 0;
    const pct = Math.max(6, Math.round((r.converted / maxConv) * 100));
    const stale = state.prices?.countries?.[r.country]?.staleSource;
    return `
      <div class="row-card${best ? ' row-card--best' : ''}" style="--i:${i}">
        <div class="row-card__rank">${i + 1}</div>
        <div class="row-card__who">
          <span class="row-card__flag">${flagEmoji(r.country)}</span>
          <div style="min-width:0">
            <span class="row-card__country">${esc(countryName(r.country))}${best ? '<span class="badge-best">最省</span>' : ''}</span>
            <span class="row-card__local">${esc(r.iap.priceFormatted || '')}${r.iap.currency ? ` ${esc(r.iap.currency)}` : ''}${stale ? ' · 快取' : ''}</span>
          </div>
        </div>
        <div class="row-card__price">
          <span class="row-card__converted">${formatMoney(r.converted, target)}</span>
          <span class="row-card__delta${r.delta > 0 ? ' row-card__delta--more' : ''}">
            ${r.delta > 0 ? `+${(r.delta * 100).toFixed(0)}%` : '基準最低'}
          </span>
        </div>
        <div class="row-card__bar"><i style="--pct:${pct}"></i></div>
      </div>`;
  }).join('');

  els.board.innerHTML = rowsHtml;
  renderSummary(rows, group, target);
}

function renderSummary(rows, group, target) {
  const best = rows.find((r) => r.converted != null);
  if (!best) { els.summaryBanner.hidden = true; return; }

  const twRow = rows.find((r) => r.country === 'tw' && r.converted != null);
  let saveHtml = '';
  if (twRow && twRow.country !== best.country && twRow.converted > best.converted) {
    const diff = twRow.converted - best.converted;
    const pct = ((diff / twRow.converted) * 100).toFixed(0);
    saveHtml = `<span class="save">比台灣省 ${pct}%（${formatMoney(diff, target)}）</span>`;
  }

  // 官網是否更便宜
  let officialHtml = '';
  const officialBest = cheapestOfficial(group, target);
  if (officialBest && officialBest.converted < best.converted) {
    officialHtml = `<span>💡 <b>官網訂閱更便宜：${formatMoney(officialBest.converted, target)}</b>（${esc(officialBest.plan.name)}）</span>`;
  }

  els.summaryBanner.innerHTML = `
    <span class="summary__flag">${flagEmoji(best.country)}</span>
    <span><b>${esc(countryName(best.country))}</b> 的「${esc(group.name)}」最省 —
      <b>${formatMoney(best.converted, target)}</b>${group.period ? `/${periodLabel(group.period)}` : ''}</span>
    ${saveHtml} ${officialHtml}`;
  els.summaryBanner.hidden = false;
}

function cheapestOfficial(group, target) {
  if (!state.official) return null;
  const matched = matchOfficialToGroup(state.official.plans, group);
  const pool = matched.length ? matched : [];
  let best = null;
  for (const plan of pool) {
    const converted = convertOfficialPlan(plan, state.rates, target, feePct());
    if (converted != null && (!best || converted < best.converted)) best = { plan, converted };
  }
  return best;
}

function renderOfficial() {
  const o = state.official;
  if (!o || !o.plans?.length) { els.officialBox.hidden = true; return; }
  const target = state.settings.targetCurrency;
  const group = currentGroup();
  const rows = group ? rankPlan(group, state.rates, target, feePct()) : [];
  const bestStore = rows.find((r) => r.converted != null);

  const items = o.plans.map((p) => {
    const conv = convertOfficialPlan(p, state.rates, target, feePct());
    const cheaper = bestStore && conv != null && conv < bestStore.converted
      && matchOfficialToGroup([p], group || { name: '' }).length > 0;
    return `
      <div class="official__row">
        <span class="official__name">${esc(p.name)}${cheaper ? '<span class="badge-official">比 App Store 便宜</span>' : ''}</span>
        <span class="official__price">${formatMoney(p.price, p.currency)}${p.period ? `/${periodLabel(p.period)}` : ''}</span>
        <span class="official__conv">${conv != null ? formatMoney(conv, target, { approx: true }) : ''}</span>
      </div>`;
  }).join('');

  const anyCheaper = items.includes('badge-official');
  const safeUrl = /^https:\/\//i.test(o.url || '') ? o.url : null;
  els.officialBox.className = `official glass${anyCheaper ? ' official--win' : ''}`;
  els.officialBox.innerHTML = `
    <div class="official__head">
      <h3>🌐 官網訂閱價</h3>
      ${safeUrl ? `<a class="official__link" href="${esc(safeUrl)}" target="_blank" rel="noopener">前往官網 →</a>` : ''}
    </div>
    ${items}
    <p class="official__note">${esc(o.note || '')} 官網價為人工整理（${esc(String(state.officialUpdatedAt || '')) || '日期見資料檔'}），以官網實際顯示為準。</p>`;
  els.officialBox.hidden = false;
}

function renderMeta() {
  const p = state.prices;
  if (!p) { els.metaLine.textContent = ''; return; }
  const srcLabel = {
    'local-cache': '本地快取', snapshot: '雲端快照（GitHub Actions 每日抓取）',
    live: '即時抓取', 'live-partial': '即時抓取中…', mixed: '雲端快照＋即時補抓',
    'stale-cache': '過期快取',
  }[p.source] || p.source;
  const age = timeAgo(p.fetchedAt);
  const parts = [`資料來源：${srcLabel} · ${age}`];
  if (state.ratesInfo) {
    parts.push(`匯率：${state.ratesInfo.date || '每日參考匯率'}${state.ratesInfo.stale ? '（較舊）' : ''}`);
  }
  if (feePct() > 0) parts.push(`含 ${feePct()}% 手續費`);
  let html = esc(parts.join(' · '));
  if (p.partial || p.source === 'stale-cache') {
    html += ' · <span class="warn">部分地區抓取失敗，按「更新價格」重試</span>';
  }
  if (state.cloudHintUrl) {
    html += ` · <a href="${esc(state.cloudHintUrl)}" target="_blank" rel="noopener">☁️ 加入雲端追蹤（免重爬）</a>`;
  }
  els.metaLine.innerHTML = html;
}

/* ---------------- 價格歷史 ---------------- */

/** 步階折線 sparkline（單序列、時間軸依實際日期、期末圓點） */
function sparklineSvg(points, { width = 120, height = 28 } = {}) {
  if (points.length < 2) return '';
  const t0 = points[0].t;
  const t1 = Math.max(Date.now(), points[points.length - 1].t);
  const vs = points.map((p) => p.v);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const pad = 3;
  const x = (t) => (t1 === t0 ? pad : pad + ((t - t0) / (t1 - t0)) * (width - pad * 2));
  const y = (v) => (vMax === vMin
    ? height / 2
    : (height - pad) - ((v - vMin) / (vMax - vMin)) * (height - pad * 2));
  let d = `M ${x(points[0].t).toFixed(1)} ${y(points[0].v).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H ${x(points[i].t).toFixed(1)} V ${y(points[i].v).toFixed(1)}`;
  }
  d += ` H ${(width - pad).toFixed(1)}`;
  const lastY = y(points[points.length - 1].v).toFixed(1);
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
    <title>${vMin} – ${vMax}</title>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${(width - pad).toFixed(1)}" cy="${lastY}" r="3" fill="currentColor"/>
  </svg>`;
}

/** 從歷史檔的連續紀錄推導變動事件（新→舊排序） */
function historyEvents(h) {
  const events = [];
  const entries = h?.entries || [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1].c || {};
    const next = entries[i].c || {};
    for (const [cc, nc] of Object.entries(next)) {
      const pc = prev[cc];
      if (!pc) continue;
      if (pc.app != null && nc.app != null && pc.app !== nc.app) {
        events.push({ date: entries[i].d, cc, name: 'App 售價', old: pc.app, new: nc.app });
      }
      for (const [k, v] of Object.entries(nc.plans || {})) {
        const ov = pc.plans?.[k];
        if (ov != null && v != null && ov !== v) {
          events.push({ date: entries[i].d, cc, name: h.names?.[k] || k, old: ov, new: v });
        }
      }
    }
  }
  return events.reverse();
}

function renderPriceHistory() {
  const h = state.history;
  if (!h || !h.entries?.length || els.resultView.hidden) {
    els.historyBox.hidden = true;
    return;
  }
  const events = historyEvents(h);
  const group = currentGroup();

  // 選中方案的各國走勢（有變動才畫）
  const sparkRows = [];
  if (group) {
    for (const cc of activeCountries()) {
      let key = null;
      if (group.key === '__appprice') {
        key = '__app';
      } else {
        const entryIap = group.entries?.[cc];
        if (!entryIap) continue;
        const m = planPriceMap(state.prices?.countries?.[cc]?.inApps || []);
        key = Object.keys(m).find(
          (k) => m[k].name === entryIap.name && m[k].price === entryIap.price,
        ) || null;
        if (!key) continue;
      }
      const series = [];
      for (const e of h.entries) {
        const c = e.c?.[cc];
        if (!c) continue;
        const v = key === '__app' ? c.app : c.plans?.[key];
        if (v != null) series.push({ t: Date.parse(e.d), v });
      }
      if (series.length >= 2 && new Set(series.map((s) => s.v)).size >= 2) {
        const cur = state.prices?.countries?.[cc]?.currency || '';
        sparkRows.push(`
          <div class="phistory__row">
            <span class="phistory__flag">${flagEmoji(cc)}</span>
            <span class="phistory__cc">${esc(countryName(cc))}</span>
            <span class="phistory__spark">${sparklineSvg(series)}</span>
            <span class="phistory__range">${esc(String(series[0].v))} → ${esc(String(series[series.length - 1].v))} ${esc(cur)}</span>
          </div>`);
      }
    }
  }

  const evHtml = events.slice(0, 10).map((e) => {
    const up = e.new > e.old;
    const pct = e.old > 0
      ? `（${up ? '+' : ''}${(((e.new - e.old) / e.old) * 100).toFixed(0)}%）` : '';
    return `
      <div class="phistory__event">
        <span class="phistory__date">${esc(e.date)}</span>
        <span class="phistory__what">${flagEmoji(e.cc)} ${esc(e.name)}</span>
        <span class="${up ? 'phistory__up' : 'phistory__down'}">${esc(String(e.old))} → ${esc(String(e.new))}${esc(pct)}</span>
      </div>`;
  }).join('');

  els.historyBox.innerHTML = `
    <h3 class="phistory__head">📈 價格歷史</h3>
    ${sparkRows.length ? `<div class="phistory__sparks">${sparkRows.join('')}</div>` : ''}
    ${events.length
    ? evHtml + (events.length > 10 ? `<p class="phistory__note">僅顯示最近 10 筆（共 ${events.length} 筆）</p>` : '')
    : `<p class="phistory__note">自 ${esc(h.entries[0].d)} 開始追蹤，尚無價格變動 — 之後有調價，每日爬蟲會自動開 issue 通知（watch 這個 repo 就會收到）。</p>`}
  `;
  els.historyBox.hidden = false;
}

/* ---------------- 我的訂閱 ---------------- */

function isSubbed(appId, planKey) {
  return getMySubs().some((s) => s.appId === appId && s.planKey === planKey);
}

function toggleSub(group) {
  const appId = state.app.appId;
  let subs = getMySubs();
  if (isSubbed(appId, group.key)) {
    subs = subs.filter((s) => !(s.appId === appId && s.planKey === group.key));
    toast('已從我的訂閱移除');
  } else {
    const withData = Object.keys(group.entries || {});
    subs.push({
      appId,
      planKey: group.key,
      planName: group.name,
      appName: state.app.name || appId,
      icon: state.app.icon || null,
      period: group.period || null,
      useCountry: withData.includes('tw') ? 'tw' : withData[0] || 'tw',
      addedAt: Date.now(),
    });
    toast('已加入我的訂閱 ★ 右上角星號可看總覽');
  }
  saveMySubs(subs);
  renderPlanTabs();
}

async function renderMySubs() {
  const token = state.loadToken;
  const subs = getMySubs();
  if (!subs.length) {
    els.mysubsTotals.hidden = true;
    els.mysubsList.innerHTML = `
      <div class="row-card row-card--muted" style="grid-template-columns:1fr">
        <div>還沒有訂閱項目 — 查一個 App，在方案列按「☆ 加入我的訂閱」就會出現在這裡。</div>
      </div>`;
    return;
  }
  els.mysubsList.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
  const target = state.settings.targetCurrency;
  try {
    await ensureRates();
  } catch {
    els.mysubsList.innerHTML = `
      <div class="row-card row-card--muted" style="grid-template-columns:1fr"><div>無法取得匯率，稍後再試。</div></div>`;
    return;
  }

  const countries = activeCountries();
  const rows = [];
  let totalCur = 0;
  let totalBest = 0;
  for (const sub of subs) {
    try {
      const prices = await getAppPrices(sub.appId, countries, {});
      const { groups } = buildPlanGroups(prices.countries, countries);
      const pg = buildAppPriceGroup(prices.countries, countries);
      if (pg) groups.unshift(pg);
      const group = groups.find((g) => g.key === sub.planKey)
        || groups.find((g) => g.name === sub.planName);
      if (!group) { rows.push({ sub, error: '找不到此方案（可能改名或下架）' }); continue; }
      const ranked = rankPlan(group, state.rates, target, feePct())
        .filter((r) => r.converted != null);
      if (!ranked.length) { rows.push({ sub, error: '暫無價格資料' }); continue; }
      const current = ranked.find((r) => r.country === sub.useCountry) || ranked[0];
      const best = ranked[0];
      const period = group.period || sub.period || null;
      const mCur = monthlyEquivalent(current.converted, period);
      const mBest = monthlyEquivalent(best.converted, period);
      if (mCur != null && mBest != null) { totalCur += mCur; totalBest += mBest; }
      rows.push({ sub, group, ranked, current, best, mCur, mBest, period });
    } catch (e) {
      rows.push({ sub, error: String(e?.message || e) });
    }
  }
  if (token !== state.loadToken) return; // 使用者已離開此頁

  els.mysubsList.innerHTML = rows.map((r, i) => {
    const s = r.sub;
    const head = `
      <div class="msub__who">
        ${s.icon ? `<img src="${esc(s.icon)}" alt="" loading="lazy" />` : '<span class="msub__noicon"></span>'}
        <div style="min-width:0">
          <a class="msub__app" href="#app/${esc(s.appId)}">${esc(s.appName)}</a>
          <span class="msub__plan">${esc(s.planName)}${r.period === 'lifetime' ? '<span class="badge-official">買斷</span>' : ''}</span>
        </div>
      </div>`;
    if (r.error) {
      return `<div class="row-card row-card--muted msub" data-i="${i}">
        ${head}<div class="row-card__err">${esc(r.error)}</div>
        <button type="button" class="msub__rm" data-rm="${i}" aria-label="移除">✕</button>
      </div>`;
    }
    const opts = r.ranked.map((rr) =>
      `<option value="${esc(rr.country)}" ${rr.country === r.current.country ? 'selected' : ''}>${flagEmoji(rr.country)} ${esc(countryName(rr.country))}</option>`).join('');
    const diff = r.mCur != null && r.mBest != null ? r.mCur - r.mBest : null;
    const perLabel = r.period === 'lifetime' ? '' : '/月';
    return `
      <div class="row-card msub" data-i="${i}">
        ${head}
        <div class="msub__cur">
          <select class="msub__cc" data-sel="${i}">${opts}</select>
          <span class="row-card__converted">${formatMoney(r.mCur ?? r.current.converted, target)}<small>${perLabel}</small></span>
        </div>
        <div class="msub__best">
          ${r.best.country === r.current.country
    ? '<span class="msub__ok">✓ 已是最省區</span>'
    : `<span class="msub__tip">最省 ${flagEmoji(r.best.country)} ${esc(countryName(r.best.country))}
         <b>${formatMoney(r.mBest ?? r.best.converted, target)}</b>${perLabel}
         ${diff > 0.5 ? `<span class="save">省 ${formatMoney(diff, target)}${perLabel}</span>` : ''}</span>`}
        </div>
        <button type="button" class="msub__rm" data-rm="${i}" aria-label="移除">✕</button>
      </div>`;
  }).join('');

  const save = totalCur - totalBest;
  els.mysubsTotals.innerHTML = `
    <span>目前每月合計 <b>${formatMoney(totalCur, target)}</b></span>
    <span>全搬最省區 <b>${formatMoney(totalBest, target)}</b></span>
    ${save > 0.5
    ? `<span class="save">每月可省 ${formatMoney(save, target)} ・ 一年省 ${formatMoney(save * 12, target)}</span>`
    : '<span class="save">✓ 已是最佳配置</span>'}`;
  els.mysubsTotals.hidden = false;

  // 事件：切換使用區 / 移除
  els.mysubsList.querySelectorAll('[data-sel]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const all = getMySubs();
      const idx = Number(sel.dataset.sel);
      const target2 = rows[idx]?.sub;
      const found = all.find((s2) => s2.appId === target2.appId && s2.planKey === target2.planKey);
      if (found) { found.useCountry = sel.value; saveMySubs(all); }
      renderMySubs();
    });
  });
  els.mysubsList.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.rm);
      const target2 = rows[idx]?.sub;
      saveMySubs(getMySubs().filter((s2) => !(s2.appId === target2.appId && s2.planKey === target2.planKey)));
      renderMySubs();
    });
  });
}

/* ---------------- 更新價格 ---------------- */

els.refreshBtn.addEventListener('click', async () => {
  if (!state.app?.appId) return;
  const pat = state.settings.githubPat?.trim();
  if (pat) triggerCloudCrawl(state.app.appId, pat); // 背景觸發，不等待
  await loadApp(state.app.appId, { force: true });
});

/** 新 App 自動入雲端快取：有 Token 直接觸發（12 小時內不重複），否則給一鍵 issue 連結 */
function maybeRequestCloudCrawl(appId) {
  const pat = state.settings.githubPat?.trim();
  if (pat) {
    const key = `appprize.cloudreq.${appId}`;
    try {
      if (Date.now() - (Number(localStorage.getItem(key)) || 0) < 12 * 60 * 60 * 1000) return;
      localStorage.setItem(key, String(Date.now()));
    } catch { /* 忽略 */ }
    triggerCloudCrawl(appId, pat);
    // 雲端快速通道：輪詢 raw 內容等爬蟲 commit 落地；
    // 若當下 proxy 抓得不完整，雲端結果一到就自動補上
    const since = Date.now();
    pollCloudSnapshot(appId, { repo: REPO, sinceMs: since }).then((snap) => {
      if (!snap?.countries) return;
      setCachedApp(appId, { appId, name: snap.name, countries: snap.countries });
      const viewing = state.app?.appId === appId && !els.resultView.hidden;
      const incomplete = state.prices?.partial
        || state.prices?.source === 'live-partial'
        || state.prices?.source === 'stale-cache'
        || (state.prices?.missing?.length > 0);
      if (viewing && incomplete) {
        if (!state.app.name && snap.name) { state.app.name = snap.name; renderAppHeader(); }
        applyPrices({
          appId, name: snap.name, countries: snap.countries,
          fetchedAt: Date.parse(snap.fetchedAt) || Date.now(),
          source: 'snapshot', partial: false, missing: [],
        }, activeCountries(), { keepSelection: true });
        toast('☁️ 雲端爬蟲完成，已更新為最新價格');
      }
    }).catch(() => {});
  } else {
    const title = encodeURIComponent(`[crawl] id${appId}`);
    const body = encodeURIComponent('把這個 App 加入雲端快照與每日自動更新（由 AppPrize 網站發起）。');
    state.cloudHintUrl = `https://github.com/${REPO}/issues/new?title=${title}&body=${body}`;
  }
}

async function triggerCloudCrawl(appId, pat) {
  try {
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    const repoInfo = await fetch(`https://api.github.com/repos/${REPO}`, { headers }).then((r) => r.json());
    const ref = repoInfo.default_branch || 'main';
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/crawl.yml/dispatches`,
      { method: 'POST', headers, body: JSON.stringify({ ref, inputs: { app_id: appId } }) },
    );
    if (res.status === 204) toast('已觸發雲端爬蟲，數分鐘後快照會更新 ✓');
    else toast(`雲端爬蟲觸發失敗（HTTP ${res.status}），請確認 Token 權限`);
  } catch {
    toast('雲端爬蟲觸發失敗，請檢查網路或 Token');
  }
}

/* ---------------- 幣別選單 ---------------- */

const CURRENCY_CHOICES = ['TWD', 'USD', 'JPY', 'EUR', 'GBP', 'HKD', 'CNY', 'KRW', 'SGD', 'MYR', 'THB', 'VND', 'AUD', 'CAD', 'TRY', 'INR'];

function renderCurrencyLabel() {
  const c = state.settings.targetCurrency;
  els.currencyLabel.textContent = `${c} ${CURRENCY_NAMES[c] || ''}`.trim();
}

els.currencyBtn.addEventListener('click', () => {
  if (!els.currencyMenu.hidden) { els.currencyMenu.hidden = true; return; }
  els.currencyMenu.innerHTML = CURRENCY_CHOICES.map((c) => `
    <button type="button" class="menu__item" role="option" data-cur="${c}"
      aria-selected="${c === state.settings.targetCurrency}">
      <span>${c}</span><small>${esc(CURRENCY_NAMES[c] || '')}</small>
    </button>`).join('');
  const rect = els.currencyBtn.getBoundingClientRect();
  els.currencyMenu.style.top = `${rect.bottom + 8}px`;
  els.currencyMenu.style.right = `${Math.max(10, window.innerWidth - rect.right)}px`;
  els.currencyMenu.style.left = 'auto';
  els.currencyMenu.hidden = false;
  els.currencyMenu.querySelectorAll('[data-cur]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings = saveSettings({ targetCurrency: btn.dataset.cur });
      els.currencyMenu.hidden = true;
      renderCurrencyLabel();
      if (state.prices) renderAll();
    });
  });
});

/* ---------------- 設定面板 ---------------- */

els.settingsBtn.addEventListener('click', () => {
  const s = state.settings;
  els.feeEnabled.checked = !!s.feeEnabled;
  els.feePercent.value = s.feePercent;
  els.cacheTtl.value = s.cacheTtlHours;
  els.customProxy.value = s.customProxy || '';
  els.githubPat.value = s.githubPat || '';
  renderCountryGrid();
  els.settingsDialog.showModal();
});

function renderCountryGrid() {
  const selected = new Set(activeCountries());
  els.countryGrid.innerHTML = Object.keys(STOREFRONTS).map((cc) => `
    <button type="button" class="countrychip" data-cc="${cc}" aria-pressed="${selected.has(cc)}">
      <span>${flagEmoji(cc)}</span><span>${esc(countryName(cc))}</span><small>${esc(STOREFRONTS[cc].currency)}</small>
    </button>`).join('');
  els.countryGrid.querySelectorAll('[data-cc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!pressed));
    });
  });
}

els.settingsDialog.addEventListener('close', () => {
  const countries = [...els.countryGrid.querySelectorAll('[aria-pressed="true"]')]
    .map((b) => b.dataset.cc);
  state.settings = saveSettings({
    countries: countries.length ? countries : null,
    feeEnabled: els.feeEnabled.checked,
    feePercent: Math.max(0, Math.min(10, Number(els.feePercent.value) || 0)),
    cacheTtlHours: Math.max(1, Math.min(720, Number(els.cacheTtl.value) || 24)),
    customProxy: els.customProxy.value.trim(),
    githubPat: els.githubPat.value.trim(),
  });
  if (state.app?.appId && !els.resultView.hidden) {
    loadApp(state.app.appId); // 設定變更後重新整理
  }
});

els.clearCacheBtn.addEventListener('click', () => {
  clearPriceCache();
  toast('已清除本地價格快取');
});

/* ---------------- 官網價 updatedAt ---------------- */

import('./official.js').then(({ loadOfficialIndex }) =>
  loadOfficialIndex().then((idx) => { state.officialUpdatedAt = idx.updatedAt; }),
).catch(() => {});

/* ---------------- Service Worker ---------------- */

function showUpdateToast() {
  clearTimeout(toastTimer);
  els.toast.innerHTML =
    '網站已更新到新版 <button type="button" class="toast__btn" id="reloadBtn">重新整理</button>';
  els.toast.hidden = false;
  document.getElementById('reloadBtn')?.addEventListener('click', () => location.reload());
}

if ('serviceWorker' in navigator) {
  // 新版 SW 接管時提示重新整理（首次安裝不提示，之後的更新都提示）
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showUpdateToast();
    hadController = true;
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
      // 回到分頁時順手檢查新版（瀏覽器對 sw.js 的檢查不吃 HTTP 快取）
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

/* ---------------- App 圖示載入失敗處理 ---------------- */

els.appIcon.addEventListener('error', () => { els.appIcon.style.opacity = '0'; });
els.appIcon.addEventListener('load', () => { els.appIcon.style.opacity = '1'; });

/* ---------------- 啟動 ---------------- */

applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});
renderCurrencyLabel();
renderHistory();
route();
