import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const script = path.resolve('scripts/prepare-worker-config.js');
const cache = path.resolve('.cache');
mkdirSync(cache, { recursive: true });

test('generates a KV binding from OAUTH_KV_ID and rejects absent or invalid IDs without changing output', () => {
  const root = mkdtempSync(path.join(cache, 'config-test-'));
  try {
    writeFileSync(path.join(root, 'wrangler.jsonc'), '{ // comment\n "name": "test", "main": "src/worker.ts", "kv_namespaces": [{"binding":"OTHER","id":"existing"}],\n}');
    const output = path.join(root, '.cache/worker-deploy/wrangler.json');
    const run = (id) => {
      const env = { ...process.env };
      delete env.OAUTH_KV_ID;
      if (id !== undefined) env.OAUTH_KV_ID = id;
      return spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    };
    let result = run(undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'OAUTH_KV_ID must be a 32-character hexadecimal KV namespace ID.\n');
    assert.equal(existsSync(output), false);
    result = run('0123456789abcdef0123456789abcdef');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Worker deployment configuration prepared.\n');
    const before = readFileSync(output, 'utf8');
    const config = JSON.parse(before);
    assert.deepEqual(config.kv_namespaces, [
      { binding: 'OTHER', id: 'existing' },
      { binding: 'OAUTH_KV', id: '0123456789abcdef0123456789abcdef' },
    ]);
    assert.equal(path.resolve(path.dirname(output), config.main), path.join(root, 'src/worker.ts'));
    result = run('invalid');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'OAUTH_KV_ID must be a 32-character hexadecimal KV namespace ID.\n');
    assert.equal(readFileSync(output, 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
