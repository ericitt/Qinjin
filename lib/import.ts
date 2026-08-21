import pool from './db';
import { normPn } from './matching';

import type { ColKind, ColProfile } from './profile';

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
  // 对齐公司「供应商名单」那张表的列：
  // 供应商 / 是否代理商 / 供应物料 / 含税价格 / 品牌 / 封装 / 最小包装 / 日期 / 备注
  // 这张表是分组报表，供应商一栏只在每组第一行填，导入时会自动向下填充。
  supplier_quotes: [
    { key: 'supplier', label: '供应商', required: true, hint: '只在每组第一行填也可以，会自动向下填充' },
    { key: 'pn', label: '供应物料', required: true, hint: '型号' },
    { key: 'price', label: '含税价格', required: true },
    { key: 'brand', label: '品牌', required: false, hint: '会用来补全物料的品牌' },
    { key: 'pkg', label: '封装', required: false },
    { key: 'moq', label: '最小包装', required: false, hint: '起订量' },
    { key: 'quoted_at', label: '日期', required: false, hint: '报价日期' },
    { key: 'is_agent', label: '是否代理商', required: false },
    { key: 'notes', label: '备注', required: false },
    { key: 'currency', label: '币种', required: false, hint: '默认 CNY' },
    { key: 'lead_time_days', label: '交期(天)', required: false },
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
    // 注意：这里要填 ERP 里的「编号」，因为采购单引用的是编号而不是公司全称。
    // 用全称导入会新建一批重复供应商，而不是给已有的补联系方式。
    { key: 'company_name', label: '供应商名称', required: true, hint: '要和采购单里的写法一致（通常是 ERP 的「编号」）' },
    { key: 'notes', label: '公司全称/备注', required: false },
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
  pn: ['型号', '物料型号', '料号', '规格型号', '供应物料', '供货型号', 'pn', 'part', 'partnumber', '产品型号'],
  quantity: ['数量', '出货数量', '订单数量', '收货数量', 'qty', 'quantity', '发货数量'],
  unit_price: ['单价', '售价', '成交价', '税价', '含税价', 'price', '销售单价', '含税单价'],
  unit_cost: ['成本', '成本单价', 'cost', '采购单价'],
  supplier: ['供应商', '供应商名称', '供应商号', 'supplier', '厂商', '供货商'],
  buy_date: ['采购日期', '下单日期', '日期', 'buy_date'],
  pkg: ['封装', '包装', 'package', 'pkg'],
  price: ['单价', '报价', '价格', '含税价格', '含税单价', '未税价', 'price'],
  currency: ['币种', '货币', 'currency'],
  moq: ['起订', '最小起订', '起订量', '最小包装', '包装量', 'moq'],
  lead_time_days: ['交期', '货期', '交货期', 'leadtime', 'lead_time'],
  quoted_at: ['报价日期', '报价时间', 'quote_date', '日期'],
  is_agent: ['是否代理商', '代理商', '是否代理'],
  valid_until: ['有效期', '有效期至', '报价有效期'],
  spec: ['规格', '规格描述', '描述', '型号描述', '物料描述', '品名', 'spec', 'description', '说明'],
  cat: ['分类', '类别', '品类', 'category', 'cat'],
  brand: ['品牌', '厂牌', '牌子', '商标', 'brand', '制造商', 'mfr', 'manufacturer'],
  catalog_cost: ['目录成本', '参考成本', '成本'],
  standard_price: ['标准售价', '参考售价', '标准价'],
  stock_qty: ['库存', '现存量', '库存数量', 'stock'],
  company_name: ['供应商名称', '供应商编号', '编号', '公司名称', '名称', 'company'],
  notes: ['备注', '公司全称', '全称', 'notes', 'remark'],
  contact_name: ['联系人', '业务员', 'contact'],
  phone: ['电话', '手机', '联系电话', 'phone', 'tel'],
  region: ['地区', '区域', '所在地', 'region'],
  grade: ['评级', '等级', 'grade'],
  payment_terms: ['账期', '结算方式', '付款方式', 'terms'],
  name: ['客户全称', '客户名称', '公司名称', '名称'],
  short_name: ['简称', '客户简称', 'short'],
  level: ['分级', '等级', '客户等级', 'level'],
};

