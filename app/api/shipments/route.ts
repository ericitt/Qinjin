import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 出货明细：支持型号/客户/日期区间筛选 + 分页（旧版没有分页，只能看前 200 条） */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get('q') || '').trim();
  const customerId = sp.get('customer_id');
  const from = sp.get('from');
  const to = sp.get('to');
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '50', 10) || 50, 1), 200);
  const page = Math.max(parseInt(sp.get('page') || '1', 10) || 1, 1);

  const where: string[] = ['p.merged_into IS NULL'];
  const params: any[] = [];
  let i = 1;
  if (q) { where.push(`(p.pn ILIKE $${i} OR p.spec ILIKE $${i} OR c.name ILIKE $${i} OR c.short_name ILIKE $${i})`); params.push(`%${q}%`); i++; }
  if (customerId) { where.push(`s.customer_id = $${i}`); params.push(Number(customerId)); i++; }
  if (from) { where.push(`s.ship_date >= $${i}`); params.push(from); i++; }
  if (to) { where.push(`s.ship_date <= $${i}`); params.push(to); i++; }

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.ship_date::text AS ship_date,
              s.quantity::float AS quantity, s.unit_price::float AS unit_price,
              s.unit_cost::float AS unit_cost, s.price_flag,
              (s.quantity * s.unit_price)::float AS amount,
              p.id AS part_id, p.pn, p.spec, p.brand,
              c.id AS customer_id, coalesce(c.short_name, c.name) AS customer,
              count(*) OVER () AS total_count
         FROM shipments s
         JOIN parts p ON p.id = s.part_id
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.ship_date DESC, s.id DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, (page - 1) * limit]
    );

    const { rows: [sum] } = await pool.query(
      `SELECT count(*)::int AS n,
              sum(s.quantity * s.unit_price)::float AS amount,
              count(s.unit_cost)::int AS n_with_cost,
              sum(s.quantity * s.unit_price) FILTER (WHERE s.unit_cost IS NOT NULL)::float AS amount_costed,
              sum(s.quantity * s.unit_cost)  FILTER (WHERE s.unit_cost IS NOT NULL)::float AS cost
         FROM shipments s JOIN parts p ON p.id = s.part_id
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${where.join(' AND ')} AND s.price_flag = 'ok'`,
      params
    );

    const total = rows.length ? Number(rows[0].total_count) : 0;
    return NextResponse.json({
      shipments: rows.map(({ total_count, ...r }: any) => r),
      total, page, limit, pages: Math.ceil(total / limit),
      summary: {
        ...sum,
        // 只在有成本的部分算毛利，并给出成本覆盖率
        margin: sum?.amount_costed > 0 ? ((sum.amount_costed - sum.cost) / sum.amount_costed) * 100 : null,
        cost_coverage: sum?.n > 0 ? (sum.n_with_cost / sum.n) * 100 : null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
