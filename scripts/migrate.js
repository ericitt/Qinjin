#!/usr/bin/env node
/**
 * 数据库迁移：把 sql/migrations/ 下还没执行过的 .sql 按文件名顺序跑一遍。
 *
 *   npm run migrate
 *
 * 每跑成功一个就在 schema_migrations 里记一笔，所以可以反复执行，
 * 已经跑过的会自动跳过。以后每次 git pull 之后跑一次就行，
 * 不用再记「这次要不要执行什么 SQL」。
 *
 * 每个文件单独一个事务：中间某个失败了，前面成功的不会被回滚，
 * 修好那一个再跑一次即可。
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const DIR = path.join(__dirname, '..', 'sql', 'migrations');
const url = process.env.DATABASE_URL;

function needsSsl(u) {
  if (!u) return false;
  if (/[?&]sslmode=disable/i.test(u)) return false;
  if (/[?&]sslmode=(require|verify-full|verify-ca)/i.test(u)) return true;
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(h)) return false;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}

async function main() {
  if (!url) {
    console.error('✗ 没有读到 DATABASE_URL。请确认项目根目录下有 .env 文件。');
    process.exit(1);
  }
  if (!fs.existsSync(DIR)) {
    console.error('✗ 找不到 sql/migrations 目录');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: false } : false });
  try {
    await client.connect();
  } catch (e) {
    console.error('✗ 连不上数据库：' + e.message);
    console.error('  检查 .env 里的 DATABASE_URL，以及 PostgreSQL 服务是否在运行。');
    process.exit(1);
  }

  const fresh = await client.query(`SELECT to_regclass('public.schema_migrations') IS NULL AS fresh`);
  const firstTime = fresh.rows[0].fresh;
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  // ── 基线 ────────────────────────────────────────────────────────────
  // 这套记账是后加的。老库里下面这几个早就手工跑过了，但表里一条记录都没有，
  // 直接开跑会把 002（型号去重合并）再执行一遍 —— 那个脚本不是幂等的，会重复合并。
  // 所以第一次建记账表、且库里已经有业务表时，把它们直接标记成「已执行」而不真的执行。
  const PRE_RUNNER = [
    '001_phase1_schema.sql',
    '002_dedup_parts.sql',
    '003_rollback_merge.sql',
    '010_shipment_src_key_unique.sql',
  ];
  if (firstTime) {
    const has = await client.query(`SELECT to_regclass('public.import_batches') IS NOT NULL AS has`);
    if (has.rows[0].has) {
      for (const f of PRE_RUNNER) {
        if (!files.includes(f)) continue;
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
      }
      console.log(`检测到已有数据的旧库，把 ${PRE_RUNNER.length} 个历史迁移标记为已执行（不重复执行）。\n`);
    }
  }

  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));

  let applied = 0, failed = 0;
  for (const f of files) {
    if (done.has(f)) { console.log(`· ${f} 已执行过，跳过`); continue; }
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    process.stdout.write(`→ ${f} … `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('完成');
      applied++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('失败');
      console.error(`   ${e.message}`);
      failed++;
      break;   // 后面的迁移可能依赖这一个，不再继续
    }
  }

  await client.end();
  console.log(`\n新执行 ${applied} 个，跳过 ${files.length - applied - failed} 个${failed ? `，失败 ${failed} 个` : ''}。`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
