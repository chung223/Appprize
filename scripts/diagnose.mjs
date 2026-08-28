#!/usr/bin/env node
// 診斷工具 v2：定向挖掘 serialized-server-data 的 shelf 結構與 amp-api token
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
console.log(`status=${res.status} length=${html.length}`);

const m = html.match(
  /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i,
);
if (!m) {
  console.log('!!! serialized-server-data not found');
  process.exit(0);
}
const ssd = JSON.parse(m[1]);
const d0 = ssd?.data?.[0]?.data || {};
console.log('\n=== data[0].data KEYS:', Object.keys(d0).join(', '));
const sm = d0.shelfMapping || {};
console.log('=== shelfMapping KEYS:', Object.keys(sm).join(', '));

for (const key of Object.keys(sm)) {
  if (/subscription|inapp|in-app/i.test(key)) {
    console.log(`\n=== DUMP shelfMapping.${key}（前 6000 字）`);
    console.log(JSON.stringify(sm[key]).slice(0, 6000));
  }
}

// 全 JSON 找貨幣符號/price 字樣的字串值
console.log('\n=== STRING VALUES containing currency-ish text（最多 30）');
let hits = 0;
const seen = new Set();
(function walk(node, path) {
  if (hits >= 30 || !node) return;
  if (typeof node === 'string') {
    if (/[₺₹¥￥$€£₩]|per month|\/month|ay|month/i.test(node) && node.length < 120 && !seen.has(node)) {
      seen.add(node);
      hits++;
      console.log(`${path} = ${JSON.stringify(node)}`);
    }
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], `${path}.${k}`);
  }
})(d0, '$');

// 找 JS bundle 裡的 media-api token（amp-api 備援用）
console.log('\n=== TOKEN HUNT');
const assetM = html.match(/src="(\/assets\/index[^"]+\.js)"/);
console.log('asset:', assetM?.[1]);
if (assetM) {
  const assetRes = await fetch(`https://apps.apple.com${assetM[1]}`, {
    headers: { 'User-Agent': UA },
  });
  const js = await assetRes.text();
  console.log(`asset status=${assetRes.status} len=${js.length}`);
  const tokenM = js.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  console.log('jwt found:', tokenM ? `${tokenM[1].slice(0, 40)}…(len ${tokenM[1].length})` : 'NO');
  if (tokenM) {
    // 試打 amp-api 拿 IAP
    for (const host of ['amp-api-edge.apps.apple.com', 'amp-api.apps.apple.com']) {
      const apiUrl = `https://${host}/v1/catalog/${country}/apps/${appId}?platform=web&include=top-in-apps&fields=name,offers&l=en-GB`;
      try {
        const apiRes = await fetch(apiUrl, {
          headers: {
            'User-Agent': UA,
            Authorization: `Bearer ${tokenM[1]}`,
            Origin: 'https://apps.apple.com',
          },
        });
        const body = await apiRes.text();
        console.log(`\n=== AMP-API ${host} status=${apiRes.status}`);
        console.log(body.slice(0, 3000));
        if (apiRes.status === 200) break;
      } catch (e) {
        console.log(`amp-api ${host} error: ${e.message}`);
      }
    }
  }
}
console.log('\n=== DONE');
