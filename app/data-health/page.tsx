'use client';
import { useState, useEffect } from 'react';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, CardH, Badge, Empty, Note, Spinner,
  money, pct, int, shortDate,
} from '../components/ui';

export default function DataHealthPage() {
  const [tab, setTab] = useState<'dup' | 'price' | 'merge'>('dup');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(() => api('/api/data-health'), []);
  // 「这些数字是什么时候的」必须写出来。不写的话，导完数据过来看见数字没变，
  // 根本分不清是「数据没进去」还是「页面没刷新」—— 这两件事的处理方式完全不同。
  const [at, setAt] = useState<string>('');
  useEffect(() => { if (data) setAt(new Date().toLocaleTimeString('zh-CN')); }, [data]);

  const mergeAll = async () => {
    setBusy(true); setMsg(null);
    try {
      const r: any = await api('/api/parts/merge', { method: 'POST', body: JSON.stringify({ all: true }) });
      setMsg(r.merged ? `已合并 ${r.merged} 条重复记录（批次 ${r.batch}），可在「合并批次」页签撤销` : '没有需要合并的重复型号');
      reload();
    } catch (e: any) { setMsg('合并失败：' + e.message); } finally { setBusy(false); }
  };

  const undo = async (batch: string) => {
    setBusy(true); setMsg(null);
    try {
      const r: any = await api('/api/parts/merge', { method: 'DELETE', body: JSON.stringify({ batch }) });
      setMsg(`已撤销 ${r.reverted} 条合并`);
      reload();
    } catch (e: any) { setMsg('撤销失败：' + e.message); } finally { setBusy(false); }
  };

  const o = data?.overview || {};
  const dups: any[] = data?.duplicateGroups || [];
  const bad: any[] = data?.badPriceRows || [];
  const merges: any[] = data?.mergeBatches || [];

  return (
    <>
      <Topbar title="数据体检" sub="重复型号、异常价格与数据完整度" />
      <div className="page">
        <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
          <button className="btn" onClick={() => reload()} disabled={loading || busy}>
            {loading ? <><span className="spin" /> 读取中…</> : '↻ 刷新'}
          </button>
          <span className="muted small">
            {at ? `数据读取于 ${at}` : '尚未读取'}
          </span>
        </div>
        <Note kind="new">
          <b>每次打开或点刷新都会重新扫一遍生产库</b>，不是缓存也不是估算。
          刚导完数据想确认有没有进去，点一下「刷新」看数字变没变就行。
        </Note>

        {loading && <Card style={{ marginTop: 14 }}><div className="card-b"><Spinner /></div></Card>}
        {error && <Note kind="err">{error}</Note>}
        {msg && <div style={{ marginTop: 14 }}><Note>{msg}</Note></div>}

        {data && (
          <>
            <div className="grid g4" style={{ margin: '14px 0' }}>
              {[
                ['待处理重复组', int(dups.length), dups.length ? '会拆散成交历史' : '已全部合并', dups.length ? 'down' : 'up'],
                ['已合并记录', int(o.parts_merged), `保留 ${int(o.aliases_total)} 个可搜索别名`, ''],
                ['异常价格记录', int(o.shipments_bad_price), '已排除出均价统计', ''],
                ['在库物料', int(o.parts_active), `其中 ${int(o.parts_with_sale)} 个有成交记录`, ''],
              ].map(([l, v, d, tone]: any) => (
                <div className="card" key={l}><div className="card-b">
                  <div className="stat-l">{l}</div>
                  <div className={`stat ${tone}`}>{v}</div>
                  <div className="stat-d muted">{d}</div>
                </div></div>
              ))}
            </div>

            <Card style={{ marginBottom: 14 }}>
              <div className="tabs">
                <button className={tab === 'dup' ? 'on' : ''} onClick={() => setTab('dup')}>
                  重复型号（{dups.length}）</button>
                <button className={tab === 'price' ? 'on' : ''} onClick={() => setTab('price')}>
                  异常价格（{o.shipments_bad_price}）</button>
                <button className={tab === 'merge' ? 'on' : ''} onClick={() => setTab('merge')}>
                  合并批次（{merges.length}）</button>
              </div>

              {tab === 'dup' && (
                <>
                  <div className="card-b">
                    {dups.length ? (
                      <Note kind="warn">
                        <b>问题说明：</b>型号末尾的斜杠和空格没有被清洗，同一个物料在库里存了多条。
                        结果是客户询价时可能命中那条没有成交记录的，
                        本来「出货过」的型号被判成「仅目录价」，报价直接失去历史依据。
                      </Note>
                    ) : (
                      <Note>
                        <b>已全部处理。</b>首批清洗合并了 {int(o.parts_merged)} 条重复记录，
                        旧型号全部保留为别名，客户用老型号照样能搜到。
                        新导入的数据如果再产生重复，会自动出现在这里。
                      </Note>
                    )}
                  </div>
                  {dups.length > 0 && (
                    <>
                      <div className="card-b flush">
                        <div className="table-wrap"><table>
                          <thead><tr><th>归一化型号</th><th>库中变体</th>
                            <th className="num">成交记录</th><th>影响</th></tr></thead>
                          <tbody>{dups.map((d) => (
                            <tr key={d.pn_norm}>
                              <td className="mono"><b>{d.pn_norm}</b></td>
                              <td>{d.variants.split(' | ').map((v: string) => (
                                <span key={v} className="chip mono">{v}</span>))}</td>
                              <td className="num">{d.with_sale} / {d.n} 条有记录</td>
                              <td>{d.with_sale > 0 && d.with_sale < d.n
                                ? <Badge kind="red">查询可能落空</Badge>
                                : <Badge kind="amber">列表重复</Badge>}</td>
                            </tr>
                          ))}</tbody>
                        </table></div>
                      </div>
                      <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
                        <div className="row">
                          <button className="btn primary" onClick={mergeAll} disabled={busy}>
                            {busy ? <><span className="spin" /> 合并中…</> : `合并全部 ${dups.length} 组`}
                          </button>
                          <span className="muted small">
                            合并保留别名，客户仍可用旧型号搜到；本次合并可整批撤销
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {tab === 'price' && (
                <>
                  <div className="card-b">
                    <Note kind="warn">
                      <b>已修正：</b>这些记录单价为 0 或负数。旧版本的报价逻辑直接对全部出货记录取
                      <span className="mono"> avg(unit_price)</span>，没有过滤零值，导致建议报价被系统性拉低。
                      现在它们被标记为 <span className="mono">price_flag=&apos;zero&apos;</span>，
                      保留原始行但不参与任何均价统计。
                    </Note>
                  </div>
                  <div className="card-b flush">
                    {bad.length ? (
                      <div className="table-wrap"><table>
                        <thead><tr><th>型号</th><th>出货日期</th>
                          <th className="num">数量</th><th className="num">单价</th><th>标记</th></tr></thead>
                        <tbody>{bad.map((b) => (
                          <tr key={b.id}>
                            <td className="mono">{b.pn}</td>
                            <td>{b.ship_date}</td>
                            <td className="num">{int(b.quantity)}</td>
                            <td className="num mono">{money(b.unit_price)}</td>
                            <td><Badge kind="gray">{b.price_flag}</Badge></td>
                          </tr>
                        ))}</tbody>
                      </table></div>
                    ) : <Empty icon="✓" text="没有异常价格记录" />}
                  </div>
                </>
              )}

              {tab === 'merge' && (
                <div className="card-b flush">
                  {merges.length ? (
                    <div className="table-wrap"><table>
                      <thead><tr><th>批次</th><th className="num">合并记录</th>
                        <th className="num">搬迁出货</th><th className="num">搬迁报价</th>
                        <th>时间</th><th></th></tr></thead>
                      <tbody>{merges.map((m) => (
                        <tr key={m.merge_batch}>
                          <td className="mono">{m.merge_batch}</td>
                          <td className="num">{int(m.merged_rows)}</td>
                          <td className="num">{int(m.moved_shipments)}</td>
                          <td className="num">{int(m.moved_quotes)}</td>
                          <td className="muted small">{shortDate(m.created_at)}</td>
                          <td>{m.reverted > 0
                            ? <Badge kind="gray">已撤销</Badge>
                            : <button className="btn sm danger" disabled={busy}
                                onClick={() => undo(m.merge_batch)}>撤销</button>}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  ) : <Empty icon="⚙" text="还没有合并记录" />}
                </div>
              )}
            </Card>

            <Card>
              <CardH title="数据完整度" />
              <div className="card-b">
                {data.completeness.map((c: any) => (
                  <div key={c.label} style={{ marginBottom: 13 }}>
                    <div className="row" style={{ marginBottom: 5 }}>
                      <span style={{ fontSize: 12.5 }}>{c.label}</span>
                      <div className="spacer" />
                      <span className="mono muted small">{int(c.a)} / {int(c.b)} · {pct(c.pct)}</span>
                    </div>
                    <div className="bar"><div style={{
                      width: `${c.pct}%`,
                      background: c.pct < 20 ? 'var(--red)' : c.pct < 60 ? 'var(--amber)' : 'var(--green)',
                    }} /></div>
                  </div>
                ))}
                {data.completeness.some((c: any) => c.pct < 5) && (
                  <Note kind="warn">
                    <b>接近 0 的那几项决定了系统的天花板：</b>
                    没有供应商报价，「找哪家买最便宜」答不了；
                    出货记录没有客户，「这个客户买过什么」也答不了。
                    这两块补上之前，系统只能当查价工具，做不了生意闭环 ——
                    去「数据导入」把这两类数据灌进来就行。
                  </Note>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
