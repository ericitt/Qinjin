'use client';
import { useState, useCallback, useEffect } from 'react';
import Topbar from '../components/Topbar';
import {
  api, Card, CardH, Badge, Stat, Empty, Note, Spinner, Pager,
  money, pct, int, shortDate, OUTCOME_LABEL,
} from '../components/ui';

const OUTCOMES = ['draft', 'quoted', 'pending', 'won', 'lost'];

export default function InquiriesPage() {
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (p = 1, o = outcome) => {
    setLoading(true); setErr(null);
    try {
      const sp = new URLSearchParams({ page: String(p), limit: '50' });
      if (o) sp.set('outcome', o);
      setD(await api(`/api/inquiries?${sp}`));
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [outcome]);

  useEffect(() => { load(1, outcome); setPage(1); }, [outcome, load]);

  const setResult = async (id: number, o: string) => {
    await api('/api/inquiries', { method: 'PATCH', body: JSON.stringify({ id, outcome: o }) });
    load(page, outcome);
  };

  const m = d?.monthly || {};
  return (
    <>
      <Topbar title="询价记录" sub="历史询价单与成交追踪" />
      <div className="page">
        <Note kind="new">
          <b>新页面：</b>以前每次 AI 询价的结果只写进数据库，前端没有任何地方能看回来，
          更无法追踪是否成交。没有这一层，转化率和报价准确度都无从谈起。
        </Note>

        <div className="grid g4" style={{ margin: '14px 0' }}>
          <Stat label="本月询价" value={int(m.total)} />
          <Stat label="已成交" value={int(m.won)} />
          <Stat label="成交率" value={m.winRate == null ? '—' : pct(m.winRate)} />
          <Stat label="平均毛利" value={m.avg_margin == null ? '—' : pct(m.avg_margin)} />
        </div>

        <Card>
          <CardH title="询价单" right={
            <select style={{ width: 140 }} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">全部状态</option>
              {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o].text}</option>)}
            </select>
          } />
          <div className="card-b flush">
            {loading && <div className="card-b"><Spinner /></div>}
            {err && <div className="card-b"><Note kind="err">{err}</Note></div>}
            {!loading && d && (d.inquiries.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>单号</th><th>日期</th><th>客户</th>
                    <th className="num">行数</th><th className="num">匹配率</th>
                    <th className="num">金额</th><th className="num">毛利</th>
                    <th>状态</th><th>负责人</th><th>标记结果</th>
                  </tr></thead>
                  <tbody>
                    {d.inquiries.map((q: any) => {
                      const o = OUTCOME_LABEL[q.outcome] || OUTCOME_LABEL.draft;
                      return (
                        <tr key={q.id}>
                          <td className="mono"><b>{q.quote_no || `#${q.id}`}</b></td>
                          <td>{shortDate(q.created_at)}</td>
                          <td>{q.short_name || q.customer_name || <span className="muted">未指定</span>}</td>
                          <td className="num">{q.line_count}</td>
                          <td className="num">{q.line_count ? pct((q.matched_count / q.line_count) * 100) : '—'}</td>
                          <td className="num mono">{money(q.total_amount)}</td>
                          <td className="num">{pct(q.margin_pct)}</td>
                          <td><Badge kind={o.kind}>{o.text}</Badge></td>
                          <td className="muted">{q.submitted_by || '—'}</td>
                          <td>
                            <div className="row" style={{ gap: 5 }}>
                              <button className="btn sm" onClick={() => setResult(q.id, 'won')}>成交</button>
                              <button className="btn sm" onClick={() => setResult(q.id, 'lost')}>流失</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon="☰" text="还没有询价记录" hint="去 AI 询价助手确认第一单" />)}
          </div>
          {d && <Pager page={d.page} pages={Math.ceil(d.total / d.limit)} total={d.total}
            onPage={(p) => { setPage(p); load(p, outcome); }} />}
        </Card>
      </div>
    </>
  );
}
