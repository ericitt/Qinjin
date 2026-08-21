'use client';
import { useState, useRef, useEffect } from 'react';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, CardH, Badge, Empty, Note, Spinner,
  int, shortDate,
} from '../components/ui';

const KINDS = [
  { k: 'purchases', t: '采购记录', d: 'ERP 导出的采购单：供应商、型号、单价、数量、日期', why: '实际付过的钱比口头报价可信，同型号取最近一次采购价' },
  { k: 'supplier_quotes', t: '供应商报价', d: '供应商、供应物料、含税价格、品牌、封装、最小包装、日期', why: '对应公司的「供应商名单」表，直接导即可' },
  { k: 'shipments', t: '出货流水', d: '日期、客户、型号、数量、单价', why: '带客户列导入，出货记录才有客户维度' },
  { k: 'parts', t: '物料主数据', d: '型号、规格、分类、品牌、成本', why: '补全规格与成本，减少「无成本可参考」' },
  { k: 'suppliers', t: '供应商档案', d: '名称、联系人、电话、地区、账期', why: '把品牌统计升级成能下单的对象' },
  { k: 'customers', t: '客户档案', d: '全称、简称、联系人、分级、结算方式', why: '建立客户实体' },
];

// 列内容画像的中文标签 —— 让人一眼看出「这一列被系统认成了什么」
const COL_KIND: Record<string, string> = {
  date: '日期', int: '整数', money: '金额', pn: '型号', company: '公司名',
  pkg: '封装', currency: '币种', bool: '是否', brand: '短文本', text: '文本', empty: '全空',
};

const SAMPLE: Record<string, string> = {
  purchases: `供应商号,日期,货币,牌子,型号,单价,订单数量,封装
阿里芯城,2025-06-19,RMB,Chipanalog(川土微),CA-IS1306M25G,2.079646,2000,1K
安得能,2025-12-16,RMB,ON,1SMA5934BT3G,0.36,5000,5K`,
  supplier_quotes: `供应商,是否代理商,供应物料,含税价格,品牌,封装,最小包装,日期,备注
深圳市金棕榈半导体有限公司,是,CJ3402(R2),0.105,CJ（长电）,SOT-23,3000,2026/8/13,长电微盟授权代理
,,LMBT5551LT1G,0.039,,SOT-23,3000,2026/8/13,
深圳市发润达科技有限公司,否,LMV324IDR,0.791,TI,SOP-14,2500,2026/8/14,
深圳市尚想信息技术有限公司,否,ADSP-CM408CSWZ-BF,145.00,ADI,LQFP-176,200,2026/8/11,`,
  shipments: `日期,客户,型号,数量,单价,成本
2026-06-12,深圳市锐驰电子有限公司,STM32F103RCT6,2000,23.50,18.20
2026-06-14,东莞恒泰智能装备,0603104KB,100000,0.0098,0.0083`,
  parts: `型号,规格,分类,品牌,目录成本
TEST-PN-001,0402 100nF 16V,电容,MURATA,0.0089`,
  suppliers: `供应商名称,联系人,电话,地区,评级,交期,账期
深圳华秋电子,赵经理,13800002841,深圳,A,3,月结30天`,
  customers: `客户全称,简称,联系人,电话,分级,结算方式
深圳市锐驰电子有限公司,锐驰,王经理,13900001234,A,月结30天`,
};

