import { NextRequest, NextResponse } from 'next/server';
import { matchOnePart } from '@/lib/matching';
import pool from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: { pn: string } }) {
  const pn = decodeURIComponent(params.pn);
  try {
    const result = await matchOnePart(pn, 1);
    if (!result.part) {
      return NextResponse.json({ error: '未找到该型号' }, { status: 404 });
    }
    const partId = result.part.id;

    const [recent, aliases, trend, priceHist] = await Promise.all([
      // 最近成交（带客户），零价记录标出来但不参与统计
      pool.query(
        `SELECT s.ship_date::text AS ship_date, s.quantity::float AS quantity,
                s.unit_price::float AS unit_price, s.unit_cost::float AS unit_cost,
                s.price_flag, c.short_name, c.name AS customer_name
           FROM shipments s LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.part_id = $1
          ORDER BY s.ship_date DESC LIMIT 30`,
        [partId]
      ),
      // 合并进来的历史别名
      pool.query(
        `SELECT alias, source FROM part_aliases WHERE part_id = $1 ORDER BY alias`,
        [partId]
      ),
      // 按月成交均价走势
      pool.query(
        `SELECT to_char(date_trunc('month', ship_date), 'YYYY-MM') AS ym,
                avg(unit_price)::float AS avg_price,
                sum(quantity)::float AS qty
           FROM shipments
          WHERE part_id = $1 AND price_flag = 'ok'
            AND ship_date >= (current_date - interval '24 months')
          GROUP BY 1 ORDER BY 1`,
        [partId]
      ),
      // 各来源价格记录
      pool.query(
        `SELECT source::text, brand, price::float AS price, quantity::float AS quantity,
                recorded_at::text AS recorded_at
           FROM quotes WHERE part_id = $1 ORDER BY recorded_at DESC LIMIT 20`,
        [partId]
      ),
    ]);

    return NextResponse.json({
      ...result,
      recentShipments: recent.rows,
      aliases: aliases.rows,
      priceTrend: trend.rows,
      priceRecords: priceHist.rows,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
