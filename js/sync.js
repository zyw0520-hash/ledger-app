// 云同步（Supabase PostgREST）：拉取合并 + 推送变更
// 合并策略：记录级"最后修改优先"（updatedAt）；删除通过墓碑表跨设备广播
// 云端表 sync_docs：uid（'表名:记录id'，主键）、tbl、data（记录 JSON）、updated_at

import { db, getSetting, setSetting, dedupSeeds } from './db.js';

const TABLES = ['ledgers', 'categories', 'transactions', 'recurringRules'];
const PAGE = 1000;   // Supabase 单次查询上限
const BATCH = 200;   // 单次推送条数

// ---------- 纯函数（selftest 覆盖） ----------

// 'transactions:abc-uuid' → { tbl, id }；非法返回 null
export function parseUid(u) {
  const s = String(u ?? '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { tbl: s.slice(0, i), id: s.slice(i + 1) };
}

// 远端记录是否比本地新（本地缺失视为远端胜出）
export function remoteWins(local, remote) {
  return (remote?.updatedAt || 0) > (local?.updatedAt || 0);
}

// 墓碑是否生效：本地记录缺失，或本地记录在删除之后未被修改过。
// 本地 updatedAt 更新（删除后又编辑过）→ 复活胜出
export function tombstoneWins(localRow, tomb) {
  if (!localRow) return true;
  return (localRow.updatedAt || 0) <= (tomb?.deletedAt || 0);
}

// ---------- 配置与状态 ----------

export const getSyncConfig = () => getSetting('syncConfig', null);   // { url, key } 或 null
const getSyncState = () => getSetting('syncState', {});              // { lastSyncAt, lastPushedAt, lastError }
const patchSyncState = patch => getSyncState().then(s => setSetting('syncState', { ...s, ...patch }));

// ---------- REST ----------

async function api(cfg, path, opts = {}) {
  // 兼容误带 /rest/v1 后缀的地址（自动去掉重复段）
  const base = cfg.url.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const url = base + '/rest/v1/' + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).message || msg; } catch { /* 保留状态码信息 */ }
    throw new Error(msg);
  }
  // 204 无内容；201 + return=minimal 也是空响应体，需容错
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- 拉取合并 ----------

// 合并一批云端文档到本地（供 sync 和 selftest 使用）
export async function mergeRemote(docs) {
  const rows = docs.filter(d => d.tbl !== 'tombstones');
  const tombs = docs.filter(d => d.tbl === 'tombstones');
  await db.transaction('rw', [...TABLES.map(t => db[t]), db.tombstones], async () => {
    for (const d of tombs) {
      const p = parseUid(d.data?.uid || d.uid);
      if (!p || !TABLES.includes(p.tbl)) continue;
      const local = await db[p.tbl].get(p.id);
      const tomb = { deletedAt: d.data?.deletedAt || d.updated_at || Date.now() };
      if (!tombstoneWins(local, tomb)) {
        // 本地记录较新（删除后又修改过）→ 复活胜出：
        // 跳过删除、不落墓碑，并清掉本地同 uid 旧墓碑，
        // 否则下次 push 会用墓碑文档反向覆盖刚推上去的记录文档
        await db.tombstones.delete(p.tbl + ':' + p.id);
        continue;
      }
      await db[p.tbl].delete(p.id);
      await db.tombstones.put({
        uid: p.tbl + ':' + p.id,
        deletedAt: tomb.deletedAt,
      });
    }
    for (const d of rows) {
      const row = d.data;
      if (!row || typeof row.id !== 'string' || !TABLES.includes(d.tbl)) continue;
      const local = await db[d.tbl].get(row.id);
      if (remoteWins(local, row)) await db[d.tbl].put(row);
    }
  });
}

// 拉取后合并重复种子：云端与本地种子 UUID 不同，运行期同步合并入库后
// 会出现同名重复（仅启动时去重不够，需每次拉取后收敛）
async function dedupAfterPull() {
  try {
    const d = await dedupSeeds();
    if ((d.mergedLedgers || d.mergedCats) && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ledger-dedup'));
    }
  } catch (e) {
    console.warn('[同步] 重复数据合并失败：', e.message);
  }
}

async function pull(cfg) {
  let offset = 0, total = 0;
  while (true) {
    const page = await api(cfg, `sync_docs?select=uid,tbl,data,updated_at&limit=${PAGE}&offset=${offset}`);
    if (page.length) await mergeRemote(page);
    total += page.length;
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return total;
}

// ---------- 推送 ----------

async function push(cfg) {
  const since = (await getSyncState()).lastPushedAt || 0;
  const now = Date.now();
  const docs = [];
  for (const tbl of TABLES) {
    for (const r of await db[tbl].toArray()) {
      if ((r.updatedAt || 0) > since) {
        docs.push({ uid: `${tbl}:${r.id}`, tbl, data: r, updated_at: r.updatedAt || now });
      }
    }
  }
  for (const t of await db.tombstones.toArray()) {
    if ((t.deletedAt || 0) > since) {
      docs.push({ uid: t.uid, tbl: 'tombstones', data: t, updated_at: t.deletedAt || now });
    }
  }
  for (let i = 0; i < docs.length; i += BATCH) {
    await api(cfg, 'sync_docs?on_conflict=uid', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(docs.slice(i, i + BATCH)),
    });
  }
  await patchSyncState({ lastPushedAt: now });
  return docs.length;
}

