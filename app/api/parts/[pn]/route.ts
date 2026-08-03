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

    // 最近20条出货记录，供详情页展示
    const { rows: recentShipments } = await pool.query(
      `SELECT ship_date, quantity, unit_price FROM shipments WHERE part_id = $1 ORDER BY ship_date DESC LIMIT 20`,
      [result.part.id]
    );

    // 手动/认证供应商里，是否有人报过这个型号
    const { rows: supplierQuotes } = await pool.query(
      `SELECT s.company_name, s.grade, s.phone, s.contact_name, sp.price
       FROM supplier_parts sp JOIN suppliers s ON s.id = sp.supplier_id
       WHERE sp.part_id = $1`,
      [result.part.id]
    );

    return NextResponse.json({ ...result, recentShipments, supplierQuotes });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
