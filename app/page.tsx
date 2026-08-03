'use client';
import Link from 'next/link';
import Topbar from './components/Topbar';
import {
  api, useAsync, Card, CardH, Stat, Badge, Bars, Spinner, Empty, Note,
  money, pct, int, OUTCOME_LABEL,
} from './components/ui';

export default function Home() {
  const { data, loading, error } = useAsync(() => api('/api/dashboard'), []);

  return (
    <>
      <Topbar title="工作台" sub="今日概览" />
      <div className="page">
        {loading && <Card><div className="card-b"><Spinner /></div></Card>}
        {error && <Note kind="err">加载失败：{error}</Note>}
        {data && <Body d={data} />}
      </div>
    </>
  );
}

function Body({ d }: { d: any }) {
  const k = d.kpi || {};
  const t = d.todos || {};
  const rev: any[] = d.revenueTrend || [];
  const mq: any[] = d.matchQuality || [];
  const mqTotal = mq.reduce((s, x) => s + x.n, 0);

  const MQ_ORDER = [
    { k: 'exact', label: '出货过', color: 'var(--green)' },
    { k: 'alias', label: '历史别名', color: 'var(--purple)' },
    { k: 'catalog', label: '目录价', color: 'var(--blue)' },
    { k: 'partial', label: '模糊命中', color: 'var(--amber)' },
    { k: 'none', label: '未找到', color: 'var(--red)' },
  ];

  const noTodo = !t.dup_groups && !t.parts_no_quote && !t.ship_no_customer && !t.bad_price && !t.stale_quotes;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label="本月询价单" value={int(k.inq_month)}
          delta={k.inqDelta === 0 ? '与上月持平' : `较上月 ${k.inqDelta > 0 ? '+' : ''}${k.inqDelta}`}
          tone={k.inqDelta > 0 ? 'up' : k.inqDelta < 0 ? 'down' : undefined} />
        <Stat label="本月成交率" value={k.winRate === null || k.winRate === undefined ? '—' : pct(k.winRate)}
          delta={`已结案 ${int(k.closed_month)} 单`} />
        <Stat label="本月毛利率" value={k.margin_month === null || k.margin_month === undefined ? '—' : pct(k.margin_month)}
          delta="按已确认报价单统计" />
        <Stat label="进行中询价" value={int(k.open_inq)}
          delta={t.stale_quotes > 0 ? `${t.stale_quotes} 单超 3 天未跟进` : '均在跟进中'}
          tone={t.stale_quotes > 0 ? 'down' : undefined} />
      </div>

      <div className="grid g2" style={{ marginBottom: 14 }}>
        <Card>
          <CardH title="近半年成交金额" sub="仅统计有效价格记录" />
          <div className="card-b">
            {rev.length ? (
              <>
                <Bars data={rev.map((r) => r.amount || 0)} height={110} />
                <div className="row small muted" style={{ marginTop: 8, justifyContent: 'space-between' }}>
                  {rev.map((r) => <span key={r.ym}>{r.ym.slice(5)}月</span>)}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="muted small">最近一月</span>
                  <b className="mono">{money(rev[rev.length - 1]?.amount)}</b>
                </div>
              </>
            ) : <Empty icon="▤" text="暂无出货数据" />}
          </div>
        </Card>

        <Card>
          <CardH title="询价匹配质量" sub="近 90 天" />
          <div className="card-b">
            {mqTotal ? MQ_ORDER.map((o) => {
              const n = mq.find((x) => x.match_type === o.k)?.n || 0;
              const p = (n / mqTotal) * 100;
              return (
                <div key={o.k} style={{ marginBottom: 11 }}>
                  <div className="row small" style={{ marginBottom: 4 }}>
                    <span>{o.label}</span><div className="spacer" />
                    <span className="mono muted">{n} · {pct(p)}</span>
                  </div>
                  <div className="bar"><div style={{ width: `${p}%`, background: o.color }} /></div>
                </div>
              );
            }) : <Empty icon="✦" text="还没有确认过的询价单" hint="在 AI 询价助手里确认一单后，这里开始统计" />}
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card>
          <CardH title="待办" />
          <div className="card-b flush">
            <div className="table-wrap"><table><tbody>
              {t.dup_groups > 0 && (
                <tr><td><Badge kind="red">数据</Badge></td>
                  <td>检测到 {t.dup_groups} 组重复型号，会拆散成交历史</td>
                  <td className="num"><Link href="/data-health" className="btn sm">去处理</Link></td></tr>
              )}
              {t.parts_no_quote > 0 && (
                <tr><td><Badge kind="amber">报价</Badge></td>
                  <td>{int(t.parts_no_quote)} 个物料没有任何供应商报价</td>
                  <td className="num"><Link href="/import" className="btn sm">去导入</Link></td></tr>
              )}
              {t.ship_no_customer > 0 && (
                <tr><td><Badge kind="blue">客户</Badge></td>
                  <td>{int(t.ship_no_customer)} 条出货记录还没关联客户</td>
                  <td className="num"><Link href="/import" className="btn sm">去补全</Link></td></tr>
              )}
              {t.bad_price > 0 && (
                <tr><td><Badge kind="gray">价格</Badge></td>
                  <td>{t.bad_price} 条零价出货记录已排除出均价统计</td>
                  <td className="num"><Link href="/data-health" className="btn sm">查看</Link></td></tr>
              )}
              {t.stale_quotes > 0 && (
                <tr><td><Badge kind="amber">跟进</Badge></td>
                  <td>{t.stale_quotes} 张报价单超过 3 天没有结果</td>
                  <td className="num"><Link href="/inquiries" className="btn sm">去跟进</Link></td></tr>
              )}
              {noTodo && (
                <tr><td colSpan={3}><div className="empty" style={{ padding: 28 }}>暂时没有待办</div></td></tr>
              )}
            </tbody></table></div>
          </div>
        </Card>

        <Card>
          <CardH title="最近询价" right={<Link href="/inquiries" className="btn sm ghost">全部 →</Link>} />
          <div className="card-b flush">
            {d.recentInquiries?.length ? (
              <div className="table-wrap"><table><tbody>
                {d.recentInquiries.map((q: any) => {
                  const o = OUTCOME_LABEL[q.outcome] || OUTCOME_LABEL.draft;
                  return (
                    <tr key={q.id}>
                      <td className="mono">{q.quote_no || `#${q.id}`}</td>
                      <td>{q.customer || <span className="muted">未指定客户</span>}</td>
                      <td className="num">{q.line_count} 项</td>
                      <td className="num mono">{money(q.total_amount)}</td>
                      <td><Badge kind={o.kind}>{o.text}</Badge></td>
                    </tr>
                  );
                })}
              </tbody></table></div>
            ) : <Empty icon="☰" text="还没有询价记录" hint="去 AI 询价助手处理第一单" />}
          </div>
        </Card>
      </div>
    </>
  );
}