// ---------- 对外接口 ----------

let syncing = false;

// push-first 恢复专用同步：先推送本地数据（覆盖云端墓碑），再拉取合并
export async function syncAfterRestore() {
  if (syncing) throw new Error('同步正在进行中');
  const cfg = await getSyncConfig();
  if (!cfg?.url || !cfg?.key) throw new Error('尚未配置云同步');
  syncing = true;
  try {
    const pushed = await push(cfg);
    const pulled = await pull(cfg);
    await dedupAfterPull();
    await patchSyncState({ lastSyncAt: Date.now(), lastError: null });
    return { pulled, pushed };
  } catch (e) {
    await patchSyncState({ lastError: e.message }).catch(() => {});
    throw e;
  } finally {
    syncing = false;
    notifySyncState();
  }
}

export async function syncNow() {
  if (syncing) throw new Error('同步正在进行中');
  const cfg = await getSyncConfig();
  if (!cfg?.url || !cfg?.key) throw new Error('尚未配置云同步');
  syncing = true;
  try {
    const pulled = await pull(cfg);
    await dedupAfterPull();
    const pushed = await push(cfg);
    await patchSyncState({ lastSyncAt: Date.now(), lastError: null });
    return { pulled, pushed };
  } catch (e) {
    await patchSyncState({ lastError: e.message }).catch(() => {});
    throw e;
  } finally {
    syncing = false;
    notifySyncState();
  }
}

// ---------- 状态查询（顶栏指示器） ----------

// 待推送条数：updatedAt 晚于上次成功推送的记录数
// 注意：业务表未建 updatedAt 索引，用 filter 全表过滤（个人数据量小）
export async function getPendingCount() {
  const cfg = await getSyncConfig();
  if (!cfg) return 0;
  const since = (await getSyncState()).lastPushedAt || 0;
  let n = 0;
  for (const tbl of TABLES) {
    n += await db[tbl].filter(r => (r.updatedAt || 0) > since).count();
  }
  n += await db.tombstones.where('deletedAt').above(since).count();
  return n;
}

// 聚合同步状态，供指示器与设置页使用
export async function getSyncStatus() {
  const cfg = await getSyncConfig();
  if (!cfg) return { configured: false };
  const st = await getSyncState();
  return {
    configured: true,
    pending: await getPendingCount(),
    syncing,
    lastSyncAt: st.lastSyncAt || 0,
    lastError: st.lastError || null,
    auto: await getSetting('syncAuto', true),
  };
}

// 同步状态变化时广播，app.js 监听刷新指示器
export function notifySyncState() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ledger-sync'));
}

// ---------- 自动同步触发 ----------

// 写操作后的自动同步（3 秒去抖，失败仅记录不打扰）
let timer = null;
function scheduleSync(delay = 3000) {
  clearTimeout(timer);
  timer = setTimeout(autoSync, delay);
}

async function autoSync() {
  const cfg = await getSyncConfig();
  const auto = await getSetting('syncAuto', true);
  if (!cfg || !auto || !navigator.onLine) return;
  try {
    const r = await syncNow();
    console.log(`[同步] 自动同步完成：拉取 ${r.pulled} 条 / 推送 ${r.pushed} 条`);
  } catch (e) {
    console.warn('[同步] 自动同步失败：', e.message);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('ledger-write', () => scheduleSync());

  // 断网恢复后立即同步（离线记的账马上补推）
  window.addEventListener('online', () => scheduleSync(1000));

  // 切回应用时同步：手机 PWA 常驻后台，另一台设备记的账靠这个拉下来
  // （隐藏超过 30 秒才触发，避免频繁切换来回请求）
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 30_000) scheduleSync(500);
    hiddenAt = 0;
  });

  // 应用打开期间每 5 分钟轮询一次（另一设备在记账时本机也能及时收到）
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 5 * 60_000);
}

// 启动时自动同步一次（已配置且开关开启时）
export async function bootSync() {
  const cfg = await getSyncConfig();
  if (!cfg) return false;
  if (!(await getSetting('syncAuto', true))) return false;
  try {
    const r = await syncNow();
    console.log(`[同步] 启动同步完成：拉取 ${r.pulled} 条 / 推送 ${r.pushed} 条`);
  } catch (e) {
    console.warn('[同步] 启动同步失败：', e.message);
  }
  return true;
}
