'use client';
import React from 'react';

/* ---------- 格式化 ---------- */
export const fmt = (n: any, d = 2): string => {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const money = (n: any): string => {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return '￥' + fmt(v, Math.abs(v) < 1 && v !== 0 ? 4 : 2);
};
export const pct = (n: any): string => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : fmt(n, 1) + '%');
export const int = (n: any): string => fmt(n, 0);
export const shortDate = (s?: string | null) => (s ? s.slice(0, 10) : '—');

/* ---------- 原子组件 ---------- */
export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="card" style={style}>{children}</div>;
}
export function CardH({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="card-h">
      <h3>{title}</h3>
      {sub && <span className="sub">{sub}</span>}
      {right && <><div className="spacer" />{right}</>}
    </div>
  );
}
export function Stat({ label, value, delta, tone }: { label: string; value: React.ReactNode; delta?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="card"><div className="card-b">
      <div className="stat-l">{label}</div>
      <div className={`stat ${tone || ''}`}>{value}</div>
      {delta && <div className={`stat-d ${tone || 'muted'}`}>{delta}</div>}
    </div></div>
  );
}
export function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`badge b-${kind}`}>{children}</span>;
}
export function Empty({ icon = '⌕', text, hint }: { icon?: string; text: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>{text}
      {hint && <div className="small" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}
export function Note({ kind, children }: { kind?: 'warn' | 'err' | 'new'; children: React.ReactNode }) {
  return <div className={`note ${kind || ''}`}>{children}</div>;
}
export function Spinner({ text }: { text?: string }) {
  return <span className="muted"><span className="spin" /> {text || '加载中…'}</span>;
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-h">
          <h3>{title}</h3><div className="spacer" />
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-b">{children}</div>
      </div>
    </div>
  );
}
export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="card-b" style={{ borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="muted small">共 {int(total)} 条 · 第 {page} / {Math.max(pages, 1)} 页</span>
      <div className="spacer" />
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>← 上一页</button>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页 →</button>
    </div>
  );
}
export function Bars({ data, height = 30 }: { data: number[]; height?: number }) {
  const max = Math.max(...data, 1);
  return (
    <div className="sparkline" style={{ height }}>
      {data.map((v, i) => (
        <i key={i} className={i === data.length - 1 ? 'last' : ''} style={{ height: `${(v / max) * 100}%` }} />
      ))}
    </div>
  );
}

/* ---------- 匹配类型标签 ---------- */
export const MATCH_LABEL: Record<string, { text: string; kind: string }> = {
  exact:   { text: '出货过',   kind: 'green' },
  alias:   { text: '历史别名', kind: 'purple' },
  catalog: { text: '目录价',   kind: 'blue' },
  partial: { text: '模糊命中', kind: 'amber' },
  none:    { text: '未找到',   kind: 'red' },
};
export const OUTCOME_LABEL: Record<string, { text: string; kind: string }> = {
  draft:   { text: '草稿',   kind: 'gray' },
  quoted:  { text: '已报价', kind: 'blue' },
  pending: { text: '待确认', kind: 'amber' },
  won:     { text: '已成交', kind: 'green' },
  lost:    { text: '已流失', kind: 'red' },
};

/* ---------- fetch 封装 ---------- */
export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  // 登录过期时后端返回 401，直接送回登录页，不要让用户对着「请求失败」发懵
  if (r.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
    throw new Error('登录已过期');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `请求失败 (${r.status})`);
  return j as T;
}

export function useAsync<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const reload = React.useCallback(() => {
    setLoading(true); setError(null);
    fn().then((d) => setData(d)).catch((e) => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload, setData };
}
