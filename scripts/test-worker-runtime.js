import assert from 'node:assert/strict';
import { unstable_dev } from 'wrangler';

// Synthetic credentials only: these probes never call Google or Cloudflare APIs.
process.env.WRANGLER_SEND_METRICS = 'false';
const accessToken = 'local-runtime-test-token-at-least-32-characters';
const worker = await unstable_dev('src/worker.ts', {
  config: 'wrangler.jsonc',
  local: true,
  persist: false,
  ip: '127.0.0.1',
  port: 0,
  inspectorPort: 0,
  vars: {
    MCP_ACCESS_TOKEN: accessToken,
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh',
  },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
try {
  assert.equal((await worker.fetch('/mcp', { method: 'POST' })).status, 401);
  for (const method of ['initialize', 'tools/list']) {
    const response = await worker.fetch('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method,
        ...(method === 'initialize' ? { params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'runtime-probe', version: '1' },
        } } : {}),
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.ok(body.result);
    assert.equal(response.headers.get('mcp-session-id'), null);
    if (method === 'tools/list') assert.ok(body.result.tools.some(tool => tool.name === 'search'));
  }
  console.log('Workers runtime: auth, initialize, and tools/list passed. No external API calls.');
} finally {
  await worker.stop();
}
