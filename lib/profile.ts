/**
 * 列内容画像（Column Profiling）
 *
 * 为什么需要这一层：
 * 原来的字段映射只看表头文字。表头一旦写得含糊，整套逻辑就瞎了 ——
 * 龙威导出的采购表里「单价」「金额」「总金额」三列都叫得像价格；
 * 「日期」这个词同时是采购日期和报价日期的别名；
 * 有些表干脆把列名写成「列1 列2 列3」。
 *
 * 所以这里不看名字，只看**这一列里装的是什么东西**：
 * 是不是日期、是不是整数、是不是钱、是不是元器件型号、是不是公司名。
 * 表头和内容两票并行，谁都不能单独决定，冲突时以内容为准。
 */

export type ColKind =
  | 'empty' | 'date' | 'int' | 'money' | 'pn' | 'company'
  | 'pkg' | 'currency' | 'bool' | 'brand' | 'text';

export type ColProfile = {
  index: number;
  header: string;
  kind: ColKind;
  fill: number;        // 非空率 0~1
  distinct: number;    // 去重后的取值个数
  distinctRatio: number;
  grouped: boolean;    // 是不是「分组报表只在组首打印」那种稀疏列
  numeric: boolean;
  intRatio: number;    // 数值里整数的占比
  maxDecimals: number;
  min?: number;
  max?: number;
  samples: string[];
};

/* ---------------- 单值判定 ---------------- */

