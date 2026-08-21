import pool from './db';

/* =====================================================================
   商机分析
   ---------------------------------------------------------------------
   全部基于已有的出货记录、供应商报价和 BOM，不依赖任何外部数据。

   设计上有两条原则，是这块最容易做错的地方：

   1. 「沉默多久」本身没有意义，要和这个客户自己的节奏比。
      有的客户一直是每半年下一次单，沉默四个月完全正常；
      有的客户每周都来，沉默一个月就是出事了。
      所以先算出每个客户历史订单间隔的中位数，再看现在超了几倍。

   2. 样本小的时候要闭嘴。
      只有几十个客户，型号共现很容易凑出一堆巧合。
      共同客户数不到 3 个的组合一律不出，并且把支撑数直接显示给人看，
      让人自己判断可信度，而不是给个光秃秃的「推荐」。
   ===================================================================== */

export type Sleeping = {
  id: number; name: string; short_name: string | null;
  contact_name: string | null; phone: string | null; level: string | null;
  first_date: string; last_date: string;
  order_days: number; total_amt: number; part_kinds: number;
  silent_days: number; median_gap: number; overdue_ratio: number;
  monthly_amt: number; risk_value: number;
};

/**
 * 沉睡客户。
 * order_days = 有过出货的天数，用它当「下单次数」的近似 ——
 * 同一天多行是一张单里的多个型号，不该算成多次。
 */
export async function sleepingCustomers(limit = 50): Promise<Sleeping[]> {
  const { rows } = await pool.query(
    `WITH orders AS (
       SELECT customer_id, ship_date, sum(quantity * unit_price) AS amt
         FROM shipments
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id, ship_date
     ),
     gaps AS (
       SELECT customer_id,
              (ship_date - lag(ship_date) OVER (PARTITION BY customer_id ORDER BY ship_date)) AS gap
         FROM orders
     ),
     cadence AS (
       SELECT customer_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap
         FROM gaps WHERE gap IS NOT NULL AND gap > 0
        GROUP BY customer_id
     ),
     agg AS (
       SELECT customer_id,
              min(ship_date) AS first_date, max(ship_date) AS last_date,
              count(*)::int AS order_days,
              sum(amt) AS total_amt
         FROM orders GROUP BY customer_id
     )
     SELECT c.id, c.name, c.short_name, c.contact_name, c.phone, c.level,
            a.first_date::text AS first_date,
            a.last_date::text  AS last_date,
            a.order_days,
            a.total_amt::float AS total_amt,
            (SELECT count(DISTINCT part_id)::int FROM shipments s
              WHERE s.customer_id = c.id) AS part_kinds,
            (CURRENT_DATE - a.last_date)::int AS silent_days,
            -- 只下过一次单的客户没有间隔可算，给一个 90 天的保守默认值
            coalesce(cd.median_gap, 90)::float AS median_gap,
            ((CURRENT_DATE - a.last_date)::float / greatest(coalesce(cd.median_gap, 90), 7)::float)
              AS overdue_ratio,
            -- 月均贡献：总额 ÷ 合作月数
            (a.total_amt::float / greatest((a.last_date - a.first_date) / 30.0, 1)::float)
              AS monthly_amt,
            -- 流失价值 = 月均贡献 × 超期倍数（封顶 4 倍，避免几年前的老客户霸榜）
            ((a.total_amt::float / greatest((a.last_date - a.first_date) / 30.0, 1)::float)
             * least((CURRENT_DATE - a.last_date)::float / greatest(coalesce(cd.median_gap, 90), 7)::float, 4::float))
              AS risk_value
       FROM customers c
       JOIN agg a       ON a.customer_id = c.id
       LEFT JOIN cadence cd ON cd.customer_id = c.id
      WHERE (CURRENT_DATE - a.last_date)::float > greatest(coalesce(cd.median_gap, 90), 30)::float * 1.5
      ORDER BY risk_value DESC
      LIMIT $1`, [limit]);
  return rows;
}

/**
 * 型号级别的流失：这个型号以前一直在买，现在停了。
 * 比客户级别更可操作 —— 可以直接拿着型号去问「这颗还要吗」。
 */
