import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { google } from 'googleapis';
import { RUNTIME_DEFAULTS } from '../../src/utils/cliArgs.js';
import { createAllMocks } from '../helpers/mock-google-apis.js';

test('MCP dispatch enforces the same folder policy for tools and resources', async () => {
  const mocks = createAllMocks();
  Object.assign(google, mocks.google);
  const files: Record<string, any> = {
    root: { id: 'root', name: 'Root' },
    private: { id: 'private', name: 'Private', parents: ['root'] },
    secret: { id: 'secret', name: 'Secret.txt', parents: ['private'], mimeType: 'text/plain' },
    public: { id: 'public', name: 'Public.txt', parents: ['root'], mimeType: 'text/plain' },
  };
  mocks.drive.service.files.get._setImpl(async (params: any) => {
    if (!files[params.fileId]) throw new Error('not found');
    return { data: params.alt === 'media' ? 'public text' : files[params.fileId] };
  });
  mocks.drive.service.files.list._setImpl(async () => ({
    data: { files: [files.secret, files.public], nextPageToken: 'next' },
  }));
  const mod = await import('../../src/index.js');
  mod._setAuthClientForTesting({ request: async () => ({ data: {} }) });
  const server = mod.createMcpServer({ ...RUNTIME_DEFAULTS, blockedFolderIds: ['private'] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'folder-policy-test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map(r => r.uri), ['gdrive:///public']);
    assert.equal(resources.nextCursor, 'next');
    await assert.rejects(() => client.readResource({ uri: 'gdrive:///secret' }), /blocked folder/i);
    const allowed = await client.readResource({ uri: 'gdrive:///public' });
    assert.ok(JSON.stringify(allowed).includes('public text'));
    const search = await client.callTool({ name: 'search', arguments: { query: 'text' } });
    assert.ok(!search.isError);
    assert.ok(JSON.stringify(search).includes('Public.txt'));
    assert.ok(!JSON.stringify(search).includes('Secret.txt'));
    const before = JSON.stringify(files);
    const denied = await client.callTool({ name: 'renameItem', arguments: { itemId: 'secret', newName: 'Changed' } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /blocked folder/i);
    assert.equal(JSON.stringify(files), before);
    const native = await client.callTool({ name: 'getGoogleDocContent', arguments: { documentId: 'secret' } });
    assert.equal(native.isError, true);
    assert.match(JSON.stringify(native), /blocked folder/i);
    assert.equal(mocks.docs.tracker.getCalls('documents.get').length, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