const RE_DATE = /^(19|20)\d{2}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}日?$/;
const RE_DATE_COMPACT = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
const RE_NUM = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;
// 元器件型号：以字母或数字开头，含字母，允许 - _ . / ( ) #，长度 3~40
const RE_PN = /^[A-Za-z0-9][A-Za-z0-9\-_.\/()#+]{2,39}$/;
const RE_HAS_ALPHA = /[A-Za-z]/;
const RE_CN = /[一-龥]/;
const RE_COMPANY = /(有限公司|股份|集团|电子|科技|贸易|实业|半导体|微电子|商行|经营部|工作室|Co\.?,?\s?Ltd|Inc\.?|Corp)/i;
const RE_PKG = /^(\d+(\.\d+)?[KkMm]|SOT-?\d+|SOP-?\d+|SOIC-?\d+|QFN-?\d+|QFP-?\d+|LQFP-?\d+|TSSOP-?\d+|MSOP-?\d+|DIP-?\d+|SMA|SMB|SMC|DFN-?\d+|BGA-?\d+|0201|0402|0603|0805|1206|1210|1812|2010|2512|TO-?\d+|散装|盘装|卷装|管装|编带|袋装)$/i;
const CURRENCIES = new Set(['RMB', 'CNY', 'USD', 'HKD', 'EUR', 'JPY', '人民币', '美元', '港币', '欧元', '日元', '¥', '$']);
const BOOLS = new Set(['是', '否', 'Y', 'N', 'YES', 'NO', 'TRUE', 'FALSE', '1', '0', '有', '无']);

const clean = (v: any) => String(v ?? '').trim();

function isDate(s: string): boolean {
  if (RE_DATE.test(s) || RE_DATE_COMPACT.test(s)) return true;
  // Excel 序列号（1900-01-01 起算），只认落在 1990~2050 之间的
  if (/^\d{5}$/.test(s)) { const n = Number(s); return n > 32800 && n < 55000; }
  return false;
}
function toNumber(s: string): number | null {
  const t = s.replace(/[,，¥￥$\s]/g, '');
  if (!t || !RE_NUM.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function decimalsOf(s: string): number {
  const m = s.replace(/,/g, '').match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

/* ---------------- 整列判定 ---------------- */

/**
 * 判断一列是不是「分组稀疏」：分组报表里客户/供应商只在每组第一行打印。
 * 特征是非空率低、但非空的值彼此不同、且空值成段出现。
 * 认出来之后 buildRows 会向下填充 —— 不填充的话 90%+ 的行会因缺必填项被拒。
 */
function looksGrouped(vals: string[]): boolean {
  const nonEmpty = vals.filter(Boolean).length;
  if (!vals.length || nonEmpty === 0) return false;
  const fill = nonEmpty / vals.length;
  if (fill > 0.7 || fill < 0.01) return false;
  // 连续空段的平均长度 > 1.5 才算「成段」，而不是随机缺失
  let runs = 0, inRun = false;
  for (const v of vals) {
    if (!v) { if (!inRun) { runs++; inRun = true; } } else inRun = false;
  }
  const emptyCount = vals.length - nonEmpty;
  return runs > 0 && emptyCount / runs >= 1.5;
}

function classify(vals: string[]): ColKind {
  const nn = vals.filter(Boolean);
  if (!nn.length) return 'empty';
  const n = nn.length;
  const ratio = (f: (s: string) => boolean) => nn.filter(f).length / n;

  if (ratio((s) => CURRENCIES.has(s.toUpperCase())) > 0.8) return 'currency';
  if (ratio(isDate) > 0.7) return 'date';
  // 是/否 类的列常混着「待确认」「待定」这种第三态，所以阈值放到 0.6，
  // 但取值种类必须很少 —— 否则一列公司名里恰好有几个「是」也会被误判
  if (ratio((s) => BOOLS.has(s.toUpperCase())) > 0.6 && new Set(nn).size <= 5) return 'bool';
  if (ratio((s) => RE_PKG.test(s)) > 0.6) return 'pkg';

  const nums = nn.map(toNumber).filter((x): x is number => x !== null);
  if (nums.length / n > 0.85) {
    const ints = nums.filter((x) => Number.isInteger(x)).length / nums.length;
    const maxDec = Math.max(0, ...nn.map(decimalsOf));
    // 整数为主、且数值偏大 → 数量；带小数 → 金额/单价
    if (ints > 0.95 && maxDec === 0) return 'int';
    return 'money';
  }

  // 公司名：含中文且出现公司类关键词，或者纯中文短串且重复度高
  if (ratio((s) => RE_CN.test(s) && RE_COMPANY.test(s)) > 0.5) return 'company';
  const distinctRatio = new Set(nn).size / n;
  if (ratio((s) => RE_CN.test(s)) > 0.8 && distinctRatio < 0.6) return 'company';

  // 型号：以字母数字为主、含字母、区分度高
  if (ratio((s) => RE_PN.test(s) && RE_HAS_ALPHA.test(s)) > 0.7) {
    return distinctRatio > 0.25 ? 'pn' : 'brand';
  }
  // 短的纯字母串、重复度高 → 品牌
  if (ratio((s) => s.length <= 20 && !RE_CN.test(s)) > 0.7 && distinctRatio < 0.3) return 'brand';
  return 'text';
}

/**
 * 给整张表做画像。只抽样前 sampleLimit 行 —— 几千行的表全量扫没必要，
 * 400 行足够把一列的形态定下来，而且预览要求秒回。
 */
export function profileColumns(table: string[][], sampleLimit = 400): ColProfile[] {
  if (!table.length) return [];
  const headers = table[0].map(clean);
  const body = table.slice(1, 1 + sampleLimit);
  return headers.map((h, i) => {
    const raw = body.map((r) => clean(r[i]));
    const nn = raw.filter(Boolean);
    const nums = nn.map(toNumber).filter((x): x is number => x !== null);
    const set = new Set(nn);
    return {
      index: i,
      header: h,
      kind: classify(raw),
      fill: raw.length ? nn.length / raw.length : 0,
      distinct: set.size,
      distinctRatio: nn.length ? set.size / nn.length : 0,
      grouped: looksGrouped(raw),
      numeric: nn.length > 0 && nums.length / nn.length > 0.85,
      intRatio: nums.length ? nums.filter((x) => Number.isInteger(x)).length / nums.length : 0,
      maxDecimals: Math.max(0, ...nn.map(decimalsOf)),
      min: nums.length ? Math.min(...nums) : undefined,
      max: nums.length ? Math.max(...nums) : undefined,
      samples: Array.from(set).slice(0, 3),
    };
  });
}

/**
 * 表头指纹：用来记住「这张表以前导过，当时是怎么映射的」。
 * 归一化到只剩内容本身，这样列顺序变了、大小写变了、多了空格括号，
 * 依然认得出是同一种表。
 */
export function fingerprint(headers: string[]): string {
  const norm = headers
    .map((h) => clean(h).toLowerCase().replace(/[\s_\-()（）:：]/g, ''))
    .filter(Boolean)
    .sort();
  // 简易 FNV-1a，避免为了算个 hash 去引 crypto（Edge runtime 上也能跑）
  let hash = 0x811c9dc5;
  const s = norm.join('|');
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + '-' + norm.length + '-' + s.length;
}

/** 两组表头的相似度（Jaccard），用来做「差不多是同一张表」的模糊命中 */
export function headerSimilarity(a: string[], b: string[]): number {
  const norm = (xs: string[]) => new Set(xs.map((h) => clean(h).toLowerCase().replace(/[\s_\-()（）:：]/g, '')).filter(Boolean));
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
