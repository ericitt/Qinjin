import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '勤进科技 · 伺服物料库',
  description: '内部物料查询与AI询价助手',
};

const NAV = [
  { href: '/', label: '智能查询', icon: '⚡' },
  { href: '/bom', label: 'AI 询价助手', icon: '✦' },
  { href: '/orders', label: '出货明细', icon: '□' },
  { href: '/suppliers', label: '供应商管理', icon: '◎' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <div className="layout">
          <nav className="sidebar">
            <div className="sb-logo">
              <div className="sb-logo-name">勤进科技</div>
              <div className="sb-logo-sub">伺服驱动器物料库 · MVP</div>
            </div>
            <div className="sb-nav">
              {NAV.map((n) => (
                <a key={n.href} className="sb-item" href={n.href}>
                  <span>{n.icon}</span> {n.label}
                </a>
              ))}
            </div>
            <div className="sb-footer">
              v0.1 MVP · 在线实时数据
              <br />
              无登录 · 内部工具
            </div>
          </nav>
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
