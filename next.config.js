/** @type {import('next').NextConfig} */
const nextConfig = {
  // 自建部署要用 standalone：构建时把用到的依赖一起打进产物，
  // 运行时不需要完整 node_modules，镜像小很多、启动也快。
  // 这个选项对 Vercel 部署没有副作用，两边共用同一份代码。
  output: 'standalone',
};

module.exports = nextConfig;
