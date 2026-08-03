import './globals.css';
import type { Metadata } from 'next';
import Shell from './components/Shell';

export const metadata: Metadata = {
  title: '勤进科技 · 物料库',
  description: '物料查询、AI询价、客户与供应商管理',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
