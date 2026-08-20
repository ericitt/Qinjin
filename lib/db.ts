import { Pool } from 'pg';

// 两种部署环境的连接方式不一样：
//
// 1. 云端（Supabase + Vercel）：必须走 "Connection pooling"（Transaction 模式，端口 6543）连接串，
//    不能用 Direct connection（5432）—— Vercel 的 serverless function 按请求起停，
//    并发高时直连很容易把连接数配额打满。Supabase 强制要求 SSL。
//
// 2. 内网自建（本机 PostgreSQL）：本地库默认没开 SSL。
//    如果这里无条件带上 ssl 选项，连接会直接失败（表现为所有接口 500），
//    数据库明明是好的、.env 也对，但页面一条数据都没有 —— 排查起来很费劲。
//    所以下面按主机名判断：localhost / 127.0.0.1 / 内网地址一律不用 SSL。

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

function needsSsl(url: string | undefined): boolean {
  if (!url) return false;
  // 连接串里显式写了就听它的
  if (/[?&]sslmode=disable/i.test(url)) return false;
  if (/[?&]sslmode=(require|verify-full|verify-ca)/i.test(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    // 私有网段（局域网内的数据库）同样不用 SSL
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;   // 其余当成公网托管数据库
  } catch {
    return false;
  }
}

const useSsl = needsSsl(process.env.DATABASE_URL);

const pool =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    // 内部工具、2-3 人用，连接数给小一点
    max: 5,
    idleTimeoutMillis: 30000,
  });

if (process.env.NODE_ENV !== 'production') {
  global._pgPool = pool;
}

export default pool;
