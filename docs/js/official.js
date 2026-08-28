// 官網訂閱價（人工整理的 curated 資料）：docs/data/official/index.json
// 官網價會隨時間變動，資料附 updatedAt 與來源連結，顯示時註明「以官網為準」。

let cache = null;

export async function loadOfficialIndex() {
  if (cache) return cache;
  try {
    const url = new URL('./data/official/index.json', document.baseURI).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return (cache = { updatedAt: null, apps: {} });
    cache = await res.json();
  } catch {
    cache = { updatedAt: null, apps: {} };
  }
  return cache;
}

/** 取得某 app 的官網價資料；沒有則回傳 null */
export async function getOfficialPricing(appId) {
  const idx = await loadOfficialIndex();
  return idx.apps?.[String(appId)] || null;
}
