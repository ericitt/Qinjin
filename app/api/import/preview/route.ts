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
    // kind 传 'auto' 或不传 → 自动识别，这是「一键导入」的入口
    const isAuto = !kind || kind === 'auto';
    if (!isAuto && !FIELD_DEFS[kind as ImportKind]) {
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

    const ranked = guessKind(headers);
    // 自动模式下用猜出来的类型；得分 0 说明必填字段都配不齐，没有可用类型
    const kindUsed: ImportKind = isAuto ? ranked[0].kind : (kind as ImportKind);
    if (isAuto && ranked[0].score <= 0) {
      return NextResponse.json({
        error: '认不出这份表属于哪一类数据。请检查表头，或在下方手动选择类型。',
        detected: null,
        candidates: ranked.slice(0, 3).map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind], score: r.score })),
        headers,
      }, { status: 422 });
    }
    // 和次选拉开差距才算「有把握」，否则提示用户确认一下
    const confident = ranked[0].score - (ranked[1]?.score ?? 0) >= 5;

    const mapping = userMapping && Object.keys(userMapping).length
      ? userMapping
      : suggestMapping(kindUsed, headers);

    // 选错类型是最容易犯的错。与其甩一堆「缺少必填字段」，不如直接告诉用户
    // 这份文件更像哪一类 —— 判断依据是必填字段能不能在表头里找到。
    const missingRequired = FIELD_DEFS[kindUsed]
      .filter((f) => f.required && !mapping[f.key]).map((f) => f.label);
    let kindHint: { suggest: ImportKind; suggestLabel: string; missing: string[] } | null = null;
    if (missingRequired.length) {
      const best = guessKind(headers)[0];
      if (best && best.kind !== kindUsed && best.score > 0) {
        kindHint = {
          suggest: best.kind,
          suggestLabel: KIND_LABEL[best.kind],
          missing: missingRequired,
        };
      }
    }

    const { rows, issues } = buildRows(kindUsed, table, mapping);
    await enrichIssues(kindUsed, rows, issues);

    const rejectRows = new Set(issues.filter((i) => i.level === 'reject').map((i) => i.row));
    const warnRows = new Set(issues.filter((i) => i.level === 'warn').map((i) => i.row));

    const result: PreviewResult = {
      kind: kindUsed,
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
      fields: FIELD_DEFS[kindUsed],
      detected: { kind: kindUsed, label: KIND_LABEL[kindUsed], confident,
                  candidates: ranked.slice(0, 3).map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind], score: r.score })) },
      missingRequired,
      kindHint,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
