'use client';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

type Item = { group: string } | { href: string; label: string; icon: string; tag?: string; needsAI?: boolean };

const NAV: Item[] = [
  { group: '日常' },
  { href: '/', label: '工作台', icon: '◈' },
  { href: '/search', label: '智能查询', icon: '⌕' },
  // AI 询价依赖外部大模型服务，没配密钥时整条隐藏（needsAI）
  { href: '/bom', label: 'AI 询价助手', icon: '✦', needsAI: true },
  { href: '/inquiries', label: '询价记录', icon: '☰' },
  { group: '数据' },
  { href: '/orders', label: '出货明细', icon: '▤' },
  { href: '/customers', label: '客户管理', icon: '◉' },
  { href: '/suppliers', label: '供应商', icon: '⬡' },
  { href: '/opportunities', label: '商机', icon: '◎', tag: '新' },
  { group: '维护' },
  { href: '/import', label: '数据导入', icon: '↥' },
  { href: '/data-health', label: '数据体检', icon: '⚙' },
];

export default function Nav({ aiEnabled = false, onNavigate }: { aiEnabled?: boolean; onNavigate?: () => void }) {
  const path = usePathname();

  // 先过滤掉用不了的条目，再去掉因此变空的分组标题
  const items = NAV.filter((n) => ('group' in n ? true : !n.needsAI || aiEnabled));
  const visible = items.filter((n, i) => {
    if (!('group' in n)) return true;
    const next = items[i + 1];
    return next !== undefined && !('group' in next);
  });

  return (
    <div className="sb-nav">
      {visible.map((n, i) =>
        'group' in n ? (
          <div className="sb-group" key={'g' + i}>{n.group}</div>
        ) : (
          <Link key={n.href} href={n.href} onClick={onNavigate}
                className={`sb-item ${path === n.href ? 'on' : ''}`}>
            <span className="ic">{n.icon}</span>
            {n.label}
            {n.tag && <span className="tag">{n.tag}</span>}
          </Link>
        )
      )}
    </div>
  );
}
