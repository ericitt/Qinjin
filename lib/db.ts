import { Pool } from 'pg';

// Supabase + Vercel serverless 环境注意事项：
// 1. 一定要用 Supabase 项目设置里的 "Connection pooling"（Transaction 模式，端口 6543）连接串，
//    不要用 "Direct connection"（端口 5432）—— Vercel 的 serverless function 是按请求起停的，
//    并发高的时候直连很容易把 Supabase 免费额度的连接数配额打满。
// 2. Supabase 要求 SSL，下面已经处理好了。

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

const pool =
  global._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // 内部工具、2-3人用，连接数给小一点；用了 Supabase 连接池后这个数字本身不那么关键了
    max: 5,
    idleTimeoutMillis: 30000,
  });

if (process.env.NODE_ENV !== 'production') {
  global._pgPool = pool;
}

export default pool;
