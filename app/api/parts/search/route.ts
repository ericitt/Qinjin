import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  const cat = req.nextUrl.searchParams.get('cat')?.trim() || '';
  const brand = req.nextUrl.searchParams.get('brand')?.trim() || '';
  const shippedOnly = req.nextUrl.searchParams.get('shipped') === 'true';
  const sort = req.nextUrl.searchParams.get('sort') || 'default'; // 'default' | 'freq'
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50', 10) || 50, 200);

  let query = `
    SELECT p.id, p.pn, p.spec, p.cat, p.brand, p.stock_qty, p.catalog_cost, p.standard_price, p.has_actual_sale,
           COALESCE(s.ship_count, 0)::int as ship_count, COALESCE(s.total_qty, 0)::float as total_qty, s.avg_price
    FROM parts p
    LEFT JOIN LATERAL (
      SELECT count(*) as ship_count, sum(quantity) as total_qty, avg(unit_price) as avg_price
      FROM shipments WHERE part_id = p.id
    ) s ON true
    WHERE 1=1
  `;
  const params: any[] = [];
  let i = 1;

  if (q) {
    query += ` AND (p.pn ILIKE $${i} OR p.spec ILIKE $${i} OR p.brand ILIKE $${i} OR p.cat ILIKE $${i})`;
    params.push(`%${q}%`);
    i++;
  }
  if (cat) { query += ` AND p.cat = $${i}`; params.push(cat); i++; }
  if (brand) { query += ` AND p.brand = $${i}`; params.push(brand); i++; }
  if (shippedOnly) query += ` AND p.has_actual_sale = true`;

  query += sort === 'freq'
    ? ` ORDER BY ship_count DESC, p.pn ASC LIMIT $${i}`
    : ` ORDER BY p.has_actual_sale DESC, p.pn ASC LIMIT $${i}`;
  params.push(limit);

  try {
    const result = await pool.query(query, params);
    return NextResponse.json({ parts: result.rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

