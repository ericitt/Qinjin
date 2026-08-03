import pool from './db';
import { normPn } from './matching';

/* =====================================================================
   数据导入
   这是之前整个系统最大的缺口：上线后没有任何入口能新增出货记录、
   更新供应商报价或修改物料，所有数据只能靠一次性 seed 脚本。

   设计要点：
   - 四类数据共用一条链路：解析 → 字段映射 → 校验 → 预览 → 分批入库
   - 每批生成 batch_no，写入的每一行都带 import_batch_id
   - 整批可撤销（rollbackBatch），这是脏数据不再继续累积的前提
   ===================================================================== */

export type ImportKind =
  | 'shipments' | 'supplier_quotes' | 'purchases' | 'parts' | 'suppliers' | 'customers';

export type FieldDef = { key: string; label: string; required: boolean; hint?: string };

export const FIELD_DEFS: Record<ImportKind, FieldDef[]> = {
  shipments: [
    { key: 'ship_date', label: '出货日期', required: true, hint: '2026-05-29 / 2026/5/29' },
    { key: 'customer', label: '客户名称', required: false, hint: '没有则留空，可后续补' },
    { key: 'pn', label: '物料型号', required: true },
    { key: 'quantity', label: '数量', required: true },
    { key: 'unit_price', label: '单价', required: true },
    { key: 'unit_cost', label: '成本单价', required: false },
  ],
  supplier_quotes: [
    { key: 'supplier', label: '供应商名称', required: true },
    { key: 'pn', label: '物料型号', required: true },
    { key: 'price', label: '单价', required: true },
    { key: 'currency', label: '币种', required: false, hint: '默认 CNY' },
    { key: 'moq', label: '最小起订', required: false },
    { key: 'lead_time_days', label: '交期(天)', required: false },
    { key: 'quoted_at', label: '报价日期', required: false },
    { key: 'valid_until', label: '有效期至', required: false },
  ],
  // 采购单据：ERP 直接导出的「采购记录」，比单独维护一张报价表现实得多 ——
  // 实际付过的钱比对方口头报的价更可信。每个(供应商,型号)取最近一次采购价写进 supplier_parts。
  purchases: [
    { key: 'supplier', label: '供应商', required: true, hint: '对应 ERP 的「供应商号」' },
    { key: 'pn', label: '物料型号', required: true },
    { key: 'price', label: '采购单价', required: true },
    { key: 'quantity', label: '采购数量', required: false },
    { key: 'buy_date', label: '采购日期', required: false, hint: '同型号多次采购时取最近一次' },
    { key: 'currency', label: '币种', required: false, hint: 'RMB / USD，默认 CNY' },
    { key: 'brand', label: '品牌', required: false },
    { key: 'pkg', label: '封装', required: false },
  ],
  parts: [
    { key: 'pn', label: '物料型号', required: true },
    { key: 'spec', label: '规格描述', required: false },
    { key: 'cat', label: '分类', required: false },
    { key: 'brand', label: '品牌', required: false },
    { key: 'catalog_cost', label: '目录成本', required: false },
    { key: 'standard_price', label: '标准售价', required: false },
    { key: 'stock_qty', label: '库存', required: false },
  ],
  suppliers: [
    { key: 'company_name', label: '供应商名称', required: true },
    { key: 'contact_name', label: '联系人', required: false },
    { key: 'phone', label: '电话', required: false },
    { key: 'region', label: '地区', required: false },
    { key: 'grade', label: '评级', required: false, hint: 'A/B/C' },
    { key: 'lead_time_days', label: '交期(天)', required: false },
    { key: 'moq', label: '起订', required: false },
    { key: 'payment_terms', label: '账期', required: false },
  ],
  customers: [
    { key: 'name', label: '客户全称', required: true },
    { key: 'short_name', label: '简称', required: false },
    { key: 'contact_name', label: '联系人', required: false },
    { key: 'phone', label: '电话', required: false },
    { key: 'region', label: '地区', required: false },
    { key: 'level', label: '分级', required: false, hint: 'A/B/C' },
    { key: 'payment_terms', label: '结算方式', required: false },
  ],
};

export type RowIssue = { row: number; level: 'reject' | 'warn'; field?: string; msg: string };
export type ParsedRow = Record<string, any>;

