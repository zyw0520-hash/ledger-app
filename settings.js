// 设置页：账本 / 分类 / 周期规则 / 汇率 / 数据备份

import {
  db, getSetting, setSetting, addLedger, renameLedger, deleteLedger, addCategory, deleteCategory,
  addRule, updateRule, deleteRule, clearAll,
} from '../db.js';
import { getSyncConfig, syncNow, notifySyncState } from '../sync.js';
import {
  getRate, getRatesCache, fetchRates, getCustomCurrencies, saveCustomCurrency,
  removeCustomCurrency, setManualRate,
} from '../rates.js';
import {
  exportCsv, exportJson, importJson, takeSnapshot, restoreSnapshot, exportSnapshot,
} from '../backup.js';
import { formatCny, fmtRate, currencyOptions } from '../currency.js';
import { dlgPrompt, dlgConfirm, dlgAlert } from '../dialog.js';
import { FREQUENCIES } from '../recurring.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const SYNC_HELP = `配置步骤（约 5 分钟，免费）：
1. 打开 supabase.com 注册并登录
2. 点 New project 创建项目（名称任意，Region 选 Singapore 或 Tokyo）
3. 左侧 SQL Editor，粘贴下面的建表语句，点 Run 运行：

create table if not exists sync_docs (
  uid text primary key,
  tbl text not null,
  data jsonb not null,
  updated_at bigint not null default 0
);
alter table sync_docs enable row level security;
create policy "sync_all" on sync_docs
  for all using (true) with check (true);

4. 左侧 Project Settings → API：
   复制 Project URL 和 anon public key
5. 回到本页点「配置」，依次填入这两项即可

