'use strict';

const { validateBaseUrl } = require('./chat-client.cjs');
const { sanitizeZenModels } = require('../renderer/chat-config.js');
const MAX_BYTES = 1024 * 1024;

async function fetchZenModels(connection, fetchImpl = fetch) {
  const base = validateBaseUrl(connection.baseUrl).replace(/\/(chat\/completions|responses|messages|models)$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let reader;
  try {
    // The official catalog is public. A configured proxy can require its own saved key.
    const headers = { Accept: 'application/json' };
    if (base !== 'https://opencode.ai/zen/v1') headers.Authorization = `Bearer ${connection.apiKey}`;
    const response = await fetchImpl(base + '/models', { headers, signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('unavailable');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('too large');
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(body.data) || body.data.length > 2000) throw new Error('invalid catalog');
    const models = sanitizeZenModels(body.data.map(model => model?.id));
    if (!models.length) throw new Error('empty catalog');
    return models;
  } catch {
    // Never forward service error bodies, headers or proxy credentials to the renderer.
    throw new Error('模型列表获取失败，已保留缓存或预设模型。请检查网络和 Zen API 地址。');
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
  }
}

module.exports = { fetchZenModels };
