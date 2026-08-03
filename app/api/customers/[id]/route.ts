import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 单个客户的采购画像：买过什么、买了多少、毛利如何、最近在买什么 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: '无效的客户 ID' }, { status: 400 });

  try {
    const [cust, topParts, monthly, recent] = await Promise.all([
      pool.query(
        `SELECT c.*,
                coalesce(s.n,0)::int AS ship_rows,
                coalesce(s.amount,0)::float AS amount,
                coalesce(s.cost,0)::float AS cost,
                coalesce(s.n_with_cost,0)::int AS n_with_cost,
                coalesce(s.amount_costed,0)::float AS amount_costed,
                s.first_date::text AS first_date,
                s.last_date::text  AS last_date,
                coalesce(s.parts,0)::int AS part_kinds
           FROM customers c
           LEFT JOIN LATERAL (
             -- 毛利只能在「有成本」的行上算。把缺失成本当 0 会让毛利虚高得离谱：
             -- 某客户 15 行里只有 6 行有成本，当 0 算出来 59.8%，实际 13.5%。
             SELECT count(*) AS n,
                    sum(quantity*unit_price) AS amount,
                    count(unit_cost) AS n_with_cost,
                    sum(quantity*unit_price) FILTER (WHERE unit_cost IS NOT NULL) AS amount_costed,
                    sum(quantity*unit_cost)  FILTER (WHERE unit_cost IS NOT NULL) AS cost,
                    min(ship_date) AS first_date, max(ship_date) AS last_date,
                    count(DISTINCT part_id) AS parts
               FROM shipments WHERE customer_id = c.id AND price_flag = 'ok'
           ) s ON true
          WHERE c.id = $1`, [id]),
      // 买得最多的型号 + 该型号当前最优供应商报价，直接看出还有没有降本空间
      pool.query(
        `SELECT p.id, p.pn, p.spec, p.brand,
                count(*)::int AS times,
                sum(s.quantity)::float AS qty,
                sum(s.quantity*s.unit_price)::float AS amount,
                avg(s.unit_price)::float AS avg_price,
                avg(s.unit_cost)::float  AS avg_cost,
                (SELECT min(sp.price) FROM supplier_parts sp WHERE sp.part_id = p.id)::float AS best_supplier_price
           FROM shipments s JOIN parts p ON p.id = s.part_id
          WHERE s.customer_id = $1 AND s.price_flag = 'ok'
          GROUP BY p.id, p.pn, p.spec, p.brand
          ORDER BY sum(s.quantity*s.unit_price) DESC NULLS LAST
          LIMIT 20`, [id]),
      pool.query(
        `SELECT to_char(date_trunc('month', ship_date),'YYYY-MM') AS ym,
                sum(quantity*unit_price)::float AS amount
           FROM shipments WHERE customer_id = $1 AND price_flag = 'ok'
          GROUP BY 1 ORDER BY 1`, [id]),
      pool.query(
        `SELECT s.ship_date::text AS ship_date, p.pn, s.quantity::float AS quantity,
                s.unit_price::float AS unit_price, s.unit_cost::float AS unit_cost
           FROM shipments s JOIN parts p ON p.id = s.part_id
          WHERE s.customer_id = $1
          ORDER BY s.ship_date DESC LIMIT 20`, [id]),
    ]);

    if (!cust.rows[0]) return NextResponse.json({ error: '客户不存在' }, { status: 404 });
    const c = cust.rows[0];
    return NextResponse.json({
      customer: {
        ...c,
        // 注意字段名要对上外层 SELECT 的别名：出货笔数在外层叫 ship_rows，不叫 n
        margin_pct: c.amount_costed > 0 ? ((c.amount_costed - c.cost) / c.amount_costed) * 100 : null,
        cost_coverage: c.ship_rows > 0 ? (c.n_with_cost / c.ship_rows) * 100 : null,
      },
      topParts: topParts.rows.map((r: any) => ({
        ...r,
        margin: r.avg_price && r.avg_cost ? ((r.avg_price - r.avg_cost) / r.avg_price) * 100 : null,
        // 现在的成交价 vs 最便宜的供应商报价 —— 差得越多，越有议价/降本空间
        saving: r.avg_cost && r.best_supplier_price && r.avg_cost > r.best_supplier_price
          ? (r.avg_cost - r.best_supplier_price) * r.qty : null,
      })),
      monthly: monthly.rows,
      recent: recent.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
