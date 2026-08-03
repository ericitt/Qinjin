import { NextRequest, NextResponse } from 'next/server';
import { parseBomWithAI } from '@/lib/ai';
import { matchManyParts } from '@/lib/matching';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || !String(text).trim()) {
      return NextResponse.json({ error: '缺少文本内容' }, { status: 400 });
    }
    if (String(text).length > 200_000) {
      return NextResponse.json({ error: '内容过长，请分批处理（单次上限 20 万字符）' }, { status: 413 });
    }

    // 1. AI 清洗：把客户发来的乱格式文本提取成结构化型号列表（内部会按行分片）
    const parsedItems = await parseBomWithAI(String(text));
    if (!parsedItems.length) {
      return NextResponse.json(
        { error: 'AI 未能从文本中识别出任何型号，请检查内容或换一种描述方式' }, { status: 422 });
    }

    // 2. 批量匹配（整批 5 次查询，不再是每个型号 4 次）
    const matched = await matchManyParts(parsedItems.map((it) => ({ pn: it.pn, qty: it.qty })));

    const results = matched.map((m, idx) => ({
      ...m,
      brandHint: parsedItems[idx]?.brand_hint || null,
    }));

    const summary = {
      total: results.length,
      exact: results.filter((r) => r.matchType === 'exact').length,
      alias: results.filter((r) => r.matchType === 'alias').length,
      catalog: results.filter((r) => r.matchType === 'catalog').length,
      partial: results.filter((r) => r.matchType === 'partial').length,
      none: results.filter((r) => r.matchType === 'none').length,
      needsReview: results.filter((r) => r.warnings.length > 0).length,
      totalAmount: results.reduce((s, r) => s + (r.unitPrice || 0) * (r.qty || 0), 0),
      totalCost: results.reduce((s, r) => s + (r.cost || 0) * (r.qty || 0), 0),
    };

    return NextResponse.json({
      items: results,
      summary: {
        ...summary,
        margin: summary.totalAmount > 0
          ? ((summary.totalAmount - summary.totalCost) / summary.totalAmount) * 100 : null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