提示：密钥不要透露给他人；免费项目连续 7 天不同步会休眠，正常使用不会触发。`;

export async function render(el, ctx) {
  const [ledgers, cats, rules, ratesCache, custom] = await Promise.all([
    db.ledgers.toArray(), db.categories.toArray(), db.recurringRules.toArray(),
    getRatesCache(), getCustomCurrencies(),
  ]);
  const txCountByLedger = {};
  for (const l of ledgers) {
    txCountByLedger[l.id] = await db.transactions.where('ledgerId').equals(l.id).count();
  }

  const fetchedAt = ratesCache
    ? new Date(ratesCache.fetchedAt).toLocaleString('zh-CN')
    : '尚未获取';

  const snaps = await db.snapshots.orderBy('id').reverse().toArray();

  const syncCfg = await getSyncConfig();
  const syncSt = await getSetting('syncState', {});
  const syncAuto = await getSetting('syncAuto', true);
  const syncStatus = !syncCfg
    ? '数据仅保存在本机，配置后多设备自动同步'
    : syncSt.lastError
      ? `上次同步失败：${syncSt.lastError}`
      : syncSt.lastSyncAt
        ? `上次同步 ${new Date(syncSt.lastSyncAt).toLocaleString('zh-CN')}`
        : '已配置，尚未同步';

  el.innerHTML = `
    <h1 class="page-title">设置</h1>

    <div class="sec-title">账本</div>
    ${ledgers.map(l => `
      <div class="row-item">
        <div class="grow">📒 ${esc(l.name)}
          <div class="sub">${txCountByLedger[l.id]} 笔记录</div></div>
        <button class="act" data-rename-ledger="${l.id}">改名</button>
        ${ledgers.length > 1 ? `<button class="act del" data-del-ledger="${l.id}">删除</button>` : ''}
      </div>`).join('')}
    <button class="btn-line" data-act="add-ledger">＋ 新建账本</button>

    <div class="sec-title">分类</div>
    ${['expense', 'income'].map(type => `
      <div class="sec-title" style="margin-top:6px">${type === 'expense' ? '支出分类' : '收入分类'}</div>
      ${cats.filter(c => c.type === type).map(c => `
        <div class="row-item" style="padding:9px 14px">
          <div class="grow">${esc(c.icon)} ${esc(c.name)}</div>
          <button class="act del" data-del-cat="${c.id}">删除</button>
        </div>`).join('')}`).join('')}
    <button class="btn-line" data-act="add-cat">＋ 新建分类</button>

    <div class="sec-title">周期自动记账</div>
    ${rules.length ? rules.map(r => `
      <div class="row-item">
        <div class="grow">
          ${r.type === 'expense' ? '−' : '+'}${esc(formatCny(r.amount))} / ${FREQUENCIES[r.frequency] || r.frequency}
          <div class="sub">下次生成 ${esc(r.nextDate)}${r.note ? ' · ' + esc(r.note) : ''}</div>
        </div>
        <label class="switch"><input type="checkbox" data-rule-toggle="${r.id}" ${r.enabled ? 'checked' : ''}><span class="track"></span></label>
        <button class="act del" data-del-rule="${r.id}">删除</button>
      </div>`).join('')
      : '<div class="row-item"><div class="grow sub">暂无规则</div></div>'}
    <button class="btn-line" data-act="add-rule">＋ 新建周期规则</button>

    <div class="sec-title">汇率（1 人民币兑外币）</div>
    <div class="row-item"><div class="grow">更新时间<div class="sub">${esc(fetchedAt)}${ratesCache?.apiDate ? ' · 央行日期 ' + esc(ratesCache.apiDate) : ''}</div></div>
      <button class="act" data-act="refresh-rates">立即更新</button></div>
    <div class="row-item" style="flex-wrap:wrap">
      <div class="grow" style="flex-basis:100%">
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px">
          ${Object.entries(ratesCache?.rates || {}).sort().map(([k, v]) =>
            `<span>${k} ${esc(fmtRate(v))}${ratesCache?.manual?.[k] ? ' ✍' : ''}</span>`).join('')}
          ${Object.entries(custom).map(([k, v]) =>
            `<span title="自定义">${k} ${esc(fmtRate(v.rate))} ✍</span>`).join('')}
        </div>
      </div>
      <button class="act" data-act="manual-rate">修改币种汇率</button>
      <button class="act" data-act="add-custom">添加自定义币种</button>
      <button class="act del" data-act="del-custom">删除自定义币种</button>
    </div>
    <div class="sub" style="font-size:11px;margin:-4px 4px 0;color:var(--text-2)">✍ 表示手动修改过；联网时每小时自动刷新一次缓存</div>

    <div class="sec-title">云同步（Supabase）</div>
    <div class="row-item">
      <div class="grow">${syncCfg ? '✅ 已连接' : '☁️ 未配置'}
        <div class="sub">${esc(syncStatus)}</div></div>
      <button class="act" data-act="sync-help">如何配置</button>
      ${syncCfg ? '<button class="act" data-act="sync-now">立即同步</button>' : ''}
      <button class="act" data-act="sync-config">${syncCfg ? '修改' : '配置'}</button>
      ${syncCfg ? '<button class="act del" data-act="sync-unbind">解除</button>' : ''}
    </div>
    ${syncCfg ? `
    <div class="row-item">
      <div class="grow">自动同步<div class="sub">打开应用和每次记账后自动进行</div></div>
      <label class="switch"><input type="checkbox" data-sync-auto ${syncAuto ? 'checked' : ''}><span class="track"></span></label>
    </div>` : ''}

    <div class="sec-title">数据快照</div>
    <div class="sub" style="font-size:12px;color:var(--text-2);margin:-6px 4px 6px">每天首次打开自动拍一份，保留最近 7 份；误删或合并出错时可恢复</div>
    ${snaps.length ? snaps.map(s => `
      <div class="row-item">
        <div class="grow">${esc(new Date(s.createdAt).toLocaleString('zh-CN'))}
          <div class="sub">${s.counts.transactions} 笔记录 · ${s.reason === 'daily' ? '自动' : '手动'}</div></div>
        <button class="act" data-act="snap-export" data-snap-id="${s.id}">导出</button>
        <button class="act del" data-act="snap-restore" data-snap-id="${s.id}">恢复</button>
      </div>`).join('')
      : '<div class="row-item"><div class="grow sub">暂无快照</div></div>'}
    <button class="btn-line" data-act="snap-now">立即快照</button>

    <div class="sec-title">数据</div>
    <button class="btn-line" data-act="export-csv">导出 CSV（Excel 可打开）</button>
    <button class="btn-line" data-act="export-json">导出 JSON 备份</button>
    <button class="btn-line" data-act="import-json">导入 JSON 备份恢复</button>
    <button class="btn-line warn" data-act="clear-all">清空全部数据</button>

    <div class="sub" style="text-align:center;color:var(--text-2);font-size:11px;padding:16px 0">轻记账 · 数据仅保存在本机浏览器</div>
  `;

  // ---------- 事件 ----------
  // el 是常驻页面元素，用赋值式绑定避免刷新后叠加监听器
  el.onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;

    if (btn.dataset.renameLedger) {
      const id = btn.dataset.renameLedger;
      const name = await dlgPrompt('新账本名：', ledgers.find(l => l.id === id)?.name || '');
      if (name && name.trim()) { await renameLedger(id, name.trim()); ctx.refresh(); }
    } else if (btn.dataset.delLedger) {
      const id = btn.dataset.delLedger;
      const n = txCountByLedger[id] || 0;
      if (await dlgConfirm(`删除该账本将同时删除其下 ${n} 笔记录和周期规则，确定？`, { danger: true })) {
        await deleteLedger(id); ctx.refresh(); ctx.toast('账本已删除');
      }
    } else if (act === 'add-ledger') {
      const name = await dlgPrompt('账本名称：');
      if (name && name.trim()) { await addLedger({ name: name.trim() }); ctx.refresh(); }
    } else if (btn.dataset.delCat) {
      if (await dlgConfirm('删除该分类后，其下记录将变为"未分类"，确定？', { danger: true })) {
        await deleteCategory(btn.dataset.delCat); ctx.refresh();
      }
    } else if (act === 'add-cat') {
      const name = await dlgPrompt('分类名称：');
      if (!name || !name.trim()) return;
      const type = await dlgConfirm('收入分类点"确定"，支出分类点"取消"') ? 'income' : 'expense';
      const icon = await dlgPrompt('一个 emoji 图标（可留空）：') || (type === 'income' ? '📥' : '📦');
      await addCategory({ name: name.trim(), icon, type }); ctx.refresh();
    } else if (btn.dataset.delRule) {
      if (await dlgConfirm('确定删除该周期规则？（已生成的记录保留）', { danger: true })) {
        await deleteRule(btn.dataset.delRule); ctx.refresh();
      }
    } else if (act === 'add-rule') {
      openRuleForm(ctx);
    } else if (act === 'refresh-rates') {
      ctx.toast('正在更新汇率…');
      try { await fetchRates(); ctx.toast('汇率已更新'); ctx.refresh(); }
      catch { ctx.toast('更新失败，请检查网络'); }
    } else if (act === 'manual-rate') {
      const code = await dlgPrompt('币种代码（如 USD）：');
      if (!code) return;
      const c = code.trim().toUpperCase();
      const { rate } = await getRate(c);
      const v = await dlgPrompt(`1 ${c} = ? 人民币：`, rate ?? '');
      if (v == null) return;
      const num = parseFloat(v);
      if (!isFinite(num) || num <= 0) { ctx.toast('汇率需为正数'); return; }
      await setManualRate(c, num); ctx.toast('已保存'); ctx.refresh();
    } else if (act === 'add-custom') {
      const code = await dlgPrompt('自定义币种代码（如 TWD）：');
      if (!code) return;
      const c = code.trim().toUpperCase();
      const name = await dlgPrompt('名称（如 新台币）：', c);
      const rate = parseFloat(await dlgPrompt(`1 ${c} = ? 人民币：`));
      if (!isFinite(rate) || rate <= 0) { ctx.toast('汇率需为正数'); return; }
      await saveCustomCurrency(c, { name, rate }); ctx.toast('已添加'); ctx.refresh();
    } else if (act === 'del-custom') {
      const customCodes = Object.keys(await getCustomCurrencies());
      if (!customCodes.length) { ctx.toast('暂无自定义币种'); return; }
      const code = await dlgPrompt('要删除的自定义币种代码：\n' + customCodes.join(', '));
      if (!code) return;
      await removeCustomCurrency(code.trim().toUpperCase()); ctx.toast('已删除'); ctx.refresh();
    } else if (act === 'sync-help') {
      dlgAlert(SYNC_HELP);
    } else if (act === 'sync-config') {
      const url = await dlgPrompt('Supabase 项目地址（形如 https://xxxx.supabase.co）：', syncCfg?.url || '');
      if (!url || !url.trim()) return;
      // 统一去掉末尾斜杠和可能误带的 /rest/v1，保存纯净的项目地址
      const u = url.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
      if (!/^https?:\/\//i.test(u)) { ctx.toast('地址需以 http(s):// 开头'); return; }
      const key = await dlgPrompt('anon public 密钥（以 eyJ 开头的一长串）：', syncCfg?.key || '');
      if (!key || !key.trim()) return;
      await setSetting('syncConfig', { url: u, key: key.trim() });
      await setSetting('syncState', {});
      notifySyncState();
      ctx.toast('已保存，正在首次同步…');
      try {
        const r = await syncNow();
        ctx.toast(`同步成功：拉取 ${r.pulled} 条，推送 ${r.pushed} 条`);
      } catch (err) {
        dlgAlert('同步失败：' + err.message);
      }
      ctx.refresh();
    } else if (act === 'sync-now') {
      ctx.toast('正在同步…');
      try {
        const r = await syncNow();
        ctx.toast(`同步成功：拉取 ${r.pulled} 条，推送 ${r.pushed} 条`);
      } catch (err) {
        ctx.toast('同步失败：' + err.message);
      }
      ctx.refresh();
    } else if (act === 'sync-unbind') {
      if (await dlgConfirm('解除后将停止自动同步，本机和云端数据都保留。确定？')) {
        await setSetting('syncConfig', null);
        await setSetting('syncState', {});
        notifySyncState();
        ctx.toast('已解除云同步');
        ctx.refresh();
      }
    } else if (act === 'snap-now') {
      await takeSnapshot('manual');
      ctx.toast('已拍快照');
      ctx.refresh();
    } else if (act === 'snap-export') {
      try {
        await exportSnapshot(Number(btn.dataset.snapId));
        ctx.toast('快照已导出');
      } catch (err) {
        dlgAlert('导出失败：' + err.message);
      }
    } else if (act === 'snap-restore') {
      const id = Number(btn.dataset.snapId);
      if (await dlgConfirm(
        '恢复将用该快照覆盖当前全部数据；快照之后其他设备在云端做的修改也会被覆盖。确定恢复？',
        { okText: '恢复', danger: true },
      )) {
        ctx.toast('正在恢复…');
        try {
          const r = await restoreSnapshot(id);
          if (r.sync?.error) ctx.toast(`已恢复本机数据（云同步失败：${r.sync.error}）`);
          else ctx.toast(`已恢复：${r.counts.transactions} 笔记录${r.sync ? '，已同步云端' : ''}`);
        } catch (err) {
          dlgAlert('恢复失败：' + err.message);
        }
        ctx.refresh();
      }
    } else if (act === 'export-csv') {
      await exportCsv(); ctx.toast('CSV 已导出');
    } else if (act === 'export-json') {
      await exportJson(); ctx.toast('备份已导出');
    } else if (act === 'import-json') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (!(await dlgConfirm('导入将按 id 合并覆盖现有数据，继续？'))) return;
        try {
          const r = await importJson(await file.text());
          ctx.toast(`已导入：${r.transactions} 笔记录`);
          ctx.refresh();
        } catch (err) {
          dlgAlert('导入失败：' + err.message);
        }
      };
      input.click();
    } else if (act === 'clear-all') {
      if (!(await dlgConfirm('将删除全部数据且不可恢复，确定？', { danger: true }))) return;
      if ((await dlgPrompt('此操作不可恢复！输入"清空"以确认：')) !== '清空') { ctx.toast('已取消'); return; }
      await clearAll(); ctx.toast('已清空'); ctx.refresh();
    }
  };

  el.onchange = async e => {
    if ('syncAuto' in e.target.dataset) {
      await setSetting('syncAuto', e.target.checked);
      ctx.toast(e.target.checked ? '自动同步已开启' : '自动同步已关闭');
      return;
    }
    const id = e.target.dataset.ruleToggle;
    if (id) {
      await updateRule(id, { enabled: e.target.checked });
      ctx.toast(e.target.checked ? '规则已启用' : '规则已停用');
    }
  };
}

// 新建周期规则（复用底部弹层）
async function openRuleForm(ctx) {
  const ledgers = await db.ledgers.toArray();
  const cats = (await db.categories.toArray()).filter(c => c.type === 'expense');
  const custom = await getCustomCurrencies();

  const overlayEl = document.getElementById('sheet-overlay');
  const sheetEl = document.getElementById('sheet');
  sheetEl.innerHTML = `
    <div class="sheet-title"><span>新建周期规则</span><button class="close" data-act="close">✕</button></div>
    <div class="form-row"><label>金额</label>
      <input id="r-amount" class="amount-input" inputmode="decimal" placeholder="0.00"></div>
    <div class="form-row"><label>币种</label>
      <select id="r-currency">${currencyOptions(custom).map(c => `<option value="${c.code}">${esc(c.name)} ${c.code}</option>`).join('')}</select></div>
    <div class="form-row"><label>周期</label>
      <select id="r-frequency">
        <option value="monthly">每月</option><option value="daily">每天</option>
        <option value="weekly">每周</option><option value="yearly">每年</option>
      </select></div>
    <div class="form-row"><label>开始日期</label>
      <input type="date" id="r-start" value="${new Date().toISOString().slice(0, 10)}"></div>
    <div class="form-row"><label>账本</label>
      <select id="r-ledger">${ledgers.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
    <div class="form-row"><label>分类（支出）</label>
      <select id="r-cat">${cats.map(c => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></div>
    <div class="form-row"><label>备注</label><input id="r-note" placeholder="如 房租、视频会员"></div>
    <div class="form-error" id="r-err"></div>
    <button class="btn-primary" id="r-save">保存规则</button>
  `;
  overlayEl.hidden = false;
  sheetEl.querySelector('[data-act="close"]').addEventListener('click', () => {
    overlayEl.hidden = true; sheetEl.innerHTML = '';
  });
  sheetEl.querySelector('#r-save').addEventListener('click', async () => {
    const amount = parseFloat(sheetEl.querySelector('#r-amount').value);
    const err = sheetEl.querySelector('#r-err');
    if (!isFinite(amount) || amount <= 0) { err.textContent = '请输入正确金额'; err.classList.add('show'); return; }
    const currency = sheetEl.querySelector('#r-currency').value;
    const { rate } = await getRate(currency);
    if (rate == null) { err.textContent = '该币种暂无汇率，请先在"汇率"中设置'; err.classList.add('show'); return; }
    await addRule({
      ledgerId: sheetEl.querySelector('#r-ledger').value,
      type: 'expense',
      amount, currency, rate,
      categoryId: sheetEl.querySelector('#r-cat').value || null,
      note: sheetEl.querySelector('#r-note').value.trim(),
      frequency: sheetEl.querySelector('#r-frequency').value,
      startDate: sheetEl.querySelector('#r-start').value,
      nextDate: sheetEl.querySelector('#r-start').value,
      endDate: null,
      enabled: true,
    });
    overlayEl.hidden = true; sheetEl.innerHTML = '';
    ctx.toast('规则已保存，到期将自动记账');
    ctx.refresh();
  });
}
