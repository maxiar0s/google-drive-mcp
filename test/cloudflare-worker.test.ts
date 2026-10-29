import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type WorkerEnv } from '../src/worker.js';
import { createWorkerContext } from '../src/workerContext.js';
import { RUNTIME_DEFAULTS } from '../src/utils/cliArgs.js';
import { createHash } from 'node:crypto';

const env: WorkerEnv = {
  MCP_ACCESS_TOKEN: 'test-only-access-token-with-32-chars',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REFRESH_TOKEN: 'test-refresh',
};

async function rpc(method: string, params?: unknown, overrides: Partial<WorkerEnv> = {}) {
  return worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), { ...env, ...overrides });
}

test('Worker fails closed without configured secrets or valid bearer', async () => {
  const request = new Request('https://worker.example/mcp', { method: 'POST' });
  assert.equal((await worker.fetch(request, { ...env, MCP_ACCESS_TOKEN: '' })).status, 503);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate') ?? '', /Bearer/);
  assert.equal((await worker.fetch(new Request(request, {
    headers: { Authorization: 'Bearer incorrect' },
  }), env)).status, 401);
});

test('Static bearer remains valid when OAuth is configured', async () => {
  const response = await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: { Authorization: `bearer ${env.MCP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), { ...env, OAUTH_ISSUER: 'https://worker.example', OAUTH_KV: {} });
  assert.equal(response.status, 200);
  assert.ok((await response.json() as any).result.tools.some((tool: any) => tool.name === 'search'));
});

test('Worker initializes using stateless Streamable HTTP', async () => {
  const response = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
  const body = await response.json() as any;
  assert.equal(body.result.serverInfo.name, 'google-drive-mcp');
  assert.deepEqual(Object.keys(body.result.capabilities), ['tools']);
});

test('Worker lists reusable cloud tools but not host-only or account management tools', async () => {
  const response = await rpc('tools/list');
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  const tools = body.result.tools;
  assert.ok(tools.some((t: any) => t.name === 'search'));
  assert.ok(tools.some((t: any) => t.name === 'readGoogleDoc'));
  for (const name of ['downloadFile', 'uploadPdfWithSplit', 'manage_accounts', 'authGetStatus', 'authListScopes']) {
    assert.ok(!tools.some((t: any) => t.name === name), name);
  }
  const upload = tools.find((t: any) => t.name === 'uploadFile');
  assert.ok(!('localPath' in upload.inputSchema.properties));
  assert.ok(upload.inputSchema.required.includes('contentBase64'));
});

test('Worker rejects host paths and account overrides even when called directly', async () => {
  for (const [name, args] of [
    ['downloadFile', { fileId: 'file', localPath: '/tmp/leak' }],
    ['uploadFile', { localPath: '/etc/passwd' }],
    ['uploadFile', { contentBase64: 'eA==', localPath: '/etc/passwd' }],
    ['search', { query: 'test', account: 'other' }],
    ['manage_accounts', { action: 'list' }],
  ] as const) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.result.isError, true, name);
    assert.match(body.result.content[0].text, /not available|not supported/i);
    assert.ok(!JSON.stringify(body).includes(env.GOOGLE_REFRESH_TOKEN));
  }
});

test('Worker rejects cross-origin requests and oversized bodies before dispatch', async () => {
  const headers = { Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}`, Origin: 'https://untrusted.example' };
  assert.equal((await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST', headers,
  }), env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST', headers: { Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}` },
    body: 'x'.repeat(4 * 1024 * 1024 + 1),
  }), env)).status, 413);
});

