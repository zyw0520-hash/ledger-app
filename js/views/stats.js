// 统计页：月度汇总 + 分类占比 + 每日趋势（统一按 amountCny 口径）
// 图表交互：点环状图分类扇区 / 柱状图某天 → 图下展开对应支出明细；
//          大额支出可「从图表隐藏」——仅影响两个图表口径，汇总卡与明细页不变

import { db, getTransactions, getSetting, setSetting } from '../db.js';
import { formatCny } from '../currency.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  month: new Date().toISOString().slice(0, 7),
  ledgerId: '',
  detail: null,      // { kind: 'cat'|'day', key } 图下展开的明细
  showHidden: false, // 隐藏横幅是否展开
};
let charts = [];
let hiddenIds = [];  // settings.chartHiddenTx，设备本地视图偏好
let monthTxs = [];   // 当月全部交易（含隐藏，供明细卡片）

const PALETTE = ['#1677ff', '#00b578', '#f56c3f', '#f7ba1e', '#722ed1', '#14c0cc',
  '#f5319d', '#86909c', '#ff7d00', '#3491fa', '#9fdb1e', '#d91ad9'];

function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}

// 纯函数：图表口径 = 支出且未被隐藏（selftest 覆盖）
export function filterChartExpense(txs, hidden) {
  const s = new Set(hidden);
  return txs.filter(t => t.type === 'expense' && !s.has(t.id));
}

// 读取隐藏清单，顺带清理已删除记录的死 id
async function loadHidden() {
  const raw = (await getSetting('chartHiddenTx')) || [];
  const got = await db.transactions.bulkGet(raw);
  const alive = new Set(got.filter(Boolean).map(t => t.id));
  const kept = raw.filter(id => alive.has(id));
  if (kept.length !== raw.length) await setSetting('chartHiddenTx', kept);
  hiddenIds = kept;
}

async function toggleHidden(id, hide) {
  const s = new Set(hiddenIds);
  if (hide) s.add(id); else s.delete(id);
  hiddenIds = [...s];
  await setSetting('chartHiddenTx', hiddenIds);
}

