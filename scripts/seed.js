// 一键初始化：npm run seed
// 顺序：init.sql（建表）→ 迁移（sql/migrations/*.sql 按文件名排序）→ seed.sql（历史数据）
//
// 注意：003_rollback_merge.sql 是「出问题时手动执行」的撤销脚本，不参与自动迁移，
// 所以下面会跳过文件名里带 rollback 的脚本。
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const MIG_DIR = path.join(__dirname, '../sql/migrations');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('已连接数据库');

  const onlyMigrate = process.argv.includes('--migrate-only');

  if (!onlyMigrate) {
    console.log('建表中 (init.sql)…');
    await client.query(fs.readFileSync(path.join(__dirname, '../sql/init.sql'), 'utf8'));
    console.log('✓ 建表完成');
  }

  const migrations = fs.existsSync(MIG_DIR)
    ? fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && !f.includes('rollback')).sort()
    : [];
  for (const f of migrations) {
    process.stdout.write(`迁移 ${f} … `);
    await client.query(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    console.log('✓');
  }

  if (!onlyMigrate) {
    console.log('导入种子数据中 (seed.sql)，数据量较大，可能需要 1-2 分钟…');
    await client.query(fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8'));
    console.log('✓ 种子数据导入完成');

    // 种子数据是清洗前的原始型号，导入后必须重新跑一次去重与统计刷新
    console.log('清洗重复型号并刷新统计…');
    const dedup = migrations.find((f) => f.includes('dedup'));
    if (dedup) await client.query(fs.readFileSync(path.join(MIG_DIR, dedup), 'utf8'));
    await client.query('SELECT qj_refresh_part_stats()');
    await client.query('SELECT qj_refresh_supplier_part_count()');
    console.log('✓ 清洗完成');
  }

  const { rows } = await client.query(`
    SELECT
      (SELECT count(*) FROM parts WHERE merged_into IS NULL) AS 在库物料,
      (SELECT count(*) FROM parts WHERE merged_into IS NOT NULL) AS 已合并重复,
      (SELECT count(*) FROM part_aliases) AS 型号别名,
      (SELECT count(*) FROM shipments) AS 出货记录,
      (SELECT count(*) FROM shipments WHERE price_flag <> 'ok') AS 异常价格,
      (SELECT count(*) FROM supplier_parts) AS 供应商报价,
      (SELECT count(*) FROM customers) AS 客户,
      (SELECT count(*) FROM suppliers) AS 供应商
  `);
  console.log('核对：', rows[0]);

  await client.end();
  console.log('\n全部完成。接下来：');
  console.log('  1) 重算供应商评分：curl -X POST http://localhost:3000/api/suppliers/recalc-score');
  console.log('  2) 打开「数据导入」页，导入供应商报价表与带客户列的出货流水');
}

run().catch((e) => {
  console.error('执行失败：', e.message);
  process.exit(1);
});
