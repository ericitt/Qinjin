#!/usr/bin/env node
/**
 * 用 ERP 的销售记录回填已有出货数据的「客户」与「成本」
 *
 * 为什么需要单独一个脚本、而不是走「数据导入」页：
 * 导入页做的是「新增」，这里做的是「给已经存在的 5,974 条出货记录补字段」。
 * 数据库里 2025 年的 1,502 条出货和这份 ERP 导出来自同一份底稿，
 * 直接再导一遍会变成重复记录，所以必须走匹配回填。
 *
 * 匹配策略（三轮，逐轮放宽）：
 *   1. 日期 + 型号 + 数量 + 单价   ← 最严，优先
 *   2. 日期 + 型号 + 数量
 *   3. 日期 + 型号（该键在库里唯一时才用）
 * 每条数据库记录只会被匹配一次，避免一对多把同一条记录反复覆盖。
 *
 * 用法：
 *   node scripts/backfill-sales.js 25年销售记录.xls            # 只报告，不写库
 *   node scripts/backfill-sales.js 25年销售记录.xls --commit   # 实际写入
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();
const { readSpreadsheet, toTable, forwardFill } = require('../lib/xls');

const COMMIT = process.argv.includes('--commit');
const input = process.argv[2];
if (!input) {
  console.error('用法: node scripts/backfill-sales.js <25年销售记录.xls> [--commit]');
  process.exit(1);
}

const normPn = (s) => String(s ?? '').replace(/[/\s]+$/g, '').trim().toUpperCase();
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,，¥￥$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  const s = String(v ?? '').trim().replace(/[/.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};

// ERP 导出的列名 → 内部字段。
// required 为 false 的列缺了也能跑：不同年份的导出表字段不一样，
// 比如 2023-2024 那份就没有「单位成本」和「业务员」，只能回填客户。
const COL = {
  cust: { label: '客户名称', required: true },
  date: { label: '日期', required: true },
  pn:   { label: '型号', required: true },
  qty:  { label: '订单数量', required: true },
  price:{ label: '税价', required: true },
  cost: { label: '单位成本', required: false },
  rep:  { label: '业务员', required: false },
};

function parseFile(file) {
  const table = toTable(readSpreadsheet(file)[0].cells);
  const header = table[0].map((h) => String(h ?? '').trim());
  const at = {};
  const missing = [];
  for (const [k, def] of Object.entries(COL)) {
    at[k] = header.indexOf(def.label);
    if (at[k] < 0) {
      if (def.required) throw new Error(`表里找不到必需列「${def.label}」，实际列名：${header.join(' | ')}`);
      missing.push(def.label);
    }
  }
  if (missing.length) console.log(`  注意：这份表没有 ${missing.map((m) => '「' + m + '」').join('、')}，对应字段不会回填`);
  const body = table.slice(1).filter((r) => String(r[at.pn] ?? '').trim());
  forwardFill(body, at.cust);           // 分组报表：客户名只在每组第一行
  const col = (r, k) => (at[k] >= 0 ? r[at[k]] : null);
  return body.map((r) => ({
    cust: String(col(r, 'cust') ?? '').trim(),
    date: toDate(col(r, 'date')),
    pn: normPn(col(r, 'pn')),
    qty: num(col(r, 'qty')),
    price: num(col(r, 'price')),
    cost: num(col(r, 'cost')),
    rep: String(col(r, 'rep') ?? '').trim(),
  })).filter((r) => r.date && r.pn);
}

async function main() {
  const rows = parseFile(path.resolve(input));
  const customers = [...new Set(rows.map((r) => r.cust).filter(Boolean))];
  const from = rows.reduce((a, r) => (r.date < a ? r.date : a), rows[0].date);
  const to = rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date);
  console.log(`读取 ${rows.length} 行，${customers.length} 个客户，日期 ${from} ~ ${to}`);

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 把库里同期的出货记录连同型号一起拉出来
  const { rows: db } = await client.query(
    `SELECT s.id, s.ship_date::text AS date, s.quantity::float AS qty,
            s.unit_price::float AS price, s.customer_id, s.unit_cost,
            coalesce(p2.pn_norm, p.pn_norm) AS pn
       FROM shipments s
       JOIN parts p ON p.id = s.part_id
       LEFT JOIN parts p2 ON p2.id = p.merged_into
      WHERE s.ship_date BETWEEN $1 AND $2`, [from, to]);
  console.log(`库中同期出货记录 ${db.length} 条`);

  // 型号别名 → 主型号，保证两边口径一致
  const { rows: aliases } = await client.query(`SELECT alias_norm, p.pn_norm FROM part_aliases a JOIN parts p ON p.id = a.part_id`);
  const aliasMap = new Map(aliases.map((a) => [a.alias_norm, a.pn_norm]));
  const canon = (pn) => aliasMap.get(pn) || pn;

  const used = new Set();
  const byKey = (fn) => {
    const m = new Map();
    for (const d of db) {
      if (used.has(d.id)) continue;
      const k = fn(d);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    }
    return m;
  };

  const plan = [];       // {id, cust, cost}
  const unmatched = [];
  const round = [
    { name: '日期+型号+数量+单价', key: (x) => `${x.date}|${canon(x.pn)}|${x.qty}|${Math.round((x.price ?? 0) * 1e6)}` },
    { name: '日期+型号+数量',      key: (x) => `${x.date}|${canon(x.pn)}|${x.qty}` },
    { name: '日期+型号(唯一)',     key: (x) => `${x.date}|${canon(x.pn)}`, uniqueOnly: true },
  ];

  let pending = rows.slice();
  for (const r of round) {
    const idx = byKey(r.key);
    const next = [];
    let hit = 0;
    for (const s of pending) {
      const cands = (idx.get(r.key(s)) || []).filter((d) => !used.has(d.id));
      if (cands.length === 1 || (cands.length > 1 && !r.uniqueOnly)) {
        const d = cands[0];
        used.add(d.id);
        plan.push({ id: d.id, cust: s.cust, cost: s.cost });
        hit++;
      } else next.push(s);
    }
    console.log(`  轮次「${r.name}」匹配 ${hit} 条，剩余 ${next.length} 条`);
    pending = next;
  }
  unmatched.push(...pending);

  const withCust = plan.filter((p) => p.cust).length;
  const withCost = plan.filter((p) => p.cost && p.cost > 0).length;
  console.log(`\n合计匹配 ${plan.length}/${rows.length}（${(plan.length / rows.length * 100).toFixed(1)}%）`);
  console.log(`  可回填客户 ${withCust} 条，可回填成本 ${withCost} 条`);
  console.log(`  未匹配 ${unmatched.length} 条` + (unmatched.length ? `，例如：${unmatched.slice(0, 3).map((u) => `${u.date} ${u.pn} x${u.qty}`).join('；')}` : ''));

  if (!COMMIT) {
    console.log('\n（这是预演，没有写库。确认无误后加 --commit 实际执行）');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const c of customers) {
      await client.query(
        `INSERT INTO customers (name, short_name) VALUES ($1, $1) ON CONFLICT (name) DO NOTHING`, [c]);
    }
    const { rows: cs } = await client.query(`SELECT id, name FROM customers`);
    const cid = new Map(cs.map((c) => [c.name, c.id]));

    let n = 0;
    for (const p of plan) {
      await client.query(
        `UPDATE shipments SET customer_id = coalesce($1, customer_id),
                              unit_cost   = coalesce($2, unit_cost)
          WHERE id = $3`,
        [p.cust ? cid.get(p.cust) : null, p.cost && p.cost > 0 ? p.cost : null, p.id]);
      n++;
    }
    await client.query('COMMIT');
    console.log(`\n✓ 已回填 ${n} 条出货记录`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  const { rows: [chk] } = await client.query(`
    SELECT count(*)::int AS total,
           count(customer_id)::int AS with_customer,
           count(unit_cost)::int AS with_cost
      FROM shipments WHERE ship_date BETWEEN $1 AND $2`, [from, to]);
  console.log('核对：', chk);
  await client.end();
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
