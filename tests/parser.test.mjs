import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppId, extractCountry, parsePriceString, guessPeriod,
  parseAppPage, looksLikeNotFound, planKey,
} from '../docs/js/parser.js';

/* ---------------- extractAppId / extractCountry ---------------- */

test('extractAppId：各種輸入格式', () => {
  assert.equal(extractAppId('https://apps.apple.com/tr/app/chatgpt/id6448311069'), '6448311069');
  assert.equal(extractAppId('https://apps.apple.com/tw/app/id6448311069'), '6448311069');
  assert.equal(extractAppId('https://apps.apple.com/us/app/youtube-watch-listen-stream/id544007664?uo=4'), '544007664');
  assert.equal(extractAppId('https://itunes.apple.com/tw/app/foo/id123456789?mt=8'), '123456789');
  assert.equal(extractAppId('id6448311069'), '6448311069');
  assert.equal(extractAppId('6448311069'), '6448311069');
  assert.equal(extractAppId('ChatGPT'), null);
  assert.equal(extractAppId(''), null);
  assert.equal(extractAppId(null), null);
});

test('extractCountry', () => {
  assert.equal(extractCountry('https://apps.apple.com/tr/app/chatgpt/id6448311069'), 'tr');
  assert.equal(extractCountry('https://apps.apple.com/TW/app/id1'), 'tw');
  assert.equal(extractCountry('nope'), null);
});

/* ---------------- parsePriceString ---------------- */

test('parsePriceString：各地區價格格式', () => {
  assert.equal(parsePriceString('₺1.299,99', 'TRY'), 1299.99);
  assert.equal(parsePriceString('₺12,99', 'TRY'), 12.99);
  assert.equal(parsePriceString('₺1.299', 'TRY'), 1299);
  assert.equal(parsePriceString('₹8,900', 'INR'), 8900);
  assert.equal(parsePriceString('₹899.00', 'INR'), 899);
  assert.equal(parsePriceString('NT$650', 'TWD'), 650);
  assert.equal(parsePriceString('NT$1,590', 'TWD'), 1590);
  assert.equal(parsePriceString('US$19.99', 'USD'), 19.99);
  assert.equal(parsePriceString('$199.99', 'USD'), 199.99);
  assert.equal(parsePriceString('¥3,000', 'JPY'), 3000);
  assert.equal(parsePriceString('₩44,000', 'KRW'), 44000);
  assert.equal(parsePriceString('Rp 149.000', 'IDR'), 149000);
  assert.equal(parsePriceString('₫2.999.000', 'VND'), 2999000);
  assert.equal(parsePriceString('1 490,00 Ft', 'HUF'), 1490);
  assert.equal(parsePriceString('R$ 114,90', 'BRL'), 114.9);
  assert.equal(parsePriceString('1,00 €', 'EUR'), 1);
  assert.equal(parsePriceString('Free'), 0);
  assert.equal(parsePriceString('免費'), 0);
  assert.equal(parsePriceString('沒有數字'), null);
  assert.equal(parsePriceString(null), null);
});

test('guessPeriod', () => {
  assert.equal(guessPeriod('ChatGPT Plus Monthly'), 'monthly');
  assert.equal(guessPeriod('Premium (Annual)'), 'yearly');
  assert.equal(guessPeriod('Super Duolingo 1 Month'), 'monthly');
  assert.equal(guessPeriod('終身方案'), 'lifetime');
  assert.equal(guessPeriod('ChatGPT Plus'), null);
});

test('planKey：正規化配對鍵', () => {
  assert.equal(planKey('ChatGPT Plus'), planKey('  chatgpt   plus '));
  assert.equal(planKey('Premium - Family'), planKey('premium family'));
  // 不同層級不可混淆
  assert.notEqual(planKey('Premium+'), planKey('Premium'));
  assert.notEqual(planKey('Plus'), planKey('Pro'));
});

/* ---------------- parseAppPage：shoebox（fastboot 二次序列化） ---------------- */

