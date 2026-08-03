/**
 * 极简 BIFF5/BIFF7 (.xls) 解析器
 *
 * 为什么需要自己写：ERP（用友/管家婆这类）导出的 .xls 其实是 Excel 5.0/95 格式，
 * 字符串按 GBK(cp936) 存成字节串，没有 SST 共享字符串表。
 * 这种老格式 openpyxl 读不了（它只支持 xlsx），SheetJS 能读但要装依赖，
 * 而这里只需要「读出单元格」这一件事，直接写一个 200 行的解析器更省事。
 *
 * 支持的记录：LABEL / NUMBER / RK / MULRK / FORMULA(数值结果) / BOUNDSHEET
 * 用法：
 *   const { readXls, toTable } = require('./xls');
 *   const sheets = readXls('文件.xls');       // [{name, cells}]
 *   const rows = toTable(sheets[0].cells);    // 二维数组
 */
const fs = require('fs');

const REC = {
  BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085,
  LABEL: 0x0204, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd,
  FORMULA: 0x0006, BLANK: 0x0201, CODEPAGE: 0x0042,
};

/** RK 值解码：低两位是标志位（是否除以 100 / 是否整数） */
function rkToNumber(rk) {
  const cents = rk & 1;
  const isInt = rk & 2;
  let v;
  if (isInt) {
    // 30 位有符号整数
    let i = rk >> 2;
    if (i & 0x20000000) i -= 0x40000000;
    v = i;
  } else {
    // 高 30 位是 IEEE754 双精度的高位
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(rk & 0xfffffffc, 4);
    v = buf.readDoubleLE(0);
  }
  return cents ? v / 100 : v;
}

/** GBK 解码。Node 自带 ICU 通常支持 gbk；不支持时退回 latin1，至少数字不丢 */
function decode(buf) {
  try {
    return new TextDecoder('gbk').decode(buf).trim();
  } catch {
    try { return new TextDecoder('cp936').decode(buf).trim(); }
    catch { return buf.toString('latin1').trim(); }
  }
}

function readXls(pathOrBuffer) {
  const data = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : fs.readFileSync(pathOrBuffer);
  const sheets = [];
  const names = [];
  let cur = null;
  let pos = 0;

  while (pos + 4 <= data.length) {
    const rid = data.readUInt16LE(pos);
    const len = data.readUInt16LE(pos + 2);
    const body = data.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (body.length < len) break;

    if (rid === REC.BOUNDSHEET && body.length >= 8) {
      names.push(decode(body.subarray(7, 7 + body[6])));
      continue;
    }
    if (rid === REC.BOF) {
      // dt === 0x0010 表示这是一个工作表的开始
      if (body.length >= 4 && body.readUInt16LE(2) === 0x0010) {
        cur = { name: names[sheets.length] || `Sheet${sheets.length + 1}`, cells: new Map() };
        sheets.push(cur);
      }
      continue;
    }
    if (!cur || body.length < 6) continue;

    const row = body.readUInt16LE(0);
    let col = body.readUInt16LE(2);
    const key = (r, c) => r + ':' + c;

    switch (rid) {
      case REC.LABEL: {
        const cch = body.readUInt16LE(6);
        cur.cells.set(key(row, col), decode(body.subarray(8, 8 + cch)));
        break;
      }
      case REC.NUMBER:
        cur.cells.set(key(row, col), body.readDoubleLE(6));
        break;
      case REC.RK:
        cur.cells.set(key(row, col), rkToNumber(body.readInt32LE(6)));
        break;
      case REC.MULRK: {
        let k = 4;
        while (k + 6 <= body.length - 2) {
          cur.cells.set(key(row, col), rkToNumber(body.readInt32LE(k + 2)));
          col++; k += 6;
        }
        break;
      }
      case REC.FORMULA: {
        // 结果为字符串/布尔/错误时高两字节是 0xFFFF，这里只取数值结果
        if (body.readUInt16LE(12) !== 0xffff) cur.cells.set(key(row, col), body.readDoubleLE(6));
        break;
      }
      default:
        break;
    }
  }
  return sheets;
}

function toTable(cells) {
  if (!cells.size) return [];
  let maxR = 0, maxC = 0;
  for (const k of cells.keys()) {
    const [r, c] = k.split(':').map(Number);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  const out = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(cells.get(r + ':' + c) ?? '');
    out.push(row);
  }
  return out;
}

/**
 * 分组报表的「向下填充」：ERP 导出时同一客户/供应商只在该组第一行打印名字，
 * 其余行留空。不填充的话 98% 的行都会丢掉客户。
 */
function forwardFill(rows, colIndex) {
  let last = '';
  for (const r of rows) {
    const v = String(r[colIndex] ?? '').trim();
    if (v) last = v; else r[colIndex] = last;
  }
  return rows;
}

function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

module.exports = { readXls, toTable, forwardFill, toCsv, rkToNumber, decode };
