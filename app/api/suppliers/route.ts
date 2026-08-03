import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind') || 'brand';
  const q = req.nextUrl.searchParams.get('q')?.trim() || '';

  let query = `SELECT * FROM suppliers WHERE kind = $1`;
  const params: any[] = [kind];
  if (q) {
    query += ` AND company_name ILIKE $2`;
    params.push(`%${q}%`);
  }
  query += kind === 'brand' ? ` ORDER BY score DESC NULLS LAST, ship_freq DESC` : ` ORDER BY company_name ASC`;

  try {
    const result = await pool.query(query, params);
    return NextResponse.json({ suppliers: result.rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
