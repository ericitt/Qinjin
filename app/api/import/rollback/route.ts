import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

export const maxDuration = 120;

/**
 * 整批撤销导入。
 * 只删除本批次写入的行；本批次"自动建档"出来的物料/供应商如果没有被别处引用，一并清掉。
 * body: { batchNo }
 */
export async function POST(req: NextRequest) {
  const client = await pool.connect();
  try {
    const { batchNo } = await req.json();
    if (!batchNo) return NextResponse.json({ error: '缺少批次号' }, { status: 400 });

    const { rows: [b] } = await client.query(
      `SELECT id, kind, status FROM import_batches WHERE batch_no = $1`, [batchNo]);
    if (!b) return NextResponse.json({ error: '批次不存在' }, { status: 404 });
    if (b.status === 'rolled_back') return NextResponse.json({ error: '该批次已经撤销过了' }, { status: 409 });

    await client.query('BEGIN');
    const removed: Record<string, number> = {};

    const del = async (label: string, sql: string) => {
      const r = await client.query(sql, [b.id]);
      removed[label] = r.rowCount ?? 0;
    };

    await del('shipments', `DELETE FROM shipments WHERE import_batch_id = $1`);
    await del('supplier_parts', `DELETE FROM supplier_parts WHERE import_batch_id = $1`);
    // 本批自动建档、且没有任何数据挂靠的物料才删
    await del('parts', `
      DELETE FROM parts p WHERE p.import_batch_id = $1
        AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.part_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.part_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM bom_items bi WHERE bi.part_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM supplier_parts sp WHERE sp.part_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM parts x WHERE x.merged_into = p.id)`);
    await del('suppliers', `
      DELETE FROM suppliers s WHERE s.import_batch_id = $1
        AND NOT EXISTS (SELECT 1 FROM supplier_parts sp WHERE sp.supplier_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.supplier_id = s.id)`);

    await client.query(`SELECT qj_refresh_part_stats()`);
    await client.query(`SELECT qj_refresh_supplier_part_count()`);
    await client.query(
      `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`, [b.id]);
    await client.query('COMMIT');

    return NextResponse.json({ ok: true, batchNo, removed });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
