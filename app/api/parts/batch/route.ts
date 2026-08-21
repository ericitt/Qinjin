import { NextRequest, NextResponse } from 'next/server';
import { matchManyParts } from '@/lib/matching';
import { profileColumns } from '@/lib/profile';
import { parseDelimited } from '@/lib/import';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 批量查询：一次丢进几百个型号，返回每个的成本、均价、毛利。
 *
 * 输入接受三种形态，因为客户发过来的东西就是这三种形态：
 *   1. { pns: ["A","B"] }        —— 直接给数组
 *   2. { text: "粘贴的内容" }     —— 从 Excel 里复制出来的一片
 *   3. multipart 上传 .xls/.xlsx/.csv —— 客户直接发的报价单/BOM
 *
 * 后两种都要先猜出「哪一列是型号、哪一列是数量」。
 * 这里复用导入模块那套列内容画像 —— 那边已经能靠内容认出型号列了，
 * 没必要再写一套。
 */

const RE_PN_LIKE = /^[A-Za-z0-9][A-Za-z0-9\-_.\/()#+]{2,39}$/;

/** 从表格里挑出型号列和数量列 */
function pickColumns(table: string[][]): { pnIdx: number; qtyIdx: number } {
  const profiles = profileColumns(table);
  const header = table[0].map((h) => String(h ?? '').trim());

  // 先看表头有没有明说
  const byName = (words: string[]) =>
    header.findIndex((h) => words.some((w) => h.replace(/\s/g, '').includes(w)));
  let pnIdx = byName(['型号', '料号', 'pn', 'part', '物料', 'mpn']);
  let qtyIdx = byName(['数量', '用量', 'qty', 'quantity', '需求']);

  // 表头认不出就看内容：型号列 = 被判定成 pn 且填充率最高的那一列
  if (pnIdx < 0) {
    const cand = profiles.filter((p) => p.kind === 'pn').sort((a, b) => b.fill - a.fill);
    pnIdx = cand.length ? cand[0].index : -1;
  }
  if (qtyIdx < 0) {
    const cand = profiles.filter((p) => p.kind === 'int' && p.index !== pnIdx)
      .sort((a, b) => b.fill - a.fill);
    qtyIdx = cand.length ? cand[0].index : -1;
  }
  return { pnIdx, qtyIdx };
}

/** 纯文本（每行一个型号，可选空格/制表符跟数量）也要能用 */
function fromLines(text: string): { pn: string; qty: number }[] {
  const out: { pn: string; qty: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    // 先把千分位逗号粘回去，否则「100,000」会被切成 100 和 000，
    // 数量直接变成 100 —— 报价单上少三个零是要出事的
    const t = line.trim().replace(/(\d),(?=\d{3}\b)/g, '$1');
    if (!t) continue;
    const parts = t.split(/[\t,;，；\s]+/).filter(Boolean);
    const pn = parts.find((x) => RE_PN_LIKE.test(x));
    if (!pn) continue;
    const qty = parts.map((x) => Number(x.replace(/,/g, '')))
      .find((n) => Number.isFinite(n) && n > 0 && n !== Number(pn));
    out.push({ pn, qty: qty && qty > 0 ? qty : 1 });
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    let items: { pn: string; qty: number }[] = [];
    let note = '';

    const ct = req.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: '没有收到文件' }, { status: 400 });
      }
      const name = (file as File).name || 'upload';
      const buf = Buffer.from(await (file as File).arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readSpreadsheetBuffer, toTable, toCsv, decode } = require('../../../../lib/xls');

      let table: string[][];
      if (/\.(csv|tsv|txt)$/i.test(name)) {
        let t = buf.toString('utf8');
        if (t.includes('�')) t = decode(buf);
        table = parseDelimited(t.replace(/^﻿/, ''));
      } else {
        const sheets = readSpreadsheetBuffer(buf);
        const sheet = sheets.find((s: any) => s.cells.size) || sheets[0];
        if (!sheet) return NextResponse.json({ error: '文件里没有工作表' }, { status: 422 });
        table = parseDelimited(toCsv(
          toTable(sheet.cells).filter((r: any[]) => r.some((c) => String(c ?? '').trim() !== ''))
        ));
      }
      if (table.length < 2) return NextResponse.json({ error: '表格是空的' }, { status: 422 });

      const { pnIdx, qtyIdx } = pickColumns(table);
      if (pnIdx < 0) {
        return NextResponse.json({
          error: '找不到型号列。请确认表里有一列是元器件型号，或者把型号那一列的表头改成「型号」。',
          headers: table[0],
        }, { status: 422 });
      }
      note = `型号取自「${table[0][pnIdx] || `第 ${pnIdx + 1} 列`}」`
        + (qtyIdx >= 0 ? `，数量取自「${table[0][qtyIdx] || `第 ${qtyIdx + 1} 列`}」` : '，未找到数量列，一律按 1 计');
      for (const r of table.slice(1)) {
        const pn = String(r[pnIdx] ?? '').trim();
        if (!pn || !RE_PN_LIKE.test(pn)) continue;
        const q = qtyIdx >= 0 ? Number(String(r[qtyIdx] ?? '').replace(/,/g, '')) : 1;
        items.push({ pn, qty: Number.isFinite(q) && q > 0 ? q : 1 });
      }
    } else {
      const body = await req.json();
      if (Array.isArray(body.pns)) {
        items = body.pns.map((x: any) =>
          typeof x === 'string' ? { pn: x.trim(), qty: 1 } : { pn: String(x.pn).trim(), qty: Number(x.qty) || 1 });
      } else if (body.text) {
        const raw = String(body.text);
        // 多列（从 Excel 复制过来的）走表格解析，单列走逐行解析
        const table = parseDelimited(raw);
        if (table.length > 1 && table[0].length > 1) {
          const { pnIdx, qtyIdx } = pickColumns(table);
          if (pnIdx >= 0) {
            note = `型号取自第 ${pnIdx + 1} 列`;
            for (const r of table.slice(1)) {
              const pn = String(r[pnIdx] ?? '').trim();
              if (!pn || !RE_PN_LIKE.test(pn)) continue;
              const q = qtyIdx >= 0 ? Number(String(r[qtyIdx] ?? '').replace(/,/g, '')) : 1;
              items.push({ pn, qty: Number.isFinite(q) && q > 0 ? q : 1 });
            }
          }
        }
        if (!items.length) items = fromLines(raw);
      }
    }

    // 同一个型号出现多次就合并数量，免得结果表里同一行出现三遍
    const merged = new Map<string, number>();
    for (const it of items) {
      if (!it.pn) continue;
      merged.set(it.pn, (merged.get(it.pn) || 0) + it.qty);
    }
    const list = Array.from(merged, ([pn, qty]) => ({ pn, qty })).slice(0, 500);

    if (!list.length) {
      return NextResponse.json({ error: '没有解析出任何型号', note }, { status: 422 });
    }

    const results = await matchManyParts(list);
    const hit = results.filter((r) => r.part).length;
    return NextResponse.json({
      results, note,
      total: list.length,
      hit,
      miss: list.length - hit,
      truncated: merged.size > 500 ? merged.size : 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
