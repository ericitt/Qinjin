import { NextResponse } from 'next/server';
import { recalcAllBrandScores } from '@/lib/scoring';

// 部署后手动跑一次：curl -X POST https://你的地址/api/suppliers/recalc-score
// 以后如果出货数据有更新，可以再跑一次刷新评分（MVP阶段不做定时任务，手动触发就够）
export async function POST() {
  try {
    const count = await recalcAllBrandScores();
    return NextResponse.json({ ok: true, updated: count });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
