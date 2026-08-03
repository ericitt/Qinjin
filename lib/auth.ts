/**
 * 共享密码门禁的签名逻辑。
 *
 * 这个文件会被 middleware 引用，而 middleware 跑在 Edge Runtime 上，
 * 所以只能用 Web Crypto（crypto.subtle），不能用 Node 的 crypto 模块，
 * 也不能 import 任何带数据库连接的东西。
 *
 * 做法：登录成功后发一个 cookie，值是 `过期时间.HMAC签名`。
 * 服务端每次用 ACCESS_PASSWORD 当密钥重新算一遍签名比对，
 * 因此不需要在服务端存 session，也改不了过期时间（改了签名就对不上）。
 */
export const AUTH_COOKIE = 'qj_auth';
export const SESSION_DAYS = 14;

const enc = new TextEncoder();

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定长比较，避免因为提前 return 泄露信息 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createToken(secret: string): Promise<string> {
  const exp = String(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  return `${exp}.${await hmac(exp, secret)}`;
}

export async function verifyToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  const ts = Number(exp);
  if (!Number.isFinite(ts) || ts < Date.now()) return false;   // 过期
  return safeEqual(sig, await hmac(exp, secret));
}

/** 密码是否已配置。没配就等于门禁关闭 —— 这样忘了设也不会把自己锁在外面 */
export function gateEnabled(): boolean {
  return !!(process.env.ACCESS_PASSWORD && process.env.ACCESS_PASSWORD.length > 0);
}
