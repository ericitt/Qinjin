import pool from './db';

export type MatchType = 'exact' | 'alias' | 'catalog' | 'partial' | 'none';

export type PartRow = {
  id: number;
  pn: string;
  spec: string | null;
  cat: string | null;
  brand: string | null;
  stock_qty: string | null;
  catalog_cost: string | null;
  standard_price: string | null;
  has_actual_sale: boolean;
  ship_count: number;
  ship_qty: number | null;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  last_ship_date: string | null;
};

export type ShipmentStats = {
  ship_count: number;
  total_qty: number;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  last_date: string | null;
};

export type SupplierQuote = {
  supplier_id: number;
  supplier_name: string;
  price: number;
  currency: string | null;
  moq: string | null;
  lead_time_days: number | null;
  quoted_at: string | null;
  valid_until: string | null;
  expired: boolean;
};

export type MatchResult = {
  queryPn: string;
  qty: number;
  matchType: MatchType;
  part: PartRow | null;
  shipStats: ShipmentStats | null;
  unitPrice: number | null;   // 建议报价单价
  cost: number | null;        // 参考成本（供应商最优报价优先，其次目录成本）
  costSource: 'supplier' | 'catalog' | null;
  margin: number | null;      // 毛利率 %
  bestQuote: SupplierQuote | null;
  supplierQuotes: SupplierQuote[];
  bomInfo: { driver_model: string; designator: string | null; qty_per_unit: number; alt_pns: string[] | null }[];
  warnings: string[];
};

/** 与数据库 qj_norm_pn() 保持一致：只去尾部斜杠/空白 + 转大写，不动型号内部字符 */
export function normPn(pn: string): string {
  return (pn || '').replace(/[/\s]+$/g, '').trim().toUpperCase();
}