/**
 * 每个字段期望列里装什么。表头看走眼时，靠这个把关。
 * want 命中加分，avoid 命中重罚 —— 「客户」这个字段绝不可能落在一列纯数字上。
 */
const FIELD_CONTENT: Record<string, { want: ColKind[]; avoid?: ColKind[] }> = {
  ship_date: { want: ['date'], avoid: ['company', 'pn', 'money'] },
  buy_date: { want: ['date'], avoid: ['company', 'pn', 'money'] },
  quoted_at: { want: ['date'], avoid: ['company', 'pn', 'money'] },
  valid_until: { want: ['date'], avoid: ['company', 'pn', 'money'] },
  quantity: { want: ['int'], avoid: ['date', 'company', 'pn', 'currency'] },
  stock_qty: { want: ['int', 'money'], avoid: ['date', 'company', 'pn'] },
  moq: { want: ['int', 'pkg'], avoid: ['date', 'company'] },
  lead_time_days: { want: ['int'], avoid: ['date', 'company', 'pn'] },
  unit_price: { want: ['money'], avoid: ['date', 'company', 'pn', 'currency'] },
  price: { want: ['money'], avoid: ['date', 'company', 'pn', 'currency'] },
  unit_cost: { want: ['money'], avoid: ['date', 'company', 'pn', 'currency'] },
  catalog_cost: { want: ['money'], avoid: ['date', 'company', 'pn'] },
  standard_price: { want: ['money'], avoid: ['date', 'company', 'pn'] },
  pn: { want: ['pn'], avoid: ['company', 'date', 'money', 'int', 'currency', 'bool'] },
  customer: { want: ['company'], avoid: ['pn', 'money', 'int', 'date', 'currency'] },
  supplier: { want: ['company'], avoid: ['pn', 'money', 'int', 'date', 'currency'] },
  company_name: { want: ['company', 'text'], avoid: ['money', 'int', 'date'] },
  name: { want: ['company', 'text'], avoid: ['money', 'int', 'date'] },
  short_name: { want: ['company', 'text', 'brand'], avoid: ['money', 'date'] },
  brand: { want: ['brand', 'company', 'text'], avoid: ['money', 'date', 'int'] },
  pkg: { want: ['pkg', 'brand', 'text'], avoid: ['date', 'company'] },
  currency: { want: ['currency'], avoid: ['date', 'money', 'int', 'pn', 'company'] },
  is_agent: { want: ['bool'], avoid: ['date', 'money', 'pn', 'company'] },
  phone: { want: ['int', 'text'], avoid: ['date', 'money', 'company'] },
  spec: { want: ['text', 'pn'], avoid: ['date', 'money', 'currency'] },
  notes: { want: ['text', 'company'], avoid: ['date', 'currency'] },
  cat: { want: ['brand', 'text'], avoid: ['date', 'money', 'pn'] },
  region: { want: ['brand', 'text', 'company'], avoid: ['date', 'money', 'int'] },
  contact_name: { want: ['text', 'brand'], avoid: ['date', 'money', 'int', 'pn'] },
  grade: { want: ['brand', 'bool', 'text'], avoid: ['date', 'money', 'pn'] },
  level: { want: ['brand', 'bool', 'text'], avoid: ['date', 'money', 'pn'] },
  payment_terms: { want: ['text', 'brand'], avoid: ['date', 'money', 'pn'] },
};

const normHeader = (s: string) => String(s ?? '').toLowerCase().replace(/[\s_\-()（）:：\[\]]/g, '');

/** 编辑距离 ≤1 的容错，专治「客户名称」被打成「客户名秤」这种 */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

