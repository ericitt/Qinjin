-- =====================================================================
-- 001 · 第一阶段结构改造
-- 目标：补齐客户实体、型号别名/合并机制、可回滚导入批次、供应商报价字段
-- 原则：全部为增量变更，不删除任何既有列与数据
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. 型号归一化函数
--    只处理"尾部斜杠 + 空白 + 大小写"，不动型号内部字符。
--    刻意不去掉小数点：04024.99K 和 040249.9K 是不同型号，不能合并。
--    也不去掉中文：0603LED蓝 / 0603LED绿 是不同物料。
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION qj_norm_pn(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT upper(btrim(regexp_replace(coalesce(p, ''), '[/\s]+$', '', 'g')))
$$;

-- ---------------------------------------------------------------
-- 2. 客户实体（当前系统最大的模型缺口）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id            bigserial PRIMARY KEY,
    name          text NOT NULL,
    short_name    text,
    contact_name  text,
    phone         text,
    email         text,
    region        text,
    level         text,                       -- A/B/C 人工分级
    payment_terms text,                       -- 结算方式：月结30天 / 款到发货 …
    notes         text,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_name ON customers (name);
CREATE INDEX IF NOT EXISTS idx_customers_short ON customers (short_name);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------
-- 3. 导入批次：每批导入可预览、可回滚的前提
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
    id           bigserial PRIMARY KEY,
    batch_no     text NOT NULL UNIQUE,        -- IMP-20260803-01
    kind         text NOT NULL,               -- shipments|supplier_quotes|parts|suppliers|customers
    file_name    text,
    row_total    integer DEFAULT 0,
    row_ok       integer DEFAULT 0,
    row_skipped  integer DEFAULT 0,
    row_rejected integer DEFAULT 0,
    status       text NOT NULL DEFAULT 'committed',  -- committed|rolled_back
    mapping      jsonb,                       -- 本次使用的字段映射，便于复现
    issues       jsonb,                       -- 校验问题摘要
    created_by   text,
    created_at   timestamptz DEFAULT now(),
    rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_import_batches_kind ON import_batches (kind, created_at DESC);

-- ---------------------------------------------------------------
-- 4. parts 扩展
--    merged_into: 指向合并后的主记录，非空即表示这条是重复记录（查询默认排除）
--    pn_norm    : 归一化型号，用于去重与精确匹配
--    统计字段冗余：避免每次搜索都对 shipments 现算聚合
-- ---------------------------------------------------------------
ALTER TABLE parts ADD COLUMN IF NOT EXISTS merged_into    bigint REFERENCES parts(id) ON DELETE SET NULL;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS pn_norm        text;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS ship_count     integer DEFAULT 0;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS ship_qty       numeric(18,2) DEFAULT 0;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS avg_price      numeric(14,4);
ALTER TABLE parts ADD COLUMN IF NOT EXISTS min_price      numeric(14,4);
ALTER TABLE parts ADD COLUMN IF NOT EXISTS max_price      numeric(14,4);
ALTER TABLE parts ADD COLUMN IF NOT EXISTS last_ship_date date;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batches(id) ON DELETE SET NULL;

UPDATE parts SET pn_norm = qj_norm_pn(pn) WHERE pn_norm IS DISTINCT FROM qj_norm_pn(pn);
ALTER TABLE parts ALTER COLUMN pn_norm SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parts_pn_norm    ON parts (pn_norm);
CREATE INDEX IF NOT EXISTS idx_parts_merged     ON parts (merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parts_active     ON parts (id) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS idx_parts_shipcount  ON parts (ship_count DESC) WHERE merged_into IS NULL;

-- ---------------------------------------------------------------
-- 5. 型号别名：合并后旧型号仍然可以被搜到
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS part_aliases (
    id         bigserial PRIMARY KEY,
    part_id    bigint NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    alias      text NOT NULL,
    alias_norm text NOT NULL,
    source     text DEFAULT 'merge',          -- merge|manual|import
    created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_aliases_alias ON part_aliases (alias);
CREATE INDEX IF NOT EXISTS idx_part_aliases_norm ON part_aliases (alias_norm);
CREATE INDEX IF NOT EXISTS idx_part_aliases_part ON part_aliases (part_id);

-- ---------------------------------------------------------------
-- 6. 合并日志：记录每一次合并搬动了哪些数据，用于整批撤销
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS part_merge_log (
    id            bigserial PRIMARY KEY,
    merge_batch   text NOT NULL,
    from_part_id  bigint NOT NULL,
    to_part_id    bigint NOT NULL,
    from_pn       text NOT NULL,
    to_pn         text NOT NULL,
    moved_shipments integer DEFAULT 0,
    moved_quotes    integer DEFAULT 0,
    moved_bom_items integer DEFAULT 0,
    moved_supplier_parts integer DEFAULT 0,
    reverted_at   timestamptz,
    created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_merge_log_batch ON part_merge_log (merge_batch);
CREATE INDEX IF NOT EXISTS idx_merge_log_from  ON part_merge_log (from_part_id);

-- ---------------------------------------------------------------
-- 7. shipments 扩展：客户维度 + 数据质量标记
--    price_flag: ok|zero|outlier —— 零价记录不再参与均价计算，但保留原始行
-- ---------------------------------------------------------------
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS customer_id     bigint REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS unit_cost       numeric(14,4);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS price_flag      text NOT NULL DEFAULT 'ok';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_customer ON shipments (customer_id, ship_date DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_part_ok  ON shipments (part_id) WHERE price_flag = 'ok';
CREATE INDEX IF NOT EXISTS idx_shipments_batch    ON shipments (import_batch_id);

-- 把 63 条零价/负价记录标出来（不删除，只是不再参与统计）
UPDATE shipments SET price_flag = 'zero' WHERE unit_price <= 0 AND price_flag = 'ok';

-- ---------------------------------------------------------------
-- 8. supplier_parts 扩展：真正能用来比价的字段
-- ---------------------------------------------------------------
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS currency        text DEFAULT 'CNY';
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS moq             text;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS lead_time_days  integer;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS quoted_at       date;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS valid_until     date;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS notes           text;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batches(id) ON DELETE SET NULL;
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS created_at      timestamptz DEFAULT now();
ALTER TABLE supplier_parts ADD COLUMN IF NOT EXISTS updated_at      timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_supplier_parts_supplier ON supplier_parts (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_parts_price    ON supplier_parts (part_id, price);
CREATE INDEX IF NOT EXISTS idx_supplier_parts_batch    ON supplier_parts (import_batch_id);

-- ---------------------------------------------------------------
-- 9. suppliers 扩展
-- ---------------------------------------------------------------
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms   text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS part_count      integer DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS score_detail    jsonb;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at      timestamptz DEFAULT now();
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batches(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------
-- 10. boms 扩展：把"一次AI解析"升级为"一张可追踪的询价单"
-- ---------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS quote_no      text;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS customer_id   bigint REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS submitted_by  text;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS line_count    integer DEFAULT 0;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS matched_count integer DEFAULT 0;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS total_amount  numeric(16,2);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS total_cost    numeric(16,2);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS margin_pct    numeric(6,2);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS outcome       text NOT NULL DEFAULT 'draft'; -- draft|quoted|pending|won|lost
ALTER TABLE boms ADD COLUMN IF NOT EXISTS outcome_at    timestamptz;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS updated_at    timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_boms_quote_no ON boms (quote_no) WHERE quote_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_boms_customer ON boms (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_boms_outcome  ON boms (outcome, created_at DESC);

-- quote_line_items 补充报价决策所需字段
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS raw_pn        text;
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS match_type    text;
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS suggest_price numeric(14,4);
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS final_price   numeric(14,4);
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS unit_cost     numeric(14,4);
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS qty           numeric(14,2);

-- ---------------------------------------------------------------
-- 11. updated_at 自动维护（之前所有表的 updated_at 都是永不更新的摆设）
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION qj_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_parts_touch          ON parts;
DROP TRIGGER IF EXISTS trg_customers_touch      ON customers;
DROP TRIGGER IF EXISTS trg_suppliers_touch      ON suppliers;
DROP TRIGGER IF EXISTS trg_supplier_parts_touch ON supplier_parts;
DROP TRIGGER IF EXISTS trg_boms_touch           ON boms;

CREATE TRIGGER trg_parts_touch          BEFORE UPDATE ON parts          FOR EACH ROW EXECUTE FUNCTION qj_touch_updated_at();
CREATE TRIGGER trg_customers_touch      BEFORE UPDATE ON customers      FOR EACH ROW EXECUTE FUNCTION qj_touch_updated_at();
CREATE TRIGGER trg_suppliers_touch      BEFORE UPDATE ON suppliers      FOR EACH ROW EXECUTE FUNCTION qj_touch_updated_at();
CREATE TRIGGER trg_supplier_parts_touch BEFORE UPDATE ON supplier_parts FOR EACH ROW EXECUTE FUNCTION qj_touch_updated_at();
CREATE TRIGGER trg_boms_touch           BEFORE UPDATE ON boms           FOR EACH ROW EXECUTE FUNCTION qj_touch_updated_at();

-- ---------------------------------------------------------------
-- 12. 统计刷新函数：导入 / 合并之后调用，替代查询时现算
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION qj_refresh_part_stats(p_part_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH agg AS (
    SELECT s.part_id,
           count(*)::int              AS c,
           sum(s.quantity)            AS q,
           avg(s.unit_price)          AS a,
           min(s.unit_price)          AS mn,
           max(s.unit_price)          AS mx,
           max(s.ship_date)           AS ld
    FROM shipments s
    WHERE s.price_flag = 'ok'
      AND (p_part_id IS NULL OR s.part_id = p_part_id)
    GROUP BY s.part_id
  )
  UPDATE parts p
     SET ship_count      = coalesce(agg.c, 0),
         ship_qty        = coalesce(agg.q, 0),
         avg_price       = agg.a,
         min_price       = agg.mn,
         max_price       = agg.mx,
         last_ship_date  = agg.ld,
         has_actual_sale = coalesce(agg.c, 0) > 0
    FROM agg
   WHERE p.id = agg.part_id;
  GET DIAGNOSTICS n = ROW_COUNT;

  -- 没有任何有效出货记录的物料要归零（否则合并后旧值会留在原地）
  UPDATE parts p
     SET ship_count = 0, ship_qty = 0, avg_price = NULL,
         min_price = NULL, max_price = NULL, last_ship_date = NULL,
         has_actual_sale = false
   WHERE (p_part_id IS NULL OR p.id = p_part_id)
     AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.part_id = p.id AND s.price_flag = 'ok')
     AND (p.ship_count <> 0 OR p.has_actual_sale);

  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION qj_refresh_supplier_part_count()
RETURNS void LANGUAGE sql AS $$
  UPDATE suppliers s
     SET part_count = coalesce(x.c, 0)
    FROM (SELECT supplier_id, count(*)::int AS c FROM supplier_parts GROUP BY supplier_id) x
   WHERE s.id = x.supplier_id;
$$;

SELECT qj_refresh_part_stats();
