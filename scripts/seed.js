// 一键导入：npm run seed
// 会依次执行 sql/init.sql（建表）和 sql/seed.sql（导入真实历史数据：5327个型号、5974条出货记录、142条BOM明细、227家供应商）
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('已连接数据库');

  const initSql = fs.readFileSync(path.join(__dirname, '../sql/init.sql'), 'utf8');
  const seedSql = fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8');

  console.log('建表中 (init.sql)…');
  await client.query(initSql);
  console.log('✓ 建表完成');

  console.log('导入种子数据中 (seed.sql)，数据量较大，可能需要1-2分钟…');
  await client.query(seedSql);
  console.log('✓ 种子数据导入完成');

  const { rows } = await client.query(`
    SELECT
      (SELECT count(*) FROM parts) as parts,
      (SELECT count(*) FROM shipments) as shipments,
      (SELECT count(*) FROM bom_items) as bom_items,
      (SELECT count(*) FROM suppliers) as suppliers
  `);
  console.log('导入结果核对：', rows[0]);

  await client.end();
  console.log('\n全部完成。建议接下来跑一次供应商评分计算：');
  console.log('  curl -X POST http://localhost:3000/api/suppliers/recalc-score');
}

run().catch((e) => {
  console.error('导入失败：', e.message);
  process.exit(1);
});
