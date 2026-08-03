import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const revalidate = 0;

/** 数据体检：重复型号、异常价格、完整度 —— 让数据质量问题可见、可处理 */
export async function GET() {
  try {
    const [overview, dupGroups, zeroPrice, merges] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM parts WHERE merged_into IS NULL) AS parts_active,
          (SELECT count(*)::int FROM parts WHERE merged_into IS NOT NULL) AS parts_merged,
          (SELECT count(*)::int FROM parts WHERE merged_into IS NULL AND has_actual_sale) AS parts_with_sale,
          (SELECT count(*)::int FROM parts WHERE merged_into IS NULL AND catalog_cost IS NOT NULL) AS parts_with_cost,
          (SELECT count(DISTINCT part_id)::int FROM supplier_parts) AS parts_with_quote,
          (SELECT count(*)::int FROM shipments) AS shipments_total,
          (SELECT count(*)::int FROM shipments WHERE customer_id IS NOT NULL) AS shipments_with_customer,
          (SELECT count(*)::int FROM shipments WHERE price_flag <> 'ok') AS shipments_bad_price,
          (SELECT count(*)::int FROM suppliers) AS suppliers_total,
          (SELECT count(*)::int FROM suppliers WHERE phone IS NOT NULL OR contact_name IS NOT NULL) AS suppliers_with_contact,
          (SELECT count(*)::int FROM customers) AS customers_total,
          (SELECT count(*)::int FROM part_aliases) AS aliases_total
      `),
      // 还没处理的重复组（清洗后应为 0，新导入可能再产生）
      pool.query(`
        SELECT pn_norm, count(*)::int AS n,
               string_agg(pn, ' | ' ORDER BY pn) AS variants,
               sum(ship_count)::int AS total_ship,
               count(*) FILTER (WHERE has_actual_sale)::int AS with_sale
          FROM parts WHERE merged_into IS NULL
         GROUP BY pn_norm HAVING count(*) > 1
         ORDER BY count(*) DESC, sum(ship_count) DESC LIMIT 50
      `),
      pool.query(`
        SELECT s.id, p.pn, s.ship_date::text AS ship_date,
               s.quantity::float AS quantity, s.unit_price::float AS unit_price, s.price_flag
          FROM shipments s JOIN parts p ON p.id = s.part_id
         WHERE s.price_flag <> 'ok'
         ORDER BY s.ship_date DESC LIMIT 50
      `),
      pool.query(`
        SELECT merge_batch, count(*)::int AS merged_rows,
               sum(moved_shipments)::int AS moved_shipments,
               sum(moved_quotes)::int AS moved_quotes,
               min(created_at)::text AS created_at,
               count(*) FILTER (WHERE reverted_at IS NOT NULL)::int AS reverted
          FROM part_merge_log GROUP BY merge_batch ORDER BY min(created_at) DESC LIMIT 10
      `),
    ]);

    const o = overview.rows[0];
    const completeness = [
      { label: '有成交记录的物料', a: o.parts_with_sale, b: o.parts_active },
      { label: '有成本参考的物料', a: o.parts_with_cost, b: o.parts_active },
      { label: '有供应商报价的物料', a: o.parts_with_quote, b: o.parts_active },
      { label: '出货记录关联到客户', a: o.shipments_with_customer, b: o.shipments_total },
      { label: '供应商有联系方式', a: o.suppliers_with_contact, b: o.suppliers_total },
    ].map((x) => ({ ...x, pct: x.b ? (x.a / x.b) * 100 : 0 }));

    return NextResponse.json({
      overview: o,
      completeness,
      duplicateGroups: dupGroups.rows,
      badPriceRows: zeroPrice.rows,
      mergeBatches: merges.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
