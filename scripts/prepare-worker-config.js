import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const id = process.env.OAUTH_KV_ID;
if (!id || !/^[0-9a-f]{32}$/i.test(id)) {
  process.stderr.write('OAUTH_KV_ID must be a 32-character hexadecimal KV namespace ID.\n');
  process.exit(1);
}

const root = process.cwd();
const sourcePath = path.join(root, 'wrangler.jsonc');
const generatedDir = path.join(root, '.cache', 'worker-deploy');
const result = ts.parseConfigFileTextToJson(sourcePath, readFileSync(sourcePath, 'utf8'));
if (result.error || !result.config || typeof result.config.main !== 'string') {
  process.stderr.write('Invalid Wrangler configuration.\n');
  process.exit(1);
}
const config = result.config;
for (const key of ['main', '$schema']) {
  if (typeof config[key] === 'string' && !path.isAbsolute(config[key])) {
    config[key] = path.relative(generatedDir, path.resolve(root, config[key])).split(path.sep).join('/');
  }
}
if (config.kv_namespaces !== undefined && !Array.isArray(config.kv_namespaces)) {
  process.stderr.write('Invalid Wrangler configuration.\n');
  process.exit(1);
}
config.kv_namespaces = (config.kv_namespaces ?? []).filter(entry => entry?.binding !== 'OAUTH_KV');
config.kv_namespaces.push({ binding: 'OAUTH_KV', id });
mkdirSync(generatedDir, { recursive: true });
writeFileSync(path.join(generatedDir, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write('Worker deployment configuration prepared.\n');
