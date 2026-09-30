'use strict';

const path = require('node:path');
const ChatConfig = require('../renderer/chat-config.js');
const { validateBaseUrl } = require('./chat-client.cjs');
const { atomicWrite } = require('./storage.cjs');

const KEY_NAMES = Object.freeze({
  deepseek: 'DS_DESKTOP_DEEPSEEK_API_KEY',
  go: 'DS_DESKTOP_GO_API_KEY',
  zen: 'DS_DESKTOP_ZEN_API_KEY',
});
const APIS = Object.freeze({ chat: 'openai-completions', responses: 'openai-responses', messages: 'anthropic-messages' });

function endpoint(baseUrl, protocol) {
  const base = validateBaseUrl(baseUrl).replace(/\/(chat\/completions|responses|messages)$/, '');
  // Anthropic's SDK appends /v1/messages, whereas Chat and OpenCode publish
  // an already-versioned API root. Match Chat's endpoint without doubling /v1.
  return protocol === 'messages' && base.endsWith('/v1') ? base.slice(0, -3) : base;
}

/** Translate shared Chat routes into upstream adapters, without putting keys on disk. */
function buildHarnessConnections(settings) {
  const providers = {};
  const env = {};
  const selections = new Map();
  const models = ChatConfig.models(settings);
  for (const connection of settings.connections) {
    env[KEY_NAMES[connection.provider]] = connection.apiKey;
    for (const model of models) {
      if (!ChatConfig.candidates(settings, model).some(c => c.provider === connection.provider)) continue;
      const route = ChatConfig.route({ ...settings, connections: [connection] }, model);
      const id = `desktop-${connection.provider}-${route.protocol}`;
      providers[id] ||= {
        displayName: `${ChatConfig.platforms[connection.provider].name} · ${route.protocol}`,
        apiKeyEnv: KEY_NAMES[connection.provider],
        api: APIS[route.protocol],
        baseURL: endpoint(route.baseUrl, route.protocol),
        models: [],
      };
      const entry = { id: route.model, name: ChatConfig.modelLabel(model) };
      if (route.thinkingMode === 'deepseek') {
        entry.reasoningEfforts = { off: null, high: 'high' };
        entry.compat = { thinkingFormat: 'deepseek', supportsReasoningEffort: false,
          supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true, maxTokensField: 'max_tokens' };
      } else if (route.thinkingMode === 'responses' || route.thinkingMode === 'adaptive' || route.thinkingMode === 'budget') {
        entry.reasoningEfforts = { off: null, low: 'low', medium: 'medium', high: 'high' };
        if (route.thinkingMode === 'adaptive') entry.compat = { forceAdaptiveThinking: true };
      }
      if (!providers[id].models.some(m => m.id === entry.id)) providers[id].models.push(entry);
      if (ChatConfig.route(settings, model)?.provider === connection.provider) {
        selections.set(model, { provider: id, model: route.model });
      }
    }
  }
  const selection = selections.get(ChatConfig.selectedModel(settings));
  // No shared connections: leave existing standalone Harness settings usable.
  // The overlay is rebuilt on every launch, so removed platforms cannot linger.
  const patch = selection ? [
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', config: { providers } },
    { id: 'agent-default-model', config: selection },
  ] : [];
  return { patch, env };
}

async function prepareHarnessLaunch(storage, dataDir) {
  return storage.serialized(async () => {
    const { patch, env } = buildHarnessConnections(storage.getHarnessSettings());
    const patchPath = path.join(dataDir, 'harness-home', 'desktop-connections.patch.json');
    // JSON is a YAML subset accepted by the upstream --patch loader. This layer
    // overrides shared model routes without rewriting user patches or sessions.
    await atomicWrite(patchPath, JSON.stringify(patch, null, 2));
    return { env, args: ['--patch', patchPath] };
  });
}

module.exports = { buildHarnessConnections, prepareHarnessLaunch, KEY_NAMES };
