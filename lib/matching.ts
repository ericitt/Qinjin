import pool from './db';

export type MatchType = 'exact' | 'catalog' | 'partial' | 'none';

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
};

export type ShipmentStats = {
  ship_count: number;
  total_qty: number;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  last_date: string | null;
};

export type MatchResult = {
  queryPn: string;
  qty: number;
  matchType: MatchType;
  part: PartRow | null;
  shipStats: ShipmentStats | null;
  unitPrice: number | null; // 用于报价的参考单价（出货均价优先，其次目录标准售价）
  cost: number | null;
  margin: number | null; // 百分比
  bomInfo: { driver_model: string; designator: string | null; qty_per_unit: number; alt_pns: string[] | null }[];
};

export function calcMargin(cost: number | null, price: number | null): number | null {
  if (!cost || cost <= 0 || !price || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

async function getShipStats(partId: number): Promise<ShipmentStats | null> {
  const { rows } = await pool.query(
    `SELECT count(*)::int as ship_count, sum(quantity)::float as total_qty,
            avg(unit_price)::float as avg_price, min(unit_price)::float as min_price,
            max(unit_price)::float as max_price, max(ship_date)::text as last_date
     FROM shipments WHERE part_id = $1`,
    [partId]
  );
  const r = rows[0];
  if (!r || !r.ship_count) return null;
  return r as ShipmentStats;
}

async function getBomInfo(partId: number) {
  const { rows } = await pool.query(
    `SELECT driver_model, designator, qty_per_unit, alt_pns FROM bom_items WHERE part_id = $1`,
    [partId]
  );
  return rows;
}

async function getCost(partId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT price FROM quotes WHERE part_id = $1 AND source = 'catalog_cost' ORDER BY price ASC LIMIT 1`,
    [partId]
  );
  return rows[0] ? Number(rows[0].price) : null;
}

// 单条型号的四档匹配：exact(真实出货过) > catalog(仅目录参考价) > partial(模糊命中) > none
export async function matchOnePart(pnRaw: string, qty = 1): Promise<MatchResult> {
  const pn = pnRaw.trim();
  const empty: MatchResult = {
    queryPn: pn,
    qty,
    matchType: 'none',
    part: null,
    shipStats: null,
    unitPrice: null,
    cost: null,
    margin: null,
    bomInfo: [],
  };
  if (!pn) return empty;

  // 1. 精确匹配（大小写不敏感）
  let { rows } = await pool.query<PartRow>(`SELECT * FROM parts WHERE lower(pn) = lower($1) LIMIT 1`, [pn]);

  let matchType: MatchType = 'none';
  if (rows[0]) {
    matchType = rows[0].has_actual_sale ? 'exact' : 'catalog';
  } else {
    // 2. 模糊匹配：型号/规格/品牌部分包含，优先出过货的
    const fuzzy = await pool.query<PartRow>(
      `SELECT * FROM parts
       WHERE pn ILIKE $1 OR spec ILIKE $1 OR brand ILIKE $1
       ORDER BY has_actual_sale DESC, length(pn) ASC
       LIMIT 1`,
      [`%${pn}%`]
    );
    rows = fuzzy.rows;
    if (rows[0]) matchType = 'partial';
  }

  const part = rows[0] ?? null;
  if (!part) return empty;

  const [shipStats, bomInfo, cost] = await Promise.all([
    getShipStats(part.id),
    getBomInfo(part.id),
    getCost(part.id),
  ]);

  const unitPrice =
    shipStats?.avg_price ??
    (part.standard_price ? Number(part.standard_price) : null) ??
    null;

  return {
    queryPn: pn,
    qty,
    matchType,
    part,
    shipStats,
    unitPrice,
    cost,
    margin: calcMargin(cost, unitPrice),
    bomInfo: bomInfo as any,
  };
}

// 批量匹配（BOM 用），并发但限流，避免一次几百条把连接池打爆
export async function matchManyParts(items: { pn: string; qty: number }[]): Promise<MatchResult[]> {
  const CONCURRENCY = 4;
  const results: MatchResult[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await matchOnePart(items[i].pn, items[i].qty);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(worker));
  return results;
}

// 型号不存在时自动建档（AI询价助手处理完订单后调用）
export async function ensurePartExists(pn: string): Promise<number> {
  const pnTrim = pn.trim();
  const found = await pool.query<{ id: number }>(`SELECT id FROM parts WHERE lower(pn) = lower($1)`, [pnTrim]);
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO parts (pn, has_actual_sale) VALUES ($1, false)
     ON CONFLICT (pn) DO UPDATE SET pn = EXCLUDED.pn
     RETURNING id`,
    [pnTrim]
  );
  return inserted.rows[0].id;
}
