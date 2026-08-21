'use client';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Nav from './Nav';

/**
 * 外壳：侧边栏 + 内容区。
 *
 * 手机上侧边栏改成抽屉：默认收起，点左上角按钮划出来，点任意菜单或遮罩自动收回。
 * 桌面端（≥820px）行为不变，还是常驻侧边栏。
 *
 * 登录页不套这层壳 —— 还没登录就看到导航很怪。
 * 根 layout 是服务端组件拿不到当前路径，所以判断放在这个客户端组件里。
 */
export default function Shell({ children, aiEnabled = false }: { children: React.ReactNode; aiEnabled?: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // 切页面时把抽屉收起来
  useEffect(() => { setOpen(false); }, [path]);

  if (path === '/login') return <>{children}</>;

  return (
    <div className="layout">
      {open && <div className="sb-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      <nav className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sb-logo">
          <div className="sb-logo-name">勤进科技 · 物料库</div>
          <div className="sb-logo-sub">内部工具 · 在线实时数据</div>
        </div>
        <Nav aiEnabled={aiEnabled} onNavigate={() => setOpen(false)} />
        <div className="sb-footer">v1.0 · 内网自建</div>
      </nav>

      <div className="content">
        <button className="sb-toggle" onClick={() => setOpen(true)} aria-label="打开菜单">☰</button>
        {children}
      </div>
    </div>
  );
}
