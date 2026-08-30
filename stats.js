// 统计页：月度汇总 + 分类占比 + 每日趋势（统一按 amountCny 口径）

import { db, getTransactions } from '../db.js';
import { formatCny } from '../currency.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = { month: new Date().toISOString().slice(0, 7), ledgerId: '' };
let charts = [];

const PALETTE = ['#1677ff', '#00b578', '#f56c3f', '#f7ba1e', '#722ed1', '#14c0cc',
  '#f5319d', '#86909c', '#ff7d00', '#3491fa', '#9fdb1e', '#d91ad9'];

function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}

export async function render(el, ctx) {
  destroyCharts();
  const ledgers = await db.ledgers.toArray();
  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  const txs = await getTransactions({
    month: state.month,
    ledgerId: state.ledgerId || undefined,
  });
  const income = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amountCny, 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amountCny, 0);

  // 分类占比（支出）
  const byCat = {};
  for (const t of txs.filter(t => t.type === 'expense')) {
    const key = t.categoryId ?? 0;
    byCat[key] = (byCat[key] || 0) + t.amountCny;
  }
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  // 每日支出
  const days = {};
  for (const t of txs.filter(t => t.type === 'expense')) {
    const d = Number(t.date.slice(8, 10));
    days[d] = (days[d] || 0) + t.amountCny;
  }
  const maxDay = new Date(Number(state.month.slice(0, 4)), Number(state.month.slice(5, 7)), 0).getDate();
  const dayLabels = Array.from({ length: maxDay }, (_, i) => String(i + 1));
  const dayData = dayLabels.map((_, i) => round(days[i + 1] || 0));

  el.innerHTML = `
    <h1 class="page-title">统计</h1>
    <div class="stat-nav">
      <button id="st-prev">‹</button>
      <div class="month">${esc(state.month)}</div>
      <button id="st-next">›</button>
    </div>
    <div class="filters" style="justify-content:flex-end">
      <select id="st-ledger">
        <option value="">全部账本</option>
        ${ledgers.map(l => `<option value="${l.id}" ${String(l.id) === state.ledgerId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
    </div>
    <div class="card summary">
      <div><div class="label">支出</div><div class="value expense">${esc(formatCny(expense))}</div></div>
      <div><div class="label">收入</div><div class="value income">${esc(formatCny(income))}</div></div>
      <div><div class="label">结余</div><div class="value">${esc(formatCny(income - expense))}</div></div>
    </div>
    <div class="card">
      <div class="chart-caption">分类占比（支出）</div>
      ${catEntries.length
        ? '<div class="chart-box"><canvas id="chart-cat"></canvas></div>'
        : '<div class="empty" style="padding:24px 0">本月暂无支出</div>'}
    </div>
    <div class="card">
      <div class="chart-caption">每日支出趋势</div>
      <div class="chart-box"><canvas id="chart-day"></canvas></div>
    </div>
  `;

  el.querySelector('#st-prev').addEventListener('click', () => shiftMonth(-1, ctx));
  el.querySelector('#st-next').addEventListener('click', () => shiftMonth(1, ctx));
  el.querySelector('#st-ledger').addEventListener('change', e => { state.ledgerId = e.target.value; render(el, ctx); });

  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const tickColor = isDark ? '#8a919c' : '#86909c';
  const gridColor = isDark ? '#2a3038' : '#e5e8ec';

  if (catEntries.length) {
    charts.push(new Chart(el.querySelector('#chart-cat'), {
      type: 'doughnut',
      data: {
        labels: catEntries.map(([id]) => (id === '0' || id === 0) ? '未分类' : (catMap[id]?.name || '已删分类')),
        datasets: [{
          data: catEntries.map(([, v]) => round(v)),
          backgroundColor: PALETTE,
          borderWidth: 0,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
      },
    }));
  }

  charts.push(new Chart(el.querySelector('#chart-day'), {
    type: 'bar',
    data: {
      labels: dayLabels,
      datasets: [{ label: '支出', data: dayData, backgroundColor: '#1677ff', borderRadius: 3 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: tickColor, maxRotation: 0, font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor } },
      },
    },
  }));
}

function shiftMonth(delta, ctx) {
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  render(ctx.el, ctx);
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
