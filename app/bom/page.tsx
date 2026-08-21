'use client';
import { useState, useEffect } from 'react';
import Topbar from '../components/Topbar';
import {
  api, Card, CardH, Badge, Empty, Note, Spinner, Stat,
  money, pct, int, MATCH_LABEL,
} from '../components/ui';

type Item = {
  queryPn: string;
  qty: number;
  matchType: keyof typeof MATCH_LABEL;
  part: any;
  unitPrice: number | null;
  cost: number | null;
  costSource: string | null;
  margin: number | null;
  bestQuote: any;
  warnings: string[];
  brandHint: string | null;
  // 本地编辑
  finalPrice?: string;
  confirmed?: boolean;
  isNew?: boolean;
};

const SAMPLE = `客户询价单
1. STM32F103RCT6  LQFP64   2000pcs
2. 0603 104K 25V 电容  100K
3、AMS1117-3.3 SOT223  5000
4. 0402 499K 1% 电阻  50000只
麻烦今天下班前给个价，谢谢！`;

export default function BomPage() {
  const [text, setText] = useState(SAMPLE);
  const [customerId, setCustomerId] = useState('');
  const [by, setBy] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [items, setItems] = useState<Item[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  useEffect(() => {
    api('/api/customers').then((d: any) => setCustomers(d.customers || [])).catch(() => {});
  }, []);

  const parse = async () => {
    setBusy(true); setErr(null); setDone(null);
    try {
      const r: any = await api('/api/ai-parse-bom', { method: 'POST', body: JSON.stringify({ text }) });
      setItems(r.items.map((it: any) => ({
        ...it,
        finalPrice: it.unitPrice != null ? String(it.unitPrice) : '',
        confirmed: it.matchType !== 'none',
        isNew: false,
      })));
      setSummary(r.summary);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const patch = (i: number, p: Partial<Item>) =>
    setItems((prev) => prev!.map((it, idx) => (idx === i ? { ...it, ...p } : it)));

  const totals = (() => {
    if (!items) return null;
    let amount = 0, cost = 0, n = 0;
    for (const it of items) {
      if (!it.confirmed && !it.isNew) continue;
      const p = Number(it.finalPrice) || 0;
      if (p > 0 && it.qty > 0) { amount += p * it.qty; cost += (it.cost || 0) * it.qty; n++; }
    }
    return { amount, cost, n, margin: amount > 0 ? ((amount - cost) / amount) * 100 : null };
  })();

  const submit = async () => {
    if (!items) return;
    setBusy(true); setErr(null);
    try {
      const r: any = await api('/api/boms/submit', {
        method: 'POST',
        body: JSON.stringify({
          raw_text: text,
          customer_id: customerId ? Number(customerId) : null,
          submitted_by: by || null,
          items: items.map((it) => ({
            pn: it.part?.pn || it.queryPn,
            qty: it.qty,
            matchType: it.matchType,
            part: it.part ? { id: it.part.id } : null,
            unitPrice: it.unitPrice,
            finalPrice: it.finalPrice ? Number(it.finalPrice) : null,
            cost: it.cost,
            confirmed: it.confirmed,
            isNew: it.isNew,
          })),
        }),
      });
      setDone(r);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const exportCsv = () => {
    if (!items) return;
    const rows = [['型号', '客户原文', '数量', '匹配', '单价', '小计', '毛利率']];
    for (const it of items) {
      if (!it.confirmed && !it.isNew) continue;
      const p = Number(it.finalPrice) || 0;
      const m = it.cost && p ? ((p - it.cost) / p) * 100 : null;
      rows.push([it.part?.pn || it.queryPn, it.queryPn, String(it.qty),
        MATCH_LABEL[it.matchType].text, p.toFixed(4), (p * it.qty).toFixed(2),
        m != null ? m.toFixed(1) + '%' : '']);
    }
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `报价单_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <>
      {/* AI_DISABLED_NOTE：没配密钥时导航里已经隐藏本页，
          但直接输网址还是能进来，这里给个明确提示，别让人对着报错猜 */}
      <Topbar title="AI 询价助手" sub="粘贴客户询价单，自动解析并匹配报价" />
      <div className="page">
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <Card>
            <CardH title="1 · 粘贴客户询价内容" />
            <div className="card-b">
              <div className="row" style={{ marginBottom: 13 }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <label>客户</label>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">未指定客户</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
                  </select>
                </div>
                <div style={{ width: 130 }}>
                  <label>负责人</label>
                  <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="姓名" />
                </div>
              </div>
              <div className="field">
                <label>询价原文（支持乱格式、Excel 粘贴、聊天记录）</label>
                <textarea rows={13} className="mono" style={{ fontSize: 12.5 }}
                  value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <div className="row">
                <button className="btn primary" onClick={parse} disabled={busy || !text.trim()}>
                  {busy ? <><span className="spin" /> 处理中…</> : '解析并匹配'}
                </button>
                <span className="muted small">整批一次匹配，不再逐条查库</span>
              </div>
              {customerId && (
                <Note kind="new">
                  已绑定客户，确认后这张单会进入「询价记录」并可追踪成交结果。
                </Note>
              )}
            </div>
          </Card>

          <div>
            {err && <Note kind="err">{err}</Note>}
            {done && (
              <Card style={{ marginBottom: 14 }}>
                <div className="card-b">
                  <Note><b>已生成报价单 {done.quote_no}</b>：
                    共 {done.quoted + done.created} 项入账，金额 {money(done.total_amount)}，
                    毛利 {pct(done.margin_pct)}。可在「询价记录」里跟踪成交结果。</Note>
                </div>
              </Card>
            )}
            {!items && !busy && (
              <Card><Empty icon="✦" text="解析结果将显示在这里" /></Card>
            )}
            {busy && !items && <Card><div className="card-b"><Spinner text="AI 正在解析询价单…" /></div></Card>}

            {items && summary && (
              <>
                <div className="grid g4" style={{ marginBottom: 14 }}>
                  <Stat label="识别行数" value={int(summary.total)} />
                  <Stat label="成功匹配" value={`${summary.total - summary.none} / ${summary.total}`} />
                  <Stat label="报价总额" value={money(totals?.amount)} />
                  <Stat label="整单毛利" value={pct(totals?.margin)}
                    tone={totals?.margin != null && totals.margin < 15 ? 'down' : 'up'} />
                </div>

                <Card>
                  <CardH title="2 · 复核与调价" sub={`${summary.needsReview} 项需要留意`} />
                  <div className="card-b flush">
                    <div className="table-wrap">
                      <table>
                        <thead><tr>
                          <th style={{ width: 32 }}></th><th>客户原文 / 匹配型号</th>
                          <th className="num">数量</th><th>匹配</th>
                          <th className="num">建议价</th><th>调整</th>
                          <th className="num">小计</th><th className="num">毛利</th>
                        </tr></thead>
                        <tbody>
                          {items.map((it, i) => {
                            const lbl = MATCH_LABEL[it.matchType];
                            const p = Number(it.finalPrice) || 0;
                            const m = it.cost && p ? ((p - it.cost) / p) * 100 : null;
                            return (
                              <tr key={i}>
                                <td><input type="checkbox" checked={!!it.confirmed}
                                  disabled={it.matchType === 'none'}
                                  onChange={(e) => patch(i, { confirmed: e.target.checked })} /></td>
                                <td>
                                  <span className="mono">{it.queryPn}</span>
                                  {it.part && it.part.pn !== it.queryPn && (
                                    <div className="muted small">→ <span className="hl mono">{it.part.pn}</span></div>
                                  )}
                                  {it.warnings?.length > 0 && (
                                    <div className="small" style={{ color: 'var(--amber)' }}>{it.warnings[0]}</div>
                                  )}
                                </td>
                                <td className="num">{int(it.qty)}</td>
                                <td><Badge kind={lbl.kind}>{lbl.text}</Badge></td>
                                <td className="num mono muted">{money(it.unitPrice)}</td>
                                <td>
                                  <input value={it.finalPrice} className="mono num"
                                    style={{ width: 92, padding: '3px 6px', fontSize: 12 }}
                                    onChange={(e) => patch(i, { finalPrice: e.target.value })} />
                                </td>
                                <td className="num mono">{money(p * it.qty)}</td>
                                <td className={`num ${m != null && m < 15 ? 'down' : 'up'}`}>{pct(m)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
                    {summary.none > 0 && (
                      <Note kind="warn">
                        <b>{summary.none} 项未匹配：</b>这些型号库里没有，也没有供应商报价。
                        建议先询供应商再回复客户，或勾选后当作新型号建档。
                      </Note>
                    )}
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="btn primary" onClick={submit} disabled={busy || !totals?.n}>
                        {busy ? <><span className="spin" /> 提交中…</> : `✓ 确认并生成报价单（${totals?.n || 0} 项）`}
                      </button>
                      <button className="btn" onClick={exportCsv} disabled={!totals?.n}>↧ 导出 CSV</button>
                    </div>
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