function shoeboxPage({ price = 999.99, priceFormatted = '₺999,99', currencyCode = 'TRY' } = {}) {
  const amp = {
    d: [{
      id: '6448311069',
      type: 'apps',
      attributes: {
        name: 'ChatGPT',
        platformAttributes: { ios: {} },
        offers: [{ type: 'get', price: 0, priceFormatted: 'Get' }],
      },
      relationships: {
        'top-in-apps': {
          data: [
            {
              id: 'a1', type: 'top-in-apps',
              attributes: {
                name: 'ChatGPT Plus', offerName: 'chatgpt_plus_monthly',
                offers: [{ type: 'buy', price, priceFormatted, currencyCode }],
              },
            },
            {
              id: 'a2', type: 'top-in-apps',
              attributes: {
                name: 'ChatGPT Pro', offerName: 'chatgpt_pro_monthly',
                offers: [{ type: 'buy', price: price * 10, priceFormatted: '₺9.999,99', currencyCode }],
              },
            },
          ],
        },
      },
    }],
  };
  const shoebox = JSON.stringify({
    'https://amp-api.apps.apple.com/v1/catalog/tr/apps/6448311069': JSON.stringify(amp),
  });
  return `<!DOCTYPE html><html><head>
    <title>‎ChatGPT on the App Store</title>
    <meta property="og:title" content="‎ChatGPT" />
    <meta property="og:image" content="https://example.mzstatic.com/icon.png" />
    <link rel="canonical" href="https://apps.apple.com/tr/app/chatgpt/id6448311069" />
    </head><body>
    <script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">${shoebox}</script>
    </body></html>`;
}

test('parseAppPage：shoebox 世代', () => {
  const r = parseAppPage(shoeboxPage(), { country: 'tr', currency: 'TRY' });
  assert.equal(r.appId, '6448311069');
  assert.equal(r.country, 'tr');
  assert.equal(r.source, 'embedded-json');
  assert.equal(r.inApps.length, 2);
  const plus = r.inApps.find((i) => i.name === 'ChatGPT Plus');
  assert.ok(plus);
  assert.equal(plus.price, 999.99);
  assert.equal(plus.currency, 'TRY');
  // app 本身的 GET offer 不應出現
  assert.ok(!r.inApps.some((i) => i.price === 0));
});

test('parseAppPage：offers 無數字 price 時退回 priceFormatted 解析', () => {
  const html = shoeboxPage().replace(/"price":999.99,/, '');
  const r = parseAppPage(html, { country: 'tr', currency: 'TRY' });
  const plus = r.inApps.find((i) => i.name === 'ChatGPT Plus');
  assert.ok(plus);
  assert.equal(plus.price, 999.99); // 從 "₺999,99" 解析
});

/* ---------------- parseAppPage：serialized-server-data（2026 實際結構） ---------------- */
// 依 2026-08 真實頁面：data[0].data.shelfMapping.information.items[] 的 Annotation 列，
// title 為「In-App Purchases」（tw:「App內購買」），textPairs = [[名稱, 價格], …]

function realServerDataPage({ country = 'tr', useV3Only = false } = {}) {
  const pairs = country === 'tw'
    ? [['ChatGPT Plus', '$690.00'], ['ChatGPT Go', '$270.00'], ['ChatGPT Pro 5x', '$3,300.00'], ['ChatGPT Pro 20x', '$6,990.00'], ['ChatGPT Plus', '$6,990.00']]
    : [['ChatGPT Plus', '₺999,99'], ['ChatGPT Go', '₺249,99'], ['ChatGPT Pro 5x', '₺5.299,99'], ['ChatGPT Pro 20x', '₺9.999,99'], ['ChatGPT Plus', '₺9.999,99']];
  const iapRow = {
    $kind: 'Annotation',
    title: country === 'tw' ? 'App內購買' : 'In-App Purchases',
    summary: country === 'tw' ? '是' : 'Yes',
    items: useV3Only ? [] : [{ $kind: 'AnnotationItem', textPairs: pairs }],
    items_V3: pairs.map(([l, t]) => ({ $kind: 'textPair', leadingText: l, trailingText: t })),
  };
  const ssd = {
    data: [{
      intent: { storefront: country, $kind: 'ProductPageIntent' },
      data: {
        $kind: 'Product',
        title: 'ChatGPT',
        canonicalURL: `https://apps.apple.com/${country}/app/chatgpt/id6448311069`,
        shelfMapping: {
          information: {
            $kind: 'Shelf',
            items: [
              { $kind: 'Annotation', title: country === 'tw' ? '供應商' : 'Provider', items: [{ $kind: 'AnnotationItem', text: 'OpenAI OpCo, LLC' }] },
              { $kind: 'Annotation', title: country === 'tw' ? '大小' : 'Size', items: [{ $kind: 'AnnotationItem', text: '216.7 MB' }] },
              iapRow,
              { $kind: 'Annotation', title: 'Copyright', items: [{ $kind: 'AnnotationItem', text: '© 2026 OpenAI' }] },
            ],
          },
        },
      },
    }],
  };
  return `<html><head><title>‎ChatGPT on the App Store</title></head><body>
    <script type="application/json" id="serialized-server-data">${JSON.stringify(ssd)}</script>
    </body></html>`;
}

