// 汇率：获取、缓存、过期刷新、自定义币种兜底

import { getSetting, setSetting } from './db.js';
import { rateFromCache } from './currency.js';

// 主源：ER-API 免费无 key、支持 CORS、对国内网络友好；备用：Frankfurter（欧洲央行）
const SOURCES = [
  {
    url: 'https://open.er-api.com/v6/latest/CNY',
    pick: data => (data && data.result === 'success' && data.rates) ? data.rates : null,
    date: data => (data?.time_last_update_utc || '').slice(0, 16),
  },
  {
    url: 'https://api.frankfurter.app/latest?base=CNY',
    pick: data => (data && data.rates) ? data.rates : null,
    date: data => data?.date || '',
  },
];
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 小时

// ratesCache 结构：{ base:'CNY', rates:{USD:0.14,...}, fetchedAt:ms }
// 含义：1 CNY = rates[ccy] 外币；单笔记账用 rate = 1 / rates[ccy]

export async function getRatesCache() {
  return getSetting('ratesCache');
}

export async function getCustomCurrencies() {
  return getSetting('customCurrencies', {});
}

export async function saveCustomCurrency(code, { name, rate }) {
  const custom = await getCustomCurrencies();
  custom[code.toUpperCase()] = { name: name || code.toUpperCase(), rate: Number(rate) };
  await setSetting('customCurrencies', custom);
}

export async function removeCustomCurrency(code) {
  const custom = await getCustomCurrencies();
  delete custom[code];
  await setSetting('customCurrencies', custom);
}

export async function setManualRate(ccy, rate) {
  // 手动修改某内置币种汇率：直接覆盖缓存中的方向值（1 CNY = r 外币）
  const cache = (await getRatesCache()) || { base: 'CNY', rates: {}, fetchedAt: Date.now() };
  cache.rates[ccy] = 1 / Number(rate);
  cache.manual = cache.manual || {};
  cache.manual[ccy] = true;
  await setSetting('ratesCache', cache);
}

// 拉取最新汇率：依次尝试多个数据源；全部失败抛错由调用方决定提示
export async function fetchRates() {
  let lastErr = null;
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rates = src.pick(data);
      if (!rates || !rates.USD) throw new Error('数据格式异常');
      const cache = { base: 'CNY', rates, fetchedAt: Date.now(), apiDate: src.date(data) };
      await setSetting('ratesCache', cache);
      return cache;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有汇率源均不可用');
}

// 启动时调用：过期则后台静默刷新，绝不抛错
// 返回 { cache, refreshed, error }
export async function ensureRates() {
  const cache = await getRatesCache();
  const fresh = cache && (Date.now() - cache.fetchedAt) < MAX_AGE_MS;
  if (fresh) return { cache, refreshed: false, error: null };
  try {
    const next = await fetchRates();
    return { cache: next, refreshed: true, error: null };
  } catch (e) {
    return { cache, refreshed: false, error: e };
  }
}

// 取某币种当前可用的"1 外币 = X CNY"汇率
// 返回 { rate, source }，source: 'cny' | 'builtin' | 'custom' | 'none'
export async function getRate(ccy) {
  if (ccy === 'CNY') return { rate: 1, source: 'cny' };
  const cache = await getRatesCache();
  const builtin = rateFromCache(ccy, cache);
  if (builtin != null) return { rate: builtin, source: 'builtin' };
  const custom = await getCustomCurrencies();
  const c = custom[ccy];
  if (c && typeof c.rate === 'number' && c.rate > 0) return { rate: c.rate, source: 'custom' };
  return { rate: null, source: 'none' };
}

// 供周期记账等场景的简单取值
export async function resolveRate(ccy, fallbackRate) {
  const { rate } = await getRate(ccy);
  if (rate != null) return rate;
  return (typeof fallbackRate === 'number' && fallbackRate > 0) ? fallbackRate : null;
}
