import { NextResponse } from 'next/server';
import pool from '@/lib/db';

/** 导入批次列表 */
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.batch_no, b.kind, b.file_name, b.row_total, b.row_ok, b.row_rejected,
              b.status, b.created_by, b.created_at::text AS created_at,
              b.rolled_back_at::text AS rolled_back_at, b.issues,
              (SELECT count(*)::int FROM shipments s WHERE s.import_batch_id = b.id) AS shipments_written,
              (SELECT count(*)::int FROM supplier_parts sp WHERE sp.import_batch_id = b.id) AS quotes_written,
              (SELECT count(*)::int FROM parts p WHERE p.import_batch_id = b.id) AS parts_written
         FROM import_batches b
        ORDER BY b.created_at DESC LIMIT 50`
    );
    return NextResponse.json({ batches: rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
