// 轻量断言自测：currency.js / recurring.js 纯函数
// 浏览器控制台运行：import('./js/tests/selftest.js')
// 该模块被导入时自动执行并 console.log 结果

import { round2, rateFromCache, convertToCny, formatCny, fmtRate } from '../currency.js';
import { advanceDate } from '../recurring.js';
import { parseUid, remoteWins, tombstoneWins } from '../sync.js';
import { needsDailySnapshot, pruneSnapshots, SNAP_KEEP } from '../backup.js';

const results = [];
function t(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['fail', `${name} — ${e.message}`]);
  }
}
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)} ${msg}`);
}

t('round2 规避浮点误差', () => eq(round2(0.1 + 0.2), 0.3));
t('round2 保留两位', () => eq(round2(100 * 7.0236), 702.36));
t('rateFromCache CNY 恒为 1', () => eq(rateFromCache('CNY', { rates: {} }), 1));
t('rateFromCache 方向换算', () => {
  // 1 CNY = 0.1423 USD → 1 USD ≈ 7.0274 CNY
  const r = rateFromCache('USD', { rates: { USD: 0.1423 } });
  if (Math.abs(r - 7.027408) > 1e-4) throw new Error('换算结果 ' + r);
});
t('rateFromCache 缓存缺失返回 null', () => eq(rateFromCache('XYZ', { rates: {} }), null));
t('convertToCny 折算取整', () => eq(convertToCny(100, 7.0236), 702.36));
t('convertToCny 零头', () => eq(convertToCny(33.33, 7.0236), 234.1)); // 234.0966 → 234.1
t('formatCny 千分位', () => eq(formatCny(1234567.5), '¥1,234,567.50'));
t('fmtRate 去尾零', () => eq(fmtRate(7.0230), '7.023'));
t('advanceDate daily', () => eq(advanceDate('2026-01-31', 'daily'), '2026-02-01'));
t('advanceDate weekly', () => eq(advanceDate('2026-01-01', 'weekly'), '2026-01-08'));
t('advanceDate monthly 月末钳制', () => eq(advanceDate('2026-01-31', 'monthly'), '2026-02-28'));
t('advanceDate monthly 平月→3月', () => eq(advanceDate('2026-02-28', 'monthly'), '2026-03-28'));
t('advanceDate yearly 闰年钳制', () => eq(advanceDate('2024-02-29', 'yearly'), '2025-02-28'));
t('parseUid 解析表名与记录 id', () => {
  const p = parseUid('transactions:abc-123');
  eq(p.tbl, 'transactions');
  eq(p.id, 'abc-123');
});
t('parseUid 非法返回 null', () => eq(parseUid('nocolon'), null));
t('remoteWins 按 updatedAt 比较', () => {
  if (!remoteWins(null, { updatedAt: 1 })) throw new Error('本地缺失时应取远端');
  if (!remoteWins({ updatedAt: 1 }, { updatedAt: 2 })) throw new Error('远端较新应胜出');
  if (remoteWins({ updatedAt: 2 }, { updatedAt: 1 })) throw new Error('本地较新应保留');
  if (remoteWins({ updatedAt: 2 }, {})) throw new Error('远端无时间戳不应覆盖');
});
t('tombstoneWins 墓碑复活规则', () => {
  if (!tombstoneWins(null, { deletedAt: 100 })) throw new Error('本地缺失时删除应生效');
  if (!tombstoneWins({ updatedAt: 100 }, { deletedAt: 100 })) throw new Error('相等时删除应生效');
  if (tombstoneWins({ updatedAt: 200 }, { deletedAt: 100 })) throw new Error('本地较新（删除后又修改）应复活');
  if (tombstoneWins({ updatedAt: 100 }, {})) throw new Error('墓碑无时间戳不应删除本地记录');
});
t('needsDailySnapshot 同日不重复', () => {
  if (!needsDailySnapshot(null, '2026-08-30')) throw new Error('无历史应触发');
  if (!needsDailySnapshot('2026-08-29', '2026-08-30')) throw new Error('跨日应触发');
  if (needsDailySnapshot('2026-08-30', '2026-08-30')) throw new Error('同日不应触发');
});
t('pruneSnapshots 保留最新 N 份', () => {
  const list = [{ id: 1 }, { id: 5 }, { id: 3 }, { id: 9 }, { id: 2 }];
  const { keep, remove } = pruneSnapshots(list, 3);
  eq(keep.map(s => s.id).join(','), '9,5,3');
  eq(remove.map(s => s.id).join(','), '2,1');
  const all = pruneSnapshots(list, SNAP_KEEP);
  eq(all.keep.length, 5);
  eq(all.remove.length, 0);
});

const fails = results.filter(([s]) => s === 'fail');
console.group(`%c[轻记账 selftest] ${results.length - fails.length}/${results.length} 通过`);
for (const [status, name] of results) {
  console[status === 'ok' ? 'log' : 'error'](`${status === 'ok' ? '✓' : '✗'} ${name}`);
}
console.groupEnd();

export const selfTestPassed = fails.length === 0;
