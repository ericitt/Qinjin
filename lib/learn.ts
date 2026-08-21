import pool from './db';
import { fingerprint, headerSimilarity } from './profile';
import type { ImportKind } from './import';

/**
 * 导入映射的「记忆」层。
 *
 * 规则打分再准，也总有认不出或认错的表。与其把这些情况一次次丢回给人，
 * 不如让系统记住结果：每导成功一次就存一条 (表头指纹 → 类型 + 映射)，
 * 人工纠正过的标记 corrected，优先级最高。
 * 效果是：同一种表第一次可能要人点两下，之后永远直接过。
 *
 * 容错很重要：011 迁移没跑的库上这张表不存在。
 * 所有函数都吞掉异常并退化成「没有记忆」，绝不能因为记忆层挂了导致导入不能用。
 */

export type Recalled = {
  kind: ImportKind;
  mapping: Record<string, string>;
  hits: number;
  corrected: boolean;
  similarity: number;   // 1 = 表头指纹完全一致
};

export async function recallMapping(headers: string[]): Promise<Recalled | null> {
  try {
    const fp = fingerprint(headers);
    // 先精确命中
    const exact = await pool.query(
      `SELECT kind, mapping, hits, corrected FROM import_mappings WHERE fingerprint = $1`, [fp]);
    if (exact.rows.length) {
      const r = exact.rows[0];
      return { kind: r.kind, mapping: r.mapping, hits: r.hits, corrected: r.corrected, similarity: 1 };
    }
    // 再模糊命中：表头改了一两列（ERP 升级、多导了一列）时还能认出来。
    // 只在最近用过的 200 条里找，避免全表扫。
    const recent = await pool.query(
      `SELECT kind, mapping, headers, hits, corrected FROM import_mappings
        ORDER BY corrected DESC, last_used_at DESC LIMIT 200`);
    let best: Recalled | null = null;
    for (const r of recent.rows) {
      const sim = headerSimilarity(headers, r.headers as string[]);
      if (sim >= 0.8 && (!best || sim > best.similarity)) {
        best = { kind: r.kind, mapping: r.mapping, hits: r.hits, corrected: r.corrected, similarity: sim };
      }
    }
    return best;
  } catch { return null; }   // 表不存在 / 库连不上 → 当作没记忆，继续走规则
}

/**
 * 记住这次的映射。corrected=true 表示这份映射是人工调过的，
 * 以后哪怕规则算出别的结果，也以这条为准。
 */
export async function rememberMapping(
  headers: string[], kind: ImportKind, mapping: Record<string, string>, corrected: boolean
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO import_mappings (fingerprint, kind, headers, mapping, corrected)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (fingerprint) DO UPDATE SET
         hits = import_mappings.hits + 1,
         last_used_at = now(),
         -- 人工纠正过的记录不会被后来的自动结果覆盖掉
         kind    = CASE WHEN import_mappings.corrected AND NOT EXCLUDED.corrected
                        THEN import_mappings.kind    ELSE EXCLUDED.kind    END,
         mapping = CASE WHEN import_mappings.corrected AND NOT EXCLUDED.corrected
                        THEN import_mappings.mapping ELSE EXCLUDED.mapping END,
         corrected = import_mappings.corrected OR EXCLUDED.corrected`,
      [fingerprint(headers), kind, JSON.stringify(headers), JSON.stringify(mapping), corrected]
    );
  } catch { /* 记不住就算了，不影响导入本身 */ }
}
