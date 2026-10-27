import assert from 'node:assert/strict';
import test from 'node:test';
import type { drive_v3 } from 'googleapis';
import { FolderAccessPolicy } from '../src/utils/folderAccess.js';

function fixture(blockedIds = ['private']) {
  const files: Record<string, any> = {
    root: { id: 'root', mimeType: 'application/vnd.google-apps.folder' },
    private: { id: 'private', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' },
    nested: { id: 'nested', parents: ['private'], mimeType: 'application/vnd.google-apps.folder' },
    secret: { id: 'secret', parents: ['nested'] },
    public: { id: 'public', parents: ['root'] },
    shortcut: { id: 'shortcut', parents: ['root'], shortcutDetails: { targetId: 'secret' } },
  };
  const calls: string[] = [];
  const raw = {
    files: {
      get: async (p: any) => {
        calls.push(`get:${p.fileId}:${p.alt ?? 'metadata'}`);
        if (!files[p.fileId]) throw new Error('not found');
        return { data: p.alt === 'media' ? 'content' : structuredClone(files[p.fileId]) };
      },
      list: async (_p: any) => ({ data: { files: Object.values(files), nextPageToken: 'next' } }),
      update: async (p: any) => {
        calls.push('update');
        files[p.fileId].changed = true;
        return { data: files[p.fileId] };
      },
      create: async (_p: any) => { calls.push('create'); return { data: { id: 'new' } }; },
      copy: async (_p: any) => { calls.push('copy'); return { data: { id: 'copy' } }; },
    },
    permissions: { create: async (_p: any) => { calls.push('permission'); return { data: {} }; } },
  };
  const policy = new FolderAccessPolicy(raw as unknown as drive_v3.Drive, blockedIds);
  return { files, calls, raw, policy, drive: policy.protect(raw, 'drive') };
}

test('blocked folders, descendants, and shortcuts reject reads before content is requested', async () => {
  const { drive, calls } = fixture();
  for (const fileId of ['private', 'nested', 'secret', 'shortcut']) {
    await assert.rejects(() => drive.files.get({ fileId, alt: 'media' }), /blocked folder/i);
  }
  assert.ok(calls.every(call => !call.endsWith(':media')));
  assert.equal((await drive.files.get({ fileId: 'public', alt: 'media' })).data, 'content');
});

test('lists hide blocked descendants and shortcuts without losing the page token', async () => {
  const { drive } = fixture();
  const result = await drive.files.list({ fields: 'files(id,name),nextPageToken' });
  assert.deepEqual(result.data.files.map(f => f.id), ['root', 'public']);
  assert.equal(result.data.nextPageToken, 'next');
});

test('rejected writes and destinations leave data unchanged', async () => {
  const { drive, files, calls } = fixture();
  const before = JSON.stringify(files);
  for (const operation of [
    () => drive.files.update({ fileId: 'secret' }),
    () => drive.files.update({ fileId: 'public', addParents: 'nested' }),
    () => drive.files.create({ requestBody: { parents: ['private'] } }),
    () => drive.files.create({ requestBody: { shortcutDetails: { targetId: 'secret' } } }),
    () => drive.files.copy({ fileId: 'secret' }),
    () => drive.permissions.create({ fileId: 'root' }),
  ]) await assert.rejects(operation, /blocked folder/i);
  assert.equal(JSON.stringify(files), before);
  assert.ok(!calls.some(call => ['update', 'create', 'copy', 'permission'].includes(call)));
  await drive.files.update({ fileId: 'public' });
  assert.equal(files.public.changed, true);
});

test('native APIs guard document IDs and cross-spreadsheet destinations', async () => {
  const { policy } = fixture();
  let executed = 0;
  const operation = async (_p: any) => { executed++; return { data: {} }; };
  for (const api of ['docs', 'sheets', 'slides'] as const) {
    const native = policy.protect({ documents: { get: operation } }, api);
    await assert.rejects(() => native.documents.get({ documentId: 'secret' }), /blocked folder/i);
  }
  const sheets = policy.protect({ spreadsheets: { sheets: { copyTo: operation } } }, 'sheets');
  await assert.rejects(() => sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: 'public', requestBody: { destinationSpreadsheetId: 'secret' },
  }), /blocked folder/i);
  assert.equal(executed, 0);
});

test('unknown ancestry and cycles fail closed; ancestry is refreshed between calls', async () => {
  const { drive, files } = fixture();
  await assert.rejects(() => drive.files.get({ fileId: 'missing' }), /verify|ancestry/i);
  files.public.parents = ['public'];
  await assert.rejects(() => drive.files.get({ fileId: 'public' }), /verify|ancestry/i);
  files.public.parents = ['root'];
  await drive.files.get({ fileId: 'public' });
  files.public.parents = ['private'];
  await assert.rejects(() => drive.files.get({ fileId: 'public' }), /blocked folder/i);
});

test('disabled policy preserves service identity and makes no metadata requests', async () => {
  const { policy, raw, calls } = fixture([]);
  assert.equal(policy.protect(raw, 'drive'), raw);
  assert.deepEqual(calls, []);
});
