// 入口：初始化、Tab 导航、周期补齐、汇率刷新、弹层与 Toast

import './tests/selftest.js';
import { db, migrateDb, seedIfEmpty, dedupSeeds, addTransaction, updateRule } from './db.js';
import { ensureRates, resolveRate } from './rates.js';
import { processDueRules } from './recurring.js';
import * as detailView from './views/detail.js';
import * as statsView from './views/stats.js';
import * as settingsView from './views/settings.js';
import { openEntrySheet } from './views/entry.js';
import { bootSync, getSyncStatus } from './sync.js';
import { maybeDailySnapshot } from './backup.js';

const views = {
  detail: { el: 'page-detail', render: detailView.render },
  stats: { el: 'page-stats', render: statsView.render },
  settings: { el: 'page-settings', render: settingsView.render },
};

const current = { tab: 'detail' };

// ---------- UI 助手 ----------

let toastTimer;
function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function showNotice(text) {
  const bar = document.getElementById('notice-bar');
  bar.innerHTML = `<span>${text}</span><button aria-label="关闭">✕</button>`;
  bar.hidden = false;
  bar.querySelector('button').addEventListener('click', () => { bar.hidden = true; });
}

function refresh() {
  renderTab(current.tab);
}

// ---------- 顶栏同步状态指示器 ----------

let syncChipTimer;
async function refreshSyncIndicator() {
  const el = document.getElementById('sync-chip');
  if (!el) return;
  try {
    const st = await getSyncStatus();
    if (!st.configured) { el.hidden = true; return; }
    el.hidden = false;
    const mode = st.syncing ? 'syncing' : st.lastError ? 'error' : st.pending > 0 ? 'pending' : 'ok';
    el.className = 'sync-chip ' + mode;
    el.innerHTML = `<span class="dot"></span>${st.pending > 0 ? `<b>${st.pending > 99 ? '99+' : st.pending}</b>` : ''}`;
    const label = st.syncing ? '同步中…'
      : st.lastError ? `同步失败：${st.lastError}`
      : st.pending > 0 ? `${st.pending} 条待同步`
      : st.lastSyncAt ? `已同步（${new Date(st.lastSyncAt).toLocaleString('zh-CN')}）`
      : '已连接，尚未同步';
    el.setAttribute('aria-label', label);
  } catch (e) {
    console.warn('指示器刷新失败', e);
  }
}

async function renderTab(tab) {
  const v = views[tab];
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(v.el);
  el.classList.add('active');
  document.querySelectorAll('#tabbar .tab').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  const ctx = { refresh, toast, editTransaction, el };
  try {
    await v.render(el, ctx);
  } catch (e) {
    console.error(e);
    toast('页面加载出错：' + e.message);
  }
}

function editTransaction(id) {
  const overlayEl = document.getElementById('sheet-overlay');
  const sheetEl = document.getElementById('sheet');
  openEntrySheet(sheetEl, overlayEl, {
    txId: id,
    saved: msg => { toast(msg); refresh(); },
  });
}

function openCreateSheet() {
  const overlayEl = document.getElementById('sheet-overlay');
  const sheetEl = document.getElementById('sheet');
  openEntrySheet(sheetEl, overlayEl, {
    saved: msg => { toast(msg); refresh(); },
  });
}

// ---------- 启动 ----------

async function bootstrap() {
  if (!globalThis.Dexie) {
    showNotice('本地数据库组件（Dexie）加载失败，请刷新页面');
    return;
  }
  try {
    await migrateDb();
  } catch (e) {
    console.error(e);
    showNotice('本地数据库不可用（可能处于隐私模式），记账功能无法使用');
    return;
  }

  // 周期记账补齐
  try {
    const n = await processDueRules({
      getEnabledRules: async () =>
        (await db.recurringRules.toArray()).filter(r => r.enabled),
      addTransaction,
      updateRule,
      resolveRate,
    });
    if (n > 0) setTimeout(() => toast(`已自动生成 ${n} 条周期记录`), 600);
  } catch (e) {
    console.error('周期补齐失败', e);
  }

  // 汇率后台刷新（不阻塞界面）
  ensureRates().then(({ cache, error }) => {
    if (error) {
      if (cache) {
        const age = Date.now() - cache.fetchedAt;
        const hours = Math.floor(age / 3600000);
        showNotice(`汇率非最新（${hours ? hours + ' 小时前' : '1 小时内'}更新），离线使用缓存`);
      } else {
        showNotice('暂无汇率数据，记外币时请手动输入汇率');
      }
    }
  });

  // 导航事件
  document.querySelectorAll('#tabbar .tab').forEach(btn =>
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab !== current.tab) { current.tab = tab; renderTab(tab); }
    }));
  document.getElementById('fab').addEventListener('click', openCreateSheet);
  document.getElementById('sheet-overlay').addEventListener('click', e => {
    if (e.target.id === 'sheet-overlay') {
      e.target.hidden = true;
      document.getElementById('sheet').innerHTML = '';
    }
  });

  renderTab('detail');

  // 每日本地快照（置于启动同步之前，避免与合并事务并发读中间态）
  maybeDailySnapshot().catch(e => console.warn('每日快照失败', e));

  // 云同步（已配置 Supabase 时自动执行，不阻塞界面）
  // 同步结束后：空库才补种子（避免新设备本地种子与云端重复），并合并历史遗留的重复项
  bootSync().catch(() => {}).finally(() => {
    Promise.all([seedIfEmpty(), dedupSeeds()])
      .then(([_, d]) => {
        if (d.mergedLedgers || d.mergedCats) {
          toast(`已合并重复数据：账本 ${d.mergedLedgers} 个、分类 ${d.mergedCats} 个`);
          refresh();
        }
      })
      .catch(e => console.warn('种子/合并失败', e));
  });

  // 顶栏同步状态指示器：状态变化与写操作后刷新，点击进设置页
  window.addEventListener('ledger-sync', refreshSyncIndicator);
  window.addEventListener('ledger-write', () => {
    clearTimeout(syncChipTimer);
    syncChipTimer = setTimeout(refreshSyncIndicator, 500);
  });
  const chip = document.getElementById('sync-chip');
  if (chip) chip.addEventListener('click', () => {
    if (current.tab !== 'settings') { current.tab = 'settings'; renderTab('settings'); }
  });
  refreshSyncIndicator();

  // 注册 Service Worker（仅 https / localhost 安全上下文）
  const swOk = 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));
  if (swOk) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败', e));
  }
}

bootstrap();
