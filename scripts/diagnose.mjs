#!/usr/bin/env node
// 診斷工具：抓一個 App Store 頁面，印出結構分析（在 GitHub Actions log 中閱讀）
// 用法：node scripts/diagnose.mjs <country> <appId>

const [, , country = 'tr', appId = '6448311069'] = process.argv;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const url = `https://apps.apple.com/${country}/app/id${appId}`;
console.log(`=== FETCH ${url}`);
const res = await fetch(url, {
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8' },
  redirect: 'follow',
});
const html = await res.text();
console.log(`status=${res.status} length=${html.length} finalUrl=${res.url}`);

// 1. 所有 script 標籤的屬性
console.log('\n=== SCRIPT TAGS');
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
const blobs = [];
while ((m = scriptRe.exec(html))) {
  const attrs = m[1].trim();
  const body = (m[2] || '').trim();
  console.log(`- attrs=[${attrs.slice(0, 120)}] bodyLen=${body.length} head=${JSON.stringify(body.slice(0, 100))}`);
  if (body && (body[0] === '{' || body[0] === '[')) {
    try { blobs.push({ attrs, json: JSON.parse(body) }); } catch { console.log('  (JSON parse failed)'); }
  }
}

// 2. 深度展開後掃描含價格關鍵字的路徑
function deepParse(node, depth = 0) {
  if (depth > 40) return node;
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

const HIT_KEY = /offer|price|inApp|in-app|subscription|purchas/i;
let printed = 0;
function scan(node, path) {
  if (printed > 80 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scan(v, `${path}[${i}]`));
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (HIT_KEY.test(k)) {
      printed++;
      const snip = JSON.stringify(v);
      console.log(`${path}.${k} = ${snip ? snip.slice(0, 400) : String(v)}`);
    }
    scan(v, `${path}.${k}`);
  }
}

console.log('\n=== PRICE-ISH JSON PATHS（每 blob 最多 80 筆）');
blobs.forEach((b, i) => {
  printed = 0;
  console.log(`--- blob#${i} [${b.attrs.slice(0, 80)}]`);
  scan(deepParse(b.json), '$');
});

// 3. HTML 中 In-App 區塊
console.log('\n=== RAW HTML AROUND "In-App"');
for (const kw of ['In-App', 'App 內購買', 'list-with-numbers', 'information-list']) {
  const idx = html.indexOf(kw);
  console.log(`--- keyword ${JSON.stringify(kw)} @ ${idx}`);
  if (idx >= 0) {
    console.log(html.slice(Math.max(0, idx - 200), idx + 1800).replace(/\s+/g, ' ').slice(0, 2000));
  }
}

// 4. raw priceFormatted 出現處
console.log('\n=== RAW "priceFormatted" OCCURRENCES');
let pos = 0;
for (let i = 0; i < 5; i++) {
  const idx = html.indexOf('priceFormatted', pos);
  if (idx < 0) break;
  console.log(`@${idx}: ${JSON.stringify(html.slice(Math.max(0, idx - 150), idx + 300))}`);
  pos = idx + 1;
}
console.log('\n=== DONE');
