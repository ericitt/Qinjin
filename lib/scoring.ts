import pool from './db';

export type BrandScore = {
  score: number;
  freqScore: number;
  qtyScore: number;
  stabScore: number;
  volatility: number;
};

// 出货频次(35%) + 累计出货量(25%，对数压缩) + 价格稳定性(40%)
export function computeBrandScore(
  freq: number,
  qty: number,
  volatility: number,
  maxFreq: number,
  maxQty: number
): BrandScore {
  const freqScore = (Math.log1p(freq) / Math.log1p(maxFreq || 1)) * 100;
  const qtyScore = (Math.log1p(qty) / Math.log1p(maxQty || 1)) * 100;
  const stabScore = Math.max(0, 100 - volatility * 100);
  const score = freqScore * 0.35 + qtyScore * 0.25 + stabScore * 0.4;
  return { score: Math.round(score * 10) / 10, freqScore, qtyScore, stabScore, volatility };
}

export function scoreTier(score: number): { label: string; cls: string } {
  if (score >= 80) return { label: '优选', cls: 'dark' };
  if (score >= 60) return { label: '良好', cls: '' };
  if (score >= 40) return { label: '一般', cls: 'outline' };
  return { label: '观察', cls: 'outline' };
}

export function manualGradeScore(grade: string | null): number {
  if (grade === 'A') return 100;
  if (grade === 'B') return 65;
  if (grade === 'C') return 35;
  return 0;
}

/* =====================================================================
   重算品牌评分

   旧实现的两个问题：
   1. 波动率把一个品牌下所有物料的成交价放在一起算极差/均值 —— 电容(0.008元)
      和 MCU(14元) 混在一起，算出来的"价格稳定性"没有业务含义，
      而稳定性占 40% 权重，等于把整个评分废掉了。
      正确的口径是「同一个型号的价格随时间波动多大」，而不是「不同型号之间差多少」。
      现在改为：先按单个 part_id 算变异系数(标准差/均值，至少 2 次成交)，
      再按出货次数加权汇总到品牌。实测下来波动率落在 0.007~0.16 的合理区间，
      而旧口径普遍 >1（等于所有品牌稳定性得分都是 0）。
   2. 218 个品牌在 for 循环里逐个 UPDATE = 218 次往返。
      现在一条 SQL 批量算完批量更新。
   ===================================================================== */
export async function recalcAllBrandScores(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`
    WITH per_part AS (
      -- 同一个型号在时间上的价格变异系数（至少 2 次成交才谈得上波动）
      SELECT p.brand,
             s.part_id,
             count(*)::int            AS n,
             avg(s.unit_price)        AS mean_price,
             stddev_pop(s.unit_price) AS sd_price
        FROM shipments s
        JOIN parts p ON p.id = s.part_id
       WHERE s.price_flag = 'ok'
         AND s.unit_price > 0
         AND p.merged_into IS NULL
         AND p.brand IS NOT NULL
       GROUP BY p.brand, s.part_id
      HAVING count(*) >= 2
    ),
    brand_vol AS (
      -- 按出货次数加权汇总到品牌
      SELECT brand,
             sum(n)::int   AS sample_n,
             count(*)::int AS parts_n,
             sum((sd_price / nullif(mean_price, 0)) * n) / nullif(sum(n), 0) AS volatility
        FROM per_part
       WHERE mean_price > 0
       GROUP BY brand
    ),
    base AS (
      SELECT s.id, s.company_name,
             coalesce(s.ship_freq, 0)::int  AS freq,
             coalesce(s.ship_qty, 0)::float AS qty,
             coalesce(least(bv.volatility, 1), 0.5)::float AS volatility,
             coalesce(bv.sample_n, 0)::int  AS sample_n,
             coalesce(bv.parts_n, 0)::int   AS parts_n
        FROM suppliers s
        LEFT JOIN brand_vol bv ON bv.brand = s.company_name
       WHERE s.kind = 'brand'
    ),
    mx AS (SELECT greatest(max(freq), 1) AS max_freq, greatest(max(qty), 1) AS max_qty FROM base),
    calc AS (
      SELECT b.id, b.company_name, b.freq, b.qty, b.volatility, b.sample_n, b.parts_n,
             (ln(1 + b.freq) / ln(1 + mx.max_freq)) * 100 AS freq_score,
             (ln(1 + b.qty)  / ln(1 + mx.max_qty))  * 100 AS qty_score,
             greatest(0, 100 - b.volatility * 100)        AS stab_score
        FROM base b CROSS JOIN mx
    )
    UPDATE suppliers s
       SET score = round((c.freq_score * 0.35 + c.qty_score * 0.25 + c.stab_score * 0.40)::numeric, 1),
           score_detail = jsonb_build_object(
             'freqScore', round(c.freq_score::numeric, 1),
             'qtyScore',  round(c.qty_score::numeric, 1),
             'stabScore', round(c.stab_score::numeric, 1),
             'volatility', round(c.volatility::numeric, 3),
             'sampleN', c.sample_n,
             'partsN', c.parts_n,
             'method', 'per-part price CV over time, ship-count weighted'
           )
      FROM calc c
     WHERE s.id = c.id
    RETURNING s.company_name AS n
  `);
  return rows.length;
}
