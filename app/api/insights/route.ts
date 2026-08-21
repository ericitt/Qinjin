import { NextRequest, NextResponse } from 'next/server';
import {
  sleepingCustomers, sleepingParts, crossSell, bomGap, supplyGap, insightSummary,
} from '@/lib/insights';

// 每次都要查实时数据（Next 会把不读 request 的 GET 固化在构建时）
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 商机分析。?tab= 决定算哪一块 —— 分开算是有意的：
 * 购物篮那个查询要做自连接，比其他几个慢得多，
 * 放一起会拖累整页打开速度，切到那个标签页再算就行。
 */
export async function GET(req: NextRequest) {
  const tab = req.nextUrl.searchParams.get('tab') || 'summary';
  try {
    switch (tab) {
      case 'sleeping':
        return NextResponse.json({
          customers: await sleepingCustomers(), parts: await sleepingParts(),
        });
      case 'cross':
        return NextResponse.json({ pairs: await crossSell() });
      case 'bom':
        return NextResponse.json(await bomGap());
      case 'supply':
        return NextResponse.json({ rows: await supplyGap() });
      default:
        return NextResponse.json(await insightSummary());
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
