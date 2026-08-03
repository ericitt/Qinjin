import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { ensurePartExists } from '@/lib/matching';

type SubmitItem = {
  pn: string;
  qty: number;
  matchType: 'exact' | 'catalog' | 'partial' | 'none';
  part?: { id: number } | null;
  unitPrice?: number | null;
  cost?: number | null;
  confirmed?: boolean; // 人工是否确认采用这条匹配结果，默认 true
  isNew?: boolean; // 人工是否确认"这是一个全新型号，需要建档"
  newPartData?: { spec?: string; cat?: string; brand?: string; price?: number };
};

export async function POST(req: NextRequest) {
  const client = await pool.connect();
  try {
    const body = await req.json();
    const rawText: string = body.raw_text || '';
    const items: SubmitItem[] = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return NextResponse.json({ error: '没有可提交的物料明细' }, { status: 400 });
    }

    await client.query('BEGIN');

    const enriched: any[] = [];
    for (const item of items) {
      let partId: number | null = item.part?.id ?? null;
      let action: 'quoted' | 'created_and_quoted' | 'skipped' = 'skipped';

      // 情况一：人工确认这是全新型号 → 自动建档
      if (item.isNew && item.pn) {
        partId = await ensurePartExists(item.pn);
        const np = item.newPartData || {};
        await client.query(
          `UPDATE parts SET
             spec = COALESCE($1, spec),
             cat = COALESCE($2, cat),
             brand = COALESCE($3, brand),
             standard_price = COALESCE($4, standard_price),
             updated_at = now()
           WHERE id = $5`,
          [np.spec || null, np.cat || null, np.brand || null, np.price || null, partId]
        );
        if (np.price || item.unitPrice) {
          await client.query(
            `INSERT INTO quotes (part_id, price, source, quantity, notes) VALUES ($1,$2,'supplier_quote',$3,$4)`,
            [partId, np.price || item.unitPrice, item.qty || null, 'AI询价助手：新型号建档']
          );
        }
        action = 'created_and_quoted';
      }
      // 情况二：匹配到了已有型号，且人工没有明确取消确认 → 记一条报价
      else if (partId && item.confirmed !== false) {
        const source = item.matchType === 'exact' ? 'actual_sale' : item.matchType === 'catalog' ? 'catalog_cost' : 'supplier_quote';
        if (item.unitPrice) {
          await client.query(
            `INSERT INTO quotes (part_id, price, source, quantity, notes) VALUES ($1,$2,$3,$4,$5)`,
            [partId, item.unitPrice, source, item.qty || null, 'AI询价助手：BOM确认提交']
          );
        }
        action = 'quoted';
      }
      // 情况三：未匹配且未确认为新型号 → 不写库，只存档，等人工后续处理

      enriched.push({ ...item, matched_part_db_id: partId, action });
    }

    const bomRes = await client.query(
      `INSERT INTO boms (raw_text, status, parsed_parts, confirmed_at) VALUES ($1, 'confirmed', $2, now()) RETURNING id`,
      [rawText, JSON.stringify(enriched)]
    );

    await client.query('COMMIT');
    return NextResponse.json({
      bom_id: bomRes.rows[0].id,
      created: enriched.filter((e) => e.action === 'created_and_quoted').length,
      quoted: enriched.filter((e) => e.action === 'quoted').length,
      skipped: enriched.filter((e) => e.action === 'skipped').length,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
