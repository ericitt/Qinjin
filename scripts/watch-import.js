#!/usr/bin/env node
/**
 * 文件夹自动导入：把 ERP 导出的表丢进一个文件夹，系统自己识别、清洗、入库。
 *
 *   npm run sync            持续监听（默认每 5 分钟扫一次）
 *   npm run sync -- --once  只扫一遍就退出（配 Windows 计划任务用这个）
 *
 * 工作流程：
 *   收件箱/  ← 你（或龙威的定时导出）把文件丢这里
 *     ├─ 已导入/   成功的挪到这里，按日期归档
 *     └─ 失败/     出错的挪到这里，旁边放一个 .错误.txt 说明原因
 *
 * 为什么不直接写数据库：走应用自己的 /api/import 接口，
 * 就自动复用了字段映射、校验、批次号、可回滚这一整套，
 * 不用维护两份逻辑，出问题也能在「数据导入」页面里看到并撤销。
 *
 * 幂等：ERP 导出的是全量累计表，同一份文件反复导入不会产生重复行
 * （出货靠 src_key 自然键，供应商报价靠 supplier_id+part_id 唯一约束）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readSpreadsheet, toTable, forwardFill, toCsv } = require('../lib/xls');
require('dotenv').config();

const INBOX = process.env.SYNC_INBOX || path.join(process.cwd(), 'data', 'inbox');
const APP_URL = process.env.SYNC_APP_URL || 'http://localhost:3000';
const ACCESS_KEY = process.env.ACCESS_PASSWORD || '';
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000);
const ONCE = process.argv.includes('--once');

const DONE_DIR = path.join(INBOX, '已导入');
const FAIL_DIR = path.join(INBOX, '失败');
const STATE_FILE = path.join(INBOX, '.已处理.json');

/**
 * 文件名 → 导入类型。
 * 龙威导出的文件名带中文，按关键词判断即可；顺序有讲究：
 * 「采购」要排在「供应商」前面，因为采购明细表里也可能出现「供应商」三个字。
 */
const RULES = [
  { kind: 'purchases',  match: /采购|进货|收货/,        ffill: '供应商号|供应商' },
  { kind: 'shipments',  match: /销售|出货|发货/,        ffill: '客户名称|客户' },
  // 「供应商名单/报价」是报价表，必须排在「供应商档案」前面，否则会被后者抢走
  { kind: 'supplier_quotes', match: /供应商名单|报价|询价单价/, ffill: '供应商' },
  { kind: 'suppliers',  match: /供应商/,               ffill: null },
  { kind: 'customers',  match: /客户/,                 ffill: null },
  { kind: 'parts',      match: /库存|物料|型号明细/,     ffill: null },
];

// 各类型下，ERP 原始列名 → 导入模块认识的列名。
// 导入模块本身有一套自动映射，这里只补它认不出来的
const RENAME = {
  shipments: { '税价': '单价', '订单数量': '数量', '单位成本': '成本' },
  purchases: { '供应商号': '供应商', '订单数量': '数量' },
  parts:     { '型号描述': '规格', '品牌': '品牌', '成本': '目录成本', '销售价': '标准售价', '数量': '库存' },
  // 供应商名单的列名已经能被自动映射识别，这里不用改名
  supplier_quotes: {},
  suppliers: { '编号': '供应商名称', '名称': '公司全称', '联系电话1': '电话', '地区名称': '地区' },
  customers: { '编号': '客户全称', '名称': '公司全称', '联系电话1': '电话', '地区名称': '地区' },
};

const log = (...a) => console.log(`[${new Date().toLocaleString('zh-CN')}]`, ...a);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) { log('状态文件写入失败:', e.message); }
}

function detectKind(filename) {
  const base = path.basename(filename);
  for (const r of RULES) if (r.match.test(base)) return r;
  return null;
}

