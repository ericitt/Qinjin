'use client';
import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Topbar from '../components/Topbar';
import {
  api, Card, Badge, Empty, Note, Spinner, Pager, Stat,
  money, pct, int,
} from '../components/ui';

// useSearchParams 要求包在 Suspense 里，否则整页会退化成动态渲染并报警告
export default function OrdersPage() {
  return (
    <Suspense fallback={<><Topbar title="出货明细" sub="历史出货流水" /><div className="page"><Spinner /></div></>}>
      <Orders />
    </Suspense>
  );
}

function Orders() {
  const sp = useSearchParams();
  const [q, setQ] = useState('');
  // 从客户页点「采购记录」跳过来时带着 ?customer=<id>，之前这个参数被忽略了
  const [customerId, setCustomerId] = useState(sp.get('customer') || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [customers, setCustomers] = useState<any[]>([]);
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api('/api/customers').then((r: any) => setCustomers(r.customers || [])).catch(() => {}); }, []);

  const load = useCallback(async (p = 1) => {
    setLoading(true); setErr(null);
    try {
      const sp = new URLSearchParams({ page: String(p), limit: '50' });
      if (q.trim()) sp.set('q', q.trim());
      if (customerId) sp.set('customer_id', customerId);
      if (from) sp.set('from', from);
      if (to) sp.set('to', to);
      setD(await api(`/api/shipments?${sp}`));
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [q, customerId, from, to]);

  useEffect(() => { const t = setTimeout(() => { setPage(1); load(1); }, 250); return () => clearTimeout(t); }, [load]);

  const exportCsv = () => {
    if (!d?.shipments?.length) return;
    const rows = [['出货日期', '客户', '型号', '规格', '数量', '单价', '金额', '成本']];
    for (const s of d.shipments) {
      rows.push([s.ship_date, s.customer || '', s.pn, s.spec || '',
        String(s.quantity), String(s.unit_price), String(s.amount), String(s.unit_cost ?? '')]);
    }
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `出货明细_第${page}页.csv`;
    a.click();
  };

  const sm = d?.summary || {};
  return (
    <>
      <Topbar title="出货明细" sub="历史出货流水" />
      <div className="page">
        <Card style={{ marginBottom: 14 }}>
          <div className="card-b">
            <div className="row">
              <input placeholder="搜索型号或客户" style={{ flex: 1, minWidth: 200 }}
                value={q} onChange={(e) => setQ(e.target.value)} />
              <select style={{ width: 170 }} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">全部客户</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
              </select>
              <input type="date" style={{ width: 150 }} value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="muted">至</span>
              <input type="date" style={{ width: 150 }} value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="btn" onClick={exportCsv}>↧ 导出本页</button>
            </div>
            {customers.length === 0 && (
              <Note kind="new">
                <b>客户维度已就位。</b>旧表结构里 shipments 根本没有客户字段，
                所以“这个客户买过什么”答不了。现在字段已经加好，
                在「数据导入」里带客户列重新导一次出货流水，这里就能按客户筛选了。
              </Note>
            )}
          </div>
        </Card>

        {d && (
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Stat label="筛选结果" value={int(d.total) + ' 条'} />
            <Stat label="成交金额" value={money(sm.amount)} />
            <Stat label="成本合计" value={money(sm.cost)} />
            <Stat label="毛利率" value={sm.margin == null ? '—' : pct(sm.margin)}
              delta={sm.cost_coverage != null && sm.cost_coverage < 95
                ? `仅 ${pct(sm.cost_coverage)} 的行有成本` : undefined}
              tone={sm.margin != null && sm.margin < 15 ? 'down' : 'up'} />
          </div>
        )}

        <Card>
          <div className="card-b flush">
            {loading && <div className="card-b"><Spinner /></div>}
            {err && <div className="card-b"><Note kind="err">{err}</Note></div>}
            {!loading && d && (d.shipments.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>出货日期</th><th>客户</th><th>型号</th><th>规格</th>
                    <th className="num">数量</th><th className="num">单价</th>
                    <th className="num">金额</th><th className="num">成本</th><th className="num">毛利</th>
                  </tr></thead>
                  <tbody>
                    {d.shipments.map((s: any) => {
                      const m = s.unit_cost && s.unit_price ? ((s.unit_price - s.unit_cost) / s.unit_price) * 100 : null;
                      return (
                        <tr key={s.id}>
                          <td>{s.ship_date}</td>
                          <td>{s.customer || <span className="muted">—</span>}</td>
                          <td className="mono">{s.pn}</td>
                          <td className="muted small">{s.spec || '—'}</td>
                          <td className="num">{int(s.quantity)}</td>
                          <td className="num mono">{money(s.unit_price)}
                            {s.price_flag !== 'ok' && <> <Badge kind="gray">零价</Badge></>}</td>
                          <td className="num mono">{money(s.amount)}</td>
                          <td className="num mono muted">{money(s.unit_cost)}</td>
                          <td className="num up">{pct(m)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon="▤" text="没有符合条件的出货记录" />)}
          </div>
          {d && <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => { setPage(p); load(p); }} />}
        </Card>
      </div>
    </>
  );
}
