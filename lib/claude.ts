// AI 询价助手核心：把客户发来的模糊/杂乱 BOM 文本清洗成结构化型号列表
// 改用 Claude API（Anthropic）。Key 只存在服务器环境变量里（Vercel 项目设置），浏览器端永远看不到

export type ParsedBomItem = {
  pn: string;
  qty: number;
  brand_hint?: string;
};

// 用直接 fetch 调 Messages API，不引入 @anthropic-ai/sdk 依赖，保持项目依赖最小
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// 这是个轻量的结构化提取任务，Sonnet 足够也更稳，
// 如果以后调用量大想省成本，可以把下面这行换成 'claude-haiku-4-5-20251001'
const MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `你是电子元器件贸易公司的BOM清洗助手。客户会发来格式混乱的物料清单（可能是表格粘贴、口语化描述、带无关备注的文本），
你的任务是提取每一行真正的物料信息，返回严格的 JSON 数组，不要任何解释文字、不要markdown代码块标记：
[{"pn": "型号或规格描述", "qty": 数量, "brand_hint": "客户提到的品牌或空字符串"}]

规则：
- 忽略表头行（如"序号/型号/数量/备注"这类列名本身）
- 数量缺失时默认为 1
- pn 尽量保留原始型号完整信息（含封装、精度等后缀），不要过度精简
- 一行如果同时提到多个型号，拆成多条
- 只输出JSON数组本身`;

export async function parseBomWithClaude(userInput: string): Promise<ParsedBomItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('服务器未配置 ANTHROPIC_API_KEY，请检查 Vercel 项目环境变量');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userInput }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API 错误 ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const content: string = (data.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  const cleanJson = content.replace(/```json|```/g, '').trim();

  let items: ParsedBomItem[];
  try {
    items = JSON.parse(cleanJson);
  } catch {
    throw new Error('AI 返回内容不是合法 JSON，原始返回：' + content.slice(0, 300));
  }
  if (!Array.isArray(items)) throw new Error('AI 返回格式不是数组');

  // 兜底清洗：过滤空行，数量非法时归 1
  return items
    .filter((it) => it && it.pn && String(it.pn).trim())
    .map((it) => ({
      pn: String(it.pn).trim(),
      qty: Number.isFinite(Number(it.qty)) && Number(it.qty) > 0 ? Math.round(Number(it.qty)) : 1,
      brand_hint: it.brand_hint ? String(it.brand_hint).trim() : undefined,
    }))
    .slice(0, 300); // 防止异常输入导致返回过大
}