/** 表头文字层面的匹配度：完全一致 > 包含 > 近似 */
function headerScore(fieldKey: string, label: string, header: string): number {
  const h = normHeader(header);
  if (!h) return 0;
  const cands = [fieldKey, label, ...(ALIASES[fieldKey] || [])].map(normHeader).filter(Boolean);
  if (cands.includes(h)) return 10;
  for (const c of cands) {
    if (c.length >= 2 && h.includes(c)) return 6;
    if (c.length >= 3 && c.includes(h) && h.length >= 2) return 4;
    if (nearlyEqual(h, c)) return 5;
  }
  return 0;
}

/**
 * 字段映射：表头 + 列内容两票并行，再用「指派」把结果定下来。
 *
 * 为什么要指派而不是各挑各的：一张表里「型号」和「型号描述」都能被
 * 「型号」这个别名匹配上。各挑各的时候两个字段会抢同一列，或者按定义顺序
 * 先到先得地抢错。改成先给所有 (字段, 列) 组合打分、再从高到低贪心占位，
 * 每列只能被一个字段占用 —— 型号拿走完全一致的那列，型号描述自然落到剩下那列。
 */
export function suggestMapping(
  kind: ImportKind, headers: string[], profiles?: ColProfile[]
): Record<string, string> {
  const defs = FIELD_DEFS[kind];
  const pf = profiles && profiles.length === headers.length ? profiles : null;

  // 这张表的表头「有多大程度能看懂」。
  // 表头基本都认识时，某个字段配不上就是真的没有这一列 —— 这时候还去靠内容硬凑，
  // 只会把「仓库」认成「供应商」。反过来表头全是「列1 列2」时，内容才是唯一线索。
  const recognizable = headers.filter(
    (h) => String(h ?? '').trim() && defs.some((f) => headerScore(f.key, f.label, h) > 0)
  ).length;
  const headerQuality = headers.length ? recognizable / headers.length : 0;
  const allowContentOnly = headerQuality < 0.2;

  type Cand = { field: string; header: string; hs: number; score: number };
  const cands: Cand[] = [];
  for (const f of defs) {
    const want = FIELD_CONTENT[f.key];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!String(h ?? '').trim()) continue;
      const hs = headerScore(f.key, f.label, h);
      let score = hs;
      const col = pf ? pf[i] : null;
      if (col && want) {
        if (want.want.includes(col.kind)) score += 5;
        else if (want.avoid?.includes(col.kind)) score -= 8;
        if (col.kind === 'empty') score -= 4;
        // 同名的两列里优先选填得满的那列（收货数量常年是空的，订单数量才是真数据）
        score += Math.round(col.fill * 3);
        // 分组稀疏列几乎一定是客户/供应商，别被「填充率低」误伤。
        // 但得有个下限：填充率 2% 的列是垃圾列，不是分组列。
        if (col.grouped && col.fill >= 0.05 && (f.key === 'customer' || f.key === 'supplier')) score += 6;
      }
      // 必填字段绝不能落在一列空气上。
      // 库存表里有个从头空到尾的「供应商」列，光看表头会被认成采购记录，
      // 然后每一行都因为「缺少供应商」被拒 —— 表面上导入失败，实际是识别错了。
      // 分组列除外：它天生就稀疏。
      if (f.required && col && col.fill < 0.3 && !(col.grouped && col.fill >= 0.05)) continue;
      // 表头完全对不上时，只有必填字段、且这列填得够满，才允许纯靠内容认亲，
      // 否则一张表里的字段会被内容形态胡乱瓜分。
      if (hs === 0 && !(allowContentOnly && f.required && col && col.fill >= 0.5
                        && want?.want.includes(col.kind))) continue;
      if (score <= 0) continue;
      cands.push({ field: f.key, header: h, hs, score });
    }
  }

  // 分数高的先占位；同分时表头匹配得更实的优先
  cands.sort((a, b) => b.score - a.score || b.hs - a.hs);
  const map: Record<string, string> = {};
  const usedHeader = new Set<string>();
  for (const c of cands) {
    if (map[c.field] || usedHeader.has(c.header)) continue;
    map[c.field] = c.header;
    usedHeader.add(c.header);
  }
  return map;
}

