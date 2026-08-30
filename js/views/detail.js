// 明细页（首页）：当月汇总 + 流水列表 + 筛选

import { db, getTransactions, deleteTransaction } from '../db.js';
import { formatCny, formatForeign } from '../currency.js';
import { dlgConfirm } from '../dialog.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  month: new Date().toISOString().slice(0, 7),
  ledgerId: '',
  type: '',
  keyword: '',
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export async function render(el, ctx) {
  const [ledgers, cats] = await Promise.all([db.ledgers.toArray(), db.categories.toArray()]);
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
  const ledgerName = Object.fromEntries(ledgers.map(l => [l.id, l.name]));

  const filters = {
    month: state.month,
    ledgerId: state.ledgerId || undefined,
    type: state.type || undefined,
    keyword: state.keyword || undefined,
  };
  const txs = await getTransactions(filters);

  const income = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amountCny, 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amountCny, 0);

  // 按日期分组
  const groups = [];
  for (const t of txs) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }

  el.innerHTML = `
    <h1 class="page-title">明细</h1>
    <div class="card summary">
      <div><div class="label">本月支出</div><div class="value expense">${esc(formatCny(expense))}</div></div>
      <div><div class="label">本月收入</div><div class="value income">${esc(formatCny(income))}</div></div>
      <div><div class="label">本月结余</div><div class="value">${esc(formatCny(income - expense))}</div></div>
    </div>
    <div class="filters">
      <input type="month" id="flt-month" value="${esc(state.month)}">
      <select id="flt-ledger">
        <option value="">全部账本</option>
        ${ledgers.map(l => `<option value="${l.id}" ${String(l.id) === state.ledgerId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
      <div class="seg">
        <button data-t="" class="${state.type === '' ? 'on' : ''}">全部</button>
        <button data-t="expense" class="${state.type === 'expense' ? 'on' : ''}">支出</button>
        <button data-t="income" class="${state.type === 'income' ? 'on' : ''}">收入</button>
      </div>
      <input type="search" id="flt-kw" placeholder="搜索备注" value="${esc(state.keyword)}">
    </div>
    <div id="tx-list">
      ${groups.length ? groups.map(g => {
        const d = new Date(g.date + 'T00:00:00');
        const dayExpense = g.items.filter(t => t.type === 'expense').reduce((s, t) => s + t.amountCny, 0);
        return `
        <div class="day-group">
          <div class="day-head">${g.date} 周${WEEK[d.getDay()]} · 支出 ${esc(formatCny(dayExpense))}</div>
          ${g.items.map(t => {
            const cat = catMap[t.categoryId];
            const orig = t.currency !== 'CNY'
              ? `${esc(formatForeign(t.amount, t.currency))} @${t.rate}` : '';
            return `
            <div class="tx" data-id="${t.id}">
              <div class="icon">${cat ? esc(cat.icon) : '❓'}</div>
              <div class="mid">
                <div class="t1">${esc(t.note || (cat ? cat.name : '未分类'))}</div>
                <div class="t2">${cat ? esc(cat.name) : '未分类'} · ${esc(ledgerName[t.ledgerId] || '')}${t.amountExpr ? ` · ${esc(t.amountExpr)}` : ''}</div>
              </div>
              <div class="right">
                <div class="amount ${t.type}">${t.type === 'expense' ? '-' : '+'}${esc(formatCny(t.amountCny))}</div>
                ${orig ? `<div class="orig">${orig}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('') : '<div class="empty">本月还没有记录<br>点下面的 ＋ 记一笔</div>'}
    </div>
  `;

  // 筛选交互
  el.querySelector('#flt-month').addEventListener('change', e => { state.month = e.target.value || state.month; ctx.refresh(); });
  el.querySelector('#flt-ledger').addEventListener('change', e => { state.ledgerId = e.target.value; ctx.refresh(); });
  el.querySelector('#flt-kw').addEventListener('input', e => { state.keyword = e.target.value; ctx.refresh(); });
  el.querySelectorAll('.seg [data-t]').forEach(b => b.addEventListener('click', () => {
    state.type = b.dataset.t; ctx.refresh();
  }));

  // 点击流水 → 编辑
  el.querySelectorAll('.tx').forEach(node => node.addEventListener('click', () => {
    ctx.editTransaction(node.dataset.id);
  }));
}

export async function removeTransaction(id) {
  if (await dlgConfirm('确定删除这笔记录？', { danger: true })) {
    await deleteTransaction(id);
    return true;
  }
  return false;
}
