'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ChatConfig = require('../renderer/chat-config.js');
const { Storage } = require('./storage.cjs');
const { buildHarnessConnections, prepareHarnessLaunch, KEY_NAMES } = require('./harness-connections.cjs');
const { sanitizeOutput } = require('./harness-manager.cjs');
const safe = { isEncryptionAvailable: () => true, encryptString: x => Buffer.from([...x].reverse().join('')),
  decryptString: x => [...x.toString()].reverse().join('') };
const connection = provider => ({ provider, baseUrl: ChatConfig.platforms[provider].baseUrl, apiKey: `${provider}-opaque-secret` });
const settings = ids => ({ connections: ids.map(connection), modelProfiles: [], model: '' });

test('every platform combination shares exactly the available models, platform keys and Chat default', () => {
  for (let mask = 0; mask < 8; mask++) {
    const config = settings(Object.keys(ChatConfig.platforms).filter((_, i) => mask & (1 << i)));
    const { patch, env } = buildHarnessConnections(config);
    assert.deepEqual(Object.keys(env).sort(), config.connections.map(c => KEY_NAMES[c.provider]).sort());
    if (!mask) { assert.deepEqual(patch, []); continue; }
    const providers = patch.find(p => p.id === 'llm-pi-ai').config.providers;
    const allModels = ChatConfig.models(config);
    for (const c of config.connections) {
      const expected = allModels.filter(m => ChatConfig.candidates(config, m).some(x => x.provider === c.provider))
        .map(m => ChatConfig.route({ ...config, connections: [c] }, m).model).sort();
      const actual = Object.entries(providers).filter(([id]) => id.startsWith(`desktop-${c.provider}-`))
        .flatMap(([, p]) => p.models.map(m => m.id)).sort();
      assert.deepEqual(actual, expected);
      assert.equal(env[KEY_NAMES[c.provider]], c.apiKey);
      assert.ok(!JSON.stringify(patch).includes(c.apiKey));
    }
    const current = ChatConfig.route(config, ChatConfig.selectedModel(config));
    assert.deepEqual(patch.at(-1).config, { provider: `desktop-${current.provider}-${current.protocol}`, model: current.model });
  }
});

test('full endpoints and custom protocols retain binding; Anthropic SDK does not duplicate v1', () => {
  const config = settings(['deepseek', 'go', 'zen']);
  config.connections[0].baseUrl += '/chat/completions';
  config.connections[2].baseUrl += '/messages';
  config.modelProfiles = [
    { model: 'my-gpt', provider: 'go', protocol: 'responses', thinkingMode: 'responses' },
    { model: 'my-claude', provider: 'zen', protocol: 'messages', thinkingMode: 'adaptive' },
  ];
  config.model = 'my-gpt';
  const { patch } = buildHarnessConnections(config);
  const p = patch[1].config.providers;
  assert.equal(p['desktop-deepseek-chat'].baseURL, 'https://api.deepseek.com');
  assert.equal(p['desktop-zen-messages'].baseURL, 'https://opencode.ai/zen');
  assert.equal(p['desktop-go-responses'].api, 'openai-responses');
  assert.deepEqual(p['desktop-go-responses'].models[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' });
  assert.deepEqual(p['desktop-zen-messages'].models.find(m => m.id === 'my-claude').compat, { forceAdaptiveThinking: true });
  assert.equal(patch.at(-1).config.provider, 'desktop-go-responses');
});

test('launches read encrypted shared storage; edits and removals rebuild without touching Harness or Chat history', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-shared-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Storage(dir, safe);
  await store.initialize();
  await store.saveSettings({ connections: ['deepseek', 'go', 'zen'].map(connection) });
  const home = path.join(dir, 'harness-home');
  await fs.mkdir(home);
  const userPatch = path.join(home, 'cordis.patch.yml');
  await fs.writeFile(userPatch, '# existing Harness settings\n[]');
  await store.saveHistory([{ id: 'keep', messages: [] }]);
  const before = await fs.readFile(path.join(dir, 'history.json'), 'utf8');
  let launch = await prepareHarnessLaunch(store, dir);
  assert.equal(launch.env.DS_DESKTOP_GO_API_KEY, 'go-opaque-secret');
  const patchFile = launch.args[1];
  for (const name of ['settings.json', path.relative(dir, patchFile)]) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    for (const id of ['deepseek', 'go', 'zen']) assert.ok(!content.includes(`${id}-opaque-secret`));
  }
  await store.saveSettings({ connections: [{ ...connection('go'), apiKey: 'rotated-key' }] });
  launch = await prepareHarnessLaunch(store, dir);
  assert.deepEqual(launch.env, { DS_DESKTOP_GO_API_KEY: 'rotated-key' });
  const patch = JSON.parse(await fs.readFile(patchFile, 'utf8'));
  assert.deepEqual(Object.keys(patch[1].config.providers), ['desktop-go-chat']);
  await store.saveSettings({ connections: [] });
  launch = await prepareHarnessLaunch(store, dir);
  assert.deepEqual(launch.env, {});
  assert.deepEqual(JSON.parse(await fs.readFile(patchFile, 'utf8')), []);
  assert.equal(await fs.readFile(userPatch, 'utf8'), '# existing Harness settings\n[]');
  assert.equal(await fs.readFile(path.join(dir, 'history.json'), 'utf8'), before);
});

test('credential failures stop launch preparation without exposing or rewriting secrets', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-shared-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Storage(dir, safe);
  await store.initialize();
  await store.saveSettings({ connections: [connection('zen')] });
  store.safeStorage = { ...safe, decryptString: () => { throw new Error('zen-opaque-secret'); } };
  await assert.rejects(prepareHarnessLaunch(store, dir), /无法解密 OpenCode Zen/);
  assert.ok(!JSON.stringify(store.publicSettings()).includes('zen-opaque-secret'));
  assert.equal(sanitizeOutput('failed zen-opaque-secret', ['zen-opaque-secret']), 'failed [credential hidden]');
});