/* ---------------- 取值与校验 ---------------- */
const toNum = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,，¥￥$\s]/g, '');
  if (!s) return null;
  // 供应商报价表里常把含税价写成算式，比如「30*1.13」（未税 × 税率），这里直接算出来
  const mul = /^(\d+(?:\.\d+)?)[*x×](\d+(?:\.\d+)?)$/i.exec(s);
  if (mul) {
    const r = Number(mul[1]) * Number(mul[2]);
    return Number.isFinite(r) ? Math.round(r * 1e6) / 1e6 : null;
  }
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

/** 分组报表里只在每组第一行填写的列 —— 导入前要向下填充，否则大部分行会因为缺必填项被拒 */
const GROUPED_FIELDS: Partial<Record<ImportKind, string>> = {
  supplier_quotes: 'supplier',
  purchases: 'supplier',
  shipments: 'customer',
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

  // 分组报表向下填充：公司的「供应商名单」「采购记录」「销售明细」都是这种格式，
  // 同一个供应商/客户只在该组第一行写名字，后面留空。不填充的话大部分行会被判缺必填字段。
  const gKey = GROUPED_FIELDS[kind];
  const gIdx = gKey !== undefined ? idx[gKey] : undefined;
  if (gIdx !== undefined && gIdx >= 0) {
    let last = '';
    for (let r = 1; r < table.length; r++) {
      const v = String(table[r][gIdx] ?? '').trim();
      if (v) last = v; else if (last) table[r][gIdx] = last;
    }
  }

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
  // 只把「同一类 + 同一字段」的问题合并。
  // 之前这里把 「物料型号」和「采购单价」都归一成「…」再当 key，
  // 结果两种不同的缺字段被合并成一行、还只显示其中一个字段名，
  // 数字看起来比行数还多（1015 行报 2030），非常误导人。
  const m = new Map<string, { msg: string; count: number; level: string; field?: string }>();
  for (const it of issues) {
    const base = it.msg.replace(/：.*$/, '');
    const key = `${it.level}|${it.field || ''}|${base}`;
    if (!m.has(key)) m.set(key, { msg: base, count: 0, level: it.level, field: it.field });
    m.get(key)!.count++;
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count);
}

/**
 * 猜这份文件属于哪一种导入类型。
 *
 * 早期版本只按「必填字段能映射上几个」打分，实测 9 个真实文件错 5 个：
 * 「物料主数据」只要求一个型号列，几乎任何表都满足，于是把销售明细也抢了去；
 * 「供应商档案」和「客户档案」结构完全一样，只靠字段根本分不开。
 *
 * 现在用两层信号：
 *   1. 必填字段必须全部能映射上，否则直接出局
 *   2. 在此基础上叠加「特征列」得分 —— 既看映射到的字段，也看表头原文的关键词。
 *      表头里出现「客户」和出现「供应商」，是区分销售/采购最可靠的信号。
 *   3. 反向信号：供应商档案里不该有型号和单价，出现了就大幅扣分。
 */
type KindRule = {
  signals: Partial<Record<string, number>>;   // 映射到的字段 → 加分
  words: [RegExp, number][];                  // 表头原文关键词 → 加分（可为负）
};

