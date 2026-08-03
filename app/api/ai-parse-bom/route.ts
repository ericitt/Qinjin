import { NextRequest, NextResponse } from 'next/server';
import { parseBomWithClaude } from '@/lib/claude';
import { matchManyParts } from '@/lib/matching';

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || !String(text).trim()) {
      return NextResponse.json({ error: '缺少文本内容' }, { status: 400 });
    }

    // 1. AI 清洗：把客户发来的乱格式文本提取成结构化型号列表
    const parsedItems = await parseBomWithClaude(String(text));
    if (!parsedItems.length) {
      return NextResponse.json({ error: 'AI 未能从文本中识别出任何型号，请检查内容或换一种描述方式' }, { status: 422 });
    }

    // 2. 匹配数据库：四档匹配（精确出货过/仅目录参考价/模糊命中/未找到）
    const matched = await matchManyParts(parsedItems.map((it) => ({ pn: it.pn, qty: it.qty })));

    // 3. 拼装成前端展示需要的格式（brand_hint 一起带回去，供人工复核参考）
    const results = matched.map((m, idx) => ({
      ...m,
      brandHint: parsedItems[idx]?.brand_hint || null,
    }));

    const summary = {
      total: results.length,
      exact: results.filter((r) => r.matchType === 'exact').length,
      catalog: results.filter((r) => r.matchType === 'catalog').length,
      partial: results.filter((r) => r.matchType === 'partial').length,
      none: results.filter((r) => r.matchType === 'none').length,
    };

    return NextResponse.json({ items: results, summary });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
