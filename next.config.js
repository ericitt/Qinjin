/** @type {import('next').NextConfig} */
const nextConfig = {
  // 自建部署要用 standalone：构建时把用到的依赖一起打进产物，
  // 运行时不需要完整 node_modules，镜像小很多、启动也快。
  // standalone 会把依赖打进 .next/standalone，内网机器上不用装完整 node_modules 也能跑。
  output: 'standalone',
};

module.exports = nextConfig;
