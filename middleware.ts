import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AUTH_COOKIE, verifyToken } from '@/lib/auth';

/**
 * 共享密码门禁。
 *
 * 设计上刻意做成「没配密码就不拦」：ACCESS_PASSWORD 为空时直接放行，
 * 这样万一环境变量没配好，也不会把所有人挡在外面。
 * 配上之后，页面会跳到 /login，接口直接返回 401。
 */
export async function middleware(req: NextRequest) {
  const secret = process.env.ACCESS_PASSWORD;
  if (!secret) return NextResponse.next();          // 门禁未启用

  const { pathname, search } = req.nextUrl;

  // 登录相关的路径必须放行，否则会陷入重定向循环
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) return NextResponse.next();

  const ok = await verifyToken(req.cookies.get(AUTH_COOKIE)?.value, secret);
  if (ok) return NextResponse.next();

  // 接口返回 401，让前端能识别；页面则跳转登录并记住原地址
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未授权，请先登录' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // 静态资源和图标不走门禁，否则登录页自己都加载不出样式
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
