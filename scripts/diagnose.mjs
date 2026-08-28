#!/usr/bin/env node
// 診斷工具 v3：dump information shelf 完整結構（tr / tw / tw?l=en-GB）
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const appId = process.argv[3] || '6448311069';

async function probe(label, url) {
  console.log(`\n########## ${label} → ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const html = await res.text();
  console.log(`status=${res.status} length=${html.length}`);
  const m = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) { console.log('!!! no serialized-server-data'); return; }
  const ssd = JSON.parse(m[1]);
  const d0 = ssd?.data?.[0]?.data || {};
  console.log('title =', JSON.stringify(d0.title));
  console.log('canonicalURL =', JSON.stringify(d0.canonicalURL));
  const info = d0.shelfMapping?.information;
  if (!info) { console.log('!!! no information shelf'); return; }
  console.log('information.$kind =', info.$kind, ' items:', (info.items || []).length);
  (info.items || []).forEach((row, i) => {
    const s = JSON.stringify(row);
    console.log(`--- items[${i}] (${s.length} chars): ${s.slice(0, 1400)}`);
  });
}

await probe('TR default', `https://apps.apple.com/tr/app/id${appId}`);
await probe('TW default', `https://apps.apple.com/tw/app/id${appId}`);
await probe('TW l=en-GB', `https://apps.apple.com/tw/app/id${appId}?l=en-GB`);
console.log('\n=== DONE');