export type PreviewResult = {
  kind: ImportKind;
  headers: string[];
  suggestedMapping: Record<string, string>;   // fieldKey -> header
  sample: ParsedRow[];
  rowTotal: number;
  okCount: number;
  rejectCount: number;
  warnCount: number;
  issues: RowIssue[];
  issueSummary: { msg: string; count: number; level: string }[];
};

/* ---------------- CSV / TSV 解析（支持引号包裹与换行） ---------------- */
export function parseDelimited(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const delim = (t.split('\n')[0].match(/\t/g)?.length || 0) > (t.split('\n')[0].match(/,/g)?.length || 0) ? '\t' : ',';
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuote) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else inQuote = false;
      } else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === delim) { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ---------------- 字段自动映射 ---------------- */
const ALIASES: Record<string, string[]> = {
  ship_date: ['日期', '出货日期', '发货日期', 'date', '出库日期'],
  customer: ['客户', '客户名称', '客户简称', 'customer', '购货单位'],
  pn: ['型号', '物料型号', '料号', '规格型号', 'pn', 'part', 'partnumber', '产品型号'],
  quantity: ['数量', '出货数量', 'qty', 'quantity', '发货数量'],
  unit_price: ['单价', '售价', '成交价', 'price', '销售单价', '含税单价'],
  unit_cost: ['成本', '成本单价', 'cost', '采购单价'],
  supplier: ['供应商', '供应商名称', '供应商号', 'supplier', '厂商', '供货商'],
  buy_date: ['采购日期', '下单日期', '日期', 'buy_date'],
  pkg: ['封装', '包装', 'package', 'pkg'],
  price: ['单价', '报价', '价格', 'price', '含税单价'],
  currency: ['币种', '货币', 'currency'],
  moq: ['起订', '最小起订', '起订量', 'moq'],
  lead_time_days: ['交期', '货期', '交货期', 'leadtime', 'lead_time'],
  quoted_at: ['报价日期', '报价时间', 'quote_date', '日期'],
  valid_until: ['有效期', '有效期至', '报价有效期'],
  spec: ['规格', '规格描述', '描述', 'spec', '说明'],
  cat: ['分类', '类别', '品类', 'category', 'cat'],
  brand: ['品牌', '厂牌', 'brand', '制造商'],
  catalog_cost: ['目录成本', '参考成本', '成本'],
  standard_price: ['标准售价', '参考售价', '标准价'],
  stock_qty: ['库存', '现存量', '库存数量', 'stock'],
  company_name: ['供应商名称', '公司名称', '名称', 'company'],
  contact_name: ['联系人', '业务员', 'contact'],
  phone: ['电话', '手机', '联系电话', 'phone', 'tel'],
  region: ['地区', '区域', '所在地', 'region'],
  grade: ['评级', '等级', 'grade'],
  payment_terms: ['账期', '结算方式', '付款方式', 'terms'],
  name: ['客户全称', '客户名称', '公司名称', '名称'],
  short_name: ['简称', '客户简称', 'short'],
  level: ['分级', '等级', '客户等级', 'level'],
};

export function suggestMapping(kind: ImportKind, headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()（）]/g, '');
  for (const f of FIELD_DEFS[kind]) {
    const cands = [f.key, f.label, ...(ALIASES[f.key] || [])].map(norm);
    const hit = headers.find((h) => cands.includes(norm(h)))
      ?? headers.find((h) => cands.some((c) => norm(h).includes(c) && c.length >= 2));
    if (hit) map[f.key] = hit;
  }
  return map;
}