export async function sleepingParts(limit = 60) {
  const { rows } = await pool.query(
    `WITH cp AS (
       SELECT customer_id, part_id, ship_date, quantity * unit_price AS amt
         FROM shipments WHERE customer_id IS NOT NULL
     ),
     gaps AS (
       SELECT customer_id, part_id,
              (ship_date - lag(ship_date) OVER (PARTITION BY customer_id, part_id ORDER BY ship_date)) AS gap
         FROM cp
     ),
     cad AS (
       SELECT customer_id, part_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap,
              count(*)::int AS gap_n
         FROM gaps WHERE gap IS NOT NULL AND gap > 0
        GROUP BY customer_id, part_id
     ),
     agg AS (
       SELECT customer_id, part_id,
              max(ship_date) AS last_date, count(*)::int AS times,
              sum(amt) AS total_amt
         FROM cp GROUP BY customer_id, part_id
     )
     SELECT c.name AS customer, c.short_name, c.id AS customer_id,
            p.pn, p.brand, p.id AS part_id,
            a.last_date::text AS last_date, a.times,
            a.total_amt::float AS total_amt,
            (CURRENT_DATE - a.last_date)::int AS silent_days,
            cad.median_gap::float AS median_gap,
            ((CURRENT_DATE - a.last_date)::float / greatest(cad.median_gap, 7)::float) AS overdue_ratio
       FROM agg a
       JOIN cad ON cad.customer_id = a.customer_id AND cad.part_id = a.part_id
       JOIN customers c ON c.id = a.customer_id
       JOIN parts p     ON p.id = a.part_id
      -- 至少买过 3 次才谈得上「规律」，2 次算不出可信的间隔
      WHERE cad.gap_n >= 2
        AND (CURRENT_DATE - a.last_date)::float > cad.median_gap::float * 2
      ORDER BY a.total_amt DESC
      LIMIT $1`, [limit]);
  return rows;
}

/**
 * 交叉销售：型号共现。
 *
 * lift = P(X且Y) / (P(X)·P(Y))。等于 1 表示两者独立，大于 1 表示同时出现的
 * 频率高于随机。这里只保留 lift ≥ 1.5、且至少 3 个客户同时买过的组合。
 *
 * 客户基数只有几十个，所以支撑数（几个客户同时买过）必须显示出来 ——
 * lift 再高，支撑数只有 3 也就是个线索，不是结论。
 */
export async function crossSell(limit = 60) {
  const { rows } = await pool.query(
    `WITH cp AS (
       SELECT DISTINCT customer_id, part_id
         FROM shipments WHERE customer_id IS NOT NULL
     ),
     tot AS (SELECT count(DISTINCT customer_id)::float AS n FROM cp),
     freq AS (
       SELECT part_id, count(*)::int AS n FROM cp GROUP BY part_id HAVING count(*) >= 3
     ),
     cp2 AS (SELECT cp.* FROM cp JOIN freq f ON f.part_id = cp.part_id),
     pairs AS (
       SELECT a.part_id AS x, b.part_id AS y, count(*)::int AS both
         FROM cp2 a
         JOIN cp2 b ON a.customer_id = b.customer_id AND a.part_id < b.part_id
        GROUP BY 1, 2
       HAVING count(*) >= 3
     )
     SELECT px.pn AS pn_x, py.pn AS pn_y, px.id AS part_x, py.id AS part_y,
            pr.both, fx.n AS n_x, fy.n AS n_y,
            (pr.both * (SELECT n FROM tot) / (fx.n::float * fy.n))::float AS lift,
            -- 已经同时买了这两颗的客户，用来给「谁还没买」做对照
            (pr.both::float / fx.n) AS conf_x_to_y,
            (pr.both::float / fy.n) AS conf_y_to_x
       FROM pairs pr
       JOIN freq fx ON fx.part_id = pr.x
       JOIN freq fy ON fy.part_id = pr.y
       JOIN parts px ON px.id = pr.x
       JOIN parts py ON py.id = pr.y
      WHERE (pr.both * (SELECT n FROM tot) / (fx.n::float * fy.n)) >= 1.5
      ORDER BY lift DESC, pr.both DESC
      LIMIT $1`, [limit]);
  return rows;
}

/**
 * 伺服 BOM 缺口。
 *
 * 基准不是我编出来的型号族，而是 bom_items 里真实的伺服驱动器 BOM。
 * 逻辑：客户买过的型号里落在 BOM 内的越多，越说明他在做伺服；
 * BOM 里他没在你这买的部分，就是明确的销售缺口。
 */
