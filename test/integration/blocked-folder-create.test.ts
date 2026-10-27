import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { google } from 'googleapis';
import { RUNTIME_DEFAULTS } from '../../src/utils/cliArgs.js';
import { createAllMocks } from '../helpers/mock-google-apis.js';

test('blocked native creation destinations never persist files', async t => {
  const mocks = createAllMocks();
  Object.assign(google, mocks.google);
  const mod = await import('../../src/index.js');
  for (const command of [
    { name: 'createGoogleSheet', arguments: { name: 'DeniedSheet', parentFolderId: 'private', data: [['hello']] } },
    { name: 'createGoogleSlides', arguments: { name: 'DeniedSlides', parentFolderId: 'private', slides: [{ title: 'Hello', content: 'Body' }] } },
  ]) {
    await t.test(command.name, async () => {
      const files: Record<string, any> = {
        root: { id: 'root' }, private: { id: 'private', parents: ['root'] },
      };
      const directory = mkdtempSync(join(tmpdir(), 'blocked-create-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const state = join(directory, 'files.json');
      const persist = () => writeFileSync(state, JSON.stringify(files));
      const hash = () => createHash('sha256').update(readFileSync(state)).digest('hex');
      persist();
      mocks.drive.service.files.get._setImpl(async (p: any) => {
        if (!files[p.fileId]) throw new Error('not found');
        return { data: files[p.fileId] };
      });
      mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
      mocks.sheets.service.spreadsheets.create._setImpl(async () => {
        files.newSheet = { id: 'newSheet', parents: ['root'] };
        persist();
        return { data: { spreadsheetId: 'newSheet' } };
      });
      mocks.slides.service.presentations.create._setImpl(async () => {
        files.newSlides = { id: 'newSlides', parents: ['root'] };
        persist();
        return { data: { presentationId: 'newSlides' } };
      });
      mod._setAuthClientForTesting({ request: async () => ({ data: {} }) });
      const server = mod.createMcpServer({ ...RUNTIME_DEFAULTS, blockedFolderIds: ['private'], retryMax: 0 });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      const client = new Client({ name: 'blocked-create', version: '1' });
      await client.connect(a);
      try {
        const before = hash();
        const result = await client.callTool(command);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /blocked folder/i);
        assert.equal(hash(), before);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
