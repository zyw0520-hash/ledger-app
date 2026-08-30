// 记一笔 / 编辑记录（底部弹层表单）

import { db, addTransaction, updateTransaction, deleteTransaction } from '../db.js';
import { getRate, getCustomCurrencies } from '../rates.js';
import { currencyOptions, convertToCny, formatCny, fmtRate, round2 } from '../currency.js';
import { evalAmountInput } from '../calc.js';
import { dlgPrompt, dlgConfirm } from '../dialog.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export async function openEntrySheet(sheetEl, overlayEl, { onClose, saved, txId = null, preset = {} }) {
  let state = {
    type: preset.type || 'expense',
    amount: preset.amount ?? '',
    currency: preset.currency || 'CNY',
    categoryId: preset.categoryId ?? null,
    date: preset.date || new Date().toISOString().slice(0, 10),
    ledgerId: preset.ledgerId ?? null,
    note: preset.note || '',
    rate: null,          // 当前生效汇率（1 外币 = X CNY）
    rateSource: null,
    manualRate: null,    // 用户单笔手改
  };
  let cats = [], ledgers = [], customCurrencies = {};

  const showErr = msg => {
    const el = sheetEl.querySelector('#f-err');
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
  };

  async function loadBase() {
    [cats, ledgers, customCurrencies] = await Promise.all([
      db.categories.toArray(), db.ledgers.toArray(), getCustomCurrencies(),
    ]);
    if (!ledgers.length) return;
    if (txId) {
      const tx = await db.transactions.get(txId);
      if (tx) state = { ...state, ...tx, amount: tx.amountExpr || String(tx.amount), manualRate: tx.currency === 'CNY' ? null : tx.rate };
    } else {
      const def = ledgers.find(l => l.name === '日常') || ledgers[0];
      state.ledgerId = preset.ledgerId ?? def.id;
    }
  }

  function optionsHtml() {
    return currencyOptions(customCurrencies).map(c =>
      `<option value="${c.code}">${esc(c.name)} ${c.code}</option>`).join('');
  }

  function shellHtml() {
    const editing = !!txId;
    return `
      <div class="sheet-title"><span>${editing ? '编辑记录' : '记一笔'}</span>
        <button class="close" data-act="close">✕</button></div>
      <div class="seg" style="margin-bottom:12px">
        <button data-type="expense" style="flex:1">支出</button>
        <button data-type="income" style="flex:1">收入</button>
      </div>
      <div class="form-row"><label>金额</label>
        <input id="f-amount" class="amount-input" inputmode="decimal" placeholder="0.00"></div>
      <div class="op-row" id="op-row">
        <button type="button" data-op="+">＋</button><button type="button" data-op="-">－</button><button type="button" data-op="×">×</button><button type="button" data-op="÷">÷</button><button type="button" data-op="(">(</button><button type="button" data-op=")">)</button>
      </div>
      <div class="calc-line" id="calc-line" hidden></div>
      <div class="form-row"><label>币种</label>
        <select id="f-currency">${optionsHtml()}</select></div>
      <div class="fx-line" id="fx-line" hidden></div>
      <div class="form-row"><label>分类</label><div class="chips" id="cat-chips"></div></div>
      <div class="form-row"><label>日期</label><input type="date" id="f-date"></div>
      <div class="form-row"><label>账本</label><select id="f-ledger">
        ${ledgers.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
      </select></div>
      <div class="form-row"><label>备注</label><input id="f-note" placeholder="选填"></div>
      <div class="form-error" id="f-err"></div>
      <button class="btn-primary" id="f-save">保存</button>
      ${editing ? '<button class="btn-danger" id="f-del">删除这笔记录</button>' : ''}
    `;
  }

  function renderChips() {
    const box = sheetEl.querySelector('#cat-chips');
    const list = cats.filter(c => c.type === state.type);
    if (!list.length) { box.innerHTML = '<span class="hint" style="font-size:12px;color:var(--text-2)">无分类，可在设置页添加</span>'; return; }
    if (!list.some(c => c.id === state.categoryId)) state.categoryId = list[0].id;
    box.innerHTML = list.map(c =>
      `<button class="chip ${c.id === state.categoryId ? 'on' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
    box.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
      state.categoryId = btn.dataset.cat;
      renderChips();
    }));
  }

  async function renderFx() {
    const line = sheetEl.querySelector('#fx-line');
    if (state.currency === 'CNY') { line.hidden = true; return; }
    line.hidden = false;
    const calc = evalAmountInput(state.amount);
    const amt = (calc.kind === 'plain' || calc.kind === 'expr') ? calc.value : NaN;
    if (state.rate == null) {
      const { rate, source } = await getRate(state.currency);
      if (source === 'builtin') state.rate = rate;
      else if (source === 'custom') state.rate = rate;
      else state.rate = null;
      if (state.manualRate != null) state.rate = state.manualRate;
    }
    const rate = state.manualRate ?? state.rate;
    if (rate == null) {
      line.innerHTML = `<span style="color:var(--danger)">该币种暂无汇率，点击设置本笔汇率</span>
        <button class="act" data-act="set-rate" style="color:var(--primary)">输入汇率</button>`;
    } else {
      const approx = isFinite(amt) ? formatCny(convertToCny(amt, rate)) : '—';
      line.innerHTML = `<span>≈ ${esc(approx)}（1 ${state.currency} = ${fmtRate(rate)}）</span>
        <button class="act" data-act="set-rate" style="color:var(--primary)">改汇率</button>`;
    }
  }

  // 金额算式实时提示：12+3.5 →「= 15.5」；非法算式红字提示
  function renderCalc() {
    const line = sheetEl.querySelector('#calc-line');
    const r = evalAmountInput(state.amount);
    if (r.kind === 'expr') {
      line.hidden = false;
      line.classList.remove('err');
      line.textContent = `= ${round2(r.value)}`;
    } else if (r.kind === 'error') {
      line.hidden = false;
      line.classList.add('err');
      line.textContent = r.error;
    } else {
      line.hidden = true;
    }
  }

  function syncInputs() {
    sheetEl.querySelectorAll('[data-type]').forEach(b =>
      b.classList.toggle('on', b.dataset.type === state.type));
    sheetEl.querySelector('#f-amount').value = state.amount;
    sheetEl.querySelector('#f-currency').value = state.currency;
    sheetEl.querySelector('#f-date').value = state.date;
    sheetEl.querySelector('#f-ledger').value = state.ledgerId;
    sheetEl.querySelector('#f-note').value = state.note;
    renderChips();
    renderCalc();
    renderFx();
  }

  async function save() {
    const raw = sheetEl.querySelector('#f-amount').value.trim();
    const calc = evalAmountInput(raw);
    if (calc.kind === 'empty') { showErr('请输入金额'); return; }
    if (calc.kind === 'error') { showErr(calc.error); return; }
    if (calc.kind === 'incomplete') { showErr('请输入正确的金额'); return; }
    const amount = round2(calc.value);
    if (!(amount > 0)) { showErr('金额需大于 0'); return; }
    // 算式记账：amount 存计算结果，amountExpr 保留原始算式便于查账
    const expr = calc.kind === 'expr' ? calc.expr : null;
    state.amount = raw;
    state.note = sheetEl.querySelector('#f-note').value.trim();
    state.date = sheetEl.querySelector('#f-date').value;
    state.ledgerId = sheetEl.querySelector('#f-ledger').value;
    const rate = state.currency === 'CNY' ? 1 : (state.manualRate ?? state.rate);
    if (state.currency !== 'CNY' && (!rate || rate <= 0 || !isFinite(rate))) {
      showErr('该币种暂无汇率，请先点击汇率行手动输入'); return;
    }
    const row = {
      type: state.type, amount, currency: state.currency, rate,
      amountCny: convertToCny(amount, rate), categoryId: state.categoryId,
      date: state.date, ledgerId: state.ledgerId, note: state.note,
      amountExpr: expr,
    };
    if (txId) await updateTransaction(txId, row);
    else await addTransaction({ ...row, createdAt: Date.now() });
    close();
    saved && saved(txId ? '已更新' : '已记一笔');
  }

  function close() {
    overlayEl.hidden = true;
    sheetEl.innerHTML = '';
    onClose && onClose();
  }

  await loadBase();
  if (!ledgers.length) { close(); saved && saved('请先到设置页创建账本'); return; }
  overlayEl.hidden = false;
  sheetEl.innerHTML = shellHtml();
  syncInputs();
  showErr('');

  // sheetEl 是常驻元素，必须用赋值式绑定避免多次打开叠加监听器
  sheetEl.onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.type) {
      state.type = btn.dataset.type;
      state.categoryId = null;
      syncInputs();
    } else if (btn.dataset.cat) {
      // 由 renderChips 处理
    } else if (btn.dataset.act === 'close') {
      close();
    } else if (btn.dataset.act === 'set-rate') {
      const cur = await dlgPrompt(`输入 1 ${state.currency} 兑多少人民币：`, state.manualRate ?? state.rate ?? '');
      if (cur == null) return;
      const v = parseFloat(cur);
      if (!isFinite(v) || v <= 0) { showErr('汇率需为正数'); return; }
      state.manualRate = v;
      showErr('');
      renderFx();
    } else if (btn.dataset.op) {
      const inp = sheetEl.querySelector('#f-amount');
      inp.value += btn.dataset.op;
      state.amount = inp.value;
      showErr('');
      renderCalc();
      renderFx();
    } else if (btn.id === 'f-save') {
      save();
    } else if (btn.id === 'f-del') {
      if (await dlgConfirm('确定删除这笔记录？', { danger: true })) {
        await deleteTransaction(txId);
        close();
        saved && saved('已删除');
      }
    }
  };
  const amountInput = sheetEl.querySelector('#f-amount');
  amountInput.oninput = e => {
    state.amount = e.target.value;
    showErr('');
    renderCalc();
    renderFx();
  };
  sheetEl.querySelector('#f-currency').onchange = e => {
    state.currency = e.target.value;
    state.rate = null; state.manualRate = null;
    renderFx();
  };
  sheetEl.querySelector('#f-date').onchange = e => { state.date = e.target.value; };
  sheetEl.querySelector('#f-ledger').onchange = e => { state.ledgerId = e.target.value; };
  sheetEl.querySelector('#f-note').oninput = e => { state.note = e.target.value; };
}
