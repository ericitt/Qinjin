import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 询价单列表 —— 之前 AI 询价的结果写进 boms 后前端无处可看，这里补上 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const outcome = (sp.get('outcome') || '').trim();
  const limit = Math.min(parseInt(sp.get('limit') || '50', 10) || 50, 200);
  const page = Math.max(parseInt(sp.get('page') || '1', 10) || 1, 1);

  const where: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (outcome) { where.push(`b.outcome = $${i}`); params.push(outcome); i++; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.quote_no, b.created_at::text AS created_at, b.outcome,
              b.line_count, b.matched_count, b.total_amount::float AS total_amount,
              b.total_cost::float AS total_cost, b.margin_pct::float AS margin_pct,
              b.submitted_by, c.short_name, c.name AS customer_name,
              count(*) OVER () AS total_count
         FROM boms b LEFT JOIN customers c ON c.id = b.customer_id
         ${whereSql}
        ORDER BY b.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, (page - 1) * limit]
    );

    const { rows: [stat] } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE outcome = 'won')::int  AS won,
              count(*) FILTER (WHERE outcome = 'lost')::int AS lost,
              count(*) FILTER (WHERE outcome IN ('quoted','pending'))::int AS open,
              avg(margin_pct)::float AS avg_margin
         FROM boms WHERE created_at >= date_trunc('month', current_date)`
    );

    return NextResponse.json({
      inquiries: rows.map(({ total_count, ...r }: any) => r),
      total: rows.length ? Number(rows[0].total_count) : 0,
      page, limit,
      monthly: {
        ...stat,
        winRate: stat.won + stat.lost > 0 ? (stat.won / (stat.won + stat.lost)) * 100 : null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** 更新询价单结果：quoted / pending / won / lost */
export async function PATCH(req: NextRequest) {
  try {
    const { id, outcome } = await req.json();
    const allowed = ['draft', 'quoted', 'pending', 'won', 'lost'];
    if (!id || !allowed.includes(outcome)) {
      return NextResponse.json({ error: '参数不合法' }, { status: 400 });
    }
    const { rows } = await pool.query(
      `UPDATE boms SET outcome = $1, outcome_at = now() WHERE id = $2 RETURNING id, quote_no, outcome`,
      [outcome, id]
    );
    if (!rows[0]) return NextResponse.json({ error: '询价单不存在' }, { status: 404 });
    return NextResponse.json({ inquiry: rows[0] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
