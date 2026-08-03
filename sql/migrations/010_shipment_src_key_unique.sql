-- =====================================================================
-- 010 · 出货记录自然键唯一索引（自动同步幂等的关键）
--
-- 背景：009 加了 src_key 字段并回填，但没建唯一索引。
-- 没有唯一索引的话，导入代码里的 ON CONFLICT (src_key) 会直接报错：
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- 另一个坑：真实数据里可能存在「同一天、同型号、同数量、同单价、同客户」的两笔
-- （比如分两单发货），它们的 src_key 天然相同。直接建唯一索引会失败。
-- 所以先给这些重复的加序号后缀区分开，再建索引。
-- 加过后缀的行不再参与幂等去重（它们已经在库里了，本来也不需要）。
-- =====================================================================

-- 1. 把已有的重复 src_key 打散
WITH dup AS (
  SELECT id, src_key,
         row_number() OVER (PARTITION BY src_key ORDER BY id) AS rn
    FROM shipments
   WHERE src_key IS NOT NULL
)
UPDATE shipments s
   SET src_key = s.src_key || '#' || dup.rn
  FROM dup
 WHERE s.id = dup.id AND dup.rn > 1;

-- 2. 建唯一索引（只约束非空的，人工录入的行 src_key 为空，不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_src_key
    ON shipments (src_key) WHERE src_key IS NOT NULL;

-- 3. 核对
SELECT count(*) AS 出货总行,
       count(src_key) AS 有自然键,
       (SELECT count(*) FROM (
          SELECT src_key FROM shipments WHERE src_key IS NOT NULL
           GROUP BY src_key HAVING count(*) > 1) x) AS 仍有冲突
  FROM shipments;
