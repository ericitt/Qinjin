'use client';
import { useState } from 'react';
import Link from 'next/link';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, Badge, Empty, Note, Spinner, Modal,
  money, pct, int, shortDate,
} from '../components/ui';

export default function CustomersPage() {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
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
                    <dt>平均毛利</dt><dd className={c.margin_pct != null && c.margin_pct < 20 ? 'down' : 'up'}>{pct(c.margin_pct)}</dd>
                    <dt>询价 / 成交</dt><dd>{int(c.quote_count)} / {int(c.won_count)}</dd>
                    <dt>结算方式</dt><dd>{c.payment_terms || '—'}</dd>
                    <dt>最近成交</dt><dd>{shortDate(c.last_date)}</dd>
                  </dl>
                  <div className="row" style={{ marginTop: 12 }}>
                    <Link className="btn sm" href={`/orders?customer=${c.id}`}>采购记录</Link>
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
    </>
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
