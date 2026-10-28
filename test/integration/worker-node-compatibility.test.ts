import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server, _setAuthClientForTesting } from '../../src/index.js';

test('Workers preparation preserves Node tool behavior and rejected-call data', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gdrive-node-compat-'));
  const filePath = join(scratch, 'data.json');
  const files: Array<Record<string, any>> = [];
  await writeFile(filePath, '[]');
  const hash = async () => createHash('sha256').update(await readFile(filePath)).digest('hex');
  const originalDrive = google.drive;
  google.drive = (() => ({ files: {
    list: async (params: any) => {
      const name = params.q?.match(/name = '([^']*)'/)?.[1];
      return { data: { files: name ? files.filter(file => file.name === name) : files } };
    },
    create: async (params: any) => {
      let content = '';
      if (typeof params.media?.body === 'string') content = params.media.body;
      else if (params.media?.body) {
        for await (const chunk of params.media.body) content += chunk.toString();
      }
      const file = { id: `id${files.length}`, ...params.requestBody, content };
      files.push(file);
      await writeFile(filePath, JSON.stringify(files));
      return { data: file };
    },
    get: async (params: any) => ({ data: files.find(file => file.id === params.fileId) ?? { id: params.fileId } }),
  } })) as unknown as typeof google.drive;
  _setAuthClientForTesting({});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'node-compatibility', version: '1' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['createTextFile', { name: 'note.txt', content: 'hello', parentFolderId: '/alpha' }, false],
      ['createTextFile', { name: 'bad.exe', content: 'bad' }, true],
      ['createTextFile', { name: 'note.txt', content: 'duplicate', parentFolderId: '/alpha' }, true],
      ['createFolder', { name: 'beta', parent: '/alpha' }, false],
      ['listFolder', { folderId: '/alpha' }, false],
      ['uploadFile', { name: 'upload.bin', contentBase64: 'aGVsbG8=' }, false],
      ['uploadFile', { name: 'bad.bin', contentBase64: '!!!!' }, true],
      ['uploadFile', { name: 'bad.bin', contentBase64: 'aGVsbG8=', localPath: 'C:\\fake' }, true],
    ];
    for (const [name, args, rejected] of cases) {
      const before = await hash();
      const result = await client.callTool({ name, arguments: args });
      assert.equal(!!result.isError, rejected, JSON.stringify(result));
      if (rejected) assert.equal(await hash(), before, `${name} rejection changed stored data`);
    }
    assert.equal(files.find(file => file.name === 'note.txt')?.content, 'hello');
    assert.equal(files.find(file => file.name === 'upload.bin')?.content, 'hello');
  } finally {
    await client.close();
    google.drive = originalDrive;
    // Test scratch follows the repository's external-temp convention.
    console.error(`Node compatibility scratch: ${scratch}`);
  }
});
