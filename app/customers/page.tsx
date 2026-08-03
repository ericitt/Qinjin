'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, CardH, Badge, Empty, Note, Spinner, Modal, Bars,
  money, pct, int, shortDate,
} from '../components/ui';

export default function CustomersPage() {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => api(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q]);

  const list: any[] = data?.customers || [];

  return (
    <>
      <Topbar title="客户管理" sub="客户档案与采购行为" />
      <div className="page">
        <Note kind="new">
          <b>新模块：</b>客户是这个业务里唯一缺失的核心实体。加上它之后，
          报价才能因客而异，也才能回答“这个客户今年买了多少、毛利如何、报过哪些没成交”。
        </Note>

        <Card style={{ margin: '14px 0' }}>
          <div className="card-b">
            <div className="row">
              <input placeholder="搜索客户名称或简称" style={{ flex: 1, minWidth: 220 }}
                value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn primary" onClick={() => setAdding(true)}>+ 新增客户</button>
            </div>
          </div>
        </Card>

        {loading && <Card><div className="card-b"><Spinner /></div></Card>}
        {error && <Note kind="err">{error}</Note>}

        {!loading && (list.length ? (
          <div className="grid g3">
            {list.map((c) => (
              <Card key={c.id}>
                <div className="card-b">
                  <div style={{ marginBottom: 10 }}>
                    <b style={{ fontSize: 14 }}>{c.short_name || c.name}</b>
                    {c.level && <> <Badge kind={c.level === 'A' ? 'green' : c.level === 'B' ? 'blue' : 'gray'}>{c.level} 类</Badge></>}
                    <div className="muted small" style={{ marginTop: 2 }}>{c.name}</div>
                  </div>
                  <dl className="kv" style={{ fontSize: 12.5 }}>
                    <dt>联系人</dt><dd>{c.contact_name || '—'}{c.phone ? ` · ${c.phone}` : ''}</dd>
                    <dt>累计出货</dt><dd>{int(c.order_count)} 次 · {money(c.amount)}</dd>
                    <dt>平均毛利</dt><dd className={c.margin_pct != null && c.margin_pct < 20 ? 'down' : 'up'}>
                      {pct(c.margin_pct)}
                      {c.cost_coverage != null && c.cost_coverage < 95 && (
                        <span className="muted small"> （仅 {pct(c.cost_coverage)} 有成本）</span>
                      )}</dd>
                    <dt>询价 / 成交</dt><dd>{int(c.quote_count)} / {int(c.won_count)}</dd>
                    <dt>结算方式</dt><dd>{c.payment_terms || '—'}</dd>
                    <dt>最近成交</dt><dd>{shortDate(c.last_date)}</dd>
                  </dl>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn sm" onClick={() => setDetailId(c.id)}>采购画像</button>
                    <Link className="btn sm" href={`/orders?customer=${c.id}`}>出货明细</Link>
                    <Link className="btn sm" href="/bom">为他询价</Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card><Empty icon="◉" text="还没有客户档案"
            hint="可以在这里手动新增，或在「数据导入」里带客户列导入出货流水自动建档" /></Card>
        ))}
      </div>

      {adding && <AddCustomer onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {detailId && <CustomerDetail id={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
}

function CustomerDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/api/customers/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);

  const c = d?.customer;
  const savings = (d?.topParts || []).reduce((s: number, p: any) => s + (p.saving || 0), 0);

  return (
    <Modal title={c ? (c.short_name || c.name) : '客户详情'} onClose={onClose}>
      {err && <Note kind="err">{err}</Note>}
      {!d && !err && <Spinner />}
      {d && (
        <>
          <div className="grid g4" style={{ marginBottom: 16 }}>
            <div><div className="stat-l">累计成交</div><div className="stat" style={{ fontSize: 19 }}>{money(c.amount)}</div></div>
            <div><div className="stat-l">出货笔数</div><div className="stat" style={{ fontSize: 19 }}>{int(c.ship_rows)}</div></div>
            <div><div className="stat-l">涉及型号</div><div className="stat" style={{ fontSize: 19 }}>{int(c.part_kinds)}</div></div>
            <div><div className="stat-l">整体毛利</div>
              <div className={`stat ${c.margin_pct != null && c.margin_pct < 20 ? 'down' : 'up'}`} style={{ fontSize: 19 }}>
                {pct(c.margin_pct)}</div></div>
          </div>
          <div className="muted small" style={{ marginBottom: 14 }}>
            首次成交 {shortDate(c.first_date)} · 最近成交 {shortDate(c.last_date)}
            {c.notes && <> · 业务员 {c.notes}</>}
          </div>

          {c.cost_coverage != null && c.cost_coverage < 95 && (
            <Note kind="warn">
              <b>毛利仅基于 {pct(c.cost_coverage)} 的出货行计算。</b>
              这个客户 {int(c.ship_rows)} 笔出货里只有 {int(c.n_with_cost)} 笔记录了成本，
              其余的没有成本就不参与毛利计算 —— 把缺失成本当成 0 会让毛利虚高好几倍。
              导入更完整的采购/成本数据后这个数字才准。
            </Note>
          )}

          {d.monthly?.length > 1 && (
            <Card style={{ marginBottom: 14 }}>
              <CardH title="成交金额走势" sub={`${d.monthly[0].ym} ~ ${d.monthly[d.monthly.length - 1].ym}`} />
              <div className="card-b"><Bars data={d.monthly.map((m: any) => m.amount || 0)} height={80} /></div>
            </Card>
          )}

          <Card style={{ marginBottom: 14 }}>
            <CardH title="主力型号" sub="按成交金额排序" />
            <div className="card-b flush">
              {d.topParts?.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>型号</th><th className="num">次数</th><th className="num">数量</th>
                    <th className="num">成交金额</th><th className="num">成交均价</th>
                    <th className="num">最优采购价</th><th className="num">毛利</th></tr></thead>
                  <tbody>{d.topParts.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono">{p.pn}<div className="muted small">{p.brand || ''}</div></td>
                      <td className="num">{p.times}</td>
                      <td className="num">{int(p.qty)}</td>
                      <td className="num mono">{money(p.amount)}</td>
                      <td className="num mono">{money(p.avg_price)}</td>
                      <td className="num mono">{p.best_supplier_price ? money(p.best_supplier_price)
                        : <span className="muted">无报价</span>}</td>
                      <td className={`num ${p.margin != null && p.margin < 15 ? 'down' : 'up'}`}>{pct(p.margin)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <Empty icon="▤" text="这个客户还没有出货记录" />}
            </div>
            {savings > 0 && (
              <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
                <Note>
                  <b>降本空间约 {money(savings)}：</b>上面这些型号里，
                  历史采购成本高于目前已知的最优供应商报价。换供应商或拿这个价去谈，差额就是净利。
                </Note>
              </div>
            )}
          </Card>

          <Card>
            <CardH title="最近出货" sub="最近 20 条" />
            <div className="card-b flush">
              {d.recent?.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>日期</th><th>型号</th><th className="num">数量</th>
                    <th className="num">单价</th><th className="num">成本</th></tr></thead>
                  <tbody>{d.recent.map((r: any, i: number) => (
                    <tr key={i}><td>{r.ship_date}</td><td className="mono">{r.pn}</td>
                      <td className="num">{int(r.quantity)}</td>
                      <td className="num mono">{money(r.unit_price)}</td>
                      <td className="num mono muted">{money(r.unit_cost)}</td></tr>
                  ))}</tbody>
                </table></div>
              ) : <Empty icon="▤" text="暂无记录" />}
            </div>
          </Card>
        </>
      )}
    </Modal>
  );
}

function AddCustomer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ level: 'B' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/customers', { method: 'POST', body: JSON.stringify(f) }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="新增客户" onClose={onClose}>
      {err && <Note kind="err">{err}</Note>}
      <div className="grid g2" style={{ marginTop: 12 }}>
        <div className="field"><label>客户全称 *</label>
          <input value={f.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="深圳市 XX 电子有限公司" /></div>
        <div className="field"><label>简称</label>
          <input value={f.short_name || ''} onChange={(e) => set('short_name', e.target.value)} /></div>
        <div className="field"><label>联系人</label>
          <input value={f.contact_name || ''} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div className="field"><label>电话</label>
          <input value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>地区</label>
          <input value={f.region || ''} onChange={(e) => set('region', e.target.value)} /></div>
        <div className="field"><label>分级</label>
          <select value={f.level} onChange={(e) => set('level', e.target.value)}>
            <option>A</option><option>B</option><option>C</option></select></div>
        <div className="field"><label>结算方式</label>
          <input value={f.payment_terms || ''} onChange={(e) => set('payment_terms', e.target.value)} placeholder="月结30天 / 款到发货" /></div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={busy || !f.name?.trim()}>
          {busy ? <><span className="spin" /> 保存中…</> : '保存'}
        </button>
        <button className="btn" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}
