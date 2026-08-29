import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchText } from '../docs/js/api.js';

const realFetch = globalThis.fetch;

test('fetchText：對沖賽跑 — 第一個 proxy 慢時第二個補位取勝', async () => {
  const calls = [];
  let aborted = 0;
  globalThis.fetch = (url, opts) => {
    calls.push(url);
    if (calls.length === 1) {
      return new Promise((_, rej) => {
        opts.signal.addEventListener('abort', () => { aborted++; rej(new Error('aborted')); });
      });
    }
    return Promise.resolve(new Response('serialized-server-data ok', { status: 200 }));
  };
  try {
    const r = await fetchText('https://apps.apple.com/tw/app/id1', {
      viaProxy: true, hedgeMs: 25, timeout: 1000,
    });
    assert.equal(r.status, 200);
    assert.ok(calls.length >= 2, '對沖應啟動第二個請求');
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(aborted >= 1, '勝出後其餘請求應被中止');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchText：4xx/5xx 垃圾回應視同失敗，立即換下一個', async () => {
  let n = 0;
  globalThis.fetch = () => {
    n++;
    if (n === 1) return Promise.resolve(new Response('bad gateway', { status: 502 }));
    return Promise.resolve(new Response('good', { status: 200 }));
  };
  try {
    const r = await fetchText('u', { viaProxy: true, hedgeMs: 5000, timeout: 1000 });
    assert.equal(r.text, 'good');
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchText：自訂 validate 失敗也會換手', async () => {
  let n = 0;
  globalThis.fetch = () => {
    n++;
    return Promise.resolve(new Response(n === 1 ? 'garbage page' : 'has-marker', { status: 200 }));
  };
  try {
    const r = await fetchText('u', {
      viaProxy: true, hedgeMs: 5000, timeout: 1000,
      validate: (t) => t.includes('has-marker'),
    });
    assert.equal(r.text, 'has-marker');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchText：全部失敗時 reject', async () => {
  globalThis.fetch = () => Promise.reject(new Error('nope'));
  try {
    await assert.rejects(fetchText('u', { viaProxy: true, hedgeMs: 10, timeout: 200 }));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchText：非 proxy 模式單一請求', async () => {
  let n = 0;
  globalThis.fetch = () => {
    n++;
    return Promise.resolve(new Response('direct', { status: 200 }));
  };
  try {
    const r = await fetchText('https://example.com/x', { timeout: 500 });
    assert.equal(r.text, 'direct');
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
