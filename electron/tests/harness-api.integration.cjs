'use strict';
// Explicit runtime integration suite. Install runtime dependencies first.
// All inference stays on loopback with fixture keys; no paid API is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildHarnessConnections, prepareHarnessLaunch } = require('../harness-connections.cjs');
const { createHarnessManager } = require('../harness-manager.cjs');
const { Storage } = require('../storage.cjs');
const runtimeRoot = path.resolve(process.env.DSH_TEST_RUNTIME_ROOT || path.join(__dirname, '../../runtime'));
const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
const safe = { isEncryptionAvailable: () => true, encryptString: x => Buffer.from(x), decryptString: x => x.toString() };
const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const args = JSON.stringify({ path: 'fixture.txt' });

function chatEvents(tool) {
  return [
    { choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'read_file', arguments: args } }] } : { content: '已读取 fixture' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    '[DONE]',
  ];
}
function responseEvents(tool) {
  const item = tool
    ? { type: 'function_call', id: 'fc-fixture', call_id: 'call-fixture', name: 'read_file', arguments: args, status: 'completed' }
    : { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '已读取 fixture', annotations: [] }] };
  return [
    { type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(tool ? [{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: args }]
      : [{ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: '已读取 fixture' }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ];
}
function messageEvents(tool) {
  return [
    { type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-fixture', name: 'read_file', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: args } : { type: 'text_delta', text: '已读取 fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}

test('real upstream adapters share all platforms and preserve streamed tools and tool-result history', { timeout: 30_000 }, async t => {
  const requests = [];
  const counts = new Map();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ path: requestPath, headers: req.headers, body: parsed });
    const count = counts.get(requestPath) || 0;
    counts.set(requestPath, count + 1);
    const events = requestPath.endsWith('/messages') ? messageEvents(count === 0)
      : requestPath.endsWith('/responses') ? responseEvents(count === 0) : chatEvents(count === 0);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) {
      if (requestPath.endsWith('/messages')) res.write(`event: ${event.type}\n`);
      res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { connections: ['deepseek', 'go', 'zen'].map(provider => ({ provider, baseUrl: `${origin}/${provider}/v1`, apiKey: `${provider}-fixture-key` })),
    modelProfiles: [], model: 'deepseek-v4.1-flash' };
  const { patch, env } = buildHarnessConnections(config);
  const [{ Context }, llm, pi] = await Promise.all([load('cordis'), load('dsh-llm'), load('dsh-llm-pi-ai')]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  await ctx.plugin(llm.default);
  await ctx.plugin(pi, patch[1].config);
  const providers = patch[1].config.providers;
  assert.equal(ctx.llm.listProviders().length, 5);
  for (const [provider, profile] of Object.entries(providers)) {
    const model = profile.models[0].id;
    const options = { provider, model, system: 'Use the read_file tool.', tools: [{ name: 'read_file', description: 'Read a test fixture', parameters }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read fixture.txt' }] }], signal: AbortSignal.timeout(5000) };
    async function generate(request) {
      const assembled = new llm.BlockAssembler();
      for await (const chunk of ctx.llm.stream(request)) assembled.push(chunk);
      assert.notEqual(assembled.finish.kind, 'error', JSON.stringify(assembled.finish));
      return assembled;
    }
    // Both Zen chat and Zen responses have separate paths and counters.
    const first = await generate(options);
    assert.equal(first.finish.kind, 'tool-calls');
    const call = first.blocks().find(b => b.type === 'tool-call');
    assert.equal(call.name, 'read_file'); assert.deepEqual(JSON.parse(call.arguments), { path: 'fixture.txt' });
    const result = llm.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'fixture-result' }], isError: false });
    const second = await generate({ ...options, messages: [...options.messages, first.message({ provider, model }), result] });
    assert.equal(second.finish.kind, 'stop');
    assert.equal(second.blocks().filter(b => b.type === 'text').map(b => b.text).join(''), '已读取 fixture');
    const [a, b] = requests.slice(-2);
    assert.equal(a.body.model, model); assert.equal(b.body.model, model);
    assert.ok(JSON.stringify(a.body.tools).includes('read_file'));
    assert.ok(JSON.stringify(b.body).includes('fixture-result'));
    const platform = provider.split('-')[1];
    assert.equal(a.headers.authorization || `Bearer ${a.headers['x-api-key']}`, `Bearer ${platform}-fixture-key`);
    const suffix = { 'openai-completions': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'messages' }[profile.api];
    assert.equal(a.path, `/${platform}/v1/${suffix}`);
  }
  // The adapter's normal provider errors propagate; no cross-platform retry.
  assert.equal(requests.length, 10);
});

test('real latest Web profile boots with shared overlay, authenticates, and closes its port', { timeout: 180_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-shared-web-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  const store = new Storage(dir, safe);
  await store.initialize();
  await store.saveSettings({ connections: ['deepseek', 'go', 'zen'].map(provider => ({ provider, apiKey: `${provider}-fixture-key` })) });
  const manager = createHarnessManager({ runtimeRoot, nodePath: path.join(runtimeRoot, 'node.exe'), dataDir: dir,
    prepareLaunch: () => prepareHarnessLaunch(store, dir) });
  t.after(() => manager.stop());
  const { url } = await manager.start({ workspace: dir });
  const login = await fetch(url, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
  const origin = new URL(url).origin;
  const page = await fetch(origin, { headers: { cookie } });
  assert.equal(page.status, 200); assert.ok(page.headers.get('content-type').includes('text/html'));
  await page.body.cancel();
  assert.equal(manager.getStatus().version, '0.2.0-rc.2');
  assert.ok(!JSON.stringify(manager.getStatus()).includes('fixture-key'));
  await manager.stop();
  await assert.rejects(fetch(origin));
});
