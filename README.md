# AppPrize — 跨區訂閱比價

<p align="center">
  <img src="docs/icons/icon-192.png" width="96" alt="AppPrize icon" />
</p>

貼上 App Store 連結（或輸入 App 名稱），**AppPrize** 自動比較各國儲存區的訂閱價格，
換算成新台幣（可切換其他幣別）排出「哪一區最省」，還會告訴你 **直接從官網訂閱是不是更便宜**。

> 名字由來：**App + Prize/Price** 雙關 — 幫你的 App 訂閱找到「最划算的那個價格」。

- 🌏 一次比較台灣／土耳其／印度／美國／日本（可自由增減 40+ 國）
- 💱 每日匯率自動換算，預設新台幣，可切換 USD/JPY/EUR 等
- 🌐 內建熱門服務的**官網訂閱價**對照（ChatGPT、YouTube Premium、Spotify…）
- 🤖 **GitHub Actions 每日自動爬價**，快照存在 repo 內當雲端快取
- 📦 查過的 App 快取在本機，過期自動重抓
- 📱 PWA：可安裝到手機主畫面、離線可看快取結果
- 🧊 Liquid Glass 視覺：極光背景、毛玻璃卡片、鏡面高光

## 運作方式

```
┌──────────────┐   ①貼連結/搜尋    ┌──────────────────────────┐
│   使用者      │ ───────────────▶ │  AppPrize PWA (GitHub Pages) │
└──────────────┘                  └──────┬───────────────────┘
                                         │ ②讀取順序
                       ┌─────────────────┼──────────────────┐
                       ▼                 ▼                  ▼
                本機快取(localStorage)  repo 快照(docs/data)  即時抓取(CORS proxy)
                       ▲                 ▲
                       │                 │ ③每日 03:00 台北時間
                       │          ┌──────┴────────┐
                       └──────────│ GitHub Actions │──▶ apps.apple.com/{國家}/app/id{ID}
                                  │  crawl.yml     │──▶ 匯率 API
                                  └───────────────┘
```

價格資料的取得順序：**本機快取（新鮮）→ repo 快照（Actions 爬的）→ 瀏覽器透過 CORS proxy 即時抓**。
三層都失敗才會顯示錯誤，過期資料會標示「快取」並提供一鍵更新。

## 啟用步驟（fork 或首次使用）

1. **開啟 GitHub Pages**：repo → Settings → Pages → Source 選「Deploy from a branch」，
   Branch 選預設分支、資料夾選 `/docs`，儲存。網址會是 `https://<帳號>.github.io/Appprize/`。
2. **啟用 Actions**：repo → Actions 頁籤，若有提示按「Enable workflows」。
3. **跑第一次爬蟲**：Actions → `crawl` → Run workflow（留空 = 抓 registry 內全部 app）。
   之後每天 03:00（台北時間）自動更新。

## 怎麼新增要追蹤的 App？

三種方式：

| 方式 | 說明 | 會加入每日排程？ |
|---|---|---|
| 網站上直接查 | 前端即時透過 proxy 抓價並快取在本機（不會進 repo） | 否 |
| Actions 手動觸發 | Actions → crawl → Run workflow → 填 App ID | 會（自動加入 registry） |
| 開 issue | 標題填 `[crawl] id6448311069` 或貼 App Store 連結（限 repo 擁有者），機器人抓完會自動回覆並關閉 | 會（自動加入 registry） |

進階：在網站「設定」貼上一組 GitHub fine-grained token（只需要此 repo 的
`Actions: Read and write` 權限），之後按「更新價格」就會順手觸發雲端爬蟲。Token 只存在瀏覽器本機。

## 本機開發

```bash
npm run serve          # 本機預覽 http://localhost:3000
npm test               # 單元測試（parser / 匯率 / 比較邏輯）
npm run crawl -- --apps 6448311069 --countries tw,tr,in   # 本機試爬
npm run icons          # 重新產生 PWA icon
```

## 資料結構

- `docs/data/registry.json` — 追蹤清單與預設國家
- `docs/data/apps/{id}.json` — 各 App 的跨區價格快照（爬蟲產出）
- `docs/data/fx.json` — 匯率快照（USD 基準，爬蟲產出）
- `docs/data/official/index.json` — **官網訂閱價（人工整理）**，歡迎直接編輯此檔擴充

### 官網價格式

```jsonc
"6448311069": {
  "name": "ChatGPT",
  "url": "https://chatgpt.com/pricing",
  "plans": [
    { "match": "plus",            // 以小寫關鍵字對應 App Store 方案名
      "name": "ChatGPT Plus（官網）",
      "price": 20, "currency": "USD", "period": "monthly" }
  ]
}
```

## 自訂 CORS Proxy（選用）

公用 proxy 偶爾不穩。部署一個 15 行的 Cloudflare Worker 就有自己的專屬 proxy：

```js
export default {
  async fetch(req) {
    const url = new URL(req.url).searchParams.get('url');
    if (!url || !/^https:\/\/(apps|itunes)\.apple\.com\//.test(url))
      return new Response('bad url', { status: 400 });
    const res = await fetch(url, { headers: { 'User-Agent': req.headers.get('User-Agent') || '' } });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html',
                 'Access-Control-Allow-Origin': '*' },
    });
  },
};
```

部署後在網站「設定 → 自訂 CORS Proxy」填 `https://<你的worker>.workers.dev/?url={url}`。

## 注意事項

- App Store 顯示的是各儲存區「上架價」；要以他區價格訂閱，需要該區 Apple 帳號，部分地區另計稅金。
- 外幣刷卡通常有約 1.5% 國際交易手續費，可在設定中納入比較。
- 匯率為每日參考匯率；官網價為人工整理，皆以實際帳單／官網為準。
- 爬蟲頻率為每日一次 + 手動觸發，對 Apple 網站保持禮貌間隔，請勿改成高頻輪詢。

## 授權

MIT
