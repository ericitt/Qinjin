'use client';
import { usePathname } from 'next/navigation';
import Nav from './Nav';

/**
 * 外壳：侧边栏 + 内容区。
 * 登录页不应该套这层壳（还没登录就看到导航很怪），
 * 而根 layout 是服务端组件拿不到当前路径，所以放在这个客户端组件里判断。
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path === '/login') return <>{children}</>;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sb-logo">
          <div className="sb-logo-name">勤进科技 · 物料库</div>
          <div className="sb-logo-sub">内部工具 · 在线实时数据</div>
        </div>
        <Nav />
        <div className="sb-footer">v0.4 · 数据可导入可回滚</div>
      </nav>
      <div className="content">{children}</div>
    </div>
  );
}