test('Worker rejects invalid folder policy without exposing configuration', async () => {
  const response = await rpc('tools/list', undefined, { GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS: 'https://bad/folder' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('https://bad/folder'));
});

test('Worker uses native fetch for token refresh without persistent credential state', () => {
  const first = createWorkerContext(env, RUNTIME_DEFAULTS);
  const second = createWorkerContext({ ...env, GOOGLE_REFRESH_TOKEN: 'different-refresh' }, RUNTIME_DEFAULTS);
  assert.notEqual(first.authClient, second.authClient);
  assert.equal(first.authClient.credentials.refresh_token, env.GOOGLE_REFRESH_TOKEN);
  assert.equal(second.authClient.credentials.refresh_token, 'different-refresh');
  assert.equal(first.authClient.transporter.defaults.fetchImplementation, globalThis.fetch);
});

test('Worker executes Drive search and enforces folder policy using mocked Google HTTP', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      assert.match(String(init?.body), /refresh_token=test-refresh/);
      return Response.json({ access_token: 'mock-google-access', expires_in: 3600, token_type: 'Bearer' });
    }
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-google-access');
    if (url.pathname === '/drive/v3/files') {
      assert.match(url.searchParams.get('q') ?? '', /fullText contains 'example'/);
      return Response.json({ files: [{ id: 'blocked-file', name: 'Example', mimeType: 'text/plain' }] });
    }
    assert.equal(url.pathname, '/drive/v3/files/blocked-file');
    return Response.json({ id: 'blocked-file', parents: ['blocked-folder'] });
  };
  try {
    const result = await (await rpc('tools/call', { name: 'search', arguments: { query: 'example' } })).json() as any;
    assert.equal(result.result.isError, false);
    assert.match(result.result.content[0].text, /Found 1 files/);
    assert.match(result.result.content[0].text, /Example/);
    const denied = await (await rpc('tools/call', { name: 'search', arguments: { query: 'example' } }, {
      GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS: 'blocked-folder',
    })).json() as any;
    assert.equal(denied.result.isError, false);
    assert.match(denied.result.content[0].text, /Found 0 files/);
    assert.ok(!JSON.stringify(denied).includes('blocked-file'));
    assert.equal(requests.filter(url => url.pathname === '/token').length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker preserves Docs, Calendar, multipart uploads, and rejection invariants', async () => {
  // Regression probes from independent verification, using only synthetic HTTP.
  const originalFetch = globalThis.fetch;
  const refreshed: string[] = [];
  const uploaded: string[] = [];
  let documentReads = 0;
  const stateHash = () => createHash('sha256').update(JSON.stringify(uploaded)).digest('hex');
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const refreshToken = new URLSearchParams(String(options?.body)).get('refresh_token')!;
      refreshed.push(refreshToken);
      return Response.json({ access_token: `access-${refreshToken}`, expires_in: 3600, token_type: 'Bearer' });
    }
    assert.ok(['www.googleapis.com', 'docs.googleapis.com'].includes(url.hostname));
    assert.ok(['Bearer access-test-refresh', 'Bearer access-other-refresh'].includes(
      new Headers(options?.headers).get('authorization') ?? '',
    ));
    if (url.pathname === '/drive/v3/files/doc') return Response.json({ id: 'doc', parents: ['blocked'] });
    if (url.pathname === '/v1/documents/doc') {
      documentReads++;
      return Response.json({ documentId: 'doc', title: 'Example', body: {
        content: [{ paragraph: { elements: [{ textRun: { content: 'Hello' } }] } }],
      } });
    }
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return Response.json({ items: [{ id: 'calendar', summary: 'Example' }] });
    }
    if (url.pathname === '/drive/v3/files') return Response.json({ files: [] });
    if (url.pathname === '/upload/drive/v3/files') {
      const body = await new Request(url, options).text();
      assert.ok(body.includes('hello upload'));
      uploaded.push(body);
      return Response.json({ id: 'uploaded', name: 'example.txt', size: '12', mimeType: 'text/plain' });
    }
    throw new Error(`Unexpected mocked Google path: ${url.pathname}`);
  };
  const call = async (name: string, args: object, overrides: Partial<WorkerEnv> = {}) => {
    const response = await rpc('tools/call', { name, arguments: args }, overrides);
    assert.equal(response.status, 200);
    return (await response.json() as any).result;
  };
  try {
    assert.equal((await call('readGoogleDoc', { documentId: 'doc' })).isError, false);
    assert.equal((await call('listCalendars', {}, { GOOGLE_REFRESH_TOKEN: 'other-refresh' })).isError, false);
    assert.ok(refreshed.includes('other-refresh'));
    assert.equal((await call('readGoogleDoc', { documentId: 'doc' }, {
      GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS: 'blocked',
    })).isError, true);
    assert.equal(documentReads, 1, 'Denied read must not reach the Docs endpoint');
    assert.equal((await call('uploadFile', {
      name: 'example.txt', contentBase64: Buffer.from('hello upload').toString('base64'),
    })).isError, false);
    assert.equal(uploaded.length, 1);
    const before = stateHash();
    assert.equal((await call('uploadFile', {
      name: 'denied.txt', contentBase64: 'eA==', parentFolderId: 'blocked',
    }, { GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS: 'blocked' })).isError, true);
    assert.equal(stateHash(), before, 'Rejected upload must not change stored data');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
