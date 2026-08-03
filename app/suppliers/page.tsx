'use client';
import { useState, useEffect } from 'react';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, CardH, Badge, Empty, Note, Spinner, Modal,
  money, pct, int, fmt, shortDate,
} from '../components/ui';

const KIND_LABEL: Record<string, { text: string; kind: string }> = {
  verified: { text: '认证', kind: 'green' },
  brand: { text: '品牌', kind: 'blue' },
  manual: { text: '手动', kind: 'gray' },
};

export default function SuppliersPage() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [recalcing, setRecalcing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set('q', q.trim());
    if (kind) sp.set('kind', kind);
    return api(`/api/suppliers?${sp}`);
  }, [q, kind]);

  const recalc = async () => {
    setRecalcing(true); setMsg(null);
    try {
      const r: any = await api('/api/suppliers/recalc-score', { method: 'POST' });
      setMsg(`已重算 ${r.updated ?? r.count ?? ''} 个品牌评分`);
      reload();
    } catch (e: any) { setMsg('重算失败：' + e.message); } finally { setRecalcing(false); }
  };

  const list: any[] = data?.suppliers || [];

  return (
    <>
      <Topbar title="供应商" sub="供应商评分与比价" />
      <div className="page">
        <Card style={{ marginBottom: 14 }}>
          <div className="card-b">
            <div className="row">
              <input placeholder="搜索供应商" style={{ flex: 1, minWidth: 200 }}
                value={q} onChange={(e) => setQ(e.target.value)} />
              <select style={{ width: 160 }} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">全部类型</option>
                <option value="verified">认证联系方式</option>
                <option value="brand">品牌统计</option>
                <option value="manual">手动录入</option>
              </select>
              <button className="btn" onClick={recalc} disabled={recalcing}>
                {recalcing ? <><span className="spin" /> 重算中…</> : '重算评分'}
              </button>
              <button className="btn primary" onClick={() => setAdding(true)}>+ 新增供应商</button>
            </div>
            {msg && <Note>{msg}</Note>}
            <Note kind="new">
              <b>评分口径已修正：</b>旧算法把一个品牌下所有物料的价格混在一起算波动率
              （电容和 MCU 放一起），实测波动率普遍大于 1，等于所有品牌的“价格稳定性”都是 0 分，
              而这一项占 40% 权重。现在改为按单个型号在时间上的变异系数、再按出货次数加权，
              实测落在 0.007~0.16 的合理区间。
            </Note>
          </div>
        </Card>

        <Card>
          <div className="card-b flush">
            {loading && <div className="card-b"><Spinner /></div>}
            {error && <div className="card-b"><Note kind="err">{error}</Note></div>}
            {!loading && (list.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>供应商</th><th>类型</th><th>地区</th>
                    <th className="num">评分</th><th className="num">出货次数</th>
                    <th className="num">报价型号</th><th className="num">最低报价</th>
                    <th className="num">交期</th><th></th>
                  </tr></thead>
                  <tbody>
                    {list.map((s) => {
                      const kl = KIND_LABEL[s.kind] || KIND_LABEL.manual;
                      return (
                        <tr key={s.id}>
                          <td><b>{s.company_name}</b>
                            {(s.contact_name || s.phone) && (
                              <div className="muted small">{[s.contact_name, s.phone].filter(Boolean).join(' · ')}</div>
                            )}</td>
                          <td><Badge kind={kl.kind}>{kl.text}</Badge></td>
                          <td>{s.region || '—'}</td>
                          <td className="num">
                            <b>{s.score == null ? '—' : fmt(s.score, 1)}</b>
                            {s.score != null && (
                              <> <Badge kind={s.score >= 80 ? 'green' : s.score >= 60 ? 'blue' : s.score >= 40 ? 'amber' : 'gray'}>
                                {s.score >= 80 ? '优选' : s.score >= 60 ? '良好' : s.score >= 40 ? '一般' : '观察'}
                              </Badge></>
                            )}
                          </td>
                          <td className="num">{int(s.ship_freq)}</td>
                          <td className="num">{s.quoted_parts ? int(s.quoted_parts) : <span className="muted">0</span>}</td>
                          <td className="num mono">{s.min_quote ? money(s.min_quote) : '—'}</td>
                          <td className="num">{s.lead_time_days ? `${s.lead_time_days} 天` : '—'}</td>
                          <td><button className="btn sm" onClick={() => setDetail(s)}>明细</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon="⬡" text="没有匹配的供应商" />)}
          </div>
        </Card>
      </div>

      {detail && <SupplierDetail s={detail} onClose={() => setDetail(null)} />}
      {adding && <AddSupplier onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function SupplierDetail({ s, onClose }: { s: any; onClose: () => void }) {
  const sd = s.score_detail || {};
  return (
    <Modal title={s.company_name} onClose={onClose}>
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <dl className="kv">
          <dt>类型</dt><dd>{(KIND_LABEL[s.kind] || KIND_LABEL.manual).text}</dd>
          <dt>联系人</dt><dd>{s.contact_name || '—'}</dd>
          <dt>电话</dt><dd>{s.phone || '—'}</dd>
          <dt>地区</dt><dd>{s.region || '—'}</dd>
        </dl>
        <dl className="kv">
          <dt>人工评级</dt><dd>{s.grade || '—'}</dd>
          <dt>交期</dt><dd>{s.lead_time_days ? `${s.lead_time_days} 天` : '—'}</dd>
          <dt>起订</dt><dd>{s.moq || '—'}</dd>
          <dt>账期</dt><dd>{s.payment_terms || '—'}</dd>
        </dl>
      </div>

      <Card style={{ marginBottom: 14 }}>
        <CardH title="评分构成" sub={sd.method ? '按型号价格变异系数加权' : '尚未重算'} />
        <div className="card-b">
          {sd.freqScore != null ? (
            <>
              {[['出货频次 (35%)', sd.freqScore], ['出货量 (25%)', sd.qtyScore], ['价格稳定性 (40%)', sd.stabScore]]
                .map(([l, v]: any) => (
                  <div key={l} style={{ marginBottom: 11 }}>
                    <div className="row small" style={{ marginBottom: 4 }}>
                      <span>{l}</span><div className="spacer" /><span className="mono muted">{fmt(v, 1)}</span>
                    </div>
                    <div className="bar"><div style={{ width: `${Math.min(Number(v), 100)}%` }} /></div>
                  </div>
                ))}
              <div className="muted small" style={{ marginTop: 10 }}>
                波动率 {fmt(sd.volatility, 3)} · 样本 {int(sd.sampleN)} 条成交 / {int(sd.partsN)} 个型号
              </div>
            </>
          ) : <Empty icon="⬡" text="点击列表页的「重算评分」后显示" />}
        </div>
      </Card>

      <SupplierParts id={s.id} />
    </Modal>
  );
}

/** 该供应商报过的型号，以及每一条相对全市场最低价贵多少 */
function SupplierParts({ id }: { id: number }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/api/suppliers/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);

  if (err) return <Note kind="err">{err}</Note>;
  if (!d) return <Card><div className="card-b"><Spinner /></div></Card>;

  const st = d.stats;
  return (
    <Card>
      <CardH title="报价明细" sub={st.quoted ? `${st.quoted} 个型号，其中 ${st.bestCount} 个是全市场最低价` : undefined} />
      <div className="card-b flush">
        {d.parts?.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>型号</th><th className="num">报价</th><th className="num">全市场最低</th>
              <th className="num">贵出</th><th className="num">我方售价</th>
              <th className="num">毛利</th><th className="num">起订</th><th>报价日期</th></tr></thead>
            <tbody>{d.parts.map((p: any) => (
              <tr key={p.id}>
                <td className="mono">{p.pn}
                  {p.ship_count > 0 && <div className="muted small">出货 {p.ship_count} 次</div>}</td>
                <td className="num mono">{money(p.price)}
                  {p.isBest && <> <Badge kind="green">最优</Badge></>}</td>
                <td className="num mono muted">{money(p.market_best)}</td>
                <td className="num">
                  {p.premiumPct == null ? '—'
                    : p.premiumPct < 0.01 ? <span className="muted">—</span>
                    : <span className="down">+{fmt(p.premiumPct, 1)}%</span>}
                </td>
                <td className="num mono">{p.our_sell_price ? money(p.our_sell_price) : <span className="muted">未售过</span>}</td>
                <td className={`num ${p.margin != null && p.margin < 15 ? 'down' : 'up'}`}>{pct(p.margin)}</td>
                <td className="num">{p.moq || '—'}</td>
                <td className="muted small">{shortDate(p.quoted_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="↥" text="该供应商还没有报价数据"
              hint="在「数据导入」里导入采购记录或供应商报价表" />}
      </div>
      {st.quoted > 0 && (
        <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
          <Note>
            {st.bestCount === st.quoted
              ? '这家在所有报过价的型号上都是最低价。'
              : `这家有 ${st.quoted - st.bestCount} 个型号不是最低价，平均贵 ${fmt(st.avgPremium, 1)}%。` +
                '「贵出」那一列可以直接拿去谈价。'}
          </Note>
        </div>
      )}
    </Card>
  );
}

function AddSupplier({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ grade: 'B' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((p: any) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('/api/suppliers', { method: 'POST', body: JSON.stringify(f) }); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="新增供应商" onClose={onClose}>
      {err && <Note kind="err">{err}</Note>}
      <div className="grid g2" style={{ marginTop: 12 }}>
        <div className="field"><label>供应商名称 *</label>
          <input value={f.company_name || ''} onChange={(e) => set('company_name', e.target.value)} /></div>
        <div className="field"><label>联系人</label>
          <input value={f.contact_name || ''} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div className="field"><label>电话</label>
          <input value={f.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>地区</label>
          <input value={f.region || ''} onChange={(e) => set('region', e.target.value)} /></div>
        <div className="field"><label>评级</label>
          <select value={f.grade} onChange={(e) => set('grade', e.target.value)}>
            <option>A</option><option>B</option><option>C</option></select></div>
        <div className="field"><label>交期(天)</label>
          <input value={f.lead_time_days || ''} onChange={(e) => set('lead_time_days', e.target.value)} /></div>
        <div className="field"><label>起订</label>
          <input value={f.moq || ''} onChange={(e) => set('moq', e.target.value)} /></div>
        <div className="field"><label>账期</label>
          <input value={f.payment_terms || ''} onChange={(e) => set('payment_terms', e.target.value)} /></div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={busy || !f.company_name?.trim()}>
          {busy ? <><span className="spin" /> 保存中…</> : '保存'}
        </button>
        <button className="btn" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}
