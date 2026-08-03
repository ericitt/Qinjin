# 勤进科技 · 物料库

内部 Web 应用，2-3 人使用。**技术栈**：Next.js（Vercel）+ Supabase（Postgres）+ Claude API。

## 页面

| 路径 | 页面 | 说明 |
|---|---|---|
| `/` | 工作台 | 询价量、成交率、毛利、数据待办 |
| `/search` | 智能查询 | 列表直接带出成交价区间、最优供应商报价、毛利 |
| `/bom` | AI 询价助手 | 粘贴客户询价 → 解析 → 匹配 → 逐行调价 → 生成报价单 |
| `/inquiries` | 询价记录 | 询价单追踪与成交转化 |
| `/orders` | 出货明细 | 按客户/日期筛选，分页 |
| `/customers` | 客户管理 | 客户档案与采购行为 |
| `/suppliers` | 供应商 | 评分、比价、报价覆盖 |
| `/import` | 数据导入 | 四步向导，可预览、可校验、可整批回滚 |
| `/data-health` | 数据体检 | 重复型号合并、异常价格、完整度看板 |

## 数据模型要点

- **型号归一化**：`parts.pn_norm` 由触发器自动维护（去掉尾部斜杠/空格 + 转大写）。
  匹配一律走 `pn_norm`，不再用 `lower(pn)`。
- **重复型号**：重复记录不物理删除，而是 `parts.merged_into` 指向主记录，
  原型号写进 `part_aliases`（客户用旧型号照样搜得到），全过程记在 `part_merge_log`，可撤销。
- **出货统计冗余**：`parts.ship_count / avg_price / min_price / max_price / last_ship_date`
  由 `qj_refresh_part_stats()` 刷新，查询时不再对 `shipments` 现算聚合。
- **零价记录**：`shipments.price_flag` 由触发器自动标记，`zero` 不参与任何均价统计。
- **导入批次**：写入的每一行都带 `import_batch_id`，整批可撤销。

## 常用命令

```bash
npm run dev          # 本地开发
npm run check        # 快速结构检查（秒级，不能替代 build）
npm run build        # 构建 —— 提交前必须跑通，Vercel 用的就是这个
npm run migrate      # 只跑 sql/migrations/（已有库升级用）
npm run seed         # 全新库：建表 + 迁移 + 导入历史数据 + 清洗
npm run typecheck    # 类型检查
```

**提交习惯**：用 `&&` 串起来，build 不过就不会提交，避免推上去一个构建失败的版本：

```bash
npm run build && git add -A && git commit -m "说明" && git push
```

## 目录结构

```
app/                Next.js 页面
app/components/     共用 UI 组件（ui.tsx 是设计系统 + fetch 封装）
app/api/            API routes
lib/matching.ts     批量匹配（整批 5 次查询，与行数无关）
lib/import.ts       导入解析、字段映射、校验
lib/scoring.ts      供应商评分
lib/db.ts           连接池（Supabase Transaction pooler）
sql/init.sql        初始表结构
sql/migrations/     增量迁移，按文件名顺序执行
sql/seed.sql        历史数据
```

## 部署方式

| 场景 | 看哪份文档 |
|---|---|
| Windows 台式机自建（当前方向） | `DEPLOY-WINDOWS.md` |
| Linux / NAS 自建 | `DEPLOY-LOCAL.md` |
| 大陆访问问题的来龙去脉 | `DEPLOY-CHINA.md` |

自建时 AI 询价必须用 DeepSeek —— Claude 的接口在大陆连不上。
配好后先 `npm run ai:test` 验证再用。

## ERP 数据自动同步

`data/inbox/` 是监控目录：把龙威导出的报表丢进去，
`sync` 服务每 5 分钟扫一次，按文件名关键词识别类型（采购/销售/供应商/客户/库存），
自动向下填充分组报表的空白列、清洗、入库，然后归档到 `已导入/` 或 `失败/`。

**重复导入是安全的**：出货记录按「日期+型号+数量+单价+客户」算自然键 `src_key`，
配合部分唯一索引 `uq_shipments_src_key` 做 `ON CONFLICT DO NOTHING`，
同一份全量表导多少次都不会产生重复行。供应商报价靠 `(supplier_id, part_id)` 唯一约束。

手动跑一次：`npm run sync -- --once`

## 访问密码

在 Vercel 的环境变量里设置 `ACCESS_PASSWORD` 即可开启门禁：

- **留空 = 不拦**。故意这么设计的，免得环境变量没配好把所有人锁在外面。
- 配上之后所有页面跳 `/login`，所有 `/api/*` 返回 401。
- 登录后发一个 HttpOnly cookie，内容是 `过期时间.HMAC签名`，服务端不存 session。
  签名密钥就是密码本身，所以**改密码 = 所有人立即掉线**。
- 有效期 14 天；连续输错 8 次会按 IP 锁 10 分钟。

这是「共享密码」级别的防护：挡住拿到网址的陌生人，够内部工具用，
但它不区分是谁登录的。以后要追责到人，需要换成真正的账号体系。

## 已知待办

- `supplier_parts` 需要导入真实供应商报价，否则「找哪家买最便宜」无法回答
- 历史 `shipments` 的客户归属需要带客户列重新导入一次
- 大陆访问：`*.vercel.app` 被墙，见 `DEPLOY-CHINA.md`
- 无自动化测试、无错误监控
