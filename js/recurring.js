// 周期记账：纯日期推进函数 + 依赖注入的补齐流程（不直接依赖 db，便于测试）

export const FREQUENCIES = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};

export function todayStr(d = new Date()) {
  return toDateStr(d);
}

export function toDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysInMonth(y, m) { // m: 0-based
  return new Date(y, m + 1, 0).getDate();
}

// 'YYYY-MM-DD' 起按频率推进一次；monthly/yearly 月末钳制（1/31 → 2/28）
export function advanceDate(dateStr, frequency) {
  const d = parseDate(dateStr);
  if (frequency === 'daily') {
    d.setDate(d.getDate() + 1);
  } else if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
  } else if (frequency === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  } else if (frequency === 'yearly') {
    const day = d.getDate();
    d.setDate(1);
    d.setFullYear(d.getFullYear() + 1);
    d.setMonth(d.getMonth());
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  } else {
    throw new Error('未知周期: ' + frequency);
  }
  return toDateStr(d);
}

// 对每条启用规则：while nextDate <= today（且未超 endDate）生成记录并推进 nextDate
// deps: { getEnabledRules, addTransaction, updateRule, resolveRate }
//   resolveRate(currency, fallbackRate) -> Promise<number|null>
// 返回生成的记录数
export async function processDueRules(deps, today = todayStr()) {
  const rules = await deps.getEnabledRules();
  let generated = 0;
  for (const rule of rules) {
    let next = rule.nextDate;
    let guard = 0;
    while (next && next <= today && guard < 1000) {
      if (rule.endDate && next > rule.endDate) break;
      const rate = await deps.resolveRate(rule.currency, rule.rate);
      if (rate == null) break; // 汇率不可用则暂停该规则，避免生成错误金额
      await deps.addTransaction({
        ledgerId: rule.ledgerId, type: rule.type, amount: rule.amount,
        currency: rule.currency, categoryId: rule.categoryId, note: rule.note,
        rate, date: next, createdAt: Date.now(),
      });
      next = advanceDate(next, rule.frequency);
      generated++;
      guard++;
    }
    if (next !== rule.nextDate) {
      await deps.updateRule(rule.id, { nextDate: next });
    }
  }
  return generated;
}
