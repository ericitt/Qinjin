import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const revalidate = 0;

/** 工作台聚合数据 */
export async function GET() {
  try {
    const [kpi, revTrend, matchQuality, recentInq, todos] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM boms WHERE created_at >= date_trunc('month', current_date)) AS inq_month,
          (SELECT count(*)::int FROM boms WHERE created_at >= date_trunc('month', current_date - interval '1 month')
                                            AND created_at <  date_trunc('month', current_date)) AS inq_prev,
          (SELECT count(*)::int FROM boms WHERE outcome = 'won'
                                            AND created_at >= date_trunc('month', current_date)) AS won_month,
          (SELECT count(*)::int FROM boms WHERE outcome IN ('won','lost')
                                            AND created_at >= date_trunc('month', current_date)) AS closed_month,
          (SELECT count(*)::int FROM boms WHERE outcome IN ('quoted','pending')) AS open_inq,
          (SELECT avg(margin_pct)::float FROM boms
            WHERE created_at >= date_trunc('month', current_date) AND margin_pct IS NOT NULL) AS margin_month
      `),
      pool.query(`
        SELECT to_char(date_trunc('month', ship_date), 'YYYY-MM') AS ym,
               sum(quantity * unit_price)::float AS amount
          FROM shipments
         WHERE price_flag = 'ok' AND ship_date >= date_trunc('month', current_date) - interval '5 months'
         GROUP BY 1 ORDER BY 1
      `),
      pool.query(`
        SELECT match_type, count(*)::int AS n
          FROM quote_line_items
         WHERE created_at >= current_date - interval '90 days' AND match_type IS NOT NULL
         GROUP BY 1
      `),
      pool.query(`
        SELECT b.id, b.quote_no, b.created_at::text AS created_at, b.outcome,
               b.line_count, b.matched_count, b.total_amount::float AS total_amount,
               b.margin_pct::float AS margin_pct, coalesce(c.short_name, c.name) AS customer
          FROM boms b LEFT JOIN customers c ON c.id = b.customer_id
         ORDER BY b.created_at DESC LIMIT 6
      `),
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM (SELECT pn_norm FROM parts WHERE merged_into IS NULL
             GROUP BY pn_norm HAVING count(*) > 1) x) AS dup_groups,
          (SELECT count(*)::int FROM shipments WHERE price_flag <> 'ok') AS bad_price,
          (SELECT count(*)::int FROM parts WHERE merged_into IS NULL
             AND NOT EXISTS (SELECT 1 FROM supplier_parts sp WHERE sp.part_id = parts.id)) AS parts_no_quote,
          (SELECT count(*)::int FROM shipments WHERE customer_id IS NULL) AS ship_no_customer,
          (SELECT max(created_at)::text FROM import_batches) AS last_import,
          (SELECT count(*)::int FROM boms WHERE outcome = 'quoted'
             AND created_at < current_date - interval '3 days') AS stale_quotes
      `),
    ]);

    const k = kpi.rows[0];
    return NextResponse.json({
      kpi: {
        ...k,
        winRate: k.closed_month > 0 ? (k.won_month / k.closed_month) * 100 : null,
        inqDelta: k.inq_month - k.inq_prev,
      },
      revenueTrend: revTrend.rows,
      matchQuality: matchQuality.rows,
      recentInquiries: recentInq.rows,
      todos: todos.rows[0],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
