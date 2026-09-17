const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const MAX_DIFF_CHARS = 140_000;

export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'riskLevel', 'findings'],
  properties: {
    summary: { type: 'string' },
    riskLevel: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'title', 'file', 'line', 'evidence', 'impact', 'minimalFix'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['boundary', 'error_handling', 'performance', 'security', 'correctness', 'maintainability'],
          },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          minimalFix: { type: 'string' },
        },
      },
    },
  },
};

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new Error('模型没有返回可读取的审查结果。');
}

function validateReview(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.findings)) {
    throw new Error('模型返回了无效的审查结果。');
  }
  return value;
}

export async function reviewCommit({ apiKey, model, details, fetchImpl = fetch }) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('请先填写 OpenAI API Key。');
  if (!model || typeof model !== 'string') throw new Error('请填写模型名称。');
  if (!details?.hash || typeof details.diff !== 'string') throw new Error('提交内容无效。');

  const truncated = details.diff.length > MAX_DIFF_CHARS;
  const diff = details.diff.slice(0, MAX_DIFF_CHARS);
  const input = [
    `请审查 Git 提交 ${details.hash}。`,
    `提交说明：\n${details.message}`,
    truncated ? '注意：差异内容过大，以下 diff 已截断。只报告能够从现有证据确认的问题。' : '',
    '代码差异：',
    '```diff',
    diff,
    '```',
  ].filter(Boolean).join('\n\n');

  let response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 6000,
      instructions: [
        '你是一名严谨的高级代码审查工程师。',
        '只根据提供的提交差异报告能够具体举证的问题，不要编造上下文。',
        '重点检查边界条件、异常处理、性能瓶颈、安全风险和逻辑正确性。',
        '按严重程度评估问题，并给出能够降低风险的最小修改方案。',
        '不要把纯风格偏好列为问题。若没有实质问题，findings 返回空数组。',
        '所有说明使用简体中文。',
      ].join('\n'),
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'commit_code_review',
          strict: true,
          schema: reviewSchema,
        },
      },
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 OpenAI API。请检查网络、系统代理或防火墙设置。${detail && detail !== 'fetch failed' ? ` (${detail})` : ''}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `模型请求失败 (${response.status})`;
    throw new Error(message);
  }
  if (payload.status === 'incomplete') {
    throw new Error(`模型输出未完成：${payload.incomplete_details?.reason || '未知原因'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(extractOutputText(payload));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('模型返回的结果无法解析。');
    throw error;
  }

  return {
    ...validateReview(parsed),
    model: payload.model || model,
    reviewedAt: new Date().toISOString(),
    truncated,
    usage: payload.usage ? {
      inputTokens: payload.usage.input_tokens ?? 0,
      outputTokens: payload.usage.output_tokens ?? 0,
      totalTokens: payload.usage.total_tokens ?? 0,
    } : null,
  };
}

export async function listAvailableModels({ apiKey, fetchImpl = fetch }) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('请先填写 OpenAI API Key。');
  let response;
  try {
    response = await fetchImpl(OPENAI_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 OpenAI API。请检查网络、系统代理或防火墙设置。${detail && detail !== 'fetch failed' ? ` (${detail})` : ''}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `读取模型列表失败 (${response.status})`);
  return (payload.data ?? [])
    .map((item) => item.id)
    .filter((id) => typeof id === 'string' && /^gpt-(?:5|6)/.test(id))
    .filter((id) => !/(audio|image|realtime|transcribe|tts|search|chat)/i.test(id))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}
