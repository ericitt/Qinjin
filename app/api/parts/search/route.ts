import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { normPn } from '@/lib/matching';

/**
 * 物料检索
 * 相比旧版的三处改动：
 *  1. 不再用 LEFT JOIN LATERAL 对全表现算出货聚合 —— 统计已冗余在 parts 上；
 *  2. 加了真正的分页（offset + total），前端可以翻页；
 *  3. 结果直接带出供应商最优报价与毛利，销售不必再逐个点开详情。
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') || '').trim();
  const cat = (sp.get('cat') || '').trim();
  const brand = (sp.get('brand') || '').trim();
  const shippedOnly = sp.get('shipped') === 'true';
  const sort = sp.get('sort') || 'default';
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(sp.get('page') || '1', 10) || 1, 1);
  const offset = (page - 1) * limit;

  const where: string[] = ['p.merged_into IS NULL'];
  const params: any[] = [];
  let i = 1;

  if (q) {
    // 型号走归一化精确/前缀，其余字段走 trigram；别名也参与匹配
    where.push(`(
      p.pn_norm = $${i} OR p.pn ILIKE $${i + 1} OR p.spec ILIKE $${i + 1}
      OR p.brand ILIKE $${i + 1} OR p.cat ILIKE $${i + 1}
      OR EXISTS (SELECT 1 FROM part_aliases a WHERE a.part_id = p.id AND a.alias ILIKE $${i + 1})
    )`);
    params.push(normPn(q), `%${q}%`);
    i += 2;
  }
  if (cat) { where.push(`p.cat = $${i}`); params.push(cat); i++; }
  if (brand) { where.push(`p.brand = $${i}`); params.push(brand); i++; }
  if (shippedOnly) where.push(`p.has_actual_sale = true`);

  const whereSql = where.join(' AND ');
  const orderSql =
    sort === 'freq' ? `p.ship_count DESC, p.pn ASC`
    : sort === 'recent' ? `p.last_ship_date DESC NULLS LAST, p.pn ASC`
    : `p.has_actual_sale DESC, p.ship_count DESC, p.pn ASC`;

  const sql = `
    SELECT p.id, p.pn, p.spec, p.cat, p.brand,
           p.stock_qty::float AS stock_qty,
           p.catalog_cost::float AS catalog_cost,
           p.standard_price::float AS standard_price,
           p.has_actual_sale,
           p.ship_count,
           p.ship_qty::float AS ship_qty,
           p.avg_price::float AS avg_price,
           p.min_price::float AS min_price,
           p.max_price::float AS max_price,
           p.last_ship_date::text AS last_ship_date,
           bq.price::float AS best_supplier_price,
           bq.supplier_name AS best_supplier_name,
           bq.lead_time_days AS best_lead_time,
           (SELECT count(*)::int FROM part_aliases a WHERE a.part_id = p.id) AS alias_count,
           count(*) OVER () AS total_count
      FROM parts p
      LEFT JOIN LATERAL (
        SELECT sp2.price, s.company_name AS supplier_name, sp2.lead_time_days
          FROM supplier_parts sp2 JOIN suppliers s ON s.id = sp2.supplier_id
         WHERE sp2.part_id = p.id AND sp2.price > 0
           AND (sp2.valid_until IS NULL OR sp2.valid_until >= current_date)
         ORDER BY sp2.price ASC LIMIT 1
      ) bq ON true
     WHERE ${whereSql}
     ORDER BY ${orderSql}
     LIMIT $${i} OFFSET $${i + 1}`;
  params.push(limit, offset);

  try {
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    const parts = rows.map(({ total_count, ...r }: any) => {
      const cost = r.best_supplier_price ?? r.catalog_cost;
      const price = r.avg_price ?? r.standard_price;
      return {
        ...r,
        ref_cost: cost,
        ref_price: price,
        margin: cost && price && price > 0 ? ((price - cost) / price) * 100 : null,
      };
    });
    return NextResponse.json({ parts, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
