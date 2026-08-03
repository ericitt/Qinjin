/**
 * 极简 .xls 解析器，同时支持两种老格式：
 *
 *   - BIFF5/BIFF7（Excel 5.0/95）：裸记录流，字符串按 GBK(cp936) 存字节
 *   - BIFF8（Excel 97-2003）：外面套一层 OLE2 复合文档，
 *     字符串集中放在 SST 共享字符串表里，单元格只存索引
 *
 * 为什么需要自己写：ERP（用友/管家婆这类）导出的就是这两种格式，
 * openpyxl 只认 xlsx 完全读不了，pandas 需要 xlrd，而这台机器装不了依赖。
 * 这里只需要「读出单元格」这一件事，自己写反而最省事。
 *
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
  SST: 0x00fc, LABELSST: 0x00fd, CONTINUE: 0x003c,
};

/* =====================================================================
   OLE2 / CFB 复合文档：把里面的 Workbook 流抠出来
   BIFF8 的 .xls 本质是个「文件系统里的文件系统」，
   真正的表格数据在名为 Workbook（老版本叫 Book）的流里。
   ===================================================================== */
function readOle2Streams(buf) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0) return null;   // 不是 OLE2
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const numMiniFat = buf.readUInt32LE(64);
  let difatSect = buf.readUInt32LE(68);
  const numDifat = buf.readUInt32LE(72);
  const off = (s) => (s + 1) * sectorSize;

  // DIFAT：前 109 个 FAT 扇区号写在文件头里，多的放在后续 DIFAT 扇区
  const fatSectors = [];
  for (let i = 0; i < 109 && i < numFat; i++) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  for (let k = 0; k < numDifat && difatSect !== 0xfffffffe && difatSect < 0xfffffffc; k++) {
    const base = off(difatSect);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) fatSectors.push(buf.readUInt32LE(base + i * 4));
    difatSect = buf.readUInt32LE(base + per * 4);
  }

  const fat = [];
  for (const s of fatSectors) {
    if (s >= 0xfffffffc) continue;
    const base = off(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readUInt32LE(base + i * 4));
  }
  const chain = (start) => {
    const out = []; let s = start; let guard = 0;
    while (s < 0xfffffffc && guard++ < 1e6) { out.push(s); s = fat[s]; }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start).map((s) => buf.subarray(off(s), off(s) + sectorSize));
    const all = Buffer.concat(parts);
    return size ? all.subarray(0, size) : all;
  };

  // 目录项：每条 128 字节，名字是 UTF-16LE
  const dirBuf = readChain(firstDir);
  const entries = [];
  for (let p = 0; p + 128 <= dirBuf.length; p += 128) {
    const nameLen = dirBuf.readUInt16LE(p + 64);
    if (!nameLen) continue;
    const name = dirBuf.subarray(p, p + Math.max(nameLen - 2, 0)).toString('utf16le');
    entries.push({ name, type: dirBuf[p + 66], start: dirBuf.readUInt32LE(p + 116), size: dirBuf.readUInt32LE(p + 120) });
  }

  const root = entries.find((e) => e.type === 5);
  const miniFat = [];
  if (numMiniFat) {
    const mf = readChain(firstMiniFat);
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readUInt32LE(i * 4));
  }
  const miniStream = root && root.size ? readChain(root.start) : Buffer.alloc(0);

  const out = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;                          // 只要流
    if (e.size >= miniCutoff) out.set(e.name, readChain(e.start, e.size));
    else {
      // 小于 4096 的流放在 mini stream 里，按 64 字节的迷你扇区串起来
      const parts = []; let s = e.start; let guard = 0;
      while (s < 0xfffffffc && guard++ < 1e6) {
        parts.push(miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize));
        s = miniFat[s];
      }
      out.set(e.name, Buffer.concat(parts).subarray(0, e.size));
    }
  }
  return out;
}

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

/**
 * 解析 BIFF8 的 SST 共享字符串表。
 * 麻烦之处：一条字符串可能被 CONTINUE 记录从中间切断，
 * 而且切断后的下一段会重新写一个「是否 16 位」的标志字节，
 * 所以不能简单地把各段 buffer 拼起来，必须按段推进。
 */
function parseSst(segments) {
  const strings = [];
  let si = 0;                       // 当前在第几段
  let p = 8;                        // 跳过 SST 头部的 total / count
  const seg = () => segments[si];
  const need = (n) => {             // 保证当前段至少还有 n 字节，不够就换下一段
    while (si < segments.length && p >= seg().length) { si++; p = 0; }
    return si < segments.length && p + n <= seg().length;
  };

  while (si < segments.length) {
    if (!need(3)) break;
    const cch = seg().readUInt16LE(p); p += 2;
    let grbit = seg()[p]; p += 1;
    let rich = 0, ext = 0;
    if (grbit & 0x08) { if (!need(2)) break; rich = seg().readUInt16LE(p); p += 2; }
    if (grbit & 0x04) { if (!need(4)) break; ext = seg().readUInt32LE(p); p += 4; }

    let out = '';
    let left = cch;
    let wide = (grbit & 0x01) !== 0;
    while (left > 0) {
      while (si < segments.length && p >= seg().length) {
        si++; p = 0;
        if (si < segments.length) { wide = (seg()[p] & 0x01) !== 0; p += 1; }  // 新段重写标志位
      }
      if (si >= segments.length) break;
      const avail = seg().length - p;
      const canChars = wide ? Math.floor(avail / 2) : avail;
      const take = Math.min(left, canChars);
      if (take <= 0) { p = seg().length; continue; }
      const bytes = seg().subarray(p, p + take * (wide ? 2 : 1));
      out += wide ? bytes.toString('utf16le')
                  : Buffer.from(bytes).toString('latin1');   // 压缩格式即 UTF-16 的低字节
      p += take * (wide ? 2 : 1);
      left -= take;
    }
    // 跳过富文本格式段与远东注音段
    let skip = rich * 4 + ext;
    while (skip > 0 && si < segments.length) {
      const avail = seg().length - p;
      if (skip < avail) { p += skip; skip = 0; }
      else { skip -= avail; si++; p = 0; }
    }
    strings.push(out);
  }
  return strings;
}

