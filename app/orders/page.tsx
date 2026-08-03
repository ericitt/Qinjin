'use client';
import { useState, useEffect, useCallback } from 'react';

type Row = {
  id: number; pn: string; spec: string | null; cat: string | null; brand: string | null;
  ship_count: number; total_qty: number; avg_price: number | null;
};

export default function OrdersPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/parts/search?q=${encodeURIComponent(query)}&shipped=true&sort=freq&limit=100`);
      const data = await resp.json();
      setRows(data.parts || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const t = setTimeout(() => load(q), 250); return () => clearTimeout(t); }, [q, load]);

  return (
    <div className="page-inner">
      <div className="page-title">出货明细</div>
      <div className="page-desc">按出货频次排序，实时数据库查询</div>
      <div className="page-divider" />
      <input className="search-input" style={{ maxWidth: 400, marginBottom: 16 }} placeholder="搜索型号、描述、品牌…" value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>加载中…</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>型号</th><th>描述</th><th>分类</th><th>品牌</th><th style={{ textAlign: 'center' }}>出货次数</th><th style={{ textAlign: 'right' }}>累计量</th><th style={{ textAlign: 'right' }}>均价</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.pn}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 260 }}>{r.spec?.slice(0, 50)}</td>
                <td><span className="tag">{r.cat}</span></td>
                <td style={{ fontSize: 12 }}>{r.brand}</td>
                <td style={{ textAlign: 'center' }} className="mono">{r.ship_count}</td>
                <td style={{ textAlign: 'right' }} className="mono">{Math.round(r.total_qty).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }} className="mono">{r.avg_price ? `¥${Number(r.avg_price).toFixed(4)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && <div className="empty">没有数据</div>}
    </div>
  );
}
