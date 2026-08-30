// 数据层：Dexie 表定义、种子数据、CRUD 封装
// 主键为字符串 UUID（跨设备同步要求全局唯一 id），旧数字 id 由 migrateIds 一次性换发

export const db = new Dexie('ledger-app');

db.version(1).stores({
  ledgers: '++id, name',
  categories: '++id, type, name',
  // 注意：IndexedDB 不能索引 boolean/null（enabled、categoryId 不建索引，靠 JS 过滤）
  transactions: '++id, [ledgerId+date], type, date',
  recurringRules: '++id, nextDate',
  settings: 'key',
});

// v2：新增 tombstones（删除墓碑，用于跨设备同步删除操作）。
// 主键仍是 id 字段，但代码统一显式传入 UUID，不再使用自增
db.version(2).stores({
  ledgers: '++id, name',
  categories: '++id, type, name',
  transactions: '++id, [ledgerId+date], type, date',
  recurringRules: '++id, nextDate',
  settings: 'key',
  tombstones: 'uid, deletedAt',
});

// v3：新增 snapshots（每日本地快照，数据安全网）
db.version(3).stores({
  ledgers: '++id, name',
  categories: '++id, type, name',
  transactions: '++id, [ledgerId+date], type, date',
  recurringRules: '++id, nextDate',
  settings: 'key',
  tombstones: 'uid, deletedAt',
  snapshots: '++id, day',
});

// ---------- UUID 与墓碑 ----------

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// 删除标记：uid = '表名:记录id'
export function makeTombstone(tbl, id) {
  return { uid: `${tbl}:${id}`, deletedAt: Date.now() };
}

// 任何写操作成功后广播，供自动同步去抖触发
function notifyWrite() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ledger-write'));
}

// ---------- 初始化与种子 ----------

const SEED_CATEGORIES = {
  expense: [
    ['餐饮', '🍜'], ['交通', '🚌'], ['购物', '🛍️'], ['住宿', '🏨'],
    ['娱乐', '🎮'], ['医疗', '💊'], ['日用', '🧴'], ['旅行', '✈️'], ['其他', '📦'],
  ],
  income: [
    ['工资', '💰'], ['红包', '🧧'], ['退款', '↩️'], ['投资', '📈'], ['其他', '📥'],
  ],
};

// 一次性迁移：旧记录的数字自增 id → UUID，并重映射外键、补 updatedAt
async function migrateIds() {
  if (await getSetting('uuidMigrated')) return;
  const lmap = new Map(), cmap = new Map();
  const now = Date.now();
  await db.transaction('rw', [db.ledgers, db.categories, db.transactions, db.recurringRules], async () => {
    for (const l of await db.ledgers.toArray()) {
      if (typeof l.id === 'string') { lmap.set(l.id, l.id); continue; }
      const nid = uid();
      lmap.set(l.id, nid);
      await db.ledgers.delete(l.id);
      await db.ledgers.put({ ...l, id: nid, updatedAt: l.updatedAt ?? now });
    }
    for (const c of await db.categories.toArray()) {
      if (typeof c.id === 'string') { cmap.set(c.id, c.id); continue; }
      const nid = uid();
      cmap.set(c.id, nid);
      await db.categories.delete(c.id);
      await db.categories.put({ ...c, id: nid, updatedAt: c.updatedAt ?? now });
    }
    for (const t of await db.transactions.toArray()) {
      if (typeof t.id === 'string') {
        if (t.updatedAt == null) await db.transactions.update(t.id, { updatedAt: now });
        continue;
      }
      const nid = uid();
      await db.transactions.delete(t.id);
      await db.transactions.put({
        ...t, id: nid,
        ledgerId: lmap.get(t.ledgerId) ?? t.ledgerId,
        categoryId: t.categoryId == null ? null : (cmap.get(t.categoryId) ?? t.categoryId),
        updatedAt: now,
      });
    }
    for (const r of await db.recurringRules.toArray()) {
      const nid = typeof r.id === 'string' ? r.id : uid();
      if (typeof r.id !== 'string') await db.recurringRules.delete(r.id);
      await db.recurringRules.put({
        ...r, id: nid,
        ledgerId: lmap.get(r.ledgerId) ?? r.ledgerId,
        categoryId: r.categoryId == null ? null : (cmap.get(r.categoryId) ?? r.categoryId),
        updatedAt: r.updatedAt ?? now,
      });
    }
  });
  await setSetting('uuidMigrated', true);
}

