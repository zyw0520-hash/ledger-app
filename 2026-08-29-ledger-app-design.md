# 轻记账（Ledger App）设计文档

- 日期：2026-08-29
- 状态：设计已与用户逐节确认
- 项目路径：`d:\AI\ledger-app\`

## 1. 背景与目标

做一个在手机上运行的个人记账本（PWA 网页应用，可"添加到主屏幕"像独立 App 使用）。核心特色：**支持外币消费，按汇率自动折算成人民币记账**，历史账目折算结果固定不随汇率波动。

## 2. 需求范围

### 2.1 功能需求（用户已确认）

| 模块 | 说明 |
|---|---|
| 基础记账 | 支出/收入、金额、分类、日期、备注 |
| 多账本 | 默认"日常"账本，可增删改（如"旅行"） |
| 统计图表 | 月度收支汇总、分类占比饼图、每日趋势图，按月切换 |
| 周期自动记账 | 日/周/月/年固定收支规则，打开 App 自动补齐到期记录并提示 |
| 多币种 | 全球主要货币（数据源支持的约 30 种），自动折算 CNY；支持自定义币种手动维护汇率 |
| 汇率 | 免费在线 API 自动获取 + 本地缓存；离线用缓存；单笔可手动改汇率 |
| 导出/备份 | CSV 导出（Excel 兼容）、JSON 全量备份与导入恢复 |
| 界面 | 中文、移动优先、自动跟随系统深色模式 |

### 2.2 非目标（明确不做）

- 预算管理（用户未选择）
- 云同步、账号系统、多端数据同步
- 原生 App / 微信小程序
- 资产管理、报销、发票等扩展功能

## 3. 技术选型

**纯静态前端，无构建步骤**（用户确认的方案 A）：

- 原生 JavaScript（ES Modules），无框架
- 存储 IndexedDB，用 **Dexie**（`lib/dexie.min.js` 本地内置）简化
- 图表用 **Chart.js**（`lib/chart.umd.js` 本地内置）
- PWA：`manifest.json` + Service Worker
- 第三方库全部本地内置，不依赖 CDN，保证完全离线可用

选型理由：零环境依赖（无需 Node）、写完即预览、可部署到任意静态托管。

## 4. 目录结构

```
ledger-app/
├── index.html            # 单页应用入口
├── manifest.json         # PWA 清单
├── sw.js                 # Service Worker
├── css/
│   └── style.css         # 全部样式（含深色模式变量）
├── lib/
│   ├── dexie.min.js
│   └── chart.umd.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── js/
    ├── app.js            # 入口：Tab 导航、初始化、SW 注册
    ├── db.js             # Dexie 表定义、CRUD 封装、数据校验
    ├── rates.js          # 汇率获取、缓存、过期刷新
    ├── currency.js       # 币种表、金额格式化、折算纯函数
    ├── recurring.js      # 周期规则补齐算法
    ├── backup.js         # CSV/JSON 导出与导入
    └── views/
        ├── detail.js     # 明细页（首页）
        ├── entry.js      # 记一笔（表单）
        ├── stats.js      # 统计页
        └── settings.js   # 设置页
```

## 5. 页面与交互

底部 Tab 导航：**明细 / 记一笔（中间大按钮）/ 统计 / 设置**。

### 5.1 明细页（首页）
- 顶部当月收支总览卡片：本月收入合计、支出合计（均为折算后 CNY）
- 流水列表按日期倒序分组；每条显示分类图标、备注、原币标注
  - 外币记录显示：`¥702.36（$100.00 @7.0236）`
- 筛选：账本、月份、支出/收入、分类、关键词（匹配备注）
- 点击条目可编辑/删除（删除需确认）

### 5.2 记一笔
- 表单字段：类型（支出/收入）、金额、币种（默认 CNY）、分类、日期（默认今天）、账本、备注
- 选择非 CNY 币种时，输入金额下方实时显示 `≈ ¥xxx.xx（汇率 1 USD = 7.0236）`，点击汇率可单笔修改
- 汇率不可用（无缓存且获取失败）时，提示手动输入该笔汇率

### 5.3 统计页
- 月份切换（上一月/下一月）
- 收支汇总、分类占比饼图、每日趋势柱状图（统一按 amountCny 统计）
- 支持按账本筛选

### 5.4 设置页
- 账本管理（增删改；删除账本需二次确认，并显示受影响记录数，确认后**级联删除**该账本全部记录）
- 分类管理（预置分类见下，可增删；删除分类后其记录变为"未分类"）
  - 预置支出分类：餐饮、交通、购物、住宿、娱乐、医疗、日用、旅行、其他
  - 预置收入分类：工资、红包、退款、投资、其他
- 周期规则管理（增删改、启用/停用）
- 汇率：查看当前缓存汇率与更新时间、手动立即更新、手动修改任意币种汇率、添加自定义币种（手动维护汇率）
- 数据：导出 CSV、导出 JSON 备份、导入恢复（二次确认）、清空全部数据（双重确认）

## 6. 数据模型（Dexie / IndexedDB）

### ledgers
| 字段 | 类型 | 说明 |
|---|---|---|
| id | auto | 主键 |
| name | string | 账本名 |
| createdAt | number | 创建时间戳 |

### categories
| 字段 | 类型 | 说明 |
|---|---|---|
| id | auto | 主键 |
| name | string | 分类名 |
| type | 'expense' \| 'income' | 分类归属 |
| icon | string | 图标（emoji） |

### transactions（索引：`[ledgerId+date], categoryId, type`）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | auto | 主键 |
| ledgerId | number | 所属账本 |
| type | 'expense' \| 'income' | 类型 |
| amount | number | **原币金额** |
| currency | string | 币种代码（如 USD），CNY 时同值 |
| rate | number | 记账时 1 外币 = rate CNY；CNY 恒为 1 |
| amountCny | number | **折算后人民币金额（冗余存储）** |
| categoryId | number \| null | 分类；删除分类后置为 null，界面显示为"未分类" |
| date | string 'YYYY-MM-DD' | 记账日期 |
| note | string | 备注 |
| createdAt | number | 创建时间戳 |

> 关键决策：折算结果 `amountCny` 冗余存储，历史账目不随汇率变化，统计与离线均直接可用。

### recurringRules（索引：`nextDate`）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | auto | 主键 |
| ledgerId / type / amount / currency / rate / categoryId / note | 同 transactions | 生成记录时复制这些值 |
| frequency | 'daily' \| 'weekly' \| 'monthly' \| 'yearly' | 周期 |
| startDate | string | 起始日期 |
| nextDate | string | 下次生成日期 |
| endDate | string \| null | 可选结束日期 |
| enabled | boolean | 停用后不生成 |

### settings（key-value）
- `ratesCache`：`{ base: 'CNY', rates: {USD: 0.14, ...}, fetchedAt: 时间戳 }`（1 CNY 兑各币种）
- `customCurrencies`：自定义币种及其手动汇率
- `defaultLedgerId` 等偏好

## 7. 汇率设计

- 数据源：**Frankfurter** 免费接口（欧洲央行参考汇率，无需 key）：
  `GET https://api.frankfurter.app/latest?base=CNY` 一次取回 1 CNY 兑全部支持币种
