import { NextRequest, NextResponse } from 'next/server';
// lib/xls.js 是手写的 CommonJS 解析器（沙箱里装不了 xlsx 之类的包），这里 require 进来
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readSpreadsheetBuffer, toTable, toCsv, decode } = require('../../../../lib/xls');

// 必须跑在 Node runtime：用到了 Buffer / zlib
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 上传文件 → CSV 文本。
 *
 * 为什么要有这个接口：龙威 ERP 导的是 .xls（BIFF5/BIFF8）和 .xlsx，
 * 以前要求用户先「另存为 CSV UTF-8」，这一步既麻烦又常常存成 GBK 导致中文全是乱码。
 * 现在直接把原始文件丢上来，服务端解析成 UTF-8 的 CSV 再走原来的预览/入库流程。
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: '没有收到文件' }, { status: 400 });
    }
    const name = (file as File).name || 'upload';
    const buf = Buffer.from(await (file as File).arrayBuffer());
    if (!buf.length) return NextResponse.json({ error: '文件是空的' }, { status: 422 });

    let csv: string;
    if (/\.(csv|tsv|txt)$/i.test(name)) {
      // 文本文件：先按 UTF-8 试，出现替换字符(U+FFFD)说明其实是 GBK，改用 GBK 重解
      let text = buf.toString('utf8');
      if (text.includes('�')) text = decode(buf);
      csv = text.replace(/^﻿/, '');
      // 制表符分隔的先转成逗号分隔，后面 parseDelimited 两种都认，这里保持原样即可
    } else {
      const sheets = readSpreadsheetBuffer(buf);
      if (!sheets.length) return NextResponse.json({ error: '这个文件里没有工作表' }, { status: 422 });
      // 只取第一个非空工作表；ERP 导出通常就一个 sheet
      const sheet = sheets.find((s: any) => s.cells.size) || sheets[0];
      const table = toTable(sheet.cells)
        .filter((r: any[]) => r.some((c) => String(c ?? '').trim() !== ''));
      if (table.length < 2) return NextResponse.json({ error: '表格是空的或只有表头' }, { status: 422 });
      csv = toCsv(table);
    }
    return NextResponse.json({ fileName: name, text: csv, bytes: buf.length });
  } catch (err: any) {
    return NextResponse.json({ error: '解析失败：' + err.message }, { status: 500 });
  }
}
