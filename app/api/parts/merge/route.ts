import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';

export const maxDuration = 300;

/**
 * 合并重复型号（数据体检页调用）
 * body: { pnNorms?: string[], all?: boolean, dryRun?: boolean }
 *
 * 与 002 迁移同样的策略，但这次把被搬迁的行 id 全部记进 part_merge_log.moved_ids，
 * 所以之后的合并是可以精确撤销的（见 /api/parts/merge DELETE）。
 */
export async function POST(req: NextRequest) {
  const client = await pool.connect();
  try {
    const { pnNorms, all, dryRun } = await req.json().catch(() => ({}));

    const groupSql = `
      SELECT pn_norm FROM parts
       WHERE merged_into IS NULL AND pn_norm <> ''
         ${all ? '' : 'AND pn_norm = ANY($1::text[])'}
       GROUP BY pn_norm HAVING count(*) > 1`;
    const groupParams = all ? [] : [pnNorms || []];
    const { rows: groups } = await client.query(groupSql, groupParams);
    if (!groups.length) return NextResponse.json({ ok: true, groups: 0, merged: 0, batch: null });

    const norms = groups.map((g: any) => g.pn_norm);
    const { rows: plan } = await client.query(
      `WITH ranked AS (
         SELECT p.id, p.pn, p.pn_norm, p.ship_count, p.has_actual_sale,
                row_number() OVER (PARTITION BY p.pn_norm
                  ORDER BY p.has_actual_sale DESC, p.ship_count DESC,
                           (p.pn ~ '[/\\s]$') ASC, length(p.pn) ASC, p.id ASC) AS rk
           FROM parts p WHERE p.merged_into IS NULL AND p.pn_norm = ANY($1::text[])
       )
       SELECT d.id AS dup_id, d.pn AS dup_pn, d.ship_count AS dup_ship,
              m.id AS main_id, m.pn AS main_pn, d.pn_norm
         FROM ranked d JOIN ranked m ON m.pn_norm = d.pn_norm AND m.rk = 1
        WHERE d.rk > 1`,
      [norms]
    );

    if (dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, groups: groups.length, willMerge: plan });
    }

    const batch = 'MERGE-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    await client.query('BEGIN');
    let merged = 0;

    for (const r of plan) {
      const moved: Record<string, number[]> = {};
      const move = async (table: string) => {
        const { rows } = await client.query(
          `UPDATE ${table} SET part_id = $1 WHERE part_id = $2 RETURNING id`, [r.main_id, r.dup_id]);
        moved[table] = rows.map((x: any) => Number(x.id));
        return rows.length;
      };
      const ship = await move('shipments');
      const quote = await move('quotes');
      const bom = await move('bom_items');

      const { rows: spMoved } = await client.query(
        `UPDATE supplier_parts sp SET part_id = $1
          WHERE sp.part_id = $2
            AND NOT EXISTS (SELECT 1 FROM supplier_parts x WHERE x.part_id = $1 AND x.supplier_id = sp.supplier_id)
          RETURNING id`, [r.main_id, r.dup_id]);
      moved['supplier_parts'] = spMoved.map((x: any) => Number(x.id));
      await client.query(`DELETE FROM supplier_parts WHERE part_id = $1`, [r.dup_id]);

      await client.query(
        `UPDATE parts m SET spec = coalesce(m.spec, d.spec), cat = coalesce(m.cat, d.cat),
                brand = coalesce(m.brand, d.brand), catalog_cost = coalesce(m.catalog_cost, d.catalog_cost),
                standard_price = coalesce(m.standard_price, d.standard_price)
           FROM parts d WHERE m.id = $1 AND d.id = $2`, [r.main_id, r.dup_id]);

      await client.query(
        `INSERT INTO part_aliases (part_id, alias, alias_norm, source)
         VALUES ($1, $2, qj_norm_pn($2), 'merge') ON CONFLICT (alias) DO NOTHING`,
        [r.main_id, r.dup_pn]);

      await client.query(`UPDATE parts SET merged_into = $1 WHERE id = $2`, [r.main_id, r.dup_id]);
      await client.query(
        `INSERT INTO part_merge_log (merge_batch, from_part_id, to_part_id, from_pn, to_pn,
           moved_shipments, moved_quotes, moved_bom_items, moved_supplier_parts, moved_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [batch, r.dup_id, r.main_id, r.dup_pn, r.main_pn, ship, quote, bom,
         moved['supplier_parts'].length, JSON.stringify(moved)]);
      merged++;
    }

    await client.query(`SELECT qj_refresh_part_stats()`);
    await client.query(`SELECT qj_refresh_supplier_part_count()`);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, batch, groups: groups.length, merged });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

/** 精确撤销一个合并批次（仅限带 moved_ids 的批次） */
export async function DELETE(req: NextRequest) {
  const client = await pool.connect();
  try {
    const { batch } = await req.json();
    if (!batch) return NextResponse.json({ error: '缺少批次号' }, { status: 400 });

    const { rows } = await client.query(
      `SELECT * FROM part_merge_log WHERE merge_batch = $1 AND reverted_at IS NULL ORDER BY id DESC`, [batch]);
    if (!rows.length) return NextResponse.json({ error: '批次不存在或已撤销' }, { status: 404 });
    if (rows.some((r: any) => !r.moved_ids)) {
      return NextResponse.json(
        { error: '该批次未记录搬迁明细（002 首批清洗），无法精确撤销，请使用 Supabase 时间点恢复' },
        { status: 409 }
      );
    }

    await client.query('BEGIN');
    for (const r of rows) {
      const ids = r.moved_ids as Record<string, number[]>;
      for (const [table, list] of Object.entries(ids)) {
        if (list?.length) {
          await client.query(`UPDATE ${table} SET part_id = $1 WHERE id = ANY($2::bigint[])`, [r.from_part_id, list]);
        }
      }
      await client.query(`UPDATE parts SET merged_into = NULL WHERE id = $1`, [r.from_part_id]);
      await client.query(`DELETE FROM part_aliases WHERE part_id = $1 AND alias = $2`, [r.to_part_id, r.from_pn]);
      await client.query(`UPDATE part_merge_log SET reverted_at = now() WHERE id = $1`, [r.id]);
    }
    await client.query(`SELECT qj_refresh_part_stats()`);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, batch, reverted: rows.length });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
