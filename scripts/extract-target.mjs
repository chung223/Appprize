#!/usr/bin/env node
// 從 workflow 事件輸入萃取要爬的 app id 與國家清單（寫入 GITHUB_OUTPUT）。
// issue 標題/內文是外部輸入：只經環境變數讀取，並以嚴格正規表達式萃取，防止指令注入。

import { appendFileSync } from 'node:fs';

const pickId = (s) => {
  const m = String(s || '').match(/id(\d{6,12})|\b(\d{6,12})\b/);
  return m ? m[1] || m[2] : '';
};

const env = process.env;
let appId = '';
let countries = '';

if (env.EVENT_NAME === 'issues') {
  appId = pickId(env.ISSUE_TITLE) || pickId(env.ISSUE_BODY);
} else if (env.EVENT_NAME === 'workflow_dispatch') {
  appId = pickId(env.INPUT_APP_ID);
  countries = String(env.INPUT_COUNTRIES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s))
    .join(',');
}

const out = `app_id=${appId}\ncountries=${countries}\n`;
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out);
console.log(out);
