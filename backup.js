// 导出与备份：CSV、JSON 全量备份与导入恢复、每日本地快照

import { db, dumpAll, initDb, uid, setSetting } from './db.js';
import { syncAfterRestore } from './sync.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function exportCsv(month) {
  const [txs, cats, ledgers] = await Promise.all([
    db.transactions.toArray(), db.categories.toArray(), db.ledgers.toArray(),
  ]);
  const catName = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const ledgerName = Object.fromEntries(ledgers.map(l => [l.id, l.name]));
  const rows = txs
    .filter(t => !month || t.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
  const header = ['date', 'type', 'category', 'ledger', 'amount', 'currency', 'rate', 'amountCny', 'note'];
  const lines = [header.join(',')];
  for (const t of rows) {
    lines.push([
      t.date, t.type, catName[t.categoryId] || '未分类', ledgerName[t.ledgerId] || '',
      t.amount, t.currency, t.rate, t.amountCny, t.note || '',
    ].map(csvEscape).join(','));
  }
  // UTF-8 BOM 保证 Excel 直接打开不乱码
  download(`账目_${month || '全部'}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

export async function exportJson() {
  const data = await dumpAll();
  const payload = { version: 1, exportedAt: new Date().toISOString(), app: 'ledger-app', ...data };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`记账备份_${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

// 旧版备份用数字自增 id：导入时统一换发 UUID 并补 updatedAt（云同步要求全局唯一 id）
function normalizeImport(data) {
  const now = Date.now();
  const lmap = new Map(), cmap = new Map();
  const ledgers = data.ledgers.map(l => {
    const id = typeof l.id === 'string' ? l.id : uid();
    if (id !== l.id) lmap.set(l.id, id);
    return { ...l, id, updatedAt: l.updatedAt ?? now };
  });
  const categories = data.categories.map(c => {
    const id = typeof c.id === 'string' ? c.id : uid();
    if (id !== c.id) cmap.set(c.id, id);
    return { ...c, id, updatedAt: c.updatedAt ?? now };
  });
  const fixLed = v => lmap.get(v) ?? v;
  const fixCat = v => v == null ? null : (cmap.get(v) ?? v);
  const transactions = data.transactions.map(t => ({
    ...t, id: typeof t.id === 'string' ? t.id : uid(),
    ledgerId: fixLed(t.ledgerId), categoryId: fixCat(t.categoryId),
    updatedAt: t.updatedAt ?? now,
  }));
  const recurringRules = data.recurringRules.map(r => ({
    ...r, id: typeof r.id === 'string' ? r.id : uid(),
    ledgerId: fixLed(r.ledgerId), categoryId: fixCat(r.categoryId),
    updatedAt: r.updatedAt ?? now,
  }));
  return { ledgers, categories, transactions, recurringRules };
}

// 校验失败抛错并说明原因；通过后按 id 合并覆盖写入
export async function importJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (!data || data.version !== 1 || data.app !== 'ledger-app') {
    throw new Error('文件不是本应用的备份（version 或 app 标识不符）');
  }
  for (const key of ['ledgers', 'categories', 'transactions', 'recurringRules']) {
    if (!Array.isArray(data[key])) throw new Error(`备份缺少 ${key} 数据`);
  }
  for (const t of data.transactions) {
    if (typeof t.amount !== 'number' || typeof t.rate !== 'number' ||
        typeof t.amountCny !== 'number' || !DATE_RE.test(t.date || '') ||
        !['expense', 'income'].includes(t.type)) {
      throw new Error(`存在不合法的交易记录（id: ${t.id ?? '未知'}），已拒绝导入`);
    }
  }
  const norm = normalizeImport(data);
  await db.transaction('rw', [db.ledgers, db.categories, db.transactions, db.recurringRules, db.settings], () => {
    db.ledgers.bulkPut(norm.ledgers);
    db.categories.bulkPut(norm.categories);
    db.transactions.bulkPut(norm.transactions);
    db.recurringRules.bulkPut(norm.recurringRules);
    if (Array.isArray(data.settings)) db.settings.bulkPut(data.settings);
  });
  await initDb(); // 种子兜底
  return {
    ledgers: norm.ledgers.length, categories: norm.categories.length,
    transactions: norm.transactions.length, recurringRules: norm.recurringRules.length,
  };
}

// ---------- 本地快照（数据安全网：防误删/合并出错/数据库损坏） ----------

export const SNAP_KEEP = 7;

// 纯函数：今天是否还没有快照（selftest 覆盖）
export function needsDailySnapshot(lastDay, today) {
  return lastDay !== today;
}

// 纯函数：按 id 倒序保留最新 keep 份（selftest 覆盖）
export function pruneSnapshots(list, keep = SNAP_KEEP) {
  const sorted = [...list].sort((a, b) => b.id - a.id);
  return { keep: sorted.slice(0, keep), remove: sorted.slice(keep) };
}

const localDay = d => {
  const x = d ?? new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// 拍一份快照（只含 4 张业务表，不含 settings，避免恢复时覆盖同步配置）
export async function takeSnapshot(reason = 'manual') {
  const [ledgers, categories, transactions, recurringRules] = await Promise.all([
    db.ledgers.toArray(), db.categories.toArray(),
    db.transactions.toArray(), db.recurringRules.toArray(),
  ]);
  const id = await db.snapshots.add({
    createdAt: Date.now(),
    day: localDay(),
    reason,
    counts: {
      ledgers: ledgers.length, categories: categories.length,
      transactions: transactions.length, recurringRules: recurringRules.length,
    },
    data: JSON.stringify({ ledgers, categories, transactions, recurringRules }),
  });
  // 清理超出保留数量的旧快照
  const all = await db.snapshots.toArray();
  for (const s of pruneSnapshots(all).remove) await db.snapshots.delete(s.id);
  return id;
}

// 每日首次打开时自动拍一份（bootstrap 静默调用，失败不影响应用）
export async function maybeDailySnapshot() {
  const last = await db.snapshots.orderBy('id').reverse().first();
  const today = localDay();
  if (last && !needsDailySnapshot(last.day, today)) return false;
  await takeSnapshot('daily');
  return true;
}

// 导出快照为 JSON 文件
export async function exportSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在');
  download(`记账快照_${snap.day}.json`, JSON.stringify({
    version: 1, exportedAt: new Date(snap.createdAt).toISOString(),
    app: 'ledger-app', ...JSON.parse(snap.data),
  }, null, 2), 'application/json');
}

// 恢复快照：覆盖当前数据（保留原 UUID），重置同步游标后 push-first 同步
export async function restoreSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在');
  let data;
  try {
    data = JSON.parse(snap.data);
  } catch {
    throw new Error('快照数据损坏（JSON 解析失败）');
  }
  for (const key of ['ledgers', 'categories', 'transactions', 'recurringRules']) {
    if (!Array.isArray(data[key])) throw new Error(`快照缺少 ${key} 数据`);
  }
  await db.transaction('rw', [db.ledgers, db.categories, db.transactions, db.recurringRules, db.tombstones], async () => {
    await Promise.all([
      db.ledgers.clear(), db.categories.clear(),
      db.transactions.clear(), db.recurringRules.clear(), db.tombstones.clear(),
    ]);
    db.ledgers.bulkPut(data.ledgers);
    db.categories.bulkPut(data.categories);
    db.transactions.bulkPut(data.transactions);
    db.recurringRules.bulkPut(data.recurringRules);
  });
  await initDb(); // 种子兜底（快照可能为空库）
  // 重置同步游标，push-first：先把恢复的数据推上去覆盖云端墓碑，再拉取其他设备的新增
  await setSetting('syncState', {});
  let sync = null;
  try {
    sync = await syncAfterRestore();
  } catch (e) {
    // 离线等原因失败不回滚恢复：数据在本机，下次同步由墓碑复活规则保护较新记录
    sync = { error: e.message };
  }
  return { counts: snap.counts, sync };
}
