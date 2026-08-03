'use client';
import { useState, useEffect, useCallback } from 'react';
import Topbar from '../components/Topbar';
import {
  api, Card, CardH, Badge, Empty, Note, Spinner, Modal, Pager, Bars,
  money, pct, int, shortDate,
} from '../components/ui';

const CATS = ['电容', '电阻', '其他IC/元器件', 'LED', '电感', '二三极管', '连接器'];

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [shipped, setShipped] = useState(false);
  const [sort, setSort] = useState('default');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const run = useCallback(async (p = page) => {
    setLoading(true); setErr(null);
    try {
      const sp = new URLSearchParams({ page: String(p), limit: '50', sort });
      if (q.trim()) sp.set('q', q.trim());
      if (cat) sp.set('cat', cat);
      if (shipped) sp.set('shipped', 'true');
      setRes(await api(`/api/parts/search?${sp}`));
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [q, cat, shipped, sort, page]);

  useEffect(() => { const t = setTimeout(() => { setPage(1); run(1); }, 260); return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat, shipped, sort]);

  return (
    <>
      <Topbar title="智能查询" sub="按型号 / 规格 / 品牌检索物料" />
      <div className="page">
        <Card style={{ marginBottom: 14 }}>
          <div className="card-b">
            <div className="row">
              <input placeholder="输入型号 / 规格 / 品牌，如 STM32、0402 100nF、MURATA"
                style={{ flex: 1, minWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <select style={{ width: 150 }} value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">全部分类</option>
                {CATS.map((c) => <option key={c}>{c}</option>)}
              </select>
              <select style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="default">默认排序</option>
                <option value="freq">出货次数最多</option>
                <option value="recent">最近成交</option>
              </select>
              <label className="inline-label">
                <input type="checkbox" checked={shipped} onChange={(e) => setShipped(e.target.checked)} /> 只看出过货的
              </label>
            </div>
            <Note kind="new">
              <b>本版改动：</b>结果直接带出「成交价区间 / 最近成交 / 供应商最优报价 / 毛利」，
              不必再逐个点开；型号搜索会自动匹配历史别名，合并前的旧型号照样能搜到。
            </Note>
          </div>
        </Card>

        <Card>
          <div className="card-b flush">
            {loading && <div className="card-b"><Spinner /></div>}
            {err && <div className="card-b"><Note kind="err">{err}</Note></div>}
            {!loading && res && (res.parts.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>型号</th><th>规格 / 品牌</th><th>状态</th>
                    <th className="num">成交价区间</th><th className="num">最近成交</th>
                    <th className="num">最优供应商</th><th className="num">毛利</th><th></th>
                  </tr></thead>
                  <tbody>
                    {res.parts.map((p: any) => (
                      <tr key={p.id} className="click" onClick={() => setDetail(p.pn)}>
                        <td className="mono"><b>{p.pn}</b>
                          {p.alias_count > 0 && <span className="muted small"> +{p.alias_count} 别名</span>}
                        </td>
                        <td>{p.spec || '—'}<div className="muted small">{p.brand || ''}</div></td>
                        <td>{p.has_actual_sale
                          ? <Badge kind="green">出货过 {p.ship_count} 次</Badge>
                          : <Badge kind="blue">仅目录价</Badge>}</td>
                        <td className="num mono">
                          {p.min_price ? `${money(p.min_price)} ~ ${money(p.max_price)}` : '—'}
                        </td>
                        <td className="num">
                          {p.last_ship_date
                            ? <><span className="mono">{money(p.avg_price)}</span>
                                <div className="muted small">{shortDate(p.last_ship_date)}</div></>
                            : '—'}
                        </td>
                        <td className="num mono">
                          {p.best_supplier_price
                            ? <>{money(p.best_supplier_price)}
                                <div className="muted small">{p.best_supplier_name}</div></>
                            : <span className="muted">无报价</span>}
                        </td>
                        <td className="num">
                          <b className={p.margin != null && p.margin < 15 ? 'down' : 'up'}>{pct(p.margin)}</b>
                        </td>
                        <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); setDetail(p.pn); }}>详情</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty text="没有匹配的物料" hint="试试只输入型号的一部分" />)}
          </div>
          {res && <Pager page={res.page} pages={res.pages} total={res.total}
            onPage={(p) => { setPage(p); run(p); }} />}
        </Card>
      </div>
      {detail && <PartDetail pn={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function PartDetail({ pn, onClose }: { pn: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api(`/api/parts/${encodeURIComponent(pn)}`).then(setD).catch((e) => setErr(e.message));
  }, [pn]);

  return (
    <Modal title={pn} onClose={onClose}>
      {err && <Note kind="err">{err}</Note>}
      {!d && !err && <Spinner />}
      {d && (
        <>
          <div className="grid g2" style={{ marginBottom: 16 }}>
            <dl className="kv">
              <dt>规格</dt><dd>{d.part.spec || '—'}</dd>
              <dt>分类</dt><dd>{d.part.cat || '—'}</dd>
              <dt>主要品牌</dt><dd>{d.part.brand || '—'}</dd>
              <dt>当前库存</dt><dd>{int(d.part.stock_qty)}</dd>
            </dl>
            <dl className="kv">
              <dt>目录成本</dt><dd className="mono">{money(d.part.catalog_cost)}</dd>
              <dt>参考成本</dt><dd className="mono">{money(d.cost)}
                {d.costSource === 'supplier' && <Badge kind="green">供应商报价</Badge>}</dd>
              <dt>成交均价</dt><dd className="mono">{money(d.part.avg_price)}</dd>
              <dt>累计出货</dt><dd>{int(d.part.ship_qty)} pcs / {d.part.ship_count} 次</dd>
            </dl>
          </div>

          {d.warnings?.length > 0 && (
            <Note kind="warn"><b>提示：</b>{d.warnings.join('；')}</Note>
          )}

          {d.aliases?.length > 0 && (
            <div style={{ margin: '14px 0' }}>
              <div className="muted small" style={{ marginBottom: 5 }}>已合并的历史型号（仍可搜索到）</div>
              {d.aliases.map((a: any) => <span key={a.alias} className="chip mono">{a.alias}</span>)}
            </div>
          )}

          {d.priceTrend?.length > 1 && (
            <Card style={{ margin: '14px 0' }}>
              <CardH title="成交价走势" sub={`近 ${d.priceTrend.length} 个月`} />
              <div className="card-b">
                <Bars data={d.priceTrend.map((t: any) => t.avg_price || 0)} height={90} />
                <div className="row small muted" style={{ marginTop: 8, justifyContent: 'space-between' }}>
                  <span>{d.priceTrend[0].ym}</span>
                  <span>{d.priceTrend[d.priceTrend.length - 1].ym}</span>
                </div>
              </div>
            </Card>
          )}

          <Card style={{ marginBottom: 14 }}>
            <CardH title="供应商报价对比" />
            <div className="card-b flush">
              {d.supplierQuotes?.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>供应商</th><th className="num">单价</th><th className="num">起订</th>
                    <th className="num">交期</th><th>报价日期</th><th></th></tr></thead>
                  <tbody>{d.supplierQuotes.map((s: any, i: number) => (
                    <tr key={s.supplier_id}>
                      <td>{s.supplier_name}{i === 0 && !s.expired && <> <Badge kind="green">最优</Badge></>}</td>
                      <td className="num mono">{money(s.price)}</td>
                      <td className="num">{s.moq || '—'}</td>
                      <td className="num">{s.lead_time_days ? `${s.lead_time_days} 天` : '—'}</td>
                      <td className="muted">{shortDate(s.quoted_at)}</td>
                      <td>{s.expired && <Badge kind="gray">已过期</Badge>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <Empty icon="⬡" text="该型号暂无供应商报价"
                    hint="在「数据导入」里导入供应商报价表后，这里会出现比价" />}
            </div>
          </Card>

          <Card>
            <CardH title="成交历史" sub="最近 30 条" />
            <div className="card-b flush">
              {d.recentShipments?.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>日期</th><th>客户</th><th className="num">数量</th>
                    <th className="num">单价</th><th className="num">毛利</th></tr></thead>
                  <tbody>{d.recentShipments.map((h: any, i: number) => {
                    const m = h.unit_cost && h.unit_price ? ((h.unit_price - h.unit_cost) / h.unit_price) * 100 : null;
                    return (
                      <tr key={i}>
                        <td>{h.ship_date}</td>
                        <td>{h.short_name || h.customer_name || <span className="muted">—</span>}</td>
                        <td className="num">{int(h.quantity)}</td>
                        <td className="num mono">{money(h.unit_price)}
                          {h.price_flag !== 'ok' && <> <Badge kind="gray">零价</Badge></>}</td>
                        <td className="num up">{pct(m)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              ) : <Empty icon="▤" text="暂无成交记录" />}
            </div>
          </Card>
        </>
      )}
    </Modal>
  );
}
