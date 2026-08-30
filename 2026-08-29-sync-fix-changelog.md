# 云同步修复变更摘要

日期：2026-08-29
涉及版本：Service Worker `ledger-v9` → `ledger-v15`

## 背景

用户需求：随时在不同设备记账，数据需自动同步。此前已实现基于 Supabase 的同步（UUID 主键 + 墓碑删除机制），但实测同步失败，且自动同步触发点不够全面。

## 变更内容

### 1. 自动同步触发点补齐（js/sync.js）

在原有「启动同步 + 记账后 3 秒去抖同步」基础上，新增三个触发点：

| 触发场景 | 实现方式 | 延迟 |
|---|---|---|
| 断网恢复 | `window online` 事件 | 1 秒 |
| 切回应用（后台超 30 秒） | `visibilitychange` 事件 | 0.5 秒 |
| 应用打开期间轮询 | `setInterval` 每 5 分钟（页面可见时） | 立即 |

- 自动同步统一走 `autoSync()`：未配置、开关关闭或离线时静默跳过
- 「自动同步」开关默认开启（设置页可关）

### 2. 修复同步失败的两个 Bug（js/sync.js）

- **URL 重复路径**：用户配置的 Supabase 地址误带 `/rest/v1/` 后缀，与代码拼接逻辑叠加导致请求路径非法（`Invalid path specified in request URL`）。
  `api()` 现自动去掉末尾斜杠及重复的 `/rest/v1` 段，历史错误配置无需重填。
- **空响应体解析**：Supabase POST 推送成功返回 `201 + return=minimal`（空响应体），原代码直接 `res.json()` 报 `Unexpected end of JSON input`。
  `api()` 改为先 `res.text()` 再解析，空体返回 `null`；同时兼容 204。

### 3. 配置保存清洗（js/views/settings.js）

「云同步配置」保存前统一清洗地址：去末尾斜杠、去误带的 `/rest/v1`，此后填带/不带后缀均可。

### 4. selftest 修复（js/tests/selftest.js）

- 补上缺失的 `import { parseUid, remoteWins } from '../sync.js'`（上会话改动丢失），修复 3 条用例报「函数未定义」。

### 5. Service Worker（sw.js）

- `./js/tests/selftest.js` 加入 SHELL 预缓存列表，避免运行时缓存与预缓存版本不一致
- 版本号 v9 → v15

## 验证结果

- selftest **17/17 通过**（含 parseUid ×2、remoteWins ×1）
- 手动 `syncNow()` 实测：**拉取 24 条 / 推送 24 条**，`syncState.lastError` 为 null
- 「记一笔」面板、设置页冒烟正常，无 JS 运行时错误

## 遗留事项

- 手机端需刷新 1–2 次使 SW v15 生效
- anon key 无鉴权，拿到 key 者均可读写 sync_docs 表；如需加强可升级为 Supabase Auth
