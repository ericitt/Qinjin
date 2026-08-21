import { NextResponse } from 'next/server';
import pool from '@/lib/db';

/**
 * 必须强制动态。
 *
 * Next.js App Router 有个很坑的默认行为：GET 路由如果不读 request、
 * 也不用 cookies()/headers() 这类动态 API，它会被当成静态内容，
 * 在 **构建时** 执行一次，然后永远返回那一次的结果。
 *
 * 表现就是：导入成功了历史列表不出现、撤销成功了按钮还在、
 * 再点一次才提示「已经撤销过了」—— 数据库明明是对的，页面就是不动。
 * 排查时会一直往数据库和事务上找，其实根本没查库。
 */
export const dynamic = 'force-dynamic';

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
