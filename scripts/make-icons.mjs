#!/usr/bin/env node
// 產生 PWA icon（零依賴：手寫 PNG 編碼 + SDF 繪圖）
// 設計：藍紫漸層圓角方塊 + 旋轉 45° 的白色價格標籤 + 頂部鏡面高光
// 用法：node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');
mkdirSync(OUT, { recursive: true });

/* ---------- PNG 編碼 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 繪圖 ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 漸層色票（同 favicon.svg）
const STOPS = [
  { t: 0.0, c: [0x67, 0xe8, 0xf9] },
  { t: 0.55, c: [0x38, 0xbd, 0xf8] },
  { t: 1.0, c: [0xa7, 0x8b, 0xfa] },
];

function gradientAt(t) {
  const tt = clamp01(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (tt <= STOPS[i].t) {
      const k = (tt - STOPS[i - 1].t) / (STOPS[i].t - STOPS[i - 1].t);
      return [0, 1, 2].map((j) => lerp(STOPS[i - 1].c[j], STOPS[i].c[j], k));
    }
  }
  return STOPS[STOPS.length - 1].c;
}

function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * 畫一顆 icon。
 * @param {number} size 邊長
 * @param {{rounded?: boolean, glyphScale?: number, opaque?: boolean}} opts
 *   rounded：透明背景 + 圓角方塊；否則滿版方形
 *   glyphScale：標籤大小相對比例（maskable 用 0.7 留安全區）
 */
function drawIcon(size, { rounded = true, glyphScale = 0.92, opaque = false } = {}) {
  const S = 2; // 2x 超取樣
  const N = size * S;
  const rgba = Buffer.alloc(size * size * 4);
  const cornerR = rounded ? N * 0.225 : 0;
  const cx = N / 2;
  const cy = N / 2;
  // 標籤（旋轉 45° 的圓角方塊）
  const tagHalf = N * 0.23 * glyphScale;
  const tagR = tagHalf * 0.28;
  const holeR = N * 0.055 * glyphScale;
  const holeOff = -tagHalf * 0.52;
  const cos = Math.SQRT1_2;

  const acc = new Float64Array(size * size * 4);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // 背景
      let r, g, b, a;
      const bgSdf = rounded
        ? roundedRectSDF(px, py, cx, cy, N / 2 - 1, N / 2 - 1, cornerR)
        : -1;
      const bgCov = clamp01(0.5 - bgSdf); // 抗鋸齒
      if (bgCov <= 0 && !opaque) {
        continue; // 透明像素
      }
      const t = (px + py) / (2 * N);
      [r, g, b] = gradientAt(t);
      a = opaque ? 1 : bgCov;

      // 頂部鏡面高光（上緣 40% 內線性淡出）
      const sheen = clamp01(1 - py / (N * 0.42)) * 0.22;
      r = lerp(r, 255, sheen);
      g = lerp(g, 255, sheen);
      b = lerp(b, 255, sheen);

      // 標籤：把座標反轉 45° 後做圓角方塊 SDF
      const rx = cos * (px - cx) + cos * (py - cy);
      const ry = -cos * (px - cx) + cos * (py - cy);
      const tagSdf = roundedRectSDF(rx, ry, 0, 0, tagHalf, tagHalf, tagR);
      const tagCov = clamp01(0.5 - tagSdf) * 0.94;
      if (tagCov > 0) {
        r = lerp(r, 255, tagCov);
        g = lerp(g, 255, tagCov);
        b = lerp(b, 255, tagCov);
        // 標籤上的圓孔（露出漸層藍）
        const holeSdf = Math.hypot(rx - holeOff, ry - holeOff) - holeR;
        const holeCov = clamp01(0.5 - holeSdf);
        if (holeCov > 0) {
          const [hr, hg, hb] = gradientAt(0.45);
          r = lerp(r, hr, holeCov);
          g = lerp(g, hg, holeCov);
          b = lerp(b, hb, holeCov);
        }
      }

      const ix = (px / S) | 0;
      const iy = (py / S) | 0;
      const o = (iy * size + ix) * 4;
      acc[o] += r * a;
      acc[o + 1] += g * a;
      acc[o + 2] += b * a;
      acc[o + 3] += a;
    }
  }

  const samples = S * S;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const aSum = acc[o + 3];
    const aOut = aSum / samples;
    if (aOut <= 0) continue;
    rgba[o] = Math.round(acc[o] / aSum);
    rgba[o + 1] = Math.round(acc[o + 1] / aSum);
    rgba[o + 2] = Math.round(acc[o + 2] / aSum);
    rgba[o + 3] = Math.round(aOut * 255);
  }
  return encodePng(size, size, rgba);
}

const targets = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['maskable-512.png', 512, { rounded: false, opaque: true, glyphScale: 0.7 }],
  ['apple-touch-icon.png', 180, { rounded: false, opaque: true, glyphScale: 0.85 }],
];

for (const [name, size, opts] of targets) {
  const png = drawIcon(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`✓ ${name} (${size}×${size}, ${png.length} bytes)`);
}
