import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, SESSION_DAYS, createToken } from '@/lib/auth';

/** 简单的失败节流：同一 IP 连续错太多次就先等一会儿，防止有人慢慢撞密码 */
const fails = new Map<string, { n: number; until: number }>();
const MAX_TRIES = 8;
const LOCK_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  const secret = process.env.ACCESS_PASSWORD;
  if (!secret) return NextResponse.json({ ok: true, gate: false });   // 未启用门禁

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const rec = fails.get(ip);
  if (rec && rec.n >= MAX_TRIES && Date.now() < rec.until) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    return NextResponse.json({ error: `尝试次数过多，请 ${mins} 分钟后再试` }, { status: 429 });
  }

  const { password } = await req.json().catch(() => ({ password: '' }));
  if (!password || password !== secret) {
    const n = (rec && Date.now() < rec.until ? rec.n : 0) + 1;
    fails.set(ip, { n, until: Date.now() + LOCK_MS });
    return NextResponse.json({ error: '密码不正确' }, { status: 401 });
  }

  fails.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await createToken(secret), {
    httpOnly: true,                 // JS 读不到，降低被 XSS 偷走的风险
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
  return res;
}
