'use client';
import { useState, useEffect, useCallback } from 'react';

type Part = {
  id: number;
  pn: string;
  spec: string | null;
  cat: string | null;
  brand: string | null;
  stock_qty: string | null;
  catalog_cost: string | null;
  standard_price: string | null;
  has_actual_sale: boolean;
};

type DetailResult = {
  part: Part;
  shipStats: { ship_count: number; total_qty: number; avg_price: number | null; min_price: number | null; max_price: number | null; last_date: string | null } | null;
  unitPrice: number | null;
  cost: number | null;
  margin: number | null;
  bomInfo: { driver_model: string; designator: string | null; qty_per_unit: number; alt_pns: string[] | null }[];
  recentShipments: { ship_date: string; quantity: string; unit_price: string }[];
  supplierQuotes: { company_name: string; grade: string | null; phone: string | null; contact_name: string | null; price: string }[];
};

export default function HomePage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Part[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const resp = await fetch(`/api/parts/search?q=${encodeURIComponent(query)}&limit=100`);
      const data = await resp.json();
      setResults(data.parts || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(q), 250); // 简单防抖，别每敲一个字就打一次库
    return () => clearTimeout(t);
  }, [q, doSearch]);

  async function openDetail(pn: string) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const resp = await fetch(`/api/parts/${encodeURIComponent(pn)}`);
      const data = await resp.json();
      if (data.part) setDetail(data);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="page-inner">
      <div className="page-title">客户询价快查</div>
      <div className="page-desc">实时查询数据库 — 不再是导出快照，随时都是最新数据</div>
      <div className="page-divider" />

      <input
        className="search-input"
        style={{ maxWidth: 480, marginBottom: 20 }}
        placeholder="输入型号、规格或品牌…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      {loading && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>查询中…</div>}

      {!loading && q && results.length === 0 && <div className="empty">未找到"{q}"相关物料</div>}

      <div style={{ display: 'grid', gridTemplateColumns: detail ? '1fr 1fr' : '1fr', gap: 20 }}>
        <div>
          {results.map((p) => (
            <div key={p.id} className="card" style={{ cursor: 'pointer' }} onClick={() => openDetail(p.pn)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>{p.pn}</span>
                    {p.cat && <span className="tag">{p.cat}</span>}
                    {p.brand && <span className="tag">{p.brand}</span>}
                    {!p.has_actual_sale && <span className="tag outline">目录参考价·未出货过</span>}
                    {p.stock_qty && Number(p.stock_qty) > 0 && <span className="tag dark">现货 {Math.round(Number(p.stock_qty)).toLocaleString()}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{p.spec}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>
                    {p.standard_price && Number(p.standard_price) > 0 ? `¥${Number(p.standard_price).toFixed(4)}` : '—'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>参考价</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {detail && (
          <div className="card" style={{ position: 'sticky', top: 20, alignSelf: 'flex-start' }}>
            {detailLoading ? (
              <div className="empty">加载中…</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{detail.part.pn}</span>
                  <button className="btn" onClick={() => setDetail(null)}>✕</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 16px' }}>{detail.part.spec}</div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                  <Stat label="成本参考" value={detail.cost ? `¥${detail.cost.toFixed(4)}` : '—'} />
                  <Stat label="对比价格" value={detail.unitPrice ? `¥${detail.unitPrice.toFixed(4)}` : '—'} />
                  <Stat label="估算毛利率" value={detail.margin !== null ? `${detail.margin.toFixed(1)}%` : '—'} warn={detail.margin !== null && detail.margin < 15} />
                  <Stat label="当前库存" value={detail.part.stock_qty && Number(detail.part.stock_qty) > 0 ? `${Math.round(Number(detail.part.stock_qty)).toLocaleString()} pcs` : '0'} />
                </div>

                {detail.shipStats && (
                  <>
                    <SectionTitle>出货历史</SectionTitle>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                      <Stat label="出货次数" value={String(detail.shipStats.ship_count)} />
                      <Stat label="累计出货量" value={`${Math.round(detail.shipStats.total_qty).toLocaleString()} pcs`} />
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>日期</th><th style={{ textAlign: 'right' }}>数量</th><th style={{ textAlign: 'right' }}>单价</th></tr></thead>
                        <tbody>
                          {detail.recentShipments.map((h, i) => (
                            <tr key={i}>
                              <td className="mono">{h.ship_date}</td>
                              <td style={{ textAlign: 'right' }} className="mono">{Number(h.quantity).toLocaleString()}</td>
                              <td style={{ textAlign: 'right' }} className="mono">¥{Number(h.unit_price)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {detail.bomInfo.length > 0 && (
                  <>
                    <SectionTitle>BOM 归属</SectionTitle>
                    {detail.bomInfo.map((b, i) => (
                      <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                        <span className="mono">{b.driver_model}</span> · {b.designator} · 单套 {b.qty_per_unit} 颗
                        {b.alt_pns && b.alt_pns.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            替代料：{b.alt_pns.map((a) => (
                              <span key={a} className="tag" style={{ marginRight: 4, cursor: 'pointer' }} onClick={() => { setQ(a); openDetail(a); }}>{a}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}

                {detail.supplierQuotes.length > 0 && (
                  <>
                    <SectionTitle>供应商报价</SectionTitle>
                    {detail.supplierQuotes.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                        <span>{s.company_name} {s.grade && <span className="tag">{s.grade}级</span>}</span>
                        <span className="mono" style={{ fontWeight: 700 }}>¥{Number(s.price).toFixed(4)}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--text3)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: warn ? '#a00' : 'var(--text)' }}>{value}</div>
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: .6, margin: '14px 0 8px', paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>{children}</div>;
}