const KIND_RULES: Record<ImportKind, KindRule> = {
  shipments: {
    signals: { customer: 3, unit_cost: 3, ship_date: 2, quantity: 1, unit_price: 1 },
    words: [[/客户/, 5], [/出货|销售|发货/, 4], [/供应商|供货商/, -6], [/库存|在途|仓库/, -4]],
  },
  purchases: {
    signals: { supplier: 3, buy_date: 2, quantity: 2, currency: 2 },
    words: [[/采购|进货|收货|订单数量/, 5], [/供应商号/, 4], [/客户/, -6], [/最小包装|代理/, -3]],
  },
  supplier_quotes: {
    signals: { supplier: 3, moq: 2, is_agent: 3, brand: 1, quoted_at: 1 },
    words: [[/含税|报价|代理|最小包装|供应物料/, 5], [/供应商/, 2], [/客户名称/, -6], [/订单数量|收货/, -4]],
  },
  parts: {
    signals: { spec: 2, cat: 2, stock_qty: 3, catalog_cost: 2, standard_price: 2 },
    words: [[/库存|现存|在途|仓库|型号明细/, 6], [/客户/, -6], [/供应商号/, -4], [/出货|销售记录/, -4]],
  },
  suppliers: {
    signals: { contact_name: 3, phone: 3, region: 2, payment_terms: 2 },
    words: [[/供应商|采购员/, 6], [/联系电话|手机号|传真/, 3], [/客户/, -7], [/型号|单价|数量/, -7]],
  },
  customers: {
    signals: { contact_name: 2, phone: 2, level: 2, payment_terms: 2, short_name: 2 },
    words: [[/客户|业务员/, 6], [/联系电话|手机号|传真/, 3], [/供应商|采购员/, -7], [/型号|单价|数量/, -7]],
  },
};

/**
 * 表的「形状」信号：流水表一定有日期列，档案表（供应商/客户/物料）一定没有。
 * 这一条比任何表头关键词都硬 —— 关键词能写歪，一整列日期骗不了人。
 */
const SHAPE_RULES: Record<ImportKind, { date: number; company: number; pn: number }> = {
  shipments:       { date: 5, company: 3, pn: 2 },
  purchases:       { date: 5, company: 3, pn: 2 },
  supplier_quotes: { date: 2, company: 3, pn: 2 },
  parts:           { date: -7, company: -3, pn: 3 },
  suppliers:       { date: -7, company: 3, pn: -6 },
  customers:       { date: -7, company: 3, pn: -6 },
};

/**
 * 判断一张表属于哪一类。
 * 三层证据叠加：① 必填字段能不能配齐（硬闸门）② 表头关键词 ③ 列内容形状。
 * 传了 profiles 就多一层内容证据，没传也能跑（只是弱一点）。
 */
export function guessKind(
  headers: string[], profiles?: ColProfile[]
): { kind: ImportKind; score: number }[] {
  const joined = headers.join(' ');
  const pf = profiles && profiles.length === headers.length ? profiles : null;
  const has = (k: ColKind) => !!pf && pf.some((c) => c.kind === k && c.fill > 0.3);
  const hasDate = has('date');
  const hasCompany = has('company') || (!!pf && pf.some((c) => c.kind === 'company' && c.grouped));
  const hasPn = has('pn');

  const out: { kind: ImportKind; score: number }[] = [];
  for (const k of Object.keys(FIELD_DEFS) as ImportKind[]) {
    const map = suggestMapping(k, headers, pf ?? undefined);
    const req = FIELD_DEFS[k].filter((f) => f.required);
    const hitReq = req.filter((f) => map[f.key]).length;

    // 必填字段没配齐 → 不是这一类
    if (hitReq < req.length) { out.push({ kind: k, score: 0 }); continue; }

    const rule = KIND_RULES[k];
    let score = 10;                                   // 必填齐全的基础分
    for (const [field, w] of Object.entries(rule.signals)) {
      if (map[field]) score += w as number;
    }
    for (const [re, w] of rule.words) {
      if (re.test(joined)) score += w;
    }
    if (pf) {
      const sh = SHAPE_RULES[k];
      if (hasDate) score += sh.date;
      if (hasCompany) score += sh.company;
      if (hasPn) score += sh.pn;
    }
    out.push({ kind: k, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const KIND_LABEL: Record<ImportKind, string> = {
  purchases: '采购记录',
  supplier_quotes: '供应商报价',
  shipments: '出货流水',
  parts: '物料主数据',
  suppliers: '供应商档案',
  customers: '客户档案',
};

export async function nextBatchNo(kind: ImportKind): Promise<string> {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM import_batches WHERE batch_no LIKE $1`, [`IMP-${day}-%`]
  );
  return `IMP-${day}-${String(rows[0].c + 1).padStart(2, '0')}`;
}
