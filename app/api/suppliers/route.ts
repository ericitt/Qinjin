import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 供应商列表：带评分明细与报价覆盖数 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get('kind') || '';
  const q = (sp.get('q') || '').trim();

  const where: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (kind) { where.push(`s.kind = $${i}`); params.push(kind); i++; }
  if (q) { where.push(`s.company_name ILIKE $${i}`); params.push(`%${q}%`); i++; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.kind, s.company_name, s.contact_name, s.phone, s.region, s.currency,
              s.grade, s.lead_time_days, s.moq, s.payment_terms, s.notes,
              s.ship_freq, s.ship_qty::float AS ship_qty, s.avg_price::float AS avg_price,
              s.score::float AS score, s.score_detail,
              coalesce(qp.n, 0)::int AS quoted_parts,
              qp.min_price::float AS min_quote,
              qp.last_quote::text  AS last_quote
         FROM suppliers s
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS n, min(price) AS min_price, max(quoted_at) AS last_quote
             FROM supplier_parts WHERE supplier_id = s.id
         ) qp ON true
         ${whereSql}
        ORDER BY s.score DESC NULLS LAST, s.ship_freq DESC NULLS LAST, s.company_name ASC
        LIMIT 300`,
      params
    );
    return NextResponse.json({ suppliers: rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** 新增供应商 */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    if (!b?.company_name?.trim()) return NextResponse.json({ error: '供应商名称必填' }, { status: 400 });
    const { rows } = await pool.query(
      `INSERT INTO suppliers (kind, company_name, contact_name, phone, region, grade,
                              lead_time_days, moq, payment_terms, notes)
       VALUES ('verified',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.company_name.trim(), b.contact_name || null, b.phone || null, b.region || null,
       b.grade || null, b.lead_time_days || null, b.moq || null, b.payment_terms || null, b.notes || null]
    );
    return NextResponse.json({ supplier: rows[0] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
