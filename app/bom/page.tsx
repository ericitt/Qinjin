'use client';
import { useState } from 'react';

type MatchItem = {
  queryPn: string;
  qty: number;
  matchType: 'exact' | 'catalog' | 'partial' | 'none';
  part: { id: number; pn: string; spec: string | null; cat: string | null; brand: string | null } | null;
  unitPrice: number | null;
  cost: number | null;
  margin: number | null;
  brandHint: string | null;
  // 本地编辑状态
  confirmed?: boolean;
  isNew?: boolean;
  newSpec?: string;
  newCat?: string;
  newBrand?: string;
  newPrice?: string;
};

const MATCH_LABEL: Record<string, string> = { exact: '精确匹配', catalog: '目录参考', partial: '模糊匹配', none: '未找到' };
const MATCH_COLOR: Record<string, string> = { exact: 'dark', catalog: 'outline', partial: 'outline', none: 'outline' };

export default function BomPage() {
  const [rawText, setRawText] = useState('');
  const [items, setItems] = useState<MatchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitResult, setSubmitResult] = useState<{ bom_id: number; created: number; quoted: number; skipped: number } | null>(null);

  async function runAiParse() {
    if (!rawText.trim()) { setError('请先粘贴客户发来的BOM/询价内容'); return; }
    setLoading(true); setError(''); setSubmitResult(null);
    try {
      const resp = await fetch('/api/ai-parse-bom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawText }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '解析失败');
      setItems(data.items.map((it: MatchItem) => ({ ...it, confirmed: true })));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function updateItem(idx: number, patch: Partial<MatchItem>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  async function submitAll() {
    setSubmitting(true); setError('');
    try {
      const payload = {
        raw_text: rawText,
        items: items.map((it) => ({
          pn: it.queryPn,
          qty: it.qty,
          matchType: it.matchType,
          part: it.part,
          unitPrice: it.isNew ? Number(it.newPrice) || it.unitPrice : it.unitPrice,
          cost: it.cost,
          confirmed: it.confirmed,
          isNew: it.isNew,
          newPartData: it.isNew ? { spec: it.newSpec, cat: it.newCat, brand: it.newBrand, price: Number(it.newPrice) || undefined } : undefined,
        })),
      };
      const resp = await fetch('/api/boms/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '提交失败');
      setSubmitResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const summary = {
    exact: items.filter((i) => i.matchType === 'exact').length,
    catalog: items.filter((i) => i.matchType === 'catalog').length,
    partial: items.filter((i) => i.matchType === 'partial').length,
    none: items.filter((i) => i.matchType === 'none').length,
  };

  return (
    <div className="page-inner">
      <div className="page-title">AI 询价助手</div>
      <div className="page-desc">把客户发来的模糊BOM/询价文本粘贴进来，AI 清洗后自动匹配数据库，确认后一键归档、新型号自动建档</div>
      <div className="page-divider" />

      <textarea
        className="form-textarea"
        style={{ minHeight: 160, marginBottom: 10 }}
        placeholder={'把客户发来的BOM表格内容/口语化询价文本整个粘贴进来，例如：\n序号 规格型号 封装 位号 用量 备注 品牌\n1 EL357N(B)(TA)-G SOP4 U1 200 EVERLIGHT\n2 贴片电阻471 1% 805 R1-R8 800'}
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button className="btn primary" onClick={runAiParse} disabled={loading}>
          {loading ? '⏳ AI 识别中…' : '✦ AI 智能识别并匹配'}
        </button>
        {items.length > 0 && (
          <button className="btn" onClick={() => { setItems([]); setSubmitResult(null); }}>清空结果</button>
        )}
      </div>

      {error && <div style={{ color: '#a00', fontSize: 12, marginBottom: 16 }}>{error}</div>}

      {submitResult && (
        <div className="card" style={{ background: 'var(--bg2)', marginBottom: 20 }}>
          <strong>已提交 · BOM 编号 #{submitResult.bom_id}</strong>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
            新建型号并记录报价 {submitResult.created} 条 · 记录报价 {submitResult.quoted} 条 · 跳过（未匹配/未确认）{submitResult.skipped} 条
          </div>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="stats-row">
            <div className="stat-cell"><div className="label">精确匹配</div><div className="value">{summary.exact}</div></div>
            <div className="stat-cell"><div className="label">目录参考</div><div className="value">{summary.catalog}</div></div>
            <div className="stat-cell"><div className="label">模糊匹配</div><div className="value">{summary.partial}</div></div>
            <div className="stat-cell"><div className="label">未找到</div><div className="value">{summary.none}</div></div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>查询型号</th><th>匹配结果</th><th style={{ textAlign: 'center' }}>用量</th>
                  <th style={{ textAlign: 'right' }}>单价</th><th style={{ textAlign: 'right' }}>毛利率</th>
                  <th>状态</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="mono">{it.queryPn}{it.brandHint && <div style={{ fontSize: 10, color: 'var(--text3)' }}>客户提及品牌：{it.brandHint}</div>}</td>
                    <td style={{ fontSize: 12 }}>{it.part ? <><span className="mono">{it.part.pn}</span><div style={{ color: 'var(--text3)', fontSize: 11 }}>{it.part.spec}</div></> : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    <td style={{ textAlign: 'center' }} className="mono">{it.qty}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{it.unitPrice ? `¥${it.unitPrice.toFixed(4)}` : '—'}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{it.margin !== null ? `${it.margin.toFixed(0)}%` : '—'}</td>
                    <td><span className={`tag ${MATCH_COLOR[it.matchType]}`}>{MATCH_LABEL[it.matchType]}</span></td>
                    <td>
                      {it.matchType === 'none' && !it.isNew && (
                        <button className="btn" style={{ height: 26, fontSize: 11 }} onClick={() => updateItem(idx, { isNew: true, newSpec: it.queryPn })}>标记为新型号</button>
                      )}
                      {it.isNew && (
                        <div style={{ display: 'grid', gap: 4, minWidth: 160 }}>
                          <input className="form-input" style={{ height: 26, fontSize: 11 }} placeholder="规格描述" value={it.newSpec || ''} onChange={(e) => updateItem(idx, { newSpec: e.target.value })} />
                          <input className="form-input" style={{ height: 26, fontSize: 11 }} placeholder="分类" value={it.newCat || ''} onChange={(e) => updateItem(idx, { newCat: e.target.value })} />
                          <input className="form-input" style={{ height: 26, fontSize: 11 }} placeholder="品牌" value={it.newBrand || it.brandHint || ''} onChange={(e) => updateItem(idx, { newBrand: e.target.value })} />
                          <input className="form-input" style={{ height: 26, fontSize: 11 }} placeholder="报价" value={it.newPrice || ''} onChange={(e) => updateItem(idx, { newPrice: e.target.value })} />
                          <button className="btn" style={{ height: 24, fontSize: 10 }} onClick={() => updateItem(idx, { isNew: false })}>取消</button>
                        </div>
                      )}
                      {it.matchType !== 'none' && (
                        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input type="checkbox" checked={it.confirmed !== false} onChange={(e) => updateItem(idx, { confirmed: e.target.checked })} />
                          确认采用
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn primary" onClick={submitAll} disabled={submitting}>
            {submitting ? '⏳ 提交中…' : '⇪ 确认并提交至数据库'}
          </button>
        </>
      )}
    </div>
  );
}
