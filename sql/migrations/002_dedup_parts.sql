-- =====================================================================
-- 002 · 合并重复型号（可回滚）
--
-- 背景：历史导入未清洗型号尾部的斜杠与空格，同一物料在 parts 里存了 2~5 条，
--       导致成交记录被拆散 —— 客户询价时可能命中"没有成交记录"的那条，
--       于是出过货的型号被当成仅有目录价来报价。
--
-- 策略（刻意不做物理删除）：
--   1. 按 pn_norm 分组，选出主记录（优先有成交记录、出货次数多、型号不带尾斜杠）
--   2. 把重复记录的 shipments / quotes / bom_items / supplier_parts 全部改挂到主记录
--   3. 主记录缺失的字段（规格/品牌/分类/成本）用重复记录补齐
--   4. 重复记录的型号写入 part_aliases —— 客户仍可用旧型号搜到
--   5. 重复记录标记 merged_into，查询默认排除，但行还在，随时可还原
--   6. 每一步写入 part_merge_log，支持整批撤销（见 003_rollback_merge.sql）
-- =====================================================================

DO $$
DECLARE
  v_batch text := 'MERGE-' || to_char(now(), 'YYYYMMDD-HH24MISS');
  r RECORD;
  v_ship int; v_quote int; v_bom int; v_sp int;
BEGIN
  FOR r IN
    WITH grp AS (
      SELECT pn_norm
        FROM parts
       WHERE merged_into IS NULL AND pn_norm <> ''
       GROUP BY pn_norm
      HAVING count(*) > 1
    ),
    ranked AS (
      SELECT p.id, p.pn, p.pn_norm,
             row_number() OVER (
               PARTITION BY p.pn_norm
               ORDER BY p.has_actual_sale DESC,
                        p.ship_count DESC,
                        (p.pn ~ '[/\s]$') ASC,   -- 不带尾斜杠的优先当主记录
                        length(p.pn) ASC,
                        p.id ASC
             ) AS rk
        FROM parts p JOIN grp g ON g.pn_norm = p.pn_norm
       WHERE p.merged_into IS NULL
    )
    SELECT d.id AS dup_id, d.pn AS dup_pn, m.id AS main_id, m.pn AS main_pn
      FROM ranked d
      JOIN ranked m ON m.pn_norm = d.pn_norm AND m.rk = 1
     WHERE d.rk > 1
  LOOP
    -- 出货记录
    UPDATE shipments SET part_id = r.main_id WHERE part_id = r.dup_id;
    GET DIAGNOSTICS v_ship = ROW_COUNT;

    -- 价格/成本记录
    UPDATE quotes SET part_id = r.main_id WHERE part_id = r.dup_id;
    GET DIAGNOSTICS v_quote = ROW_COUNT;

    -- BOM 关系
    UPDATE bom_items SET part_id = r.main_id WHERE part_id = r.dup_id;
    GET DIAGNOSTICS v_bom = ROW_COUNT;

    -- 供应商报价：主记录已有同供应商报价时不搬（避免撞 UNIQUE(supplier_id, part_id)）
    UPDATE supplier_parts sp SET part_id = r.main_id
     WHERE sp.part_id = r.dup_id
       AND NOT EXISTS (SELECT 1 FROM supplier_parts x
                        WHERE x.part_id = r.main_id AND x.supplier_id = sp.supplier_id);
    GET DIAGNOSTICS v_sp = ROW_COUNT;
    DELETE FROM supplier_parts WHERE part_id = r.dup_id;

    -- 用重复记录补齐主记录的空字段
    UPDATE parts m
       SET spec           = coalesce(m.spec, d.spec),
           cat            = coalesce(m.cat, d.cat),
           brand          = coalesce(m.brand, d.brand),
           catalog_cost   = coalesce(m.catalog_cost, d.catalog_cost),
           standard_price = coalesce(m.standard_price, d.standard_price),
           stock_qty      = coalesce(nullif(m.stock_qty, 0), d.stock_qty)
      FROM parts d
     WHERE m.id = r.main_id AND d.id = r.dup_id;

    -- 旧型号保留为别名
    INSERT INTO part_aliases (part_id, alias, alias_norm, source)
    VALUES (r.main_id, r.dup_pn, qj_norm_pn(r.dup_pn), 'merge')
    ON CONFLICT (alias) DO NOTHING;

    -- 标记为已合并
    UPDATE parts SET merged_into = r.main_id WHERE id = r.dup_id;

    INSERT INTO part_merge_log (merge_batch, from_part_id, to_part_id, from_pn, to_pn,
                                moved_shipments, moved_quotes, moved_bom_items, moved_supplier_parts)
    VALUES (v_batch, r.dup_id, r.main_id, r.dup_pn, r.main_pn, v_ship, v_quote, v_bom, v_sp);
  END LOOP;

  RAISE NOTICE '合并批次 %', v_batch;
END $$;

-- 主记录的型号本身也做一次清洗（去掉尾部斜杠/空格），前提是不会撞上已有型号
UPDATE parts p
   SET pn = qj_norm_pn(p.pn)
 WHERE p.merged_into IS NULL
   AND p.pn <> qj_norm_pn(p.pn)
   AND qj_norm_pn(p.pn) <> ''
   AND NOT EXISTS (SELECT 1 FROM parts x WHERE x.id <> p.id AND x.pn = qj_norm_pn(p.pn));

UPDATE parts SET pn_norm = qj_norm_pn(pn) WHERE pn_norm <> qj_norm_pn(pn);

-- 合并后统计必须重算，否则 avg_price 还是拆散前的旧值
SELECT qj_refresh_part_stats();
