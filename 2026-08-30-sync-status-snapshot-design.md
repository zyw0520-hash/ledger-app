# 同步状态指示器 + 本地快照设计

日期：2026-08-30
状态：已确认（方案 A）

## 背景与目标

用户担忧两点：

1. **看不见同步状态**——不知道记账数据有没有推到云端
2. **怕数据丢失**——同步失败期间设备出意外、误删、同步合并出错等

目标：让同步状态随时可见可确认；提供本机第二副本（快照），可一键恢复。

非目标（YAGNI）：不做 Supabase Realtime 实时推送（用户确认另一设备 5 分钟内更新可接受）；不做周期性导出文件提醒。

## 功能一：顶栏同步状态指示器

### UI

- `index.html` 顶部新增固定悬浮芯片 `#sync-chip`（右上角，`position:fixed`，safe-area 适配），未配置云同步时隐藏
- 四种状态（class 区分，圆点颜色区分）：
  - `ok` 绿色：无错误、无待推送
  - `pending` 黄色 + 数字角标：有 N 条已写入但尚未推送
  - `error` 红色：`syncState.lastError` 非空
  - `syncing` 蓝色呼吸动画：同步进行中
- 点击芯片 → 切换到「设置」页（同步区块已有详情和「立即同步」按钮），不新做弹层

### 数据与事件

`js/sync.js` 新增：

- `getPendingCount()`：4 张业务表 + tombstones 中 `updatedAt/deletedAt > lastPushedAt` 的条数；未配置返回 0。**注意：业务表 schema 未建 updatedAt 索引，必须用 `filter(r => (r.updatedAt||0) > since)` 全表过滤**（个人记账数据量小，性能足够）；tombstones 有 deletedAt 索引可用 where
- `getSyncStatus()`：聚合 `{ configured, pending, syncing, lastSyncAt, lastError }`
- `notifySyncState()`：派发 `window` 事件 `ledger-sync`；`syncNow` 的 `finally` 中调用；settings.js 配置保存/解除后调用

`js/app.js`：

- 监听 `ledger-sync` 与 `ledger-write`（500ms 去抖）→ `refreshSyncIndicator()` 重算状态并更新 DOM
- 指示器点击 → `renderTab('settings')`

`css/style.css`：`.sync-chip` 胶囊样式 + 四状态圆点色 + syncing 呼吸动画。

## 功能二：每日本地快照

### 存储

`js/db.js` 升级 version(3)，新增表 `snapshots: '++id, day'`。快照记录：

```
{ id 自增, createdAt 毫秒, day 'YYYY-MM-DD'（本地时区）, counts {ledgers,categories,transactions,recurringRules}, data JSON字符串 }
```

`data` 只含 4 张业务表（**不含 settings**，避免恢复时覆盖当前同步配置）。组装时直接查四张表（不复用 `dumpAll()`，其返回值含 settings）。

### 触发

`js/backup.js` 新增（备份模块，不新建文件）：

- `maybeDailySnapshot()`：`app.js` bootstrap 中调用，**置于 `bootSync()` 之前**（避免与启动同步的合并事务并发，读到中间态）；当天（本地时区）已有快照则跳过，否则拍一份
- 每次快照后按 id 倒序保留最近 7 份，多余删除
- 快照操作不触发 `ledger-write`（不进入同步循环）

### 恢复

`restoreSnapshot(id)`：

1. 校验快照存在、JSON 可解析、4 个数组齐全
2. 事务内：清空 4 张业务表 + tombstones → `bulkPut` 写回快照数据（保留原 UUID 与 updatedAt）
3. 调用 `initDb()` 兜底种子（快照四表可能全空）
4. 重置 `syncState`（`lastPushedAt=0`）
5. 触发 **push-first 专用同步 `syncAfterRestore()`**：先 push 恢复数据（以记录文档覆盖云端同 uid 的墓碑文档），再 pull。标准 syncNow 是 pull 先行，恢复场景若先 pull，云端墓碑（删除发生在快照之后，`deletedAt > 快照记录 updatedAt`）会先把恢复数据删掉。push-first 语义即「时间点恢复」：快照后的删除被撤销，快照后其他设备的新增随后由 pull 补入
6. 恢复前 `dlgConfirm` 危险确认（红色按钮），文案说明「将覆盖当前数据；快照之后其他设备在云端做的修改也会被覆盖」
7. 离线时 push 失败：恢复数据仍在本机，待恢复网络后用户手动/自动同步时，pull 的墓碑复活规则（见下）会保护 `updatedAt > deletedAt` 的记录；`updatedAt ≤ deletedAt` 的记录会被云端墓碑再次删除——这是时间点恢复的固有语义，可接受
8. 恢复完成后派发 `ledger-sync` 刷新指示器

设置页新增「数据快照」区块：快照列表（日期时间 + 笔数）+ 每条「恢复 / 导出」+ 手动「立即快照」按钮。导出复用 backup.js 的 download（`快照_YYYY-MM-DD.json`）。

### 墓碑复活规则（配套修复，必须）

云端墓碑可能在 pull 时误删本机较新的记录（含恢复场景）。修改 `js/sync.js` 的 `mergeRemote`：

- 新增纯函数 `tombstoneWins(localRow, tomb)`：仅当本地记录缺失，或 `local.updatedAt <= tomb.deletedAt` 时返回 true（删除生效）
- 删除生效时：删记录、**写本地墓碑**（维持原行为）
- 复活时（返回 false）：**跳过 delete 且跳过 put 墓碑**，并**清除本地同 uid 旧墓碑**——否则本地墓碑会在下次 push 时以同 uid（'表名:记录id'）反向覆盖刚推上去的记录文档，复活机制失效

push 顺序依赖：push 收集顺序为 4 张业务表在前、tombstones 在后，同 uid 记录/墓碑不会同时存在于本地（复活分支已清墓碑），无冲突。

## 错误处理

- `maybeDailySnapshot` / `refreshSyncIndicator` 失败仅 console.warn，不阻塞应用
- `restoreSnapshot` JSON 解析失败抛中文错误，settings 页 dlgAlert 展示
- 快照写入失败（配额等）不影响正常记账

## 测试（selftest，纯函数同步断言）

- `needsDailySnapshot(lastDay, today)`：同日不重复、跨日/无历史触发
- `pruneSnapshots(list, keep)`：返回 `{ keep, remove }`，保留 id 最大（最新）的 7 份
- `tombstoneWins(local, tomb)`：本地缺失→true；本地 updatedAt 较新→false；相等→true

## 文件变更清单

| 文件 | 变更 |
|---|---|
| js/db.js | version(3) 加 snapshots 表 |
| js/sync.js | getPendingCount / getSyncStatus / notifySyncState / tombstoneWins / mergeRemote 修改 |
| js/backup.js | 快照拍/恢复/清理/每日判断 |
| js/app.js | 指示器刷新与点击、bootstrap 调 maybeDailySnapshot |
| js/views/settings.js | 数据快照区块；配置变更后 notifySyncState |
| js/tests/selftest.js | 3 组纯函数用例 |
| index.html | #sync-chip 元素 |
| css/style.css | 指示器样式 |
| sw.js | VERSION → v16 |