export function calcMargin(cost: number | null, price: number | null): number | null {
  if (!cost || cost <= 0 || !price || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

const PART_COLS = `p.id, p.pn, p.spec, p.cat, p.brand, p.stock_qty, p.catalog_cost, p.standard_price,
  p.has_actual_sale, p.ship_count, p.ship_qty::float as ship_qty, p.avg_price::float as avg_price,
  p.min_price::float as min_price, p.max_price::float as max_price, p.last_ship_date::text as last_ship_date`;

/* =====================================================================
   批量匹配
   旧实现是每个型号 4 次 SQL（200 行 BOM ≈ 800 次往返，且连接池 max 很小）。
   现在整批固定 5 次查询，与行数无关：
     1) 精确匹配（按 pn_norm）
     2) 别名匹配（合并掉的旧型号仍能命中）
     3) 模糊匹配（仅对前两步没命中的，用 trigram 相似度排序）
     4) 供应商报价（一次取回所有命中物料的报价）
     5) BOM 关系
   出货统计不再现算，直接读 parts 上的冗余字段（导入/合并时刷新）。
   ===================================================================== */
export async function matchManyParts(items: { pn: string; qty: number }[]): Promise<MatchResult[]> {
  const results: MatchResult[] = items.map((it) => emptyResult(it.pn, it.qty));
  if (!items.length) return results;

  const norms = items.map((it) => normPn(it.pn));
  const uniqNorms = Array.from(new Set(norms.filter(Boolean)));
  if (!uniqNorms.length) return results;

  // --- 1) 精确匹配（排除已被合并的记录） ---
  const exact = await pool.query(
    `SELECT ${PART_COLS}, p.pn_norm FROM parts p
      WHERE p.merged_into IS NULL AND p.pn_norm = ANY($1::text[])`,
    [uniqNorms]
  );
  const byNorm = new Map<string, PartRow>();
  for (const r of exact.rows) byNorm.set(r.pn_norm, r as PartRow);

  // --- 2) 别名匹配：客户用的是合并前的旧型号 ---
  const missing1 = uniqNorms.filter((n) => !byNorm.has(n));
  const aliasHit = new Set<string>();
  if (missing1.length) {
    const al = await pool.query(
      `SELECT a.alias_norm, ${PART_COLS} FROM part_aliases a
         JOIN parts p ON p.id = a.part_id
        WHERE a.alias_norm = ANY($1::text[]) AND p.merged_into IS NULL`,
      [missing1]
    );
    for (const r of al.rows) {
      if (!byNorm.has(r.alias_norm)) {
        byNorm.set(r.alias_norm, r as PartRow);
        aliasHit.add(r.alias_norm);
      }
    }
  }

  // --- 3) 模糊匹配：只对仍未命中的，用 trigram 相似度取最像的一条 ---
  const missing2 = uniqNorms.filter((n) => !byNorm.has(n));
  const partialHit = new Set<string>();
  if (missing2.length) {
    const fz = await pool.query(
      `SELECT DISTINCT ON (q.n) q.n, ${PART_COLS}, similarity(p.pn, q.n) AS sim
         FROM unnest($1::text[]) AS q(n)
         JOIN parts p ON p.merged_into IS NULL
          AND (p.pn % q.n OR p.pn ILIKE '%' || q.n || '%')
        ORDER BY q.n, similarity(p.pn, q.n) DESC, p.has_actual_sale DESC, p.ship_count DESC, length(p.pn) ASC`,
      [missing2]
    );
    for (const r of fz.rows) {
      byNorm.set(r.n, r as PartRow);
      partialHit.add(r.n);
    }
  }

  const partIds = Array.from(new Set(Array.from(byNorm.values()).map((p) => p.id)));
  if (!partIds.length) return finalize(items, norms, byNorm, aliasHit, partialHit, new Map(), new Map(), results);

  // --- 4) 供应商报价 ---
  const sq = await pool.query(
    `SELECT sp.part_id, sp.supplier_id, s.company_name AS supplier_name,
            sp.price::float AS price, sp.currency, sp.moq, sp.lead_time_days,
            sp.quoted_at::text AS quoted_at, sp.valid_until::text AS valid_until,
            (sp.valid_until IS NOT NULL AND sp.valid_until < current_date) AS expired
       FROM supplier_parts sp
       JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.part_id = ANY($1::bigint[]) AND sp.price > 0
      ORDER BY sp.part_id, sp.price ASC`,
    [partIds]
  );
  const quotesByPart = new Map<number, SupplierQuote[]>();
  for (const r of sq.rows) {
    if (!quotesByPart.has(r.part_id)) quotesByPart.set(r.part_id, []);
    quotesByPart.get(r.part_id)!.push(r as SupplierQuote);
  }

  // --- 5) BOM 关系 ---
  const bi = await pool.query(
    `SELECT part_id, driver_model, designator, qty_per_unit, alt_pns
       FROM bom_items WHERE part_id = ANY($1::bigint[])`,
    [partIds]
  );
  const bomByPart = new Map<number, any[]>();
  for (const r of bi.rows) {
    if (!bomByPart.has(r.part_id)) bomByPart.set(r.part_id, []);
    bomByPart.get(r.part_id)!.push(r);
  }

  return finalize(items, norms, byNorm, aliasHit, partialHit, quotesByPart, bomByPart, results);
}

function emptyResult(pn: string, qty: number): MatchResult {
  return {
    queryPn: pn, qty, matchType: 'none', part: null, shipStats: null,
    unitPrice: null, cost: null, costSource: null, margin: null,
    bestQuote: null, supplierQuotes: [], bomInfo: [], warnings: [],
  };
}

function finalize(
  items: { pn: string; qty: number }[],
  norms: string[],
  byNorm: Map<string, PartRow>,
  aliasHit: Set<string>,
  partialHit: Set<string>,
  quotesByPart: Map<number, SupplierQuote[]>,
  bomByPart: Map<number, any[]>,
  results: MatchResult[]
): MatchResult[] {
  return results.map((res, i) => {
    const n = norms[i];
    const part = byNorm.get(n) || null;
    if (!part) return res;

    let matchType: MatchType;
    if (partialHit.has(n)) matchType = 'partial';
    else if (aliasHit.has(n)) matchType = 'alias';
    else matchType = part.has_actual_sale ? 'exact' : 'catalog';
    // 精确命中但从未成交 → 只有目录参考价
    if (matchType === 'alias' && !part.has_actual_sale) matchType = 'catalog';

    const shipStats: ShipmentStats | null = part.ship_count > 0 ? {
      ship_count: part.ship_count,
      total_qty: Number(part.ship_qty || 0),
      avg_price: num(part.avg_price),
      min_price: num(part.min_price),
      max_price: num(part.max_price),
      last_date: part.last_ship_date,
    } : null;

    const quotes = (quotesByPart.get(part.id) || []).filter((q) => !q.expired);
    const allQuotes = quotesByPart.get(part.id) || [];
    const bestQuote = quotes.length ? quotes[0] : null;

    // 成本：有有效供应商报价就用最低的那家，否则退回目录成本
    const catalogCost = num(part.catalog_cost);
    const cost = bestQuote ? bestQuote.price : catalogCost;
    const costSource: 'supplier' | 'catalog' | null = bestQuote ? 'supplier' : catalogCost ? 'catalog' : null;

    // 建议单价：历史成交均价优先，其次标准售价
    const unitPrice = num(part.avg_price) ?? num(part.standard_price);

    const warnings: string[] = [];
    if (matchType === 'partial') warnings.push('模糊匹配，请人工确认型号是否正确');
    if (matchType === 'alias') warnings.push(`命中历史别名，已归入主型号 ${part.pn}`);
    if (!shipStats) warnings.push('该型号从未成交过，只有参考价');
    if (!allQuotes.length) warnings.push('无供应商报价，成本仅供参考');
    if (allQuotes.length && !quotes.length) warnings.push('供应商报价均已过期');
    if (unitPrice && cost && unitPrice <= cost) warnings.push('建议单价低于成本，必须人工调价');

    return {
      ...res,
      matchType,
      part,
      shipStats,
      unitPrice,
      cost,
      costSource,
      margin: calcMargin(cost, unitPrice),
      bestQuote,
      supplierQuotes: allQuotes,
      bomInfo: (bomByPart.get(part.id) || []) as any,
      warnings,
    };
  });
}

export async function matchOnePart(pn: string, qty = 1): Promise<MatchResult> {
  const [r] = await matchManyParts([{ pn, qty }]);
  return r;
}

/** 型号不存在时建档；已存在（含别名、含被合并记录）则返回主记录 id */
export async function ensurePartExists(pn: string, batchId?: number): Promise<number> {
  const raw = (pn || '').trim();
  const n = normPn(raw);
  if (!n) throw new Error('型号为空');

  const found = await pool.query<{ id: number }>(
    `SELECT coalesce(p.merged_into, p.id) AS id FROM parts p WHERE p.pn_norm = $1
      UNION ALL
     SELECT a.part_id FROM part_aliases a WHERE a.alias_norm = $1
      LIMIT 1`,
    [n]
  );
  if (found.rows[0]) return found.rows[0].id;

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO parts (pn, pn_norm, has_actual_sale, import_batch_id)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (pn) DO UPDATE SET pn = EXCLUDED.pn
     RETURNING id`,
    [n, n, batchId ?? null]
  );
  return ins.rows[0].id;
}
