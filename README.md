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

## 已知待办

- `supplier_parts` 需要导入真实供应商报价，否则「找哪家买最便宜」无法回答
- 历史 `shipments` 的客户归属需要带客户列重新导入一次
- `ACCESS_PASSWORD` 未设置，线上接口目前对公网开放
- 无自动化测试、无错误监控
