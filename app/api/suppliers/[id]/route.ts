import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 单个供应商：报过哪些型号、价格是不是最优、在这家买划不划算 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: '无效的供应商 ID' }, { status: 400 });

  try {
    const [sup, parts] = await Promise.all([
      pool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]),
      pool.query(
        `SELECT p.id, p.pn, p.spec, p.brand,
                sp.price::float AS price, sp.currency, sp.moq,
                sp.lead_time_days, sp.quoted_at::text AS quoted_at,
                mn.best::float AS market_best,
                p.avg_price::float AS our_sell_price,
                p.ship_count
           FROM supplier_parts sp
           JOIN parts p ON p.id = sp.part_id
           LEFT JOIN LATERAL (
             SELECT min(price) AS best FROM supplier_parts x WHERE x.part_id = sp.part_id
           ) mn ON true
          WHERE sp.supplier_id = $1
          ORDER BY sp.price DESC NULLS LAST
          LIMIT 300`, [id]),
    ]);

    if (!sup.rows[0]) return NextResponse.json({ error: '供应商不存在' }, { status: 404 });

    const rows = parts.rows.map((r: any) => ({
      ...r,
      isBest: r.market_best !== null && r.price !== null && Math.abs(r.price - r.market_best) < 1e-9,
      // 比全市场最低价贵多少（%）
      premiumPct: r.market_best && r.price && r.market_best > 0
        ? ((r.price - r.market_best) / r.market_best) * 100 : null,
      margin: r.our_sell_price && r.price && r.our_sell_price > 0
        ? ((r.our_sell_price - r.price) / r.our_sell_price) * 100 : null,
    }));

    return NextResponse.json({
      supplier: sup.rows[0],
      parts: rows,
      stats: {
        quoted: rows.length,
        bestCount: rows.filter((r: any) => r.isBest).length,
        avgPremium: rows.length
          ? rows.filter((r: any) => r.premiumPct !== null)
              .reduce((s: number, r: any, _i: number, a: any[]) => s + r.premiumPct / a.length, 0)
          : null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
