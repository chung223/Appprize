#!/usr/bin/env node
// 從 workflow 事件輸入萃取要爬的 app id 與國家清單（寫入 GITHUB_OUTPUT）。
// issue 標題/內文是外部輸入：只經環境變數讀取，並以嚴格正規表達式萃取，防止指令注入。
// 為避免內文中任何無關數字被誤認成 app id 而永久進入 registry，
// 只接受「id123…」形式或 App Store 連結，或標題整體為「[crawl] 123…」。

import { appendFileSync } from 'node:fs';

const idFrom = (s) => {
  const str = String(s || '');
  let m = str.match(/apps\.apple\.com\/[^\s]*?\bid(\d{6,12})\b/i);
  if (m) return m[1];
  m = str.match(/\bid(\d{6,12})\b/i);
  if (m) return m[1];
  return '';
};

const env = process.env;
let appId = '';
let countries = '';
let skip = '';

if (env.EVENT_NAME === 'issues') {
  appId = idFrom(env.ISSUE_TITLE)
    || (env.ISSUE_TITLE || '').match(/^\s*\[crawl\]\s*(\d{6,12})\s*$/)?.[1]
    || idFrom(env.ISSUE_BODY);
  if (!appId) skip = 'true'; // issue 沒有有效 id：不要抓整份 registry
} else if (env.EVENT_NAME === 'workflow_dispatch') {
  appId = idFrom(env.INPUT_APP_ID)
    || (String(env.INPUT_APP_ID || '').match(/^\s*(\d{6,12})\s*$/)?.[1] ?? '');
  countries = String(env.INPUT_COUNTRIES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s))
    .join(',');
}

const out = `app_id=${appId}\ncountries=${countries}\nskip=${skip}\n`;
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out);
console.log(out);
