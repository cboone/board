import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANTHROPIC_POLICY,
  buildCountRequest,
  buildMessageRequest,
  createAnthropicClient,
  parseMessageStream,
} from '../lib/anthropic.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};
const input = { schemaVersion: 1, issues: [] };
const stream = (parts) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(Buffer.from(part));
      controller.close();
    },
  });
const event = (name, value) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...value })}\n\n`;
function successfulEvents(overrides = {}) {
  const usage = {
    input_tokens: 123,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
    inference_geo: 'global',
    service_tier: 'standard',
    ...overrides.usage,
  };
  return [
    event('message_start', {
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        usage,
      },
    }),
    event('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    event('content_block_delta', {
      index: 0,
      delta: { type: 'thinking_delta', thinking: '' },
    }),
    event('content_block_delta', {
      index: 0,
      delta: { type: 'signature_delta', signature: 'opaque' },
    }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', {
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      index: 1,
      delta: { type: 'text_delta', text: '{"ok":' },
    }),
    event('ping', {}),
    event('content_block_delta', {
      index: 1,
      delta: { type: 'text_delta', text: 'true}' },
    }),
    event('content_block_stop', { index: 1 }),
    event('message_delta', {
      delta: { stop_reason: overrides.stopReason ?? 'end_turn' },
      usage: { ...usage, output_tokens: overrides.outputTokens ?? 12 },
    }),
    event('message_stop', {}),
  ].join('');
}

test('count and paid request envelopes share fixed analysis controls while billing controls remain paid-only', () => {
  const count = buildCountRequest(input, schema);
  const paid = buildMessageRequest(input, schema);
  for (const key of [
    'model',
    'thinking',
    'output_config',
    'system',
    'messages',
  ])
    assert.deepEqual(count[key], paid[key]);
  assert.deepEqual(
    Object.keys(paid).filter((key) => !Object.hasOwn(count, key)),
    ['max_tokens', 'inference_geo', 'service_tier', 'stream'],
  );
  assert.equal(paid.model, 'claude-opus-5');
  assert.equal(paid.output_config.effort, 'high');
  assert.deepEqual(paid.thinking, { type: 'adaptive', display: 'omitted' });
  assert.equal(paid.inference_geo, 'global');
  assert.equal(paid.service_tier, 'standard_only');
  assert.equal(paid.tools, undefined);
  assert.equal(paid.temperature, undefined);
});

test('stream parser handles fragmentation, omitted thinking and cumulative usage without retaining reasoning', async () => {
  const body = successfulEvents();
  const parts = [];
  for (let index = 0; index < body.length; index += 7)
    parts.push(body.slice(index, index + 7));
  const result = await parseMessageStream(stream(parts));
  assert.equal(result.output, '{"ok":true}');
  assert.equal(result.usage.inputTokens, 123);
  assert.equal(result.usage.outputTokens, 12);
  assert.equal(result.usage.inferenceGeo, 'global');
  assert.equal(result.usage.serviceTier, 'standard');
  assert.equal(JSON.stringify(result).includes('opaque'), false);

  const crlf = body.replaceAll('\n', '\r\n');
  const splitEveryLineEnding = [...crlf];
  const crlfResult = await parseMessageStream(stream(splitEveryLineEnding));
  assert.equal(crlfResult.output, '{"ok":true}');
  assert.equal(crlfResult.usage.outputTokens, 12);
});

test('client sends exact native requests with no retries and returns only parsed output plus safe usage', async () => {
  const calls = [];
  const client = createAnthropicClient({
    apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/count_tokens'))
        return Response.json({ input_tokens: 77 });
      return new Response(stream([successfulEvents()]), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  assert.equal(await client.countTokens({ analysisInput: input, schema }), 77);
  const result = await client.createMessage({ analysisInput: input, schema });
  assert.deepEqual(result.delta, { ok: true });
  assert.equal(result.validationError, null);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).origin, 'https://api.anthropic.com');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].init.headers['x-api-key'], 'synthetic-key');
  assert.equal(
    JSON.parse(calls[1].init.body).service_tier,
    ANTHROPIC_POLICY.serviceTier,
  );
});

test('model metadata must support the exact fixed context, output, thinking, effort and schema controls', async () => {
  const client = createAnthropicClient({
    apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.ok(url.endsWith('/v1/models/claude-opus-5'));
      return Response.json({
        type: 'model',
        id: 'claude-opus-5',
        display_name: 'Claude Opus 5',
        created_at: '2026-07-24T00:00:00Z',
        max_input_tokens: 1_000_000,
        max_tokens: 64_000,
        capabilities: {
          structured_outputs: { supported: true },
          thinking: { types: { adaptive: { supported: true } } },
          effort: { high: { supported: true } },
        },
      });
    },
  });
  assert.deepEqual(await client.retrieveModel(), {
    id: 'claude-opus-5',
    maxInputTokens: 1_000_000,
    maxTokens: 64_000,
  });
});

test('missing billing facts, cache use, tools, decreasing usage, malformed events and incomplete streams fail closed', async () => {
  const cases = [
    successfulEvents({ usage: { inference_geo: undefined } }),
    successfulEvents({ usage: { cache_read_input_tokens: 1 } }),
    successfulEvents({
      usage: { server_tool_use: { web_search_requests: 1 } },
    }),
    successfulEvents({ usage: { unexpected_billed_feature: 1 } }),
    successfulEvents({ outputTokens: 0 }),
    'event: message_start\ndata: not-json\n\n',
    successfulEvents().replace(event('message_stop', {}), ''),
  ];
  for (const body of cases)
    await assert.rejects(parseMessageStream(stream([body])), (error) => {
      assert.equal(error.billingUnknown, true);
      assert.ok(
        ['analysis_ambiguous', 'pricing_review_required'].includes(error.code),
      );
      return true;
    });
});

test('invalid JSON and max-token completion remain known billed responses eligible only for caller validation handling', async () => {
  const invalid = successfulEvents({ stopReason: 'max_tokens' }).replace(
    '{"ok":',
    '{invalid:',
  );
  const client = createAnthropicClient({
    apiKey: 'synthetic-key',
    fetchImpl: async () => new Response(stream([invalid])),
  });
  const result = await client.createMessage({ analysisInput: input, schema });
  assert.equal(result.delta, null);
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.validationError, 'analysis_output_invalid');
  assert.equal(result.usage.outputTokens, 12);
});

test('HTTP errors are sanitized and no automatic retry occurs', async () => {
  for (const [status, code] of [
    [429, 'analysis_provider_rate_limited'],
    [529, 'analysis_provider_unavailable'],
  ]) {
    let calls = 0;
    const client = createAnthropicClient({
      apiKey: 'synthetic-key',
      fetchImpl: async () => {
        calls += 1;
        return new Response('provider secret detail', { status });
      },
    });
    await assert.rejects(client.countTokens({ analysisInput: input, schema }), {
      code,
    });
    assert.equal(calls, 1);
  }
});

test('an uncertain paid transport failure is retained as unknown billing exposure', async () => {
  let calls = 0;
  const client = createAnthropicClient({
    apiKey: 'synthetic-key',
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('private transport detail');
    },
  });
  await assert.rejects(
    client.createMessage({ analysisInput: input, schema }),
    (error) => {
      assert.equal(error.code, 'analysis_ambiguous');
      assert.equal(error.billingUnknown, true);
      assert.equal(error.usage, null);
      assert.equal(String(error).includes('private transport detail'), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});
