'use client';
import React, { useState, useEffect, useCallback } from 'react';
import Topbar from '../components/Topbar';
import {
  api, Card, CardH, Badge, Empty, Note, Spinner, Modal, Pager, Bars,
  money, pct, int, shortDate,
} from '../components/ui';

const CATS = ['电容', '电阻', '其他IC/元器件', 'LED', '电感', '二三极管', '连接器'];

export default function SearchPage() {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
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
      <Topbar title="智能查询" sub="按型号 / 规格 / 品牌检索物料，或一次查一整张表" />
      <div className="page">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={`btn ${mode === 'single' ? 'primary' : ''}`}
            onClick={() => setMode('single')}>单个查询</button>
          <button className={`btn ${mode === 'batch' ? 'primary' : ''}`}
            onClick={() => setMode('batch')}>批量查询</button>
        </div>

        {mode === 'batch' && <BatchQuery onPick={(pn) => setDetail(pn)} />}

        {mode === 'single' && <>
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
              <b>要一次查一整张表？</b>切到上面的「批量查询」，客户发来的报价单或 BOM 直接拖进去。
              <br />
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
        </>}
      </div>
      {detail && <PartDetail pn={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/* ---------------- 批量查询 ---------------- */
function BatchQuery({ onPick }: { onPick: (pn: string) => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  const [over, setOver] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const runText = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      setRes(await api('/api/parts/batch', { method: 'POST', body: JSON.stringify({ text }) }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const runFile = async (f: File) => {
    setFileName(f.name); setBusy(true); setErr(null); setRes(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/parts/batch', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `查询失败（${r.status}）`);
      setRes(j);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  /** 结果导出成 CSV，直接就能改成报价单发出去 */
  const exportCsv = () => {
    const head = ['型号', '数量', '匹配', '参考成本', '成本来源', '成交均价', '毛利率', '成交次数', '最近成交', '提示'];
    const lines = [head.join(',')];
    for (const r of res.results) {
      lines.push([
        r.pn, r.qty,
        r.part ? (r.matchType === 'partial' ? '模糊' : r.matchType === 'alias' ? '别名' : r.matchType === 'catalog' ? '仅目录' : '精确') : '未找到',
        r.cost ?? '', r.costSource === 'supplier' ? '供应商报价' : r.costSource === 'catalog' ? '目录成本' : '',
        r.shipStats?.avg_price ?? '', r.margin != null ? r.margin.toFixed(1) : '',
        r.shipStats?.ship_count ?? 0, r.shipStats?.last_date ?? '',
        (r.warnings || []).join(' / '),
      ].map((v) => {
        const t = String(v ?? '');
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `批量查询结果_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardH title="一次查一整张表" sub="客户发来的报价单 / BOM，直接丢进来" />
        <div className="card-b">
          <div className={`dropzone ${over ? 'over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) runFile(f); }}>
            <div style={{ fontSize: 22, opacity: .35, marginBottom: 6 }}>↥</div>
            <div style={{ fontSize: 13 }}>{fileName || '拖文件到这里，或点击选择'}</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              支持 .xls / .xlsx / .csv。会自动找出哪一列是型号、哪一列是数量
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.tsv,.txt" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) runFile(f); }} />

          <div className="field" style={{ marginTop: 12 }}>
            <label>或者直接粘贴（一行一个型号；从 Excel 复制多列也行）</label>
            <textarea rows={5} className="mono" style={{ fontSize: 12 }} value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'STM32F103RCT6\t2000\n0603104KB\t100000'} />
          </div>
          <div className="row">
            <button className="btn primary" onClick={runText} disabled={busy || !text.trim()}>
              {busy ? <><span className="spin" /> 查询中…</> : '查询'}
            </button>
            {(text || res) && <button className="btn ghost" onClick={() => {
              setText(''); setRes(null); setErr(null); setFileName('');
            }}>清空</button>}
          </div>
        </div>
      </Card>

      {err && <Note kind="err">{err}</Note>}
      {busy && <Card><div className="card-b"><Spinner text="匹配中…" /></div></Card>}

      {res && (
        <Card>
          <CardH title="查询结果"
            sub={`${res.total} 个型号，命中 ${res.hit}，未找到 ${res.miss}${res.note ? ' · ' + res.note : ''}`}
            right={<button className="btn sm" onClick={exportCsv}>导出 CSV</button>} />
          <div className="card-b flush">
            <div className="table-wrap"><table>
              <thead><tr>
                <th>型号</th><th className="num">数量</th><th>匹配</th>
                <th className="num">参考成本</th><th className="num">成交均价</th>
                <th className="num">毛利率</th><th className="num">成交次数</th><th>提示</th><th></th>
              </tr></thead>
              <tbody>{res.results.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{r.pn}</td>
                  <td className="num">{int(r.qty)}</td>
                  <td>
                    {!r.part ? <Badge kind="red">未找到</Badge>
                      : r.matchType === 'exact' ? <Badge kind="green">精确</Badge>
                      : r.matchType === 'alias' ? <Badge kind="blue">别名</Badge>
                      : r.matchType === 'partial' ? <Badge kind="amber">模糊</Badge>
                      : <Badge kind="gray">仅目录</Badge>}
                  </td>
                  <td className="num mono">{r.cost != null ? money(r.cost) : <span className="muted">—</span>}
                    {r.costSource === 'catalog' && <div className="muted small">目录</div>}</td>
                  <td className="num mono">{r.shipStats?.avg_price != null
                    ? money(r.shipStats.avg_price) : <span className="muted">—</span>}</td>
                  <td className="num">{r.margin != null
                    ? <b className={r.margin < 15 ? 'down' : 'up'}>{pct(r.margin)}</b>
                    : <span className="muted">—</span>}</td>
                  <td className="num muted">{int(r.shipStats?.ship_count || 0)}</td>
                  <td className="small muted" style={{ maxWidth: 220 }}>{(r.warnings || []).join('；')}</td>
                  <td>{r.part && <button className="btn sm" onClick={() => onPick(r.part.pn)}>详情</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        </Card>
      )}
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
          {/* 报价时真正要看的就两个数：进价多少、以前卖多少。
              其余字段（规格、分类、库存…）常年是空的，占着最显眼的位置反而碍事，
              所以放到下面，而且空的直接不显示。 */}
          <div className="grid g3" style={{ gap: 12, marginBottom: 8 }}>
            <div>
              <div className="stat-l">参考成本</div>
              <div className="stat mono" style={{ fontSize: 24 }}>{money(d.cost)}</div>
              <div className="muted small" style={{ marginTop: 2 }}>
                {d.costSource === 'supplier'
                  ? `${d.supplierQuotes?.length || 1} 家供应商里最低的一家`
                  : d.costSource === 'catalog' ? 'ERP 目录成本（非实时）' : '无成本数据'}
              </div>
            </div>
            <div>
              <div className="stat-l">成交均价</div>
              <div className="stat mono" style={{ fontSize: 24 }}>{money(d.part.avg_price)}</div>
              <div className="muted small" style={{ marginTop: 2 }}>
                {d.part.ship_count > 0
                  ? `${int(d.part.ship_count)} 次成交，已剔除零价记录`
                  : '从未成交过'}
              </div>
            </div>
            <div>
              <div className="stat-l">毛利率</div>
              <div className={`stat ${d.margin != null && d.margin > 0 ? 'up' : d.margin != null ? 'down' : ''}`}
                style={{ fontSize: 24 }}>
                {d.margin != null ? `${d.margin.toFixed(1)}%` : '—'}
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>
                {d.cost && d.part.avg_price ? '按上面两个数算的' : '缺成本或均价，算不出'}
              </div>
            </div>
          </div>

          {/* 有值才显示，避免满屏「—」 */}
          <dl className="kv" style={{ marginBottom: 14 }}>
            {[
              ['规格', d.part.spec],
              ['分类', d.part.cat],
              ['主要品牌', d.part.brand],
              ['当前库存', Number(d.part.stock_qty) > 0 ? `${int(d.part.stock_qty)} pcs` : null],
              ['ERP 目录成本', d.part.catalog_cost ? money(d.part.catalog_cost) : null],
              ['累计出货', d.part.ship_count > 0
                ? `${int(d.part.ship_qty)} pcs / ${int(d.part.ship_count)} 次` : null],
            ].filter(([, v]) => v !== null && v !== undefined && v !== '')
             .map(([k, v]: any) => (
               <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
             ))}
          </dl>

          {d.warnings?.length > 0 && (
            <Note kind="warn"><b>提示：</b>{d.warnings.join('；')}</Note>
          )}

          {d.aliases?.length > 0 && (
            <div style={{ margin: '14px 0' }}>
              <div className="muted small" style={{ marginBottom: 5 }}>已合并的历史型号（仍可搜索到）</div>
              {d.aliases.map((a: any) => <span key={a.alias} className="chip mono">{a.alias}</span>)}
            </div>
          )}

          {d.priceTrend?.length === 1 && (
            <Note>只有 {d.priceTrend[0].ym} 一个月有成交记录，画不出走势。</Note>
          )}
          {d.priceTrend?.length > 1 && (
            <Card style={{ margin: '14px 0' }}>
              <CardH title="成交价走势"
                sub={`${d.priceTrend[0].ym} ~ ${d.priceTrend[d.priceTrend.length - 1].ym}，共 ${d.priceTrend.length} 个有成交的月份`} />
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
                    {d.supplierQuotes?.some((x: any) => x.lead_time_days)
                      && <th className="num">交期</th>}
                    <th>报价日期</th><th></th></tr></thead>
                  <tbody>{d.supplierQuotes.map((s: any, i: number) => (
                    <tr key={s.supplier_id}>
                      <td>{s.supplier_name}{i === 0 && !s.expired && <> <Badge kind="green">最优</Badge></>}</td>
                      <td className="num mono">{money(s.price)}</td>
                      <td className="num">{s.moq || '—'}</td>
                      {d.supplierQuotes?.some((x: any) => x.lead_time_days)
                        && <td className="num">{s.lead_time_days ? `${s.lead_time_days} 天` : '—'}</td>}
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
