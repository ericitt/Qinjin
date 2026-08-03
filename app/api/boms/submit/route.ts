import { NextRequest, NextResponse } from 'next/server';
import pool from '@/lib/db';
import { ensurePartExists } from '@/lib/matching';

export const maxDuration = 120;

type SubmitItem = {
  pn: string;
  qty: number;
  matchType: 'exact' | 'alias' | 'catalog' | 'partial' | 'none';
  part?: { id: number } | null;
  unitPrice?: number | null;   // 建议价
  finalPrice?: number | null;  // 人工调整后的最终报价
  cost?: number | null;
  confirmed?: boolean;
  isNew?: boolean;
  newPartData?: { spec?: string; cat?: string; brand?: string; price?: number };
};

async function nextQuoteNo(client: any): Promise<string> {
  const d = new Date();
  const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { rows } = await client.query(
    `SELECT count(*)::int AS c FROM boms WHERE quote_no LIKE $1`, [`Q-${ym}-%`]);
  return `Q-${ym}-${String(rows[0].c + 1).padStart(3, '0')}`;
}

/**
 * 确认询价单：写 boms（含金额/毛利/客户）+ quote_line_items 逐行明细
 * 相比旧版：不再只把结果塞进 parsed_parts JSON，而是同时写入关联表，
 * 这样"按型号统计报过多少次价""转化率"这类问题才能用标准 SQL 回答。
 */
export async function POST(req: NextRequest) {
  const client = await pool.connect();
  try {
    const body = await req.json();
    const rawText: string = body.raw_text || '';
    const customerId: number | null = body.customer_id ?? null;
    const submittedBy: string | null = body.submitted_by || null;
    const items: SubmitItem[] = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return NextResponse.json({ error: '没有可提交的物料明细' }, { status: 400 });

    await client.query('BEGIN');

    const enriched: any[] = [];
    let totalAmount = 0;
    let totalCost = 0;
    let matched = 0;

    for (const item of items) {
      let partId: number | null = item.part?.id ?? null;
      let action: 'quoted' | 'created_and_quoted' | 'skipped' = 'skipped';
      const price = item.finalPrice ?? item.unitPrice ?? null;
      const qty = Number(item.qty) || 0;

      if (item.isNew && item.pn) {
        partId = await ensurePartExists(item.pn);
        const np = item.newPartData || {};
        await client.query(
          `UPDATE parts SET spec = coalesce($1, spec), cat = coalesce($2, cat),
                  brand = coalesce($3, brand), standard_price = coalesce($4, standard_price)
             WHERE id = $5`,
          [np.spec || null, np.cat || null, np.brand || null, np.price || price || null, partId]
        );
        if (np.price || price) {
          await client.query(
            `INSERT INTO quotes (part_id, price, source, quantity, notes)
             VALUES ($1,$2,'supplier_quote',$3,$4)`,
            [partId, np.price || price, qty || null, 'AI询价助手：新型号建档']);
        }
        action = 'created_and_quoted';
      } else if (partId && item.confirmed !== false) {
        const source = item.matchType === 'exact' ? 'actual_sale'
          : item.matchType === 'catalog' ? 'catalog_cost' : 'supplier_quote';
        if (price) {
          await client.query(
            `INSERT INTO quotes (part_id, price, source, quantity, notes)
             VALUES ($1,$2,$3,$4,$5)`,
            [partId, price, source, qty || null, 'AI询价助手：询价单确认']);
        }
        action = 'quoted';
      }

      if (partId && action !== 'skipped') {
        matched++;
        if (price && qty) { totalAmount += price * qty; totalCost += (item.cost || 0) * qty; }
      }
      enriched.push({ ...item, matched_part_db_id: partId, action });
    }

    const marginPct = totalAmount > 0 ? ((totalAmount - totalCost) / totalAmount) * 100 : null;
    const quoteNo = await nextQuoteNo(client);

    const { rows: [bom] } = await client.query(
      `INSERT INTO boms (quote_no, customer_id, submitted_by, raw_text, status, parsed_parts,
                         line_count, matched_count, total_amount, total_cost, margin_pct,
                         outcome, confirmed_at)
       VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,$8,$9,$10,'quoted',now())
       RETURNING id, quote_no`,
      [quoteNo, customerId, submittedBy, rawText, JSON.stringify(enriched),
       items.length, matched, totalAmount || null, totalCost || null,
       marginPct !== null ? Number(marginPct.toFixed(2)) : null]
    );

    // 逐行明细（替代 parsed_parts 大 JSON 做统计）
    for (const e of enriched) {
      if (!e.matched_part_db_id) continue;
      await client.query(
        `INSERT INTO quote_line_items (bom_id, part_id, raw_pn, match_type, qty,
                                       suggest_price, final_price, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [bom.id, e.matched_part_db_id, e.pn, e.matchType, e.qty || null,
         e.unitPrice ?? null, e.finalPrice ?? e.unitPrice ?? null, e.cost ?? null]);
    }

    await client.query('COMMIT');
    return NextResponse.json({
      bom_id: bom.id,
      quote_no: bom.quote_no,
      created: enriched.filter((e) => e.action === 'created_and_quoted').length,
      quoted: enriched.filter((e) => e.action === 'quoted').length,
      skipped: enriched.filter((e) => e.action === 'skipped').length,
      total_amount: totalAmount,
      margin_pct: marginPct,
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
