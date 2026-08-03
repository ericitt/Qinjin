-- 勤进科技 MVP 数据库结构
-- 原则：MVP 阶段不做登录/权限，表结构里也就不带 user_id 这类字段了
-- 如果以后要加登录，再单独加 users 表 + 各表加 created_by 字段，不影响现有结构

CREATE TYPE price_source AS ENUM ('catalog_cost', 'purchase_cost', 'actual_sale', 'supplier_quote');
CREATE TYPE bom_status   AS ENUM ('pending', 'parsed', 'confirmed');

-- 物料主表
CREATE TABLE parts (
    id              bigserial PRIMARY KEY,
    pn              text NOT NULL UNIQUE,        -- 型号
    spec            text,                        -- 规格描述
    cat             text,                        -- 分类
    brand           text,                        -- 主要品牌来源
    stock_qty       numeric(14,2) DEFAULT 0,     -- 当前库存（大部分为0，贸易公司现货很少）
    min_stock       numeric(14,2),               -- 最低库存阈值（历史数据质量差，仅供参考，不做告警）
    catalog_cost    numeric(14,4),               -- 目录参考成本（导入自库存表，未必是当下真实成本）
    standard_price  numeric(14,4),               -- 标准售价参考
    has_actual_sale boolean DEFAULT false,       -- 是否有真实出货记录（区分"历史成交价"和"目录参考价"）
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);
CREATE INDEX idx_parts_pn    ON parts (pn);
CREATE INDEX idx_parts_spec  ON parts USING gin (to_tsvector('simple', coalesce(spec,'')));
CREATE INDEX idx_parts_brand ON parts (brand);
CREATE INDEX idx_parts_cat   ON parts (cat);

-- 供应商（含品牌统计和真实认证联系方式两类，用 kind 区分）
CREATE TABLE suppliers (
    id            bigserial PRIMARY KEY,
    kind          text NOT NULL DEFAULT 'manual',   -- 'brand'(品牌出货统计) / 'verified'(认证联系方式) / 'manual'(手动录入)
    company_name  text NOT NULL,
    contact_name  text,
    phone         text,
    region        text,
    currency      text,
    grade         text,             -- A/B/C 人工评级（manual 类型才有）
    lead_time_days integer,
    moq           text,
    notes         text,
    -- 以下是从出货历史统计出的客观指标，只有 kind='brand' 才会填
    ship_freq     integer DEFAULT 0,
    ship_qty      bigint  DEFAULT 0,
    avg_price     numeric(14,4),
    score         numeric(5,2),      -- 计算出的评分，见 lib/scoring.ts
    created_at    timestamptz DEFAULT now()
);
CREATE INDEX idx_suppliers_company ON suppliers (company_name);
CREATE INDEX idx_suppliers_kind    ON suppliers (kind);

-- 供应商 x 物料 的报价关系（一个供应商可能报多个型号，一个型号可能有多个供应商报价）
CREATE TABLE supplier_parts (
    id           bigserial PRIMARY KEY,
    supplier_id  bigint REFERENCES suppliers(id) ON DELETE CASCADE,
    part_id      bigint REFERENCES parts(id) ON DELETE CASCADE,
    price        numeric(14,4),
    UNIQUE(supplier_id, part_id)
);

-- 报价/成本记录（同一型号不同品牌/来源的历史价格，全部保留，不覆盖）
CREATE TABLE quotes (
    id           bigserial PRIMARY KEY,
    part_id      bigint NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    supplier_id  bigint REFERENCES suppliers(id) ON DELETE SET NULL,
    brand        text,               -- 品牌来源（如 FH, YAGEO, MURATA），和 supplier 是两个维度
    price        numeric(14,4) NOT NULL,
    source       price_source NOT NULL,
    quantity     numeric(14,2),
    recorded_at  timestamptz DEFAULT now(),
    notes        text
);
CREATE INDEX idx_quotes_part_id ON quotes (part_id);
CREATE INDEX idx_quotes_source  ON quotes (source);

-- 出货明细（历史出货记录，5年数据，是最重的一张表）
CREATE TABLE shipments (
    id           bigserial PRIMARY KEY,
    part_id      bigint NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    ship_date    date NOT NULL,
    quantity     numeric(14,2) NOT NULL,
    unit_price   numeric(14,4) NOT NULL
);
CREATE INDEX idx_shipments_part_id ON shipments (part_id);
CREATE INDEX idx_shipments_date    ON shipments (ship_date);

-- BOM 驱动器物料清单（DHS100-0D75S2 等整机BOM，物料x驱动器的关系）
CREATE TABLE bom_items (
    id           bigserial PRIMARY KEY,
    part_id      bigint NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    driver_model text NOT NULL,        -- 驱动器型号，如 DHS100-0D75S2
    designator   text,                 -- 位号，如 U4,U5
    qty_per_unit integer NOT NULL DEFAULT 1,
    bom_price    numeric(14,4),
    alt_pns      text[]                -- 替代物料型号数组
);
CREATE INDEX idx_bom_items_driver ON bom_items (driver_model);
CREATE INDEX idx_bom_items_part   ON bom_items (part_id);

-- BOM 提交存档（AI询价助手每次处理的记录）
CREATE TABLE boms (
    id            bigserial PRIMARY KEY,
    file_path     text,                    -- 原始文件路径（MVP 阶段暂不接 OSS，先留空）
    raw_text      text,                    -- 客户原始粘贴/上传的文本
    status        bom_status DEFAULT 'pending',
    parsed_parts  jsonb,                   -- AI 解析+匹配后的完整结果（含未匹配项，供人工复核）
    created_at    timestamptz DEFAULT now(),
    confirmed_at  timestamptz
);

COMMENT ON COLUMN parts.min_stock IS '历史数据质量差（部分记录到千万级），不要用来做库存告警，仅展示原始值';
