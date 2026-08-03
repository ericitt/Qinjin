import { NextRequest, NextResponse } from 'next/server';
import {
  parseDelimited, suggestMapping, buildRows, enrichIssues, summarize, FIELD_DEFS,
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
    return NextResponse.json({ ...result, fields: FIELD_DEFS[kind as ImportKind] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
