import './globals.css';
import type { Metadata } from 'next';
import Nav from './components/Nav';

export const metadata: Metadata = {
  title: '勤进科技 · 物料库',
  description: '物料查询、AI询价、客户与供应商管理',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <div className="layout">
          <nav className="sidebar">
            <div className="sb-logo">
              <div className="sb-logo-name">勤进科技 · 物料库</div>
              <div className="sb-logo-sub">内部工具 · 在线实时数据</div>
            </div>
            <Nav />
            <div className="sb-footer">v0.2 · 数据可导入可回滚</div>
          </nav>
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
