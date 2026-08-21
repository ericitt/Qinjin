'use client';
import { useState } from 'react';
import Topbar from '../components/Topbar';
import {
  api, useAsync, Card, CardH, Badge, Empty, Note, Spinner,
  money, int, fmt, shortDate,
} from '../components/ui';

/* 每个标签页都对应一件能直接去做的事，不放"仅供参考"的图表 */
const TABS = [
  { k: 'sleeping', t: '该回访了', d: '按客户自己的下单节奏判断谁不正常地安静了' },
  { k: 'cross', t: '交叉销售', d: '别人一起买、这个客户还没买的型号' },
  { k: 'bom', t: '伺服客户', d: '照真实 BOM 反查谁在做伺服、还缺什么料' },
  { k: 'supply', t: '供应缺口', d: 'BOM 里找不到供应商报价的料' },
];

export default function OpportunitiesPage() {
  const [tab, setTab] = useState('sleeping');
  const sum = useAsync(() => api('/api/insights'), []);
  const data = useAsync<any>(() => api(`/api/insights?tab=${tab}`), [tab]);

  return (
    <>
      <Topbar title="商机" sub="从已有的出货、报价和 BOM 里挖出来的可执行线索" />
      <div className="page">
        <div className="grid g4" style={{ gap: 10, marginBottom: 14 }}>
          <div><div className="stat-l">客户数</div>
            <div className="stat" style={{ fontSize: 20 }}>{int(sum.data?.customers)}</div></div>
          <div><div className="stat-l">带客户的出货记录</div>
            <div className="stat" style={{ fontSize: 20 }}>{int(sum.data?.shipments_with_customer)}</div></div>
          <div><div className="stat-l">BOM 物料</div>
            <div className="stat" style={{ fontSize: 20 }}>{int(sum.data?.bom_parts)}</div></div>
          <div><div className="stat-l">BOM 机型</div>
            <div className="stat" style={{ fontSize: 20 }}>{int(sum.data?.bom_models)}</div></div>
        </div>

        <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          {TABS.map((x) => (
            <button key={x.k} className={`btn ${tab === x.k ? 'primary' : ''}`}
              onClick={() => setTab(x.k)}>{x.t}</button>
          ))}
        </div>
        <Note>{TABS.find((x) => x.k === tab)?.d}</Note>

        {data.loading && <Card><div className="card-b"><Spinner text="计算中…" /></div></Card>}
        {data.error && <Note kind="err">{data.error}</Note>}

        {!data.loading && !data.error && tab === 'sleeping' && <Sleeping d={data.data} />}
        {!data.loading && !data.error && tab === 'cross' && <Cross d={data.data} />}
        {!data.loading && !data.error && tab === 'bom' && <Bom d={data.data} />}
        {!data.loading && !data.error && tab === 'supply' && <Supply d={data.data} />}
      </div>
    </>
  );
}