- 刷新策略：记账页/启动时检查缓存，超过 **12 小时**则后台静默刷新；失败或离线时静默使用缓存，并在顶部提示"汇率非最新（更新于 x 时）"
- 兜底：完全无缓存时，记外币需手动输入该笔汇率；设置页可随时手动改任意币种汇率
- 自定义币种：ECB 不发布新台币等币种，允许在设置中添加自定义币种并手动维护汇率，与内置币种同样参与记账折算
- **汇率方向约定**：`transactions.rate` 与单笔手输汇率的含义是"1 外币 = rate CNY"；而 `ratesCache` 存的是"1 CNY = rates[ccy] 外币"，方向相反。内置币种折算时 `rate = 1 / ratesCache.rates[ccy]`；自定义币种在 `customCurrencies` 中直接按"1 币 = X CNY"方向存储，取用时不再换算
- 折算：`amountCny = round2(amount × rate)`；`currency.js` 中实现为纯函数（含 `round2` 分/厘处理，避免浮点误差累积），便于断言测试

## 8. 周期自动记账

- 打开 App 时（`app.js` 初始化）执行补齐：对每条启用规则，`while (nextDate <= today && 未超 endDate)`：生成一条 transaction（rate 取当日缓存汇率，无则用规则里的 rate 或提示），并按 frequency 推进 `nextDate`
- 补齐后显示一次性提示条："已自动生成 N 条周期记录"
- 频率推进语义：monthly 按日历月同日（月末自动钳制，如 1/31 → 2/28），weekly +7 天，yearly 同月同日

## 9. 导出与备份

- **CSV**：列 `date,type,category,ledger,amount,currency,rate,amountCny,note`；UTF-8 带 BOM，Excel 直接打开不乱码
- **JSON 全量备份**：`{ version: 1, exportedAt, ledgers, categories, transactions, recurringRules, settings }`
- **导入恢复**：解析后校验必需字段与版本号，校验失败整体拒绝并提示原因，不写入脏数据；导入为"合并"模式（按 id 去重覆盖），操作前二次确认

## 10. PWA 与离线

- `manifest.json`：name「轻记账」、`display: standalone`、主题色、192/512 图标
- Service Worker：
  - 本地资源（HTML/CSS/JS/lib/icons）：cache-first，版本号变更时清理旧缓存
  - 汇率 API 请求：network-first，失败回退缓存响应
  - 离线时 App 完整可用（记账、统计、查看均不依赖网络）

## 11. 错误处理

| 场景 | 处理 |
|---|---|
| 汇率请求失败/离线 | 用缓存 + 顶部提示"汇率非最新" |
| 无缓存记外币 | 表单内提示手动输入汇率 |
| 手动汇率输入非法 | 行内校验，禁止提交 |
| 导入文件格式错误 | 拒绝导入并说明原因，不写入 |
| 删除账本/分类有引用 | 二次确认；删除分类时其记录归类为"未分类" |
| IndexedDB 不可用（隐私模式等） | 启动时提示，不白屏 |

## 12. 测试与验收

- **纯函数断言**：`currency.js` 的折算/取整、`recurring.js` 的日期推进（含月末钳制）写成无副作用函数，附 `js/tests/selftest.js` 可在浏览器控制台或 Node 下运行的轻量断言
- **手动测试清单**（设计文档附）：
  1. 记一笔 CNY 支出/收入，明细与统计正确
  2. 记 USD 支出，自动折算数值正确；手改单笔汇率生效
  3. 断网记账（外币走缓存/手输），刷新后数据完整
  4. 建周期规则（月度、1/31），跨月补齐正确生成 2/28
  5. 导出 JSON → 清空 → 导入恢复一致；CSV 用 Excel 打开不乱码
  6. 多账本筛选与统计口径正确
  7. 手机浏览器"添加到主屏幕"，飞行模式下可正常记账
- 验收环境：PC Chrome + 手机（同一局域网预览）

## 13. 部署方式

- 开发预览：`ledger-app` 目录下起静态服务（如 `python -m http.server`），电脑与手机同 WiFi，手机访问 `http://<电脑IP>:8000`
- 正式使用：推送至 GitHub Pages / Vercel 等静态托管，获得固定网址后"添加到主屏幕"