/** 把表格转成导入接口认的 CSV：重命名列 + 分组报表向下填充 */
function toImportCsv(file, rule) {
  const ext = path.extname(file).toLowerCase();
  let table;
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    table = text.split('\n').filter((l) => l.trim()).map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()));
  } else {
    const sheets = readSpreadsheet(file);
    if (!sheets.length) throw new Error('文件里没有工作表');
    table = toTable(sheets[0].cells);
  }
  if (table.length < 2) throw new Error('表格是空的或只有表头');

  const header = table[0].map((h) => String(h ?? '').trim());
  let body = table.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));

  // 分组报表：客户/供应商只在每组第一行打印，其余是空的，必须向下填充
  if (rule.ffill) {
    const cands = rule.ffill.split('|');
    const idx = header.findIndex((h) => cands.includes(h));
    if (idx >= 0) {
      const before = body.filter((r) => String(r[idx] ?? '').trim()).length;
      forwardFill(body, idx);
      const after = body.filter((r) => String(r[idx] ?? '').trim()).length;
      if (after > before) log(`   向下填充「${header[idx]}」：${before} → ${after} 行有值`);
    }
  }

  const map = RENAME[rule.kind] || {};
  const outHeader = header.map((h) => map[h] || h);
  return toCsv([outHeader, ...body]);
}

async function importOne(file, rule) {
  const csv = toImportCsv(file, rule);
  const r = await fetch(`${APP_URL}/api/import/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ACCESS_KEY ? { 'x-access-key': ACCESS_KEY } : {}),
    },
    body: JSON.stringify({
      kind: rule.kind, text: csv,
      fileName: path.basename(file), createdBy: '自动同步',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `接口返回 ${r.status}`);
  return j;
}

function moveTo(dir, file, note) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(dir, `${stamp}_${path.basename(file)}`);
  try { fs.renameSync(file, target); }
  catch { fs.copyFileSync(file, target); fs.unlinkSync(file); }
  if (note) fs.writeFileSync(target + '.错误.txt', note, 'utf8');
  return target;
}

async function scanOnce() {
  fs.mkdirSync(INBOX, { recursive: true });
  const state = loadState();
  const entries = fs.readdirSync(INBOX, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$'))
    .filter((e) => /\.(xls|xlsx|csv|tsv|txt)$/i.test(e.name));

  if (!entries.length) return;
  log(`发现 ${entries.length} 个待处理文件`);

  for (const e of entries) {
    const file = path.join(INBOX, e.name);
    // 文件可能还在拷贝中，等大小稳定再处理
    const s1 = fs.statSync(file).size;
    await new Promise((r) => setTimeout(r, 1500));
    if (!fs.existsSync(file) || fs.statSync(file).size !== s1) { log(`  ${e.name} 还在写入，跳过本轮`); continue; }

    const buf = fs.readFileSync(file);
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (state[hash]) {
      log(`  ${e.name} 内容和之前导过的一样，直接归档`);
      moveTo(DONE_DIR, file);
      continue;
    }

    // 先按文件名判断；认不出来就交给接口按表头自动识别（kind='auto'）
    const rule = detectKind(e.name) || { kind: 'auto', match: null, ffill: null };

    log(`  ${e.name} → ${rule.kind === 'auto' ? '自动识别' : rule.kind}`);
    try {
      const res = await importOne(file, rule);
      const dup = res.skippedDup ? `，跳过重复 ${res.skippedDup}` : '';
      if (rule.kind === 'auto') log(`   自动识别为：${res.kind || '?'}`);
      log(`   ✓ 批次 ${res.batchNo}：写入 ${res.written}${dup}，拒绝 ${res.rejected}（共 ${res.total} 行）`);
      state[hash] = { file: e.name, at: new Date().toISOString(), batch: res.batchNo, written: res.written };
      saveState(state);
      moveTo(DONE_DIR, file);
    } catch (err) {
      log(`   ✗ 失败：${err.message}`);
      moveTo(FAIL_DIR, file,
        `导入失败\n时间：${new Date().toLocaleString('zh-CN')}\n类型：${rule.kind}\n原因：${err.message}\n\n`
        + `如果提示「认不出这份表属于哪一类数据」，把文件名改成含以下关键词之一即可：\n`
        + `采购 / 销售(出货) / 供应商名单 / 供应商 / 客户 / 库存\n`);
    }
  }
}

async function main() {
  log('自动导入服务启动');
  log('  监听目录:', INBOX);
  log('  应用地址:', APP_URL);
  log('  模式:', ONCE ? '扫一次就退出' : `常驻，每 ${INTERVAL_MS / 60000} 分钟扫一次`);
  fs.mkdirSync(INBOX, { recursive: true });

  await scanOnce().catch((e) => log('扫描出错:', e.message));
  if (ONCE) return;
  setInterval(() => { scanOnce().catch((e) => log('扫描出错:', e.message)); }, INTERVAL_MS);
}

main();