/* ---------------- 该回访了 ---------------- */
function Sleeping({ d }: { d: any }) {
  const cs = d?.customers || [];
  const ps = d?.parts || [];
  return (
    <>
      <Note kind="new">
        <b>不是简单按「多久没来」排序。</b>
        有的客户本来就是每半年下一次单，沉默四个月完全正常；有的每周都来，沉默一个月就是出事了。
        所以先算出每个客户自己历史订单间隔的中位数，再看现在超了几倍。
        排序用的是「月均贡献 × 超期倍数」—— 一个只买过几百块的客户消失两年，不值得你打电话。
      </Note>

      <Card style={{ marginTop: 14 }}>
        <CardH title="客户" sub={`${cs.length} 个客户的沉默时间明显超出自己的常规节奏`} />
        <div className="card-b flush">
          {cs.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>客户</th><th>联系人</th><th className="num">月均贡献</th>
                <th className="num">已沉默</th><th className="num">常规间隔</th>
                <th className="num">超期</th><th className="num">历史总额</th><th>最后一单</th>
              </tr></thead>
              <tbody>{cs.map((c: any) => (
                <tr key={c.id}>
                  <td><b>{c.short_name || c.name}</b>
                    {c.level && <> <Badge kind="gray">{c.level}</Badge></>}
                    <div className="muted small">买过 {int(c.part_kinds)} 种料 · {int(c.order_days)} 次下单</div></td>
                  <td className="small">{c.contact_name || '—'}
                    <div className="muted small">{c.phone || ''}</div></td>
                  <td className="num">{money(c.monthly_amt)}</td>
                  <td className="num">{int(c.silent_days)} 天</td>
                  <td className="num muted">{int(c.median_gap)} 天</td>
                  <td className="num">
                    <Badge kind={c.overdue_ratio >= 3 ? 'red' : c.overdue_ratio >= 2 ? 'amber' : 'gray'}>
                      {fmt(c.overdue_ratio, 1)}×
                    </Badge>
                  </td>
                  <td className="num muted">{money(c.total_amt)}</td>
                  <td className="muted small">{shortDate(c.last_date)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="card-b"><Empty icon="✓" text="没有异常沉默的客户" /></div>}
        </div>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <CardH title="型号" sub="这颗料他以前是规律在买的，现在停了 —— 可以直接拿着型号去问" />
        <div className="card-b flush">
          {ps.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>客户</th><th>型号</th><th className="num">买过</th>
                <th className="num">已沉默</th><th className="num">常规间隔</th><th className="num">累计金额</th>
              </tr></thead>
              <tbody>{ps.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.short_name || r.customer}</td>
                  <td className="mono">{r.pn}
                    {r.brand && <div className="muted small">{r.brand}</div>}</td>
                  <td className="num">{int(r.times)} 次</td>
                  <td className="num">{int(r.silent_days)} 天</td>
                  <td className="num muted">{int(r.median_gap)} 天</td>
                  <td className="num">{money(r.total_amt)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="card-b"><Empty icon="✓" text="没有明显停买的型号" /></div>}
        </div>
      </Card>
    </>
  );
}

/* ---------------- 交叉销售 ---------------- */
function Cross({ d }: { d: any }) {
  const rows = d?.pairs || [];
  return (
    <>
      <Note kind="warn">
        <b>先看「共同客户数」再看提升度。</b>
        你的客户基数只有几十个，两颗料凑巧被同 3 个客户买过是很容易发生的。
        提升度 = 实际共同出现频率 ÷ 随机情况下的期望频率，大于 1 说明有关联，
        但支撑数太小的时候它只是个线索，不是结论 —— 所以这里把支撑数直接列出来给你判断。
      </Note>
      <Card style={{ marginTop: 14 }}>
        <CardH title="常被一起采购的型号" sub={`${rows.length} 组，提升度 ≥ 1.5 且至少 3 个客户同时买过`} />
        <div className="card-b flush">
          {rows.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>型号 A</th><th>型号 B</th>
                <th className="num">共同客户</th><th className="num">买 A 的</th><th className="num">买 B 的</th>
                <th className="num">提升度</th><th>怎么用</th>
              </tr></thead>
              <tbody>{rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{r.pn_x}</td>
                  <td className="mono">{r.pn_y}</td>
                  <td className="num"><b>{int(r.both)}</b></td>
                  <td className="num muted">{int(r.n_x)}</td>
                  <td className="num muted">{int(r.n_y)}</td>
                  <td className="num">
                    <Badge kind={r.lift >= 3 ? 'green' : r.lift >= 2 ? 'blue' : 'gray'}>
                      {fmt(r.lift, 1)}×
                    </Badge>
                  </td>
                  <td className="small muted">
                    买了 A 的客户里 {Math.round(r.conf_x_to_y * 100)}% 也买了 B
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : (
            <div className="card-b">
              <Empty icon="⌕" text="没有达到门槛的组合"
                hint="需要至少 3 个客户同时买过同两颗料。客户数或带客户的出货记录再多一些才跑得出来。" />
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

/* ---------------- 伺服客户 ---------------- */
function Bom({ d }: { d: any }) {
  const [pick, setPick] = useState<number | null>(null);
  const cs = d?.customers || [];
  const gaps = (d?.gaps || []).filter((g: any) => pick === null || g.customer_id === pick);

  if (!d?.meta?.bom_parts) {
    return (
      <Card style={{ marginTop: 14 }}>
        <div className="card-b">
          <Empty icon="▤" text="数据库里还没有 BOM"
            hint="这一页靠 bom_items 里的真实伺服驱动器 BOM 做基准。先把 BOM 导进来再看。" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Note kind="new">
        <b>基准是你自己的真实 BOM，不是猜的型号族。</b>
        库里有 {int(d.meta.models)} 款伺服驱动器、共 {int(d.meta.bom_parts)} 种物料。
        客户买过的型号落在 BOM 里的越多，越说明他在做伺服；BOM 里他没在你这买的部分，
        就是可以直接拿去谈的缺口清单。
      </Note>

      <Card style={{ marginTop: 14 }}>
        <CardH title="疑似伺服客户" sub="点一行看他缺哪些料" />
        <div className="card-b flush">
          {cs.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>客户</th><th>联系人</th><th className="num">命中 BOM 物料</th>
                <th className="num">覆盖率</th><th className="num">BOM 相关金额</th>
                <th className="num">总金额</th><th>最后一单</th>
              </tr></thead>
              <tbody>{cs.map((c: any) => (
                <tr key={c.id} style={{ cursor: 'pointer', background: pick === c.id ? 'var(--hover, rgba(0,0,0,.03))' : undefined }}
                  onClick={() => setPick(pick === c.id ? null : c.id)}>
                  <td><b>{c.short_name || c.name}</b></td>
                  <td className="small">{c.contact_name || '—'}
                    <div className="muted small">{c.phone || ''}</div></td>
                  <td className="num"><b>{int(c.bom_hit)}</b>
                    <span className="muted"> / {int(c.bom_total)}</span></td>
                  <td className="num">
                    <Badge kind={c.bom_hit / c.bom_total >= 0.3 ? 'green' : c.bom_hit / c.bom_total >= 0.1 ? 'blue' : 'gray'}>
                      {Math.round((c.bom_hit / c.bom_total) * 100)}%
                    </Badge>
                  </td>
                  <td className="num">{money(c.bom_amt)}</td>
                  <td className="num muted">{money(c.total_amt)}</td>
                  <td className="muted small">{shortDate(c.last_date)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="card-b"><Empty icon="⌕" text="没有客户买过 BOM 里的物料" /></div>}
        </div>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <CardH title="缺口清单"
          sub={pick ? '这个客户没在你这买过的 BOM 物料' : '点上面某个客户可以只看他的'}
          right={pick ? <button className="btn sm" onClick={() => setPick(null)}>看全部</button> : undefined} />
        <div className="card-b flush">
          {gaps.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>客户</th><th>型号</th><th>用在</th>
                <th className="num">单机用量</th><th className="num">最低报价</th><th className="num">可供应商</th>
              </tr></thead>
              <tbody>{gaps.slice(0, 120).map((g: any, i: number) => (
                <tr key={i}>
                  <td className="small">{g.short_name || g.customer}</td>
                  <td className="mono">{g.pn}
                    {g.brand && <div className="muted small">{g.brand}</div>}</td>
                  <td className="muted small">{g.models}</td>
                  <td className="num">{int(g.qty_per_unit)}</td>
                  <td className="num">{g.best_price ? money(g.best_price) : <span className="muted">无报价</span>}</td>
                  <td className="num">
                    {g.supplier_count > 0
                      ? <Badge kind="green">{g.supplier_count}</Badge>
                      : <Badge kind="red">0</Badge>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="card-b"><Empty icon="✓" text="没有缺口" /></div>}
        </div>
      </Card>
    </>
  );
}

/* ---------------- 供应缺口 ---------------- */
function Supply({ d }: { d: any }) {
  const rows = d?.rows || [];
  const none = rows.filter((r: any) => !r.supplier_count).length;
  return (
    <>
      <Note kind="warn">
        <b>BOM 里有 {int(none)} 种料一个供应商报价都没有。</b>
        接伺服整机单的时候，卡住的往往就是这几颗 —— 客户问得出、你报不出。
        下面按「供应商数量从少到多、出货次数从多到少」排，最上面的是最该先去开发的。
      </Note>
      <Card style={{ marginTop: 14 }}>
        <CardH title="BOM 物料的供应覆盖" sub={`共 ${rows.length} 种`} />
        <div className="card-b flush">
          {rows.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th>型号</th><th>品牌</th><th>用在</th>
                <th className="num">可供应商</th><th className="num">最低报价</th>
                <th className="num">BOM 价</th><th className="num">出货次数</th>
              </tr></thead>
              <tbody>{rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{r.pn}
                    {r.spec && <div className="muted small">{String(r.spec).slice(0, 40)}</div>}</td>
                  <td className="small">{r.brand || '—'}</td>
                  <td className="muted small">{r.models}</td>
                  <td className="num">
                    {r.supplier_count > 0
                      ? <Badge kind={r.supplier_count >= 3 ? 'green' : 'amber'}>{r.supplier_count}</Badge>
                      : <Badge kind="red">缺</Badge>}
                  </td>
                  <td className="num">{r.best_price ? money(r.best_price) : '—'}</td>
                  <td className="num muted">{r.bom_price ? money(r.bom_price) : '—'}</td>
                  <td className="num muted">{int(r.ship_times)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="card-b"><Empty icon="▤" text="库里还没有 BOM 数据" /></div>}
        </div>
      </Card>
    </>
  );
}