/* ---------------- 取值与校验 ---------------- */
const toNum = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,，¥￥$\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const toDate = (v: any): string | null => {
  if (!v) return null;
  const s = String(v).trim().replace(/[/.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function buildRows(kind: ImportKind, table: string[][], mapping: Record<string, string>) {
  const headers = table[0];
  const idx: Record<string, number> = {};
  for (const [k, h] of Object.entries(mapping)) {
    const i = headers.indexOf(h);
    if (i >= 0) idx[k] = i;
  }
  const rows: ParsedRow[] = [];
  const issues: RowIssue[] = [];

  for (let r = 1; r < table.length; r++) {
    const raw = table[r];
    const o: ParsedRow = { __row: r + 1 };
    for (const [k, i] of Object.entries(idx)) o[k] = (raw[i] ?? '').trim();

    for (const f of FIELD_DEFS[kind]) {
      if (f.required && !o[f.key]) {
        issues.push({ row: r + 1, level: 'reject', field: f.key, msg: `缺少必填字段「${f.label}」` });
      }
    }

    if (o.pn) { o.pn_raw = o.pn; o.pn = normPn(o.pn); if (!o.pn) issues.push({ row: r + 1, level: 'reject', field: 'pn', msg: '型号为空或全为符号' }); }
    for (const k of ['quantity', 'unit_price', 'unit_cost', 'price', 'catalog_cost', 'standard_price', 'stock_qty', 'lead_time_days']) {
      if (o[k] !== undefined && o[k] !== '') {
        const n = toNum(o[k]);
        if (n === null) issues.push({ row: r + 1, level: 'reject', field: k, msg: `「${k}」不是有效数字：${o[k]}` });
        o[k] = n;
      } else o[k] = null;
    }
    for (const k of ['ship_date', 'quoted_at', 'valid_until', 'buy_date']) {
      if (o[k]) { const d = toDate(o[k]); if (!d) issues.push({ row: r + 1, level: 'reject', field: k, msg: `日期无法识别：${o[k]}` }); o[k] = d; }
    }

    if (kind === 'shipments') {
      if (o.unit_price !== null && o.unit_price <= 0) issues.push({ row: r + 1, level: 'warn', field: 'unit_price', msg: '单价为 0，将标记为不参与均价统计' });
      if (o.quantity !== null && o.quantity <= 0) issues.push({ row: r + 1, level: 'reject', field: 'quantity', msg: '数量必须大于 0' });
    }
    if ((kind === 'supplier_quotes' || kind === 'purchases') && o.price !== null && o.price <= 0) {
      issues.push({ row: r + 1, level: 'reject', field: 'price', msg: '单价为 0 或非数字，拒绝入库' });
    }
    if (kind === 'purchases') {
      // ERP 里 RMB / 人民币 都要归一成 CNY
      if (o.currency) o.currency = /rmb|人民币|cny/i.test(o.currency) ? 'CNY' : String(o.currency).toUpperCase();
    }
    rows.push(o);
  }
  return { rows, issues };
}

/** 预检：型号是否已存在、供应商/客户是否需要新建 */
export async function enrichIssues(kind: ImportKind, rows: ParsedRow[], issues: RowIssue[]) {
  const pns = Array.from(new Set(rows.map((r) => r.pn).filter(Boolean)));
  if (pns.length) {
    const { rows: found } = await pool.query(
      `SELECT pn_norm AS n FROM parts WHERE merged_into IS NULL AND pn_norm = ANY($1::text[])
       UNION SELECT alias_norm FROM part_aliases WHERE alias_norm = ANY($1::text[])`,
      [pns]
    );
    const known = new Set(found.map((f: any) => f.n));
    for (const r of rows) {
      if (r.pn && !known.has(r.pn)) {
        issues.push({ row: r.__row, level: 'warn', field: 'pn', msg: '型号在物料库中不存在，将自动建档' });
      }
    }
  }
  const names = Array.from(new Set(rows.map((r) => r.supplier || r.customer).filter(Boolean)));
  const isSupplierSide = kind === 'supplier_quotes' || kind === 'purchases';
  if (names.length && (kind === 'shipments' || isSupplierSide)) {
    const table = isSupplierSide ? 'suppliers' : 'customers';
    const col = isSupplierSide ? 'company_name' : 'name';
    const { rows: found } = await pool.query(
      `SELECT ${col} AS n FROM ${table} WHERE ${col} = ANY($1::text[])`, [names]
    );
    const known = new Set(found.map((f: any) => f.n));
    for (const r of rows) {
      const v = r.supplier || r.customer;
      if (v && !known.has(v)) {
        issues.push({ row: r.__row, level: 'warn', msg: `${isSupplierSide ? '供应商' : '客户'}「${v}」不存在，将自动建档` });
      }
    }
  }
  return issues;
}

export function summarize(issues: RowIssue[]) {
  const m = new Map<string, { msg: string; count: number; level: string }>();
  for (const it of issues) {
    const key = it.level + '|' + it.msg.replace(/：.*$/, '').replace(/「[^」]*」/g, '「…」');
    if (!m.has(key)) m.set(key, { msg: it.msg.replace(/：.*$/, ''), count: 0, level: it.level });
    m.get(key)!.count++;
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}

export async function nextBatchNo(kind: ImportKind): Promise<string> {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM import_batches WHERE batch_no LIKE $1`, [`IMP-${day}-%`]
  );
  return `IMP-${day}-${String(rows[0].c + 1).padStart(2, '0')}`;
}
