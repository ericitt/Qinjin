'use client';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const NAV: ({ group: string } | { href: string; label: string; icon: string; tag?: string })[] = [
  { group: '日常' },
  { href: '/', label: '工作台', icon: '◈' },
  { href: '/search', label: '智能查询', icon: '⌕' },
  { href: '/bom', label: 'AI 询价助手', icon: '✦' },
  { href: '/inquiries', label: '询价记录', icon: '☰', tag: '新' },
  { group: '数据' },
  { href: '/orders', label: '出货明细', icon: '▤' },
  { href: '/customers', label: '客户管理', icon: '◉', tag: '新' },
  { href: '/suppliers', label: '供应商', icon: '⬡' },
  { group: '维护' },
  { href: '/import', label: '数据导入', icon: '↥', tag: '新' },
  { href: '/data-health', label: '数据体检', icon: '⚙', tag: '新' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <div className="sb-nav">
      {NAV.map((n, i) =>
        'group' in n ? (
          <div className="sb-group" key={i}>{n.group}</div>
        ) : (
          <Link key={n.href} href={n.href} className={`sb-item ${path === n.href ? 'on' : ''}`}>
            <span className="ic">{n.icon}</span>
            {n.label}
            {n.tag && <span className="tag">{n.tag}</span>}
          </Link>
        )
      )}
    </div>
  );
}
