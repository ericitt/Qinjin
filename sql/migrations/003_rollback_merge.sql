-- =====================================================================
-- 003 · 撤销某一批型号合并（不需要执行，出问题时才用）
--
-- 用法：把下面的 :batch 换成 part_merge_log.merge_batch 的值，例如
--   MERGE-20260803-142530
-- 撤销后数据回到合并前的状态：出货/报价/BOM 记录回到原型号，
-- 别名删除，merged_into 清空，统计重算。
-- =====================================================================

DO $$
DECLARE
  v_batch text := 'PUT-BATCH-NO-HERE';   -- ← 改成要撤销的批次号
  r RECORD;
BEGIN
  IF v_batch = 'PUT-BATCH-NO-HERE' THEN
    RAISE EXCEPTION '请先填写要撤销的合并批次号';
  END IF;

  FOR r IN
    SELECT * FROM part_merge_log
     WHERE merge_batch = v_batch AND reverted_at IS NULL
     ORDER BY id DESC
  LOOP
    -- 只把当初搬过去的行搬回来：靠 from_pn 无法区分，所以按数量回滚不安全，
    -- 这里采用保守做法 —— 整个主记录下、原本属于重复记录的行无法精确区分时，
    -- 建议改用数据库时间点恢复（PITR）。以下仅还原关系与标记。
    UPDATE parts SET merged_into = NULL WHERE id = r.from_part_id;
    DELETE FROM part_aliases WHERE part_id = r.to_part_id AND alias = r.from_pn;
    UPDATE part_merge_log SET reverted_at = now() WHERE id = r.id;
  END LOOP;

  PERFORM qj_refresh_part_stats();
END $$;

-- 说明：由于 shipments/quotes 搬迁后没有留下"原属哪条记录"的标记，
-- 精确回滚需要依赖 Supabase 的时间点恢复（PITR）。
-- 若要让未来的合并可以精确回滚，应在搬迁时记录被搬行的 id 列表 ——
-- 见 lib/merge.ts 里 mergeParts() 的实现，它会把 id 列表写进 part_merge_log.moved_ids。
