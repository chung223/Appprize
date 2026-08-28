// App Store 儲存區（storefront）資料表：國碼 → 幣別 / 中文名稱
// 幣別以 Apple 各儲存區實際計價幣別為準；若頁面資料含 currencyCode 會以頁面為準。
// 注意：部分小型市場 Apple 以 USD 計價（如阿根廷、烏克蘭）。

export const STOREFRONTS = {
  tw: { currency: 'TWD', zh: '台灣' },
  tr: { currency: 'TRY', zh: '土耳其' },
  in: { currency: 'INR', zh: '印度' },
  us: { currency: 'USD', zh: '美國' },
  jp: { currency: 'JPY', zh: '日本' },
  ng: { currency: 'NGN', zh: '奈及利亞' },
  br: { currency: 'BRL', zh: '巴西' },
  ph: { currency: 'PHP', zh: '菲律賓' },
  my: { currency: 'MYR', zh: '馬來西亞' },
  id: { currency: 'IDR', zh: '印尼' },
  vn: { currency: 'VND', zh: '越南' },
  th: { currency: 'THB', zh: '泰國' },
  kr: { currency: 'KRW', zh: '韓國' },
  hk: { currency: 'HKD', zh: '香港' },
  cn: { currency: 'CNY', zh: '中國' },
  sg: { currency: 'SGD', zh: '新加坡' },
  gb: { currency: 'GBP', zh: '英國' },
  de: { currency: 'EUR', zh: '德國' },
  fr: { currency: 'EUR', zh: '法國' },
  it: { currency: 'EUR', zh: '義大利' },
  es: { currency: 'EUR', zh: '西班牙' },
  nl: { currency: 'EUR', zh: '荷蘭' },
  pl: { currency: 'PLN', zh: '波蘭' },
  se: { currency: 'SEK', zh: '瑞典' },
  no: { currency: 'NOK', zh: '挪威' },
  dk: { currency: 'DKK', zh: '丹麥' },
  ch: { currency: 'CHF', zh: '瑞士' },
  cz: { currency: 'CZK', zh: '捷克' },
  hu: { currency: 'HUF', zh: '匈牙利' },
  ro: { currency: 'RON', zh: '羅馬尼亞' },
  bg: { currency: 'BGN', zh: '保加利亞' },
  eg: { currency: 'EGP', zh: '埃及' },
  za: { currency: 'ZAR', zh: '南非' },
  sa: { currency: 'SAR', zh: '沙烏地阿拉伯' },
  ae: { currency: 'AED', zh: '阿聯' },
  il: { currency: 'ILS', zh: '以色列' },
  mx: { currency: 'MXN', zh: '墨西哥' },
  cl: { currency: 'CLP', zh: '智利' },
  co: { currency: 'COP', zh: '哥倫比亞' },
  pe: { currency: 'PEN', zh: '秘魯' },
  ar: { currency: 'USD', zh: '阿根廷' },
  ua: { currency: 'USD', zh: '烏克蘭' },
  ca: { currency: 'CAD', zh: '加拿大' },
  au: { currency: 'AUD', zh: '澳洲' },
  nz: { currency: 'NZD', zh: '紐西蘭' },
  pk: { currency: 'PKR', zh: '巴基斯坦' },
  kz: { currency: 'KZT', zh: '哈薩克' },
};

// 預設比較的儲存區（使用者目前常用：台灣／土耳其／印度）
export const DEFAULT_COUNTRIES = ['tw', 'tr', 'in', 'us', 'jp'];

// 幣別中文名（換算目標選單用）
export const CURRENCY_NAMES = {
  TWD: '新台幣', USD: '美元', JPY: '日圓', EUR: '歐元', GBP: '英鎊',
  HKD: '港幣', CNY: '人民幣', KRW: '韓元', SGD: '新加坡幣', TRY: '土耳其里拉',
  INR: '印度盧比', AUD: '澳幣', CAD: '加拿大幣', THB: '泰銖', VND: '越南盾',
  MYR: '馬來西亞令吉', IDR: '印尼盾', PHP: '菲律賓披索', NGN: '奈拉', BRL: '巴西雷亞爾',
};

// 沒有小數位的幣別（分隔符號一律視為千分位）
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'COP', 'PKR', 'KZT', 'TWD',
]);
// 註：TWD 在 App Store 顯示上為整數（NT$330），實務上無小數。

export function flagEmoji(cc) {
  const code = String(cc || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return '🌐';
  const A = 0x1f1e6;
  return String.fromCodePoint(A + code.charCodeAt(0) - 97, A + code.charCodeAt(1) - 97);
}

export function countryName(cc) {
  return STOREFRONTS[cc]?.zh || String(cc || '').toUpperCase();
}

export function storefrontCurrency(cc) {
  return STOREFRONTS[cc]?.currency || null;
}
