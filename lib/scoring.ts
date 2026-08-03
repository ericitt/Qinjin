import pool from './db';

export type BrandScore = {
  score: number;
  freqScore: number;
  qtyScore: number;
  stabScore: number;
  volatility: number;
};

// 出货频次(35%) + 累计出货量(25%，对数压缩) + 价格稳定性(40%，历史成交价波动越小越稳)
// 和 v5.html 前端 computeAllBrandScores() 用的是完全一样的权重和公式，保持口径一致
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

// 重算所有品牌评分并写回 suppliers.score（供后台定时任务或手动触发调用，不在每次页面请求时都算）
export async function recalcAllBrandScores() {
  const { rows: brands } = await pool.query<{ id: number; company_name: string; ship_freq: number; ship_qty: number }>(
    `SELECT id, company_name, ship_freq, ship_qty FROM suppliers WHERE kind = 'brand'`
  );
  if (!brands.length) return 0;

  const maxFreq = Math.max(...brands.map((b) => b.ship_freq || 0), 1);
  const maxQty = Math.max(...brands.map((b) => b.ship_qty || 0), 1);

  for (const b of brands) {
    const { rows } = await pool.query<{ h: number; l: number; a: number }>(
      `SELECT max(unit_price)::float as h, min(unit_price)::float as l, avg(unit_price)::float as a
       FROM shipments s JOIN parts p ON p.id = s.part_id
       WHERE p.brand = $1 AND s.unit_price > 0`,
      [b.company_name]
    );
    const r = rows[0];
    const volatility = r && r.a > 0 ? (r.h - r.l) / r.a : 0;
    const { score } = computeBrandScore(b.ship_freq || 0, b.ship_qty || 0, volatility, maxFreq, maxQty);
    await pool.query(`UPDATE suppliers SET score = $1 WHERE id = $2`, [score, b.id]);
  }
  return brands.length;
}
