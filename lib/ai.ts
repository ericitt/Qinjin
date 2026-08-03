/**
 * AI 询价助手：把客户发来的乱格式 BOM 文本清洗成结构化型号列表。
 *
 * 支持两个服务商，用环境变量切换：
 *   - deepseek（默认）：国内直连，大陆自建部署必须用这个，Claude 的 API 在墙外
 *   - anthropic：部署在墙外时可以用
 *
 * 两家的接口都是「发一段文本、返回一段 JSON」，差别只在 URL、鉴权头和响应结构，
 * 所以这里用一个薄封装抹平，业务代码不用关心用的是谁。
 *
 * 另外做了分片：一次把几百行 BOM 全塞进去容易超 token 上限，
 * 返回被截断后 JSON 解析就会失败（历史上踩过）。这里按行切块分批调用再合并。
 */
export type ParsedBomItem = {
  pn: string;
  qty: number;
  brand_hint?: string;
};

type Provider = 'deepseek' | 'anthropic';

const SYSTEM_PROMPT = `你是电子元器件贸易公司的BOM清洗助手。客户会发来格式混乱的物料清单（可能是表格粘贴、口语化描述、带无关备注的文本），
你的任务是提取每一行真正的物料信息，返回严格的 JSON 数组，不要任何解释文字、不要markdown代码块标记：
[{"pn": "型号或规格描述", "qty": 数量, "brand_hint": "客户提到的品牌或空字符串"}]

规则：
- 忽略表头行（如"序号/型号/数量/备注"这类列名本身）
- 数量缺失时默认为 1
- pn 尽量保留原始型号完整信息（含封装、精度等后缀），不要过度精简
- 一行如果同时提到多个型号，拆成多条
- 只输出JSON数组本身`;

/** 一片最多多少行。太大容易超上限，太小又浪费调用次数 */
const CHUNK_LINES = 80;
const MAX_ITEMS = 500;

/**
 * 把「看起来像占位符」的值当成没配。
 * .env 一般是从 .env.example 复制来的，里面留着 `sk-ant-你的密钥` 这种占位串，
 * 它非空、会被当成真 Key，然后在大陆环境里悄悄走 Claude 然后连不上 —— 很难排查。
 */
export function realKey(v: string | undefined): string | undefined {
  const s = (v || '').trim();
  if (!s) return undefined;
  if (/[^\x00-\x7F]/.test(s)) return undefined;        // 含中文 → 占位符
  if (/你的|placeholder|xxx+|your[-_]?key/i.test(s)) return undefined;
  if (s.length < 12) return undefined;                  // 正常的 Key 不会这么短
  return s;
}

function pickProvider(): Provider {
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase();
  if (explicit === 'deepseek' || explicit === 'anthropic') return explicit;
  if (realKey(process.env.DEEPSEEK_API_KEY)) return 'deepseek';
  if (realKey(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
  return 'deepseek';
}

async function callDeepSeek(text: string): Promise<string> {
  const key = realKey(process.env.DEEPSEEK_API_KEY);
  if (!key) throw new Error('未配置 DEEPSEEK_API_KEY（或填的还是占位符）。去 platform.deepseek.com 创建后填进环境变量');
  const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error(`DeepSeek API 错误 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

async function callAnthropic(text: string): Promise<string> {
  const key = realKey(process.env.ANTHROPIC_API_KEY);
  if (!key) throw new Error('未配置 ANTHROPIC_API_KEY（或填的还是占位符）');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 4000,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API 错误 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return (d.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
}

function parseJsonArray(raw: string): ParsedBomItem[] {
  let s = raw.replace(/```json|```/g, '').trim();
  // 模型偶尔会在数组前后多说一句话，这里兜底截出最外层数组
  if (!s.startsWith('[')) {
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  let items: any;
  try { items = JSON.parse(s); }
  catch { throw new Error('AI 返回内容不是合法 JSON，原始返回：' + raw.slice(0, 300)); }
  if (!Array.isArray(items)) throw new Error('AI 返回格式不是数组');
  return items;
}

function normalize(items: any[]): ParsedBomItem[] {
  return items
    .filter((it) => it && it.pn && String(it.pn).trim())
    .map((it) => ({
      pn: String(it.pn).trim(),
      qty: Number.isFinite(Number(it.qty)) && Number(it.qty) > 0 ? Math.round(Number(it.qty)) : 1,
      brand_hint: it.brand_hint ? String(it.brand_hint).trim() : undefined,
    }));
}

/** 按行分片，避免整份大 BOM 一次塞进去被截断 */
export function chunkText(text: string, perChunk = CHUNK_LINES): string[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length <= perChunk) return [text];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += perChunk) out.push(lines.slice(i, i + perChunk).join('\n'));
  return out;
}

export async function parseBomWithAI(userInput: string): Promise<ParsedBomItem[]> {
  const provider = pickProvider();
  const call = provider === 'anthropic' ? callAnthropic : callDeepSeek;
  const chunks = chunkText(userInput);

  const all: ParsedBomItem[] = [];
  for (const c of chunks) {
    const raw = await call(c);
    all.push(...normalize(parseJsonArray(raw)));
    if (all.length >= MAX_ITEMS) break;
  }
  return all.slice(0, MAX_ITEMS);
}

export const aiProvider = pickProvider;
