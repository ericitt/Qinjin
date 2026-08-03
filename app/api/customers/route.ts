import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 客户列表（带采购行为统计） */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const params: any[] = [];
  let where = '';
  if (q) { where = `WHERE c.name ILIKE $1 OR c.short_name ILIKE $1`; params.push(`%${q}%`); }

  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.short_name, c.contact_name, c.phone, c.region, c.level,
              c.payment_terms, c.notes,
              coalesce(s.order_count, 0)::int AS order_count,
              coalesce(s.amount, 0)::float   AS amount,
              s.last_date::text              AS last_date,
              s.margin_pct::float            AS margin_pct,
              coalesce(b.quote_count, 0)::int AS quote_count,
              coalesce(b.won_count, 0)::int   AS won_count
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT sh.ship_date)::int AS order_count,
                  sum(sh.quantity * sh.unit_price)  AS amount,
                  max(sh.ship_date)                 AS last_date,
                  CASE WHEN sum(sh.quantity * sh.unit_price) > 0
                       THEN (sum(sh.quantity * sh.unit_price) - sum(sh.quantity * coalesce(sh.unit_cost, 0)))
                            / nullif(sum(sh.quantity * sh.unit_price), 0) * 100 END AS margin_pct
             FROM shipments sh
            WHERE sh.customer_id = c.id AND sh.price_flag = 'ok'
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS quote_count,
                  count(*) FILTER (WHERE outcome = 'won')::int AS won_count
             FROM boms WHERE customer_id = c.id
         ) b ON true
         ${where}
        ORDER BY coalesce(s.amount, 0) DESC, c.name ASC
        LIMIT 200`,
      params
    );
    return NextResponse.json({ customers: rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** 新增 / 更新客户 */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b?.name?.trim()) return NextResponse.json({ error: '客户名称必填' }, { status: 400 });
    const { rows } = await pool.query(
      `INSERT INTO customers (name, short_name, contact_name, phone, email, region, level, payment_terms, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name) DO UPDATE SET
         short_name = coalesce(EXCLUDED.short_name, customers.short_name),
         contact_name = coalesce(EXCLUDED.contact_name, customers.contact_name),
         phone = coalesce(EXCLUDED.phone, customers.phone),
         email = coalesce(EXCLUDED.email, customers.email),
         region = coalesce(EXCLUDED.region, customers.region),
         level = coalesce(EXCLUDED.level, customers.level),
         payment_terms = coalesce(EXCLUDED.payment_terms, customers.payment_terms),
         notes = coalesce(EXCLUDED.notes, customers.notes)
       RETURNING *`,
      [b.name.trim(), b.short_name || null, b.contact_name || null, b.phone || null, b.email || null,
       b.region || null, b.level || null, b.payment_terms || null, b.notes || null]
    );
    return NextResponse.json({ customer: rows[0] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
