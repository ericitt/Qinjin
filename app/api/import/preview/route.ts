import { NextRequest, NextResponse } from 'next/server';
import {
  parseDelimited, suggestMapping, buildRows, enrichIssues, summarize,
  guessKind, KIND_LABEL, FIELD_DEFS,
} from '@/lib/import';
import { profileColumns } from '@/lib/profile';
import { recallMapping } from '@/lib/learn';
import type { ImportKind, PreviewResult } from '@/lib/import';

export const maxDuration = 60;

/**
 * 导入预览：不写任何数据，只做识别 + 字段映射 + 校验。
 * body: { kind?: ImportKind | 'auto', text, mapping? }
 *
 * 识别的证据按优先级排：
 *   1. 记忆   —— 这张表以前导过，直接用当时的映射（人工纠正过的最优先）
 *   2. 内容   —— 每一列里装的是什么（日期/整数/金额/型号/公司名）
 *   3. 表头   —— 列名关键词与别名
 * 三者一致时直接放行，不一致时把分歧摆出来让人定。
 */
export async function POST(req: NextRequest) {
  try {
    const { kind, text, mapping: userMapping } = await req.json();
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

    const profiles = profileColumns(table);
    const ranked = guessKind(headers, profiles);
    const learned = await recallMapping(headers);

    // ── 决定用哪个类型 ──────────────────────────────────────────
    let kindUsed: ImportKind;
    let source: 'manual' | 'learned' | 'auto';
    if (!isAuto) {
      kindUsed = kind as ImportKind; source = 'manual';
    } else if (learned) {
      kindUsed = learned.kind; source = 'learned';
    } else if (ranked[0].score > 0) {
      kindUsed = ranked[0].kind; source = 'auto';
    } else {
      return NextResponse.json({
        error: '认不出这份表属于哪一类数据。请检查表头，或在下方手动选择类型。',
        detected: null,
        candidates: ranked.slice(0, 3).map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind], score: r.score })),
        headers,
        profiles: profiles.map((p) => ({ header: p.header, kind: p.kind, fill: Math.round(p.fill * 100) })),
      }, { status: 422 });
    }

    // 记忆命中的直接信任；否则要和次选拉开 5 分才算有把握
    const confident = source === 'learned'
      ? true
      : source === 'manual'
        ? true
        : ranked[0].score - (ranked[1]?.score ?? 0) >= 5;

    // ── 字段映射 ────────────────────────────────────────────────
    const autoMapping = suggestMapping(kindUsed, headers, profiles);
    let mapping: Record<string, string>;
    if (userMapping && Object.keys(userMapping).length) {
      mapping = userMapping;
    } else if (learned && learned.kind === kindUsed) {
      // 记忆里的列名可能已经不在这份表里了（ERP 改过表头），逐个校验后再用
      const fromMemory: Record<string, string> = {};
      for (const [k, h] of Object.entries(learned.mapping as Record<string, string>)) {
        if (headers.includes(h)) fromMemory[k] = h;
      }
      // 记忆没覆盖到的字段用自动结果补齐
      mapping = { ...autoMapping, ...fromMemory };
    } else {
      mapping = autoMapping;
    }

    // 选错类型是最容易犯的错。与其甩一堆「缺少必填字段」，不如直接告诉用户
    // 这份文件更像哪一类 —— 判断依据是必填字段能不能在表头里找到。
    const missingRequired = FIELD_DEFS[kindUsed]
      .filter((f) => f.required && !mapping[f.key]).map((f) => f.label);
    let kindHint: { suggest: ImportKind; suggestLabel: string; missing: string[] } | null = null;
    if (missingRequired.length) {
      const best = ranked[0];
      if (best && best.kind !== kindUsed && best.score > 0) {
        kindHint = { suggest: best.kind, suggestLabel: KIND_LABEL[best.kind], missing: missingRequired };
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
      detected: {
        kind: kindUsed,
        label: KIND_LABEL[kindUsed],
        confident,
        source,
        learnedHits: learned?.hits ?? 0,
        learnedCorrected: learned?.corrected ?? false,
        learnedSimilarity: learned ? Math.round(learned.similarity * 100) : 0,
        candidates: ranked.slice(0, 3).map((r) => ({ kind: r.kind, label: KIND_LABEL[r.kind], score: r.score })),
      },
      // 把列画像也返回去，界面上直接显示「这一列被认成了什么」，
      // 映射错了一眼就能看出是哪一步歪的
      profiles: profiles.map((p) => ({
        header: p.header, kind: p.kind,
        fill: Math.round(p.fill * 100), grouped: p.grouped, samples: p.samples,
      })),
      missingRequired,
      kindHint,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