function readXls(pathOrBuffer) {
  let data = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : fs.readFileSync(pathOrBuffer);

  // BIFF8 外面套了一层 OLE2，先把 Workbook 流取出来
  const streams = readOle2Streams(data);
  if (streams) {
    const wb = streams.get('Workbook') || streams.get('Book');
    if (!wb) throw new Error('OLE2 文件里找不到 Workbook 流');
    data = wb;
  }

  const sheets = [];
  const names = [];
  let cur = null;
  let pos = 0;
  let sst = null;
  let biff8 = false;

  // 第一遍：找 SST（它在所有工作表之前），顺便判断是不是 BIFF8
  {
    let p = 0;
    while (p + 4 <= data.length) {
      const rid = data.readUInt16LE(p);
      const len = data.readUInt16LE(p + 2);
      if (rid === REC.BOF && len >= 4 && data.readUInt16LE(p + 4) >= 0x0600) biff8 = true;
      if (rid === REC.SST) {
        const segs = [data.subarray(p + 4, p + 4 + len)];
        let q = p + 4 + len;
        while (q + 4 <= data.length && data.readUInt16LE(q) === REC.CONTINUE) {
          const cl = data.readUInt16LE(q + 2);
          segs.push(data.subarray(q + 4, q + 4 + cl));
          q += 4 + cl;
        }
        sst = parseSst(segs);
        break;
      }
      p += 4 + len;
    }
  }

  while (pos + 4 <= data.length) {
    const rid = data.readUInt16LE(pos);
    const len = data.readUInt16LE(pos + 2);
    const body = data.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (body.length < len) break;

    if (rid === REC.BOUNDSHEET && body.length >= 8) {
      // BIFF8 的表名是 Unicode 串：cch(1) + grbit(1) + 数据
      if (biff8) {
        const cch = body[6], gr = body[7];
        names.push((gr & 1) ? body.subarray(8, 8 + cch * 2).toString('utf16le')
                            : decode(body.subarray(8, 8 + cch)));
      } else {
        names.push(decode(body.subarray(7, 7 + body[6])));
      }
      continue;
    }
    if (rid === REC.LABELSST && cur && body.length >= 10) {
      const r = body.readUInt16LE(0), c = body.readUInt16LE(2);
      const idx = body.readUInt32LE(6);
      cur.cells.set(r + ':' + c, (sst && sst[idx] !== undefined ? sst[idx] : '').trim());
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

/* =====================================================================
   .xlsx 读取（Excel 2007+，本质是个 zip）
   只用 Node 自带的 zlib，不引第三方库。
   需要的只有两个文件：sharedStrings.xml（字符串表）和 sheet1.xml（单元格）。
   ===================================================================== */
const zlib = require('zlib');

/** 解析 zip 的中央目录，把需要的条目解出来 */
function unzip(buf, wanted) {
  const out = new Map();
  // 从尾部找 End of Central Directory 签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 zip/xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (wanted && !wanted(name)) continue;
    // 本地文件头里的长度字段才准
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
  }
  return out;
}

const XML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENT[m])
                      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
                      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

/** A1 → {r, c}（0 基） */
function refToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

function readXlsx(pathOrBuffer) {
  const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : fs.readFileSync(pathOrBuffer);
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));

  // 共享字符串
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // 一个 si 里可能有多个 t（富文本分段），拼起来
      let s = '';
      for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(t[1]);
      shared.push(s);
    }
  }

  // 表名
  const names = [];
  const wb = files.get('xl/workbook.xml');
  if (wb) for (const m of wb.toString('utf8').matchAll(/<sheet[^>]*name="([^"]*)"/g)) names.push(unesc(m[1]));

  const sheetFiles = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const sheets = [];
  sheetFiles.forEach((fn, i) => {
    const xml = files.get(fn).toString('utf8');
    const cells = new Map();
    for (const m of xml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] || '';
      const inner = m[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      if (!ref) continue;
      const rc = refToRC(ref[1]);
      if (!rc) continue;
      const type = /t="([^"]*)"/.exec(attrs)?.[1];
      let val;
      if (type === 'inlineStr') {
        let s = '';
        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(t[1]);
        val = s;
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (!v) continue;
        if (type === 's') val = shared[Number(v[1])] ?? '';
        else if (type === 'str' || type === 'e') val = unesc(v[1]);
        else {
          const n = Number(v[1]);
          val = Number.isFinite(n) ? n : unesc(v[1]);
        }
      }
      if (typeof val === 'string') val = val.trim();
      cells.set(rc.r + ':' + rc.c, val);
    }
    sheets.push({ name: names[i] || `Sheet${i + 1}`, cells });
  });
  return sheets;
}

/** 统一入口：按文件头自动判断是 xlsx 还是 xls，返回一样的结构 */
function readSpreadsheet(path) {
  const buf = fs.readFileSync(path);
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);  // PK.. → zip
  return readXls(buf);
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

module.exports = {
  readXls, readXlsx, readSpreadsheet,
  toTable, forwardFill, toCsv, rkToNumber, decode,
};