test('parseAppPage：2026 serialized-server-data（土耳其）', () => {
  const r = parseAppPage(realServerDataPage({ country: 'tr' }), { country: 'tr', currency: 'TRY' });
  assert.equal(r.source, 'server-data-pairs');
  assert.equal(r.appId, '6448311069');
  assert.equal(r.name, 'ChatGPT');
  assert.equal(r.inApps.length, 5); // 同名不同價（月/年）都要保留
  const plus = r.inApps.filter((i) => i.name === 'ChatGPT Plus');
  assert.deepEqual(plus.map((p) => p.price).sort((a, b) => a - b), [999.99, 9999.99]);
  const pro5 = r.inApps.find((i) => i.name === 'ChatGPT Pro 5x');
  assert.equal(pro5.price, 5299.99);
  assert.equal(pro5.currency, 'TRY');
  // Size 216.7 MB 不能混進來
  assert.ok(!r.inApps.some((i) => /MB/.test(i.priceFormatted)));
});

test('parseAppPage：2026 serialized-server-data（台灣，「App內購買」＋ $690.00 格式）', () => {
  const r = parseAppPage(realServerDataPage({ country: 'tw' }), { country: 'tw', currency: 'TWD' });
  assert.equal(r.source, 'server-data-pairs');
  const go = r.inApps.find((i) => i.name === 'ChatGPT Go');
  assert.equal(go.price, 270);
  const pro20 = r.inApps.find((i) => i.name === 'ChatGPT Pro 20x');
  assert.equal(pro20.price, 6990); // "$6,990.00" → 6990（TWD 無小數）
});

/* ---------------- 買斷售價（付費 App） ---------------- */

function paidAppPage({ price = 6.99, currency = 'USD', withSsd = false } = {}) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Minecraft',
    offers: { '@type': 'Offer', price, priceCurrency: currency },
  };
  const ssd = withSsd ? `<script type="application/json" id="serialized-server-data">${JSON.stringify({
    data: [{ data: {
      title: 'Minecraft',
      canonicalURL: 'https://apps.apple.com/us/app/minecraft/id479516143',
      titleOfferDisplayProperties: { isFree: false, titles: { standard: '$6.99' } },
      shelfMapping: { information: { items: [
        { $kind: 'Annotation', title: 'Provider', items: [{ $kind: 'AnnotationItem', text: 'Mojang' }] },
      ] } },
    } }],
  })}</script>` : '';
  return `<html><head><title>Minecraft on the App Store</title></head><body>
    <script id="software-application" type="application/ld+json">${JSON.stringify(ld)}</script>
    ${ssd}</body></html>`;
}

test('parseAppPage：付費 App 買斷售價（LD+JSON）', () => {
  const r = parseAppPage(paidAppPage(), { country: 'us', currency: 'USD' });
  assert.ok(r.appPrice);
  assert.equal(r.appPrice.price, 6.99);
  assert.equal(r.appPrice.currency, 'USD');
});

test('parseAppPage：免費 App 的 appPrice 為 0', () => {
  const r = parseAppPage(paidAppPage({ price: 0 }), { country: 'us', currency: 'USD' });
  assert.equal(r.appPrice.price, 0);
});

