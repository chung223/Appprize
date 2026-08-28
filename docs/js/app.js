// AppPrize 主控制器
import {
  STOREFRONTS, DEFAULT_COUNTRIES, CURRENCY_NAMES,
  flagEmoji, countryName,
} from './storefronts.js';
import { extractAppId } from './parser.js';
import { getRates, convert, formatMoney } from './fx.js';
import { buildPlanGroups, rankPlan, convertOfficialPlan, matchOfficialToGroup } from './compare.js';
import { searchApps, lookupApp, getAppPrices } from './api.js';
import { getOfficialPricing } from './official.js';
import {
  getHistory, pushHistory, getSettings, saveSettings, clearPriceCache,
} from './db.js';

const REPO = 'chung223/Appprize';

const $ = (id) => document.getElementById(id);
const els = {
  heroView: $('heroView'), resultView: $('resultView'),
  searchForm: $('searchForm'), searchInput: $('searchInput'), searchMenu: $('searchMenu'),
  historySection: $('historySection'), historyGrid: $('historyGrid'),
  backBtn: $('backBtn'), appIcon: $('appIcon'), appName: $('appName'), appDev: $('appDev'),
  appLinks: $('appLinks'), refreshBtn: $('refreshBtn'),
  loadingBox: $('loadingBox'), loadingText: $('loadingText'),
  summaryBanner: $('summaryBanner'), planTabs: $('planTabs'), board: $('board'),
  officialBox: $('officialBox'), metaLine: $('metaLine'),
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
  } else {
    showHero();
  }
}

function showHero() {
  els.heroView.hidden = false;
  els.resultView.hidden = true;
  state.loadToken++;
  renderHistory();
}

function showResult() {
  els.heroView.hidden = true;
  els.resultView.hidden = false;
}

els.backBtn.addEventListener('click', () => navigate('#'));
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
        <span><b>${esc(r.name)}</b><small>${esc(r.developer || '')}${r.genre ? ' · ' + esc(r.genre) : ''}</small></span>
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

  try {
    const [prices] = await Promise.all([
      getAppPrices(appId, countries, {
        force,
        onProgress: (done, total, cc) => {
          if (token !== state.loadToken) return;
          els.loadingText.textContent = `正在抓取各區價格… ${done}/${total}（${flagEmoji(cc)} ${countryName(cc)}）`;
        },
      }),
      ensureRates(),
    ]);
    if (token !== state.loadToken) return;
    state.prices = prices;
    if (!state.app.name && prices.name) {
      state.app.name = prices.name;
      renderAppHeader();
    }
    const { groups, baseline } = buildPlanGroups(prices.countries, countries);
    state.groups = groups;
    state.baseline = baseline;
    state.selectedPlanKey = pickDefaultPlan(groups);
    els.loadingBox.hidden = true;
    renderAll();
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
  renderMeta();
}

function renderPlanTabs() {
  const groups = state.groups;
  if (!groups.length) { els.planTabs.innerHTML = ''; return; }
  els.planTabs.innerHTML = groups.map((g) => `
    <button type="button" class="plantab" role="tab" data-key="${esc(g.key)}"
      aria-selected="${g.key === state.selectedPlanKey}">
      ${esc(g.name)}${g.period ? `<span class="plantab__period">/${periodLabel(g.period)}</span>` : ''}
    </button>`).join('');
  els.planTabs.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedPlanKey = btn.dataset.key;
      renderAll();
    });
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
    const anyUnavailable = countries.some((cc) => state.prices?.countries?.[cc]?.unavailable);
    els.board.innerHTML = `
      <div class="row-card row-card--muted" style="grid-template-columns:1fr">
        <div>${anyUnavailable
          ? '這個 App 在所選的儲存區找不到應用內購買項目（可能未上架或不提供訂閱）。'
          : '沒有解析到應用內購買項目 — 這個 App 可能沒有訂閱制項目，或頁面暫時抓不到。'}
        </div>
      </div>`;
    els.summaryBanner.hidden = true;
    return;
  }

  const rows = rankPlan(group, state.rates, target, feePct());
  const valid = rows.filter((r) => r.converted != null);
  const maxConv = valid.length ? Math.max(...valid.map((r) => r.converted)) : 1;

  const rowsHtml = rows.map((r, i) => {
    if (r.converted == null) {
      const cData = state.prices?.countries?.[r.country];
      const why = cData?.unavailable ? '未在此區上架'
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
  els.officialBox.className = `official glass${anyCheaper ? ' official--win' : ''}`;
  els.officialBox.innerHTML = `
    <div class="official__head">
      <h3>🌐 官網訂閱價</h3>
      <a class="official__link" href="${esc(o.url)}" target="_blank" rel="noopener">前往官網 →</a>
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
    live: '即時抓取', 'stale-cache': '過期快取',
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
  els.metaLine.innerHTML = html;
}

/* ---------------- 更新價格 ---------------- */

els.refreshBtn.addEventListener('click', async () => {
  if (!state.app?.appId) return;
  const pat = state.settings.githubPat?.trim();
  if (pat) triggerCloudCrawl(state.app.appId, pat); // 背景觸發，不等待
  await loadApp(state.app.appId, { force: true });
});

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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* ---------------- 啟動 ---------------- */

applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});
renderCurrencyLabel();
renderHistory();
route();
