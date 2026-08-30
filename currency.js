// 币种、金额格式化与折算纯函数（无副作用，便于断言测试）

// Frankfurter（欧洲央行参考汇率）支持的币种，常用币种排前
export const BUILTIN_CURRENCIES = [
  { code: 'CNY', name: '人民币', symbol: '¥' },
  { code: 'USD', name: '美元', symbol: '$' },
  { code: 'EUR', name: '欧元', symbol: '€' },
  { code: 'JPY', name: '日元', symbol: 'JP¥' },
  { code: 'HKD', name: '港币', symbol: 'HK$' },
  { code: 'GBP', name: '英镑', symbol: '£' },
  { code: 'SGD', name: '新加坡元', symbol: 'S$' },
  { code: 'THB', name: '泰铢', symbol: '฿' },
  { code: 'KRW', name: '韩元', symbol: '₩' },
  { code: 'AUD', name: '澳元', symbol: 'A$' },
  { code: 'CAD', name: '加元', symbol: 'C$' },
  { code: 'CHF', name: '瑞士法郎', symbol: 'Fr' },
  { code: 'NZD', name: '新西兰元', symbol: 'NZ$' },
  { code: 'MYR', name: '马来西亚林吉特', symbol: 'RM' },
  { code: 'PHP', name: '菲律宾比索', symbol: '₱' },
  { code: 'IDR', name: '印尼盾', symbol: 'Rp' },
  { code: 'INR', name: '印度卢比', symbol: '₹' },
  { code: 'BRL', name: '巴西雷亚尔', symbol: 'R$' },
  { code: 'MXN', name: '墨西哥比索', symbol: 'Mex$' },
  { code: 'ZAR', name: '南非兰特', symbol: 'R' },
  { code: 'TRY', name: '土耳其里拉', symbol: '₺' },
  { code: 'SEK', name: '瑞典克朗', symbol: 'kr' },
  { code: 'NOK', name: '挪威克朗', symbol: 'kr' },
  { code: 'DKK', name: '丹麦克朗', symbol: 'kr' },
  { code: 'PLN', name: '波兰兹罗提', symbol: 'zł' },
  { code: 'CZK', name: '捷克克朗', symbol: 'Kč' },
  { code: 'HUF', name: '匈牙利福林', symbol: 'Ft' },
  { code: 'RON', name: '罗马尼亚列伊', symbol: 'lei' },
  { code: 'BGN', name: '保加利亚列弗', symbol: 'лв' },
  { code: 'ISK', name: '冰岛克朗', symbol: 'kr' },
  { code: 'ILS', name: '以色列谢克尔', symbol: '₪' },
];

const SYMBOL_MAP = Object.fromEntries(BUILTIN_CURRENCIES.map(c => [c.code, c.symbol]));

// 四舍五入到 2 位小数，规避浮点误差（如 0.1+0.2）
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round6(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

// ratesCache 存"1 CNY = rates[ccy] 外币"，方向与单笔 rate 相反，此处统一换算
// 返回"1 外币 = X CNY"；无效返回 null
export function rateFromCache(ccy, ratesCache) {
  if (ccy === 'CNY') return 1;
  const r = ratesCache && ratesCache.rates && ratesCache.rates[ccy];
  if (typeof r !== 'number' || !isFinite(r) || r <= 0) return null;
  return round6(1 / r);
}

// 折算：1 外币 = rate CNY
export function convertToCny(amount, rate) {
  return round2(amount * rate);
}

// ¥1,234.56
export function formatCny(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '¥' + Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// $100.00；未知币种回退为代码前缀
export function formatForeign(amount, ccy) {
  const sym = SYMBOL_MAP[ccy] || ccy + ' ';
  const sign = amount < 0 ? '-' : '';
  return sign + sym + Math.abs(amount).toLocaleString('zh-CN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// 汇率展示统一 4 位小数
export function fmtRate(rate) {
  return Number(rate).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

// 币种下拉选项：CNY + 内置 + 自定义
export function currencyOptions(customCurrencies) {
  const custom = Object.entries(customCurrencies || {}).map(([code, v]) => ({
    code, name: v.name || code, symbol: v.symbol || (code + ' '), custom: true,
  }));
  return [...BUILTIN_CURRENCIES, ...custom];
}