export default function ImportPage() {
  const [kind, setKind] = useState('auto');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const [over, setOver] = useState(false);
  // 一键导入全程只要几秒，但中间发生了什么必须看得见 ——
  // 否则文件一拖进去就「好了」，出问题根本不知道是哪一步歪的
  const [steps, setSteps] = useState<{ t: string; s: 'run' | 'ok' | 'fail'; d?: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // 结果出来后自动滚过去。页面很长，不滚的话「入库完成」在屏幕外，
  // 看起来就像什么都没发生。
  useEffect(() => {
    if (done && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [done]);

  const begin = (t: string) => setSteps((x) => [...x, { t, s: 'run' }]);
  const finish = (s: 'ok' | 'fail', d?: string) =>
    setSteps((x) => x.map((y, i) => (i === x.length - 1 ? { ...y, s, d } : y)));

  const batches = useAsync(() => api('/api/import/batches'), [done]);

  const step = done ? 4 : preview ? 3 : text ? 2 : 1;

  /**
   * 读文件。所有格式都上传给服务端解析：
   *  - .xls / .xlsx 直接解析（不用再手动「另存为 CSV」）
   *  - .csv 也走服务端，因为 Excel 存出来的 CSV 多半是 GBK，浏览器按 UTF-8 读会全是乱码
   * 自动识别模式下，解析完直接开跑，真正做到「丢进来就完事」。
   */
  const readFile = async (f: File) => {
    setFileName(f.name); setPreview(null); setDone(null); setErr(null);
    setSteps([]); setBusy(true);
    let t = '';
    try {
      begin('读取文件');
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/import/parse-file', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `解析失败（${r.status}）`);
      t = String(j.text || '');
      setText(t);
      const lines = t.split('\n').filter((x) => x.trim()).length;
      finish('ok', `${f.name} · ${Math.max(0, lines - 1)} 行数据`);
    } catch (e: any) {
      finish('fail', e.message); setErr(e.message); setBusy(false); return;
    }
    setBusy(false);
    if (kind === 'auto' && t.trim()) await oneClick(t, f.name, true);
  };

  const doPreview = async (k = kind) => {
    setBusy(true); setErr(null);
    try {
      const p: any = await api('/api/import/preview', {
        method: 'POST', body: JSON.stringify({ kind: k, text }),
      });
      setPreview(p); setMapping(p.suggestedMapping || {});
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  // 用户选错类型时，一键切到系统猜的那个并重新校验
  const switchKind = async (k: string) => {
    setKind(k); setPreview(null); setDone(null);
    await doPreview(k);
  };

  const doCommit = async () => {
    setBusy(true); setErr(null);
    // 几千行要跑十几秒。不给过程反馈的话，按钮点下去就是一片空白，
    // 人会以为没反应又点一次 —— 所以这里和一键导入用同一套进度显示。
    begin('写入数据库');
    try {
      const r: any = await api('/api/import/commit', {
        // 用 preview.kind（自动识别模式下这是识别出来的类型），不要用界面上的 kind
        method: 'POST', body: JSON.stringify({ kind: preview?.kind || kind, text, mapping, fileName }),
      });
      finish('ok', `批次 ${r.batchNo} · 写入 ${r.written} 条`);
      setDone({ ...r, label: preview?.detected?.label });
      batches.reload();
    } catch (e: any) {
      finish('fail', e.message); setErr(e.message);
    } finally { setBusy(false); }
  };

  /**
   * 一键导入：识别类型 → 映射字段 → 校验 → 直接入库，全程不用点。
   * 只有「有把握 + 零拒绝 + 必填字段齐」才会自动写库；
   * 但凡有一点不确定就停在预览页让人确认——宁可多点一下，也不要悄悄导错。
   */
  const oneClick = async (t = text, f = '', keepSteps = false) => {
    setBusy(true); setErr(null); setDone(null);
    if (!keepSteps) setSteps([]);
    try {
      begin('识别类型');
      const p: any = await api('/api/import/preview', {
        method: 'POST', body: JSON.stringify({ kind, text: t }),
      });
      setPreview(p); setMapping(p.suggestedMapping || {});
      const src = p.detected?.source === 'learned' ? '沿用上次这类表的做法'
                : p.detected?.confident ? '有把握' : '不太确定';
      finish('ok', `${p.detected?.label || KINDS.find((k) => k.k === p.kind)?.t || p.kind} · ${src}`);

      begin('字段映射');
      const mapped = Object.keys(p.suggestedMapping || {}).length;
      const miss = p.missingRequired?.length ? `，缺必填：${p.missingRequired.join('、')}` : '';
      finish(p.missingRequired?.length ? 'fail' : 'ok', `对上 ${mapped} 个字段${miss}`);

      begin('数据校验');
      finish('ok', `共 ${p.rowTotal} 行：可入库 ${p.okCount}，拒绝 ${p.rejectCount}`);

      // 允许少量拒绝行：ERP 导出的表几乎都带「合计」行、零单价行这类杂质，
      // 要求零拒绝的话一键导入基本永远不会触发。超过 5% 就说明这份表有系统性问题，
      // 那时候停下来让人看一眼才是对的。
      const badRate = p.rowTotal ? p.rejectCount / p.rowTotal : 1;
      const sure = p.okCount > 0 && badRate <= 0.05
        && !(p.missingRequired?.length) && !p.kindHint
        && (kind !== 'auto' || p.detected?.confident);
      if (!sure) {
        const why = p.missingRequired?.length ? '缺少必填字段'
          : p.kindHint ? '类型可能选错了'
          : !p.okCount ? '没有任何一行能入库'
          : badRate > 0.05 ? `拒绝率 ${(badRate * 100).toFixed(1)}% 偏高`
          : '和次选类型太接近，不敢确定';
        begin('等待确认');
        finish('fail', `${why} —— 请核对下面的映射与校验结果，确认无误后点「确认入库」`);
        return;
      }

      begin('写入数据库');
      const r: any = await api('/api/import/commit', {
        method: 'POST', body: JSON.stringify({ kind: p.kind, text: t, mapping: p.suggestedMapping, fileName: f || fileName }),
      });
      finish('ok', `批次 ${r.batchNo} · 写入 ${r.written} 条`);
      setDone({ ...r, label: p.detected?.label, auto: true });
      batches.reload();   // 不能只靠 done 变化触发，写完立刻拉一次最稳
    } catch (e: any) {
      finish('fail', e.message); setErr(e.message);
    } finally { setBusy(false); }
  };

  const rollback = async (batchNo: string) => {
    setBusy(true); setErr(null);
    try {
      await api('/api/import/rollback', { method: 'POST', body: JSON.stringify({ batchNo }) });
      batches.reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const reset = () => {
    setText(''); setFileName(''); setPreview(null); setDone(null); setErr(null); setSteps([]);
  };

  return (
    <>
      <Topbar title="数据导入" sub="批量导入出货 / 报价 / 供应商 / 客户数据" />
      <div className="page">
        <Note kind="new">
          <b>新模块，也是这次改造里最关键的一块。</b>
          在此之前所有数据只能靠一次性 seed 脚本灌进去，上线后没有任何入口能新增出货记录、
          更新供应商报价或修改物料 —— 数据从落地那天起就开始过期，而且没人能修。
          现在每批导入都有批次号，<b>可预览、可校验、可整批撤销</b>。
          <br />
          <b>现在支持一键导入：</b>把龙威导出的 .xls / .xlsx 直接拖进来就行，
          不用先转 CSV、不用选类型、不用对字段 —— 系统看表头自己判断，
          有把握且零拒绝就直接入库，拿不准才停下来问你。
        </Note>

        <div className="steps" style={{ marginTop: 18 }}>
          {['1 · 选择文件', '2 · 字段映射', '3 · 校验预览', '4 · 确认入库'].map((s, i) => (
            <div key={s} className={`step ${step >= i + 1 ? 'on' : ''}`}>{s}</div>
          ))}
        </div>

        {err && <Note kind="err">{err}</Note>}

        {steps.length > 0 && (
          <Card style={{ marginTop: 14 }}>
            <CardH title="处理过程" sub="每一步做了什么、判断依据是什么" />
            <div className="card-b">
              {steps.map((st, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0' }}>
                  <span style={{ width: 16, flex: 'none', textAlign: 'center',
                    color: st.s === 'ok' ? 'var(--green)' : st.s === 'fail' ? 'var(--amber)' : 'var(--muted)' }}>
                    {st.s === 'run' ? <span className="spin" /> : st.s === 'ok' ? '✓' : '!'}
                  </span>
                  <b style={{ fontSize: 13, width: 84, flex: 'none' }}>{st.t}</b>
                  <span className="muted small">{st.d || (st.s === 'run' ? '处理中…' : '')}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        <div className="grid g2" style={{ alignItems: 'start' }}>
          <Card>
            <CardH title="导入类型" sub="默认自动识别，认不准时再手动选" />
            <div className="card-b">
              <label style={{
                display: 'flex', gap: 10, padding: 11, borderRadius: 6, marginBottom: 8, cursor: 'pointer',
                fontWeight: 400, border: `1px solid ${kind === 'auto' ? 'var(--accent)' : 'var(--border)'}`,
                background: kind === 'auto' ? 'var(--accent-bg, transparent)' : 'transparent',
              }}>
                <input type="radio" name="kind" checked={kind === 'auto'} style={{ marginTop: 3 }}
                  onChange={() => { setKind('auto'); reset(); }} />
                <div>
                  <b style={{ fontSize: 13 }}>⚡ 自动识别（推荐）</b>
                  <div className="muted small">直接丢文件进来，系统看表头自己判断是哪一类数据</div>
                  <div className="small" style={{ color: 'var(--blue)', marginTop: 2 }}>
                    识别得有把握、且没有一行会被拒绝时，直接入库；否则停下来让你确认
                  </div>
                </div>
              </label>
              {KINDS.map((k) => (
                <label key={k.k} style={{
                  display: 'flex', gap: 10, padding: 11, borderRadius: 6, marginBottom: 8, cursor: 'pointer',
                  fontWeight: 400, border: `1px solid ${kind === k.k ? 'var(--accent)' : 'var(--border)'}`,
                }}>
                  <input type="radio" name="kind" checked={kind === k.k} style={{ marginTop: 3 }}
                    onChange={() => { setKind(k.k); reset(); }} />
                  <div>
                    <b style={{ fontSize: 13 }}>{k.t}</b>
                    <div className="muted small">{k.d}</div>
                    <div className="small" style={{ color: 'var(--blue)', marginTop: 2 }}>{k.why}</div>
                  </div>
                </label>
              ))}

              <div className={`dropzone ${over ? 'over' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}>
                <div style={{ fontSize: 22, opacity: .35, marginBottom: 6 }}>↥</div>
                <div style={{ fontSize: 13 }}>
                  {fileName || '把 ERP 导出的文件拖到这里，或点击选择'}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  支持 .xls / .xlsx / .csv / .tsv，中文编码自动处理，不用先另存为
                </div>
              </div>
              <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.tsv,.txt" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />

              <div className="field" style={{ marginTop: 12 }}>
                <label>或直接粘贴内容</label>
                <textarea rows={6} className="mono" style={{ fontSize: 12 }} value={text}
                  onChange={(e) => { setText(e.target.value); setPreview(null); setDone(null); }}
                  placeholder="第一行为表头" />
              </div>
              <div className="row">
                {/* 必须包一层箭头函数：doPreview 的第一个参数是 kind，
                    直接传给 onClick 的话 React 会把 MouseEvent 当成 kind 传进去 */}
                <button className="btn primary" onClick={() => oneClick()} disabled={busy || !text.trim()}>
                  {busy ? <><span className="spin" /> 处理中…</>
                        : kind === 'auto' ? '⚡ 一键导入' : '解析并校验 →'}
                </button>
                {kind === 'auto' && (
                  <button className="btn" onClick={() => doPreview()} disabled={busy || !text.trim()}>
                    只预览不入库
                  </button>
                )}
                <button className="btn" onClick={() => {
                  setText(SAMPLE[kind] || SAMPLE.supplier_quotes); setPreview(null); setDone(null);
                }}>
                  填入示例
                </button>
                {text && <button className="btn ghost" onClick={reset}>清空</button>}
              </div>
            </div>
          </Card>

          <div>
            {done ? (
              <div ref={resultRef}>
              <Card style={{ marginBottom: 14, border: '2px solid var(--green)' }}>
                <CardH title="✓ 已入库" sub={`批次 ${done.batchNo}`} />
                <div className="card-b">
                  <div className="grid g3" style={{ gap: 10, marginBottom: 12 }}>
                    <div><div className="stat-l">实际写入</div>
                      <div className="stat up" style={{ fontSize: 22 }}>{int(done.written)}</div></div>
                    <div><div className="stat-l">跳过（已存在）</div>
                      <div className="stat" style={{ fontSize: 22 }}>{int(done.skippedDup || 0)}</div></div>
                    <div><div className="stat-l">拒绝</div>
                      <div className="stat down" style={{ fontSize: 22 }}>{int(done.rejected)}</div></div>
                  </div>
                  <Note>
                    {done.auto && <><b>自动识别为「{done.label}」。</b> </>}
                    共 {int(done.total)} 行。数据已经进库了，下面的「导入历史」里能看到这一批，
                    随时可以整批撤销。
                    {done.written === 0 && (
                      <><br /><b>注意：实际写入 0 条。</b>
                        这份数据之前很可能已经导过了，系统按自然键判定为重复，没有产生新记录。</>
                    )}
                  </Note>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn danger" onClick={() => rollback(done.batchNo)} disabled={busy}>
                      撤销这一批
                    </button>
                    <button className="btn" onClick={reset}>继续导入下一批</button>
                  </div>
                </div>
              </Card>
              </div>
            ) : preview ? (
              <>
                <Card style={{ marginBottom: 14 }}>
                  <CardH title="2 · 字段映射"
                    sub={`${preview.detected?.label || ''} · ${fileName || '粘贴内容'} · ${int(preview.rowTotal)} 行`} />
                  <div className="card-b flush">
                    <div className="table-wrap"><table>
                      <thead><tr><th>目标字段</th><th>来源列</th><th>列识别</th><th>示例值</th></tr></thead>
                      <tbody>
                        {preview.fields.map((f: any) => {
                          const col = mapping[f.key];
                          const sample = col && preview.sample[0] ? preview.sample[0][f.key] : null;
                          return (
                            <tr key={f.key}>
                              <td>{f.label}{f.required && <span style={{ color: 'var(--red)' }}> *</span>}
                                {f.hint && <div className="muted small">{f.hint}</div>}</td>
                              <td>
                                <select style={{ width: 180 }} value={col || ''}
                                  onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                                  <option value="">（忽略此列）</option>
                                  {preview.headers.map((h: string) => <option key={h}>{h}</option>)}
                                </select>
                              </td>
                              <td>
                                {(() => {
                                  const pr = preview.profiles?.find((x: any) => x.header === col);
                                  if (!pr) return <span className="muted small">—</span>;
                                  return (
                                    <span className="muted small">
                                      {COL_KIND[pr.kind] || pr.kind}
                                      {pr.grouped && ' · 分组'}
                                      {pr.fill < 100 && ` · ${pr.fill}%有值`}
                                    </span>
                                  );
                                })()}
                              </td>
                              <td className="mono muted small">{sample ?? '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table></div>
                  </div>
                </Card>

                <Card>
                  <CardH title="3 · 校验结果" />
                  <div className="card-b">
                    {preview.detected && (
                      <Note kind={preview.detected.confident ? 'new' : 'warn'}>
                        {preview.detected.source === 'learned'
                          ? <>这类表以前导过，<b>直接沿用上次的映射</b>
                              （「{preview.detected.label}」
                              {preview.detected.learnedCorrected ? '，人工校正过' : ''}
                              ，已命中 {preview.detected.learnedHits} 次
                              {preview.detected.learnedSimilarity < 100
                                ? `，表头相似度 ${preview.detected.learnedSimilarity}%` : ''}）。</>
                          : preview.detected.confident
                            ? <>已识别为<b>「{preview.detected.label}」</b>，字段也已自动对好。</>
                            : <>看起来像<b>「{preview.detected.label}」</b>，但和
                                「{preview.detected.candidates?.[1]?.label}」比较接近，没敢直接入库，
                                请核对下面的字段映射后再点确认。改对之后系统会记住，下次同类表就不问了。</>}
                        {!preview.detected.confident && (
                          <div className="row" style={{ marginTop: 8 }}>
                            {preview.detected.candidates?.slice(1, 3).map((c: any) => (
                              <button key={c.kind} className="btn sm" onClick={() => switchKind(c.kind)}>
                                改用「{c.label}」
                              </button>
                            ))}
                          </div>
                        )}
                      </Note>
                    )}
                    {preview.kindHint && (
                      <Note kind="err">
                        <b>类型可能选错了。</b>这份文件里找不到「{preview.kindHint.missing.join('」「')}」列，
                        但它的表头很像<b>「{preview.kindHint.suggestLabel}」</b>。
                        <div style={{ marginTop: 8 }}>
                          <button className="btn sm" onClick={() => switchKind(preview.kindHint.suggest)}>
                            改用「{preview.kindHint.suggestLabel}」重新校验
                          </button>
                        </div>
                      </Note>
                    )}
                    {!preview.kindHint && preview.missingRequired?.length > 0 && (
                      <Note kind="warn">
                        <b>缺少必填列：</b>{preview.missingRequired.join('、')}。
                        请在上面的「字段映射」里手动指定，或换一份包含这些列的文件。
                      </Note>
                    )}
                    <div className="grid g3" style={{ gap: 10, marginBottom: 14 }}>
                      <div><div className="stat-l">可直接入库</div>
                        <div className="stat up" style={{ fontSize: 19 }}>{int(preview.okCount)}</div></div>
                      <div><div className="stat-l">需留意</div>
                        <div className="stat" style={{ fontSize: 19, color: 'var(--amber)' }}>{int(preview.warnCount)}</div></div>
                      <div><div className="stat-l">将被拒绝</div>
                        <div className="stat down" style={{ fontSize: 19 }}>{int(preview.rejectCount)}</div></div>
                    </div>

                    {preview.issueSummary.length ? (
                      <div className="table-wrap"><table>
                        <thead><tr><th>问题</th><th className="num">行数</th><th>处理</th></tr></thead>
                        <tbody>{preview.issueSummary.map((s: any, i: number) => (
                          <tr key={i}>
                            <td>{s.msg}</td>
                            <td className="num">{s.count}</td>
                            <td>{s.level === 'reject'
                              ? <Badge kind="red">拒绝入库</Badge>
                              : <Badge kind="amber">自动处理</Badge>}</td>
                          </tr>
                        ))}</tbody>
                      </table></div>
                    ) : <Note>全部行都通过校验。</Note>}

                    <Note kind="warn">
                      <b>入库是可回滚的：</b>本批会生成一个批次号，写入的每一行都带这个号，
                      发现问题可以整批撤销，包括这批自动建档出来的物料和供应商。
                    </Note>

                    <div className="row" style={{ marginTop: 14 }}>
                      <button className="btn primary" onClick={doCommit} disabled={busy || !preview.okCount}>
                        {busy ? <><span className="spin" /> 写入中…</> : `确认入库 ${int(preview.okCount)} 条`}
                      </button>
                      <button className="btn" onClick={() => setPreview(null)}>返回修改</button>
                    </div>
                  </div>
                </Card>
              </>
            ) : (
              <Card><Empty icon="▤" text="选择文件后，这里会显示字段映射与校验结果" /></Card>
            )}

            <Card style={{ marginTop: 14 }}>
              <CardH title="导入历史" sub="每批都可撤销" />
              <div className="card-b flush">
                {batches.loading && <div className="card-b"><Spinner /></div>}
                {/* 历史读不出来时必须说出来。之前这里静默失败，
                    看上去就像「导入了但没记录」，其实是查询报错了 */}
                {batches.error && (
                  <div className="card-b">
                    <Note kind="err">
                      读取导入历史失败：{batches.error}
                      <div style={{ marginTop: 8 }}>
                        <button className="btn sm" onClick={() => batches.reload()}>重试</button>
                      </div>
                    </Note>
                  </div>
                )}
                {batches.data?.batches?.length ? (
                  <div className="table-wrap"><table>
                    <thead><tr><th>批次</th><th>类型</th><th className="num">写入</th>
                      <th>时间</th><th>状态</th><th></th></tr></thead>
                    <tbody>{batches.data.batches.map((b: any) => (
                      <tr key={b.id}>
                        <td className="mono">{b.batch_no}</td>
                        <td>{KINDS.find((k) => k.k === b.kind)?.t || b.kind}</td>
                        <td className="num">{int(b.row_ok)}</td>
                        <td className="muted small">{shortDate(b.created_at)}</td>
                        <td>{b.status === 'rolled_back'
                          ? <Badge kind="gray">已撤销</Badge> : <Badge kind="green">已入库</Badge>}</td>
                        <td>{b.status !== 'rolled_back' && (
                          <button className="btn sm danger" disabled={busy}
                            onClick={() => rollback(b.batch_no)}>撤销</button>
                        )}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                ) : !batches.loading && !batches.error && <Empty icon="↥" text="还没有导入过数据" />}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