export async function initDb() {
  await migrateIds();
  const ledgerCount = await db.ledgers.count();
  if (ledgerCount === 0) {
    await db.ledgers.add({ id: uid(), name: '日常', createdAt: Date.now(), updatedAt: Date.now() });
  }
  const catCount = await db.categories.count();
  if (catCount === 0) {
    const rows = [];
    for (const [name, icon] of SEED_CATEGORIES.expense) rows.push({ id: uid(), name, icon, type: 'expense', updatedAt: Date.now() });
    for (const [name, icon] of SEED_CATEGORIES.income) rows.push({ id: uid(), name, icon, type: 'income', updatedAt: Date.now() });
    await db.categories.bulkAdd(rows);
  }
}

// ---------- settings（key-value） ----------

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

// ---------- 通用 CRUD ----------

export async function addLedger(row) {
  const r = { ...row, id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
  await db.ledgers.add(r);
  notifyWrite();
  return r.id;
}

export async function renameLedger(id, name) {
  await db.ledgers.update(id, { name, updatedAt: Date.now() });
  notifyWrite();
}

export async function deleteLedger(id) {
  const count = await db.transactions.where('ledgerId').equals(id).count();
  const deadTx = await db.transactions.where('ledgerId').equals(id).toArray();
  const deadRules = await db.recurringRules.where('ledgerId').equals(id).toArray();
  await db.transaction('rw', [db.ledgers, db.transactions, db.recurringRules, db.tombstones], async () => {
    await db.transactions.where('ledgerId').equals(id).delete();
    await db.recurringRules.where('ledgerId').equals(id).delete();
    await db.ledgers.delete(id);
    await db.tombstones.bulkPut([
      makeTombstone('ledgers', id),
      ...deadTx.map(t => makeTombstone('transactions', t.id)),
      ...deadRules.map(r => makeTombstone('recurringRules', r.id)),
    ]);
  });
  notifyWrite();
  return count;
}

export async function addCategory(row) {
  const r = { ...row, id: uid(), updatedAt: Date.now() };
  await db.categories.add(r);
  notifyWrite();
  return r.id;
}

export async function deleteCategory(id) {
  await db.transaction('rw', [db.categories, db.transactions, db.tombstones], async () => {
    await db.transactions.where('categoryId').equals(id).modify(t => {
      t.categoryId = null;
      t.updatedAt = Date.now();
    });
    await db.categories.delete(id);
    await db.tombstones.put(makeTombstone('categories', id));
  });
  notifyWrite();
}

export async function addTransaction(row) {
  const r = { ...row, id: uid(), updatedAt: Date.now() };
  await db.transactions.add(r);
  notifyWrite();
  return r.id;
}

export async function updateTransaction(id, patch) {
  await db.transactions.update(id, { ...patch, updatedAt: Date.now() });
  notifyWrite();
}

export async function deleteTransaction(id) {
  await db.transaction('rw', [db.transactions, db.tombstones], async () => {
    await db.transactions.delete(id);
    await db.tombstones.put(makeTombstone('transactions', id));
  });
  notifyWrite();
}

export async function getTransactions(filters = {}) {
  let rows = await db.transactions.toArray();
  if (filters.ledgerId != null) rows = rows.filter(t => t.ledgerId === filters.ledgerId);
  if (filters.month) rows = rows.filter(t => t.date.startsWith(filters.month));
  if (filters.type) rows = rows.filter(t => t.type === filters.type);
  if (filters.categoryId != null) rows = rows.filter(t => t.categoryId === filters.categoryId);
  if (filters.keyword) {
    const kw = filters.keyword.trim().toLowerCase();
    if (kw) rows = rows.filter(t => (t.note || '').toLowerCase().includes(kw));
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

// ---------- 周期规则 ----------

export async function addRule(row) {
  const r = { ...row, id: uid(), updatedAt: Date.now() };
  await db.recurringRules.add(r);
  notifyWrite();
  return r.id;
}

export async function updateRule(id, patch) {
  await db.recurringRules.update(id, { ...patch, updatedAt: Date.now() });
  notifyWrite();
}

export async function deleteRule(id) {
  await db.transaction('rw', [db.recurringRules, db.tombstones], async () => {
    await db.recurringRules.delete(id);
    await db.tombstones.put(makeTombstone('recurringRules', id));
  });
  notifyWrite();
}

export const getRules = () => db.recurringRules.toArray();

// ---------- 全量/清空（备份用） ----------

export async function dumpAll() {
  const [ledgers, categories, transactions, recurringRules, settings] = await Promise.all([
    db.ledgers.toArray(), db.categories.toArray(), db.transactions.toArray(),
    db.recurringRules.toArray(), db.settings.toArray(),
  ]);
  return { ledgers, categories, transactions, recurringRules, settings };
}

export async function clearAll() {
  await Promise.all([
    db.ledgers.clear(), db.categories.clear(), db.transactions.clear(),
    db.recurringRules.clear(), db.settings.clear(), db.tombstones.clear(),
  ]);
  await initDb();
}
