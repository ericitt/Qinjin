-- 011：导入映射记忆表
--
-- 让导入算法「记住上次是怎么导的」。每成功导入一批，就把
-- (表头指纹 → 数据类型 + 字段映射) 存下来；下次遇到同样的表头直接命中，
-- 不用再靠猜。人工纠正过的映射同样会被记住 —— 也就是说纠正一次，
-- 以后这类表就永远对了。
--
-- 幂等：可以重复执行。

CREATE TABLE IF NOT EXISTS import_mappings (
  id            bigserial PRIMARY KEY,
  fingerprint   text        NOT NULL,
  kind          text        NOT NULL,
  headers       jsonb       NOT NULL,
  mapping       jsonb       NOT NULL,
  hits          int         NOT NULL DEFAULT 1,
  corrected     boolean     NOT NULL DEFAULT false,  -- 是否被人工改过（改过的优先级最高）
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_import_mappings_fp ON import_mappings (fingerprint);
CREATE INDEX IF NOT EXISTS ix_import_mappings_used ON import_mappings (last_used_at DESC);

COMMENT ON TABLE  import_mappings IS '导入映射记忆：表头指纹 → 类型与字段映射，用于一键导入的自动命中';
COMMENT ON COLUMN import_mappings.fingerprint IS '表头归一化排序后的哈希，列顺序/空格/括号变化不影响';
COMMENT ON COLUMN import_mappings.corrected  IS '人工在界面上调整过映射，之后一律以这条为准';
