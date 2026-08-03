'use client';
import { useState, useEffect, useCallback } from 'react';

type Supplier = {
  id: number; kind: string; company_name: string; contact_name: string | null; phone: string | null;
  region: string | null; currency: string | null; grade: string | null;
  ship_freq: number | null; ship_qty: number | null; avg_price: string | null; score: string | null;
};

function scoreTag(score: number | null) {
  if (score === null) return <span className="tag outline">数据不足</span>;
  const s = Number(score);
  const label = s >= 80 ? '优选' : s >= 60 ? '良好' : s >= 40 ? '一般' : '观察';
  const cls = s >= 80 ? 'dark' : s >= 40 ? '' : 'outline';
  return <span className={`tag ${cls}`}>评分 {s.toFixed(1)} · {label}</span>;
}

export default function SuppliersPage() {
  const [kind, setKind] = useState<'brand' | 'verified'>('brand');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/suppliers?kind=${kind}&q=${encodeURIComponent(q)}`);
      const data = await resp.json();
      setRows(data.suppliers || []);
    } finally {
      setLoading(false);
    }
  }, [kind, q]);

  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  return (
    <div className="page-inner">
      <div className="page-title">供应商管理</div>
      <div className="page-desc">品牌出货评分（自动计算）+ 认证供应商联系方式</div>
      <div className="page-divider" />
      <div className="toolbar">
        <input className="search-input" style={{ maxWidth: 300 }} placeholder="搜索…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="form-input" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="brand">品牌出货评分</option>
          <option value="verified">认证供应商联系方式</option>
        </select>
      </div>
      {loading && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>加载中…</div>}
      {rows.map((s) => (
        <div key={s.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="mono" style={{ fontWeight: 700 }}>{s.company_name}</span>
            {kind === 'brand' ? scoreTag(s.score ? Number(s.score) : null) : <span className="tag dark">已核实</span>}
          </div>
          {kind === 'brand' ? (
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
              {s.ship_freq} 次出货 · {Number(s.ship_qty).toLocaleString()} pcs {s.avg_price && `· 均价 ¥${Number(s.avg_price).toFixed(4)}`}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6, lineHeight: 1.8 }}>
              {s.contact_name && <>联系人：{s.contact_name}<br /></>}
              {s.phone && <>电话：{s.phone}<br /></>}
              {s.region && <>地区：{s.region}<br /></>}
              {s.currency && <>结算币种：{s.currency}</>}
            </div>
          )}
        </div>
      ))}
      {!loading && rows.length === 0 && <div className="empty">没有数据</div>}
      {kind === 'brand' && rows.every((r) => !r.score) && rows.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
          评分显示"数据不足"？需要先运行一次评分计算：<code className="mono">POST /api/suppliers/recalc-score</code>（部署后跑一次即可，见 DEPLOY.md）
        </div>
      )}
    </div>
  );
}