test('parseAppPage：LD+JSON 缺席時退回 serialized-server-data 購買鈕價格', () => {
  const html = paidAppPage({ withSsd: true })
    .replace(/<script id="software-application"[\s\S]*?<\/script>/, '');
  const r = parseAppPage(html, { country: 'us', currency: 'USD' });
  assert.ok(r.appPrice);
  assert.equal(r.appPrice.price, 6.99);
  assert.equal(r.appPrice.currency, 'USD'); // 從 fallbackCurrency 補上
});

test('parseAppPage：只有 items_V3 textPair（無 textPairs）也能解析', () => {
  const r = parseAppPage(realServerDataPage({ country: 'tr', useV3Only: true }), { country: 'tr', currency: 'TRY' });
  assert.equal(r.source, 'server-data-pairs');
  assert.equal(r.inApps.length, 5);
});

/* ---------------- parseAppPage：serialized-server-data 世代 ---------------- */

test('parseAppPage：serialized-server-data 世代', () => {
  const data = [{
    intent: {},
    data: {
      sections: [{
        items: [{
          title: 'In-App Purchases',
          items: [
            { name: 'Premium Monthly', offers: [{ price: 259, priceFormatted: 'NT$259', currencyCode: 'TWD' }] },
            { name: 'Premium Yearly', offers: [{ price: 2590, priceFormatted: 'NT$2,590', currencyCode: 'TWD' }] },
          ],
        }],
      }],
    },
  }];
  const html = `<html><head>
    <link rel="canonical" href="https://apps.apple.com/tw/app/youtube/id544007664" />
    </head><body>
    <script id="serialized-server-data" type="application/json">${JSON.stringify(data)}</script>
    </body></html>`;
  const r = parseAppPage(html, { country: 'tw', currency: 'TWD' });
  assert.equal(r.source, 'embedded-json');
  assert.equal(r.inApps.length, 2);
  assert.equal(r.inApps[0].price, 259);
  assert.equal(r.inApps[1].period, 'yearly');
});

/* ---------------- parseAppPage：HTML 清單備援 ---------------- */

test('parseAppPage：HTML 清單備援', () => {
  const html = `<html><head><title>Spotify on the App Store</title></head><body>
    <dl><dt>In-App Purchases</dt><dd>
    <ol>
      <li class="list-with-numbers__item">
        <span class="truncate-single-line">Premium</span>
        <span class="list-with-numbers__item__price medium-show-tablecell">NT$149</span>
      </li>
      <li class="list-with-numbers__item">
        <span class="truncate-single-line">Premium &amp; Family</span>
        <span class="list-with-numbers__item__price medium-show-tablecell">NT$268</span>
      </li>
    </ol></dd></dl></body></html>`;
  const r = parseAppPage(html, { country: 'tw', currency: 'TWD' });
  assert.equal(r.source, 'html-list');
  assert.equal(r.inApps.length, 2);
  assert.equal(r.inApps[0].name, 'Premium');
  assert.equal(r.inApps[0].price, 149);
  assert.equal(r.inApps[1].name, 'Premium & Family');
  assert.equal(r.inApps[1].price, 268);
});

test('parseAppPage：沒有 IAP 的頁面回傳空清單', () => {
  const html = '<html><head><title>Foo on the App Store</title></head><body>nothing here</body></html>';
  const r = parseAppPage(html, { country: 'tw', currency: 'TWD' });
  assert.equal(r.inApps.length, 0);
  assert.equal(r.source, null);
});

test('looksLikeNotFound', () => {
  assert.equal(looksLikeNotFound('anything', 404), true);
  // 空白回應是暫時性失敗，不可誤標成「未上架」而覆蓋好資料
  assert.equal(looksLikeNotFound('', 200), false);
  assert.equal(looksLikeNotFound(shoeboxPage(), 200), false);
});

test('parsePriceString：瑞士撇號千分位', () => {
  assert.equal(parsePriceString("CHF 1'299.00", 'CHF'), 1299);
});

test('extractAppId：無儲存區短連結', () => {
  assert.equal(extractAppId('https://apps.apple.com/app/id6448311069'), '6448311069');
});
