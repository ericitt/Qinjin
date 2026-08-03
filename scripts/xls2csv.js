#!/usr/bin/env node
/**
 * 把 ERP 导出的老式 .xls（Excel 5.0/95，GBK 编码）转成 UTF-8 CSV，
 * 转完就能直接丢进「数据导入」页。
 *
 * 用法：
 *   node scripts/xls2csv.js 文件.xls                      # 输出 文件.csv
 *   node scripts/xls2csv.js 文件.xls --ffill 0            # 第 0 列向下填充（分组报表必加）
 *   node scripts/xls2csv.js 文件.xls -o 输出.csv --ffill 0
 *
 * 关于 --ffill：ERP 的分组报表里，同一个客户/供应商只在该组第一行打印名字，
 * 其余行是空的。不加这个参数，98% 的行会丢掉客户/供应商。
 */
const fs = require('fs');
const path = require('path');
const { readXls, toTable, forwardFill, toCsv } = require('../lib/xls');

const args = process.argv.slice(2);
if (!args.length) {
  console.log('用法: node scripts/xls2csv.js <文件.xls> [-o 输出.csv] [--ffill 列号,列号] [--sheet N]');
  process.exit(1);
}

const input = args[0];
const outFlag = args.indexOf('-o');
const ffillFlag = args.indexOf('--ffill');
const sheetFlag = args.indexOf('--sheet');
const output = outFlag > -1 ? args[outFlag + 1] : input.replace(/\.xls$/i, '') + '.csv';
const ffillCols = ffillFlag > -1 ? args[ffillFlag + 1].split(',').map(Number) : [];
const sheetIdx = sheetFlag > -1 ? Number(args[sheetFlag + 1]) : 0;

if (!fs.existsSync(input)) {
  console.error('找不到文件:', input);
  process.exit(1);
}

const sheets = readXls(input);
if (!sheets.length) {
  console.error('没有解析出任何工作表 —— 这个文件可能不是 BIFF5/BIFF7 格式');
  process.exit(1);
}
const sheet = sheets[sheetIdx];
if (!sheet) {
  console.error(`没有第 ${sheetIdx} 个工作表，实际有 ${sheets.length} 个`);
  process.exit(1);
}

const table = toTable(sheet.cells);
if (table.length < 2) {
  console.error('表格是空的');
  process.exit(1);
}

const header = table[0];
const body = table.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
for (const c of ffillCols) {
  const before = body.filter((r) => String(r[c] ?? '').trim()).length;
  forwardFill(body, c);
  const after = body.filter((r) => String(r[c] ?? '').trim()).length;
  console.log(`  向下填充第 ${c} 列「${header[c]}」：${before} → ${after} 行有值`);
}

fs.writeFileSync(output, toCsv([header, ...body]), 'utf8');
console.log(`✓ ${path.basename(input)} → ${path.basename(output)}`);
console.log(`  工作表「${sheet.name}」 ${body.length} 行 × ${header.length} 列`);
console.log(`  列名: ${header.map(String).join(' | ')}`);
