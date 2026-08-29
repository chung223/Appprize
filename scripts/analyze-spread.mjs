#!/usr/bin/env node
// 跨區價差分析：讀取 docs/data 的快照與匯率，列出每個 app 主要方案的
// 最便宜區 vs 台灣（換算 TWD）。開發/報告用。
// 用法：node scripts/analyze-spread.mjs [target=TWD]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanGroups, buildAppPriceGroup, rankPlan } from '../docs/js/compare.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'data');
const target = (process.argv[2] || 'TWD').toUpperCase();
const fx = JSON.parse(readFileSync(join(DATA, 'fx.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(DATA, 'registry.json'), 'utf8'));
const countries = registry.countries;

const rows = [];
for (const f of readdirSync(join(DATA, 'apps'))) {
  if (!f.endsWith('.json')) continue;
  const app = JSON.parse(readFileSync(join(DATA, 'apps', f), 'utf8'));
  const { groups } = buildPlanGroups(app.countries, countries);
  const pg = buildAppPriceGroup(app.countries, countries);
  if (pg) groups.unshift(pg);
  if (!groups.length) {
    rows.push({ name: app.name, note: '無 IAP／未上架' });
    continue;
  }
  // 主要方案：涵蓋國家最多，同數取最貴（同前端 pickDefaultPlan）
  const score = (g) => Object.keys(g.entries).length * 1000
    + Math.min(999, Math.max(...Object.values(g.entries).map((e) => e.price || 0)));
  const main = [...groups].sort((a, b) => score(b) - score(a))[0];
  const ranked = rankPlan(main, fx.rates, target, 0).filter((r) => r.converted != null);
  if (!ranked.length) { rows.push({ name: app.name, note: '無法換算' }); continue; }
  const best = ranked[0];
  const tw = ranked.find((r) => r.country === 'tw');
  rows.push({
    name: app.name,
    plan: main.name,
    best: `${best.country} ${Math.round(best.converted)}`,
    tw: tw ? Math.round(tw.converted) : null,
    savePct: tw && tw.converted > 0 ? Math.round((1 - best.converted / tw.converted) * 100) : null,
  });
}

rows.sort((a, b) => (b.savePct ?? -1) - (a.savePct ?? -1));
for (const r of rows) {
  if (r.note) { console.log(`${(r.name || '?').padEnd(28)} ${r.note}`); continue; }
  console.log(
    `${(r.name || '?').slice(0, 26).padEnd(28)}`
    + `${(r.plan || '').slice(0, 24).padEnd(26)}`
    + `最省 ${r.best.padEnd(12)}`
    + (r.tw != null ? `台灣 ${String(r.tw).padEnd(8)}` : '台灣 —      ')
    + (r.savePct != null ? `省 ${r.savePct}%` : ''),
  );
}
