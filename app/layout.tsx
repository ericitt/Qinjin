import './globals.css';
import type { Metadata, Viewport } from 'next';
import Shell from './components/Shell';
import { realKey } from '@/lib/ai';

export const metadata: Metadata = {
  title: '勤进科技 · 物料库',
  description: '物料查询、客户与供应商管理',
};

// 手机上必须给 viewport，否则会按桌面宽度缩放，字小到看不清
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 这里是服务端组件，能直接读环境变量。
  // 没配 AI 密钥就把「AI 询价助手」整条从导航里去掉，配上了自动出现，不用改代码。
  const aiEnabled = !!(realKey(process.env.DEEPSEEK_API_KEY) || realKey(process.env.ANTHROPIC_API_KEY));

  return (
    <html lang="zh">
      <body>
        <Shell aiEnabled={aiEnabled}>{children}</Shell>
      </body>
    </html>
  );
}
