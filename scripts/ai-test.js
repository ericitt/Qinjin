#!/usr/bin/env node
/**
 * 验证 AI 服务能不能用：npm run ai:test
 *
 * 存在的意义：换 AI 服务商这件事，写代码的人（我）在墙外没法实测，
 * 所以给你一个 10 秒能自查的东西，别等到点「解析并匹配」才发现连不上。
 *
 * 它会依次检查：
 *   1. 环境变量有没有配
 *   2. 网络能不能连上服务商（这一步在大陆就能筛掉 Claude）
 *   3. Key 有没有效、有没有余额
 *   4. 模型返回的是不是能解析的 JSON
 */
require('dotenv').config();

const SYSTEM = `你是电子元器件贸易公司的BOM清洗助手。提取物料信息，返回严格的 JSON 数组，不要解释、不要markdown标记：
[{"pn": "型号", "qty": 数量, "brand_hint": "品牌或空字符串"}]
只输出JSON数组本身`;

const SAMPLE = `1. STM32F103RCT6  LQFP64   2000pcs
2. 0603 104K 25V 电容  100K
3、AMS1117-3.3 SOT223  5000
麻烦报个价`;

// 和 lib/ai.ts 里同一套判断：占位符不算数
function realKey(v) {
  const s = (v || '').trim();
  if (!s) return undefined;
  if (/[^\x00-\x7F]/.test(s)) return undefined;
  if (/你的|placeholder|xxx+|your[-_]?key/i.test(s)) return undefined;
  if (s.length < 12) return undefined;
  return s;
}

function pickProvider() {
  const e = (process.env.AI_PROVIDER || '').toLowerCase();
  if (e === 'deepseek' || e === 'anthropic') return e;
  if (realKey(process.env.DEEPSEEK_API_KEY)) return 'deepseek';
  if (realKey(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
  return null;
}

async function main() {
  const provider = pickProvider();
  console.log('—'.repeat(52));
  if (!provider) {
    console.error('✗ 没有检测到任何 AI 配置。');
    console.error('  请在 .env 里设置 DEEPSEEK_API_KEY=sk-xxx（国内用这个）');
    process.exit(1);
  }
  console.log('服务商:', provider);

  const isDs = provider === 'deepseek';
  const raw = isDs ? process.env.DEEPSEEK_API_KEY : process.env.ANTHROPIC_API_KEY;
  const key = realKey(raw);
  if (!key) {
    console.error(`✗ AI_PROVIDER=${provider}，但对应的 API Key 没配好`);
    if (raw) console.error(`  当前值看起来是占位符：${raw.slice(0, 24)}  → 换成真的 Key`);
    process.exit(1);
  }
  console.log('Key:', key.slice(0, 6) + '…' + key.slice(-4), `(长度 ${key.length})`);

  const url = isDs
    ? (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions'
    : 'https://api.anthropic.com/v1/messages';
  const model = isDs
    ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat')
    : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5');
  console.log('地址:', url);
  console.log('模型:', model);
  console.log('—'.repeat(52));

  const body = isDs
    ? { model, temperature: 0.1, max_tokens: 1000,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: SAMPLE }] }
    : { model, max_tokens: 1000, temperature: 0.1, system: SYSTEM,
        messages: [{ role: 'user', content: SAMPLE }] };
  const headers = isDs
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    : { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };

  const t0 = Date.now();
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000) });
  } catch (e) {
    console.error('✗ 连不上服务商：', e.message);
    console.error('  如果你在大陆、用的是 anthropic —— 这是正常的，Claude 的接口被墙，请改用 deepseek。');
    process.exit(1);
  }
  const ms = Date.now() - t0;

  if (!r.ok) {
    const txt = await r.text();
    console.error(`✗ 接口返回 ${r.status}（耗时 ${ms}ms）`);
    console.error('  ' + txt.slice(0, 400));
    if (r.status === 401) console.error('  → Key 不对');
    if (r.status === 402) console.error('  → 余额不足，去 platform.deepseek.com 充值');
    if (r.status === 429) console.error('  → 触发限流，稍后再试');
    process.exit(1);
  }

  const d = await r.json();
  const content = isDs
    ? d?.choices?.[0]?.message?.content || ''
    : (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

  let s = content.replace(/```json|```/g, '').trim();
  if (!s.startsWith('[')) {
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  let items;
  try { items = JSON.parse(s); }
  catch {
    console.error('✗ 返回的不是合法 JSON，模型原文：');
    console.error('  ' + content.slice(0, 400));
    process.exit(1);
  }
  if (!Array.isArray(items)) { console.error('✗ 返回的不是数组'); process.exit(1); }

  console.log(`✓ 调用成功，耗时 ${ms}ms，解析出 ${items.length} 条：`);
  for (const it of items) console.log(`    ${it.pn}  ×${it.qty}${it.brand_hint ? '  [' + it.brand_hint + ']' : ''}`);

  const u = d.usage || {};
  const tok = u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0));
  if (tok) console.log(`\n本次消耗约 ${tok} tokens（DeepSeek 约 ¥${(tok / 1000 * 0.002).toFixed(4)}）`);
  console.log('\nAI 询价助手可以正常使用。');
}

main().catch((e) => { console.error('✗ 出错：', e.message); process.exit(1); });