export async function bomGap() {
  const { rows: [meta] } = await pool.query(
    `SELECT count(DISTINCT coalesce(p.merged_into, p.id))::int AS bom_parts,
            count(DISTINCT bi.driver_model)::int AS models
       FROM bom_items bi JOIN parts p ON p.id = bi.part_id`);
  if (!meta || !meta.bom_parts) return { meta, customers: [], gaps: [] };

  const { rows: customers } = await pool.query(
    `WITH bom AS (
       -- 经过去重合并的物料，出货记录挂在主记录上，BOM 里可能还指着被合并的那条。
       -- 不做这层映射会把「其实买过」误判成缺口。
       SELECT DISTINCT coalesce(p.merged_into, p.id) AS part_id
         FROM bom_items bi JOIN parts p ON p.id = bi.part_id
     ),
     cp AS (
       SELECT customer_id, part_id, sum(quantity * unit_price) AS amt, max(ship_date) AS last_date
         FROM shipments WHERE customer_id IS NOT NULL GROUP BY 1, 2
     )
     SELECT c.id, c.name, c.short_name, c.contact_name, c.phone,
            count(*) FILTER (WHERE b.part_id IS NOT NULL)::int AS bom_hit,
            (SELECT count(*)::int FROM bom) AS bom_total,
            sum(cp.amt) FILTER (WHERE b.part_id IS NOT NULL)::float AS bom_amt,
            sum(cp.amt)::float AS total_amt,
            max(cp.last_date)::text AS last_date
       FROM cp
       JOIN customers c ON c.id = cp.customer_id
       LEFT JOIN bom b  ON b.part_id = cp.part_id
      GROUP BY c.id, c.name, c.short_name, c.contact_name, c.phone
     HAVING count(*) FILTER (WHERE b.part_id IS NOT NULL) > 0
      ORDER BY bom_hit DESC, bom_amt DESC NULLS LAST
      LIMIT 40`);

  // 每个疑似伺服客户缺哪些 BOM 物料 —— 直接就是一份可以拿去谈的清单
  const { rows: gaps } = await pool.query(
    `WITH bom AS (
       SELECT coalesce(p.merged_into, p.id) AS part_id,
              min(bi.qty_per_unit)::int AS qty_per_unit,
              string_agg(DISTINCT bi.driver_model, ' / ') AS models
         FROM bom_items bi JOIN parts p ON p.id = bi.part_id
        GROUP BY coalesce(p.merged_into, p.id)
     ),
     cust AS (
       SELECT DISTINCT customer_id FROM shipments s
        WHERE customer_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bom WHERE bom.part_id = s.part_id)
     )
     SELECT c.id AS customer_id, c.short_name, c.name AS customer,
            p.pn, p.brand, b.models, b.qty_per_unit,
            (SELECT min(sp.price)::float FROM supplier_parts sp WHERE sp.part_id = p.id) AS best_price,
            (SELECT count(*)::int FROM supplier_parts sp WHERE sp.part_id = p.id) AS supplier_count
       FROM cust
       JOIN customers c ON c.id = cust.customer_id
       CROSS JOIN bom b
       JOIN parts p ON p.id = b.part_id
      WHERE NOT EXISTS (
              SELECT 1 FROM shipments s
               WHERE s.customer_id = cust.customer_id AND s.part_id = b.part_id)
      ORDER BY c.id, (SELECT count(*) FROM supplier_parts sp WHERE sp.part_id = p.id) DESC
      LIMIT 400`);

  return { meta, customers, gaps };
}

/**
 * 供应链缺口：BOM 里有哪些料我们根本找不到供应商报价。
 * 这些是接单时最容易卡住的地方，应该优先开发供应商。
 */
export async function supplyGap() {
  const { rows } = await pool.query(
    `WITH bom AS (
       SELECT coalesce(p.merged_into, p.id) AS part_id,
              string_agg(DISTINCT bi.driver_model, ' / ') AS models,
              min(bi.qty_per_unit)::int AS qty_per_unit,
              min(bi.bom_price)::float AS bom_price
         FROM bom_items bi JOIN parts p ON p.id = bi.part_id
        GROUP BY coalesce(p.merged_into, p.id)
     )
     SELECT p.pn, p.brand, p.spec, b.models, b.qty_per_unit, b.bom_price,
            (SELECT count(*)::int FROM supplier_parts sp WHERE sp.part_id = p.id) AS supplier_count,
            (SELECT min(sp.price)::float FROM supplier_parts sp WHERE sp.part_id = p.id) AS best_price,
            (SELECT count(*)::int FROM shipments s WHERE s.part_id = p.id) AS ship_times
       FROM bom b JOIN parts p ON p.id = b.part_id
      ORDER BY (SELECT count(*) FROM supplier_parts sp WHERE sp.part_id = p.id) ASC,
               (SELECT count(*) FROM shipments s WHERE s.part_id = p.id) DESC
      LIMIT 200`);
  return rows;
}

/** 顶部四个数字，让人一眼知道这页有没有东西可看 */
export async function insightSummary() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM customers) AS customers,
       (SELECT count(DISTINCT part_id)::int FROM bom_items) AS bom_parts,
       (SELECT count(DISTINCT driver_model)::int FROM bom_items) AS bom_models,
       (SELECT count(*)::int FROM shipments WHERE customer_id IS NOT NULL) AS shipments_with_customer`);
  return r;
}
