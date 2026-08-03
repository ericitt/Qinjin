import { NextRequest, NextResponse } from 'next/server';
import {
  parseDelimited, suggestMapping, buildRows, enrichIssues, summarize,
  guessKind, KIND_LABEL, FIELD_DEFS,
} from '@/lib/import';
import type { ImportKind, PreviewResult } from '@/lib/import';

export const maxDuration = 60;

/**
 * 导入预览：不写任何数据，只做解析 + 字段映射 + 校验
 * body: { kind, text, mapping? }
 */
export async function POST(req: NextRequest) {
  try {
    const { kind, text, mapping: userMapping } = await req.json();
    if (!kind || !FIELD_DEFS[kind as ImportKind]) {
      return NextResponse.json({ error: '未知的导入类型' }, { status: 400 });
    }
    if (!text || !String(text).trim()) {
      return NextResponse.json({ error: '文件内容为空' }, { status: 400 });
    }

    const table = parseDelimited(String(text));
    if (table.length < 2) {
      return NextResponse.json({ error: '至少需要表头 + 1 行数据' }, { status: 422 });
    }
    const headers = table[0].map((h) => h.trim());
    table[0] = headers;

    const mapping = userMapping && Object.keys(userMapping).length
      ? userMapping
      : suggestMapping(kind as ImportKind, headers);

    // 选错类型是最容易犯的错。与其甩一堆「缺少必填字段」，不如直接告诉用户
    // 这份文件更像哪一类 —— 判断依据是必填字段能不能在表头里找到。
    const missingRequired = FIELD_DEFS[kind as ImportKind]
      .filter((f) => f.required && !mapping[f.key]).map((f) => f.label);
    let kindHint: { suggest: ImportKind; suggestLabel: string; missing: string[] } | null = null;
    if (missingRequired.length) {
      const best = guessKind(headers)[0];
      if (best && best.kind !== kind && best.score >= 100) {
        kindHint = {
          suggest: best.kind,
          suggestLabel: KIND_LABEL[best.kind],
          missing: missingRequired,
        };
      }
    }

    const { rows, issues } = buildRows(kind as ImportKind, table, mapping);
    await enrichIssues(kind as ImportKind, rows, issues);

    const rejectRows = new Set(issues.filter((i) => i.level === 'reject').map((i) => i.row));
    const warnRows = new Set(issues.filter((i) => i.level === 'warn').map((i) => i.row));

    const result: PreviewResult = {
      kind: kind as ImportKind,
      headers,
      suggestedMapping: mapping,
      sample: rows.slice(0, 10),
      rowTotal: rows.length,
      okCount: rows.length - rejectRows.size,
      rejectCount: rejectRows.size,
      warnCount: Array.from(warnRows).filter((r) => !rejectRows.has(r)).length,
      issues: issues.slice(0, 200),
      issueSummary: summarize(issues),
    };
    return NextResponse.json({
      ...result,
      fields: FIELD_DEFS[kind as ImportKind],
      missingRequired,
      kindHint,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
