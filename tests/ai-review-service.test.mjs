import test from 'node:test';
import assert from 'node:assert/strict';
import { listAvailableModels, reviewCommit } from '../electron/ai-review-service.mjs';

const details = {
  hash: 'a'.repeat(40),
  message: 'handle user input',
  diff: 'diff --git a/input.js b/input.js\n+eval(userInput)',
};

test('requests a non-stored structured review and parses findings', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: 'completed',
        model: 'gpt-5.4-mini',
        output_text: JSON.stringify({
          summary: '存在代码执行风险。',
          riskLevel: 'critical',
          findings: [{
            severity: 'critical',
            category: 'security',
            title: '不可信输入进入 eval',
            file: 'input.js',
            line: 1,
            evidence: '新增代码直接执行 userInput。',
            impact: '攻击者可能执行任意代码。',
            minimalFix: '移除 eval，并使用明确的解析逻辑。',
          }],
        }),
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    };
  };

  const result = await reviewCommit({ apiKey: 'test-key', model: 'gpt-5.4-mini', details, fetchImpl });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(result.riskLevel, 'critical');
  assert.equal(result.findings[0].category, 'security');
  assert.equal(result.usage.totalTokens, 150);
});

test('surfaces API errors without exposing the key', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Incorrect API key' } }),
  });
  await assert.rejects(
    reviewCommit({ apiKey: 'secret-key', model: 'gpt-5.4-mini', details, fetchImpl }),
    (error) => error.message === 'Incorrect API key' && !error.message.includes('secret-key'),
  );
});

test('returns only suitable GPT text models from the account model list', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'gpt-5.4-mini' },
        { id: 'gpt-6-astra' },
        { id: 'gpt-realtime-2' },
        { id: 'gpt-image-2' },
        { id: 'text-embedding-3-small' },
      ],
    }),
  });
  const models = await listAvailableModels({ apiKey: 'test-key', fetchImpl });
  assert.deepEqual(models, ['gpt-5.4-mini', 'gpt-6-astra']);
});

test('turns low-level fetch failures into actionable network guidance', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    listAvailableModels({ apiKey: 'test-key', fetchImpl }),
    /系统代理或防火墙/,
  );
});