export async function render(el, ctx) {
  destroyCharts();
  await loadHidden();
  const ledgers = await db.ledgers.toArray();
  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
  const ledgerMap = Object.fromEntries(ledgers.map(l => [l.id, l.name]));

  monthTxs = await getTransactions({
    month: state.month,
    ledgerId: state.ledgerId || undefined,
  });
  const chartTxs = filterChartExpense(monthTxs, hiddenIds);
  const income = monthTxs.filter(t => t.type === 'income').reduce((s, t) => s + t.amountCny, 0);
  const expense = monthTxs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amountCny, 0);

  // 分类占比（支出，图表口径）
  const byCat = {};
  for (const t of chartTxs) {
    const key = String(t.categoryId ?? 0);
    byCat[key] = (byCat[key] || 0) + t.amountCny;
  }
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  // 每日支出（图表口径）
  const days = {};
  for (const t of chartTxs) {
    const d = Number(t.date.slice(8, 10));
    days[d] = (days[d] || 0) + t.amountCny;
  }
  const maxDay = new Date(Number(state.month.slice(0, 4)), Number(state.month.slice(5, 7)), 0).getDate();
  const dayLabels = Array.from({ length: maxDay }, (_, i) => String(i + 1));
  const dayData = dayLabels.map((_, i) => round(days[i + 1] || 0));

  const monthHasExpense = monthTxs.some(t => t.type === 'expense');
  const catEmptyHint = monthHasExpense
    ? '本月支出均已从图表隐藏'
    : '本月暂无支出';

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
        : `<div class="empty" style="padding:24px 0">${esc(catEmptyHint)}</div>`}
    </div>
    <div id="st-detail"></div>
    <div class="card">
      <div class="chart-caption">每日支出趋势</div>
      <div class="chart-box"><canvas id="chart-day"></canvas></div>
    </div>
  `;

  el.querySelector('#st-prev').addEventListener('click', () => { state.detail = null; shiftMonth(-1, ctx); });
  el.querySelector('#st-next').addEventListener('click', () => { state.detail = null; shiftMonth(1, ctx); });
  el.querySelector('#st-ledger').addEventListener('change', e => {
    state.ledgerId = e.target.value; state.detail = null; render(el, ctx);
  });

  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const tickColor = isDark ? '#8a919c' : '#86909c';
  const gridColor = isDark ? '#2a3038' : '#e5e8ec';

  // 点环状图扇区 → 展开该分类明细；点柱状图某天 → 展开当天明细
  if (catEntries.length) {
    charts.push(new Chart(el.querySelector('#chart-cat'), {
      type: 'doughnut',
      data: {
        labels: catEntries.map(([id]) => id === '0' ? '未分类' : (catMap[id]?.name || '已删分类')),
        datasets: [{
          data: catEntries.map(([, v]) => round(v)),
          backgroundColor: PALETTE,
          borderWidth: 0,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } } },
        onClick: (e, els) => {
          if (!els.length) return;
          const key = catEntries[els[0].index][0];
          state.detail = (state.detail?.kind === 'cat' && state.detail.key === key)
            ? null : { kind: 'cat', key };
          renderDetail(el, ctx, catMap, ledgerMap);
        },
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
      onClick: (e, els) => {
        if (!els.length) return;
        const key = String(els[0].index + 1);
        state.detail = (state.detail?.kind === 'day' && state.detail.key === key)
          ? null : { kind: 'day', key };
        renderDetail(el, ctx, catMap, ledgerMap);
      },
    },
  }));

  renderDetail(el, ctx, catMap, ledgerMap);
}

// ---------- 图下明细卡片 + 隐藏管理 ----------

function renderDetail(el, ctx, catMap, ledgerMap) {
  const box = el.querySelector('#st-detail');
  if (!box) return;
  const parts = [];

  // 已隐藏横幅：任何月份都展示（隐藏是全局清单）
  if (hiddenIds.length) {
    parts.push(`
      <div class="card hidden-card">
        <div class="hidden-banner">
          <span>🙈 图表已隐藏 ${hiddenIds.length} 笔支出（不影响汇总）</span>
          <button class="mini-btn" data-act="toggle-hidden-view">${state.showHidden ? '收起' : '查看'}</button>
        </div>
        <div id="st-hidden-list"></div>
      </div>`);
  }

  // 分类/日期明细卡片
  if (state.detail) {
    const { kind, key } = state.detail;
    let rows = [], title = '', sum = 0;
    if (kind === 'cat') {
      rows = monthTxs.filter(t => t.type === 'expense' && String(t.categoryId ?? 0) === key);
      title = key === '0' ? '未分类' : (catMap[key]?.name || '已删分类');
    } else {
      rows = monthTxs.filter(t => t.type === 'expense' && String(Number(t.date.slice(8, 10))) === String(Number(key)));
      title = `${state.month}-${String(key).padStart(2, '0')}`;
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.amountCny - a.amountCny);
    const chartSum = rows.filter(t => !hiddenIds.includes(t.id)).reduce((s, t) => s + t.amountCny, 0);
    const hiddenCount = rows.length - rows.filter(t => !hiddenIds.includes(t.id)).length;
    sum = chartSum;
    parts.push(`
      <div class="card detail-card">
        <div class="detail-head">
          <div class="detail-title">${esc(title)}<span class="detail-sub"> · ${esc(state.month)}</span></div>
          <div class="detail-sum">${esc(formatCny(sum))}${hiddenCount ? `<span class="detail-sub">（另有 ${hiddenCount} 笔已隐藏）</span>` : ''}</div>
        </div>
        ${rows.map(t => {
          const hid = hiddenIds.includes(t.id);
          return `
          <div class="st-row">
            <div class="grow">
              <div class="t1">${esc(t.note || (catMap[t.categoryId]?.name || '未分类'))}</div>
              <div class="t2">${t.date} · ${esc(ledgerMap[t.ledgerId] || '')}${t.amountExpr ? ` · ${esc(t.amountExpr)}` : ''}</div>
            </div>
            <div class="amount">-${esc(formatCny(t.amountCny))}</div>
            <button class="mini-btn ${hid ? 'primary' : ''}" data-act="${hid ? 'restore' : 'hide'}" data-id="${esc(t.id)}">${hid ? '恢复' : '隐藏'}</button>
          </div>`;
        }).join('')}
        <button class="mini-btn" data-act="close-detail" style="margin-top:8px">收起</button>
      </div>`);
  }

  box.innerHTML = parts.join('');

  // 隐藏清单展开内容（需要跨月查询）
  if (hiddenIds.length && state.showHidden) {
    (async () => {
      const list = box.querySelector('#st-hidden-list');
      if (!list) return;
      const got = await db.transactions.bulkGet(hiddenIds);
      const rows = got.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
      list.innerHTML = rows.length ? rows.map(t => `
        <div class="st-row">
          <div class="grow">
            <div class="t1">${esc(t.note || (catMap[t.categoryId]?.name || '未分类'))}</div>
            <div class="t2">${t.date} · ${esc(ledgerMap[t.ledgerId] || '')}</div>
          </div>
          <div class="amount">-${esc(formatCny(t.amountCny))}</div>
          <button class="mini-btn primary" data-act="restore" data-id="${esc(t.id)}">恢复</button>
        </div>`).join('')
        : '<div class="t2" style="padding:8px 0">记录已被删除，即将自动清理</div>';
    })();
  }

  // 卡片内按钮事件（委托）
  box.onclick = async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'toggle-hidden-view') {
      state.showHidden = !state.showHidden;
      renderDetail(el, ctx, catMap, ledgerMap);
    } else if (act === 'hide' || act === 'restore') {
      await toggleHidden(btn.dataset.id, act === 'hide');
      render(el, ctx); // 图表口径变了，整页重建
    } else if (act === 'close-detail') {
      state.detail = null;
      renderDetail(el, ctx, catMap, ledgerMap);
    }
  };
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
