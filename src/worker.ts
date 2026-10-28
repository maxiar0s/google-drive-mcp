import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as driveTools from './tools/drive.js';
import * as docsTools from './tools/docs.js';
import * as sheetsTools from './tools/sheets.js';
import * as slidesTools from './tools/slides.js';
import * as calendarTools from './tools/calendar.js';
import { TOOL_META } from './tools/toolMeta.js';
import { errorResponse } from './types.js';
import { RUNTIME_DEFAULTS } from './utils/cliArgs.js';
import { createWorkerContext } from './workerContext.js';

export interface WorkerEnv {
  MCP_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS?: string;
}

const modules = [driveTools, docsTools, sheetsTools, slidesTools, calendarTools];
const hiddenTools = new Set(['downloadFile', 'uploadPdfWithSplit', 'manage_accounts', 'authGetStatus', 'authListScopes']);
const definitions = modules.flatMap(module => module.toolDefinitions).filter(tool => !hiddenTools.has(tool.name)).map(tool => {
  const definition = TOOL_META[tool.name]?.opKind === 'read'
    ? { ...tool, annotations: { readOnlyHint: true } }
    : tool;
  if (tool.name !== 'uploadFile') return definition;
  const properties = { ...(tool.inputSchema.properties as Record<string, unknown>) };
  delete properties.localPath;
  properties.contentBase64 = { type: 'string', description: 'Base64-encoded file content. Required in Workers.' };
  return {
    ...definition,
    description: 'Upload file content to Google Drive. In Workers, provide contentBase64; host paths are not supported.',
    inputSchema: { ...tool.inputSchema, properties, required: ['contentBase64'] },
  };
});

async function readBody(request: Request): Promise<unknown | Response> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RUNTIME_DEFAULTS.maxBodyBytes) {
        await reader.cancel();
        return new Response('Request body too large', { status: 413 });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (!env.MCP_ACCESS_TOKEN || env.MCP_ACCESS_TOKEN.length < 32 ||
        !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
      return new Response('Worker secrets are not configured', { status: 503 });
    }
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
    const supplied = Buffer.from(token);
    const expected = Buffer.from(env.MCP_ACCESS_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return new Response('Origin not allowed', { status: 403 });
    if (request.method !== 'POST') {
      return new Response('Stateless endpoint supports POST only', { status: 405, headers: { Allow: 'POST' } });
    }
    const blocked = env.GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS;
    const blockedFolderIds = blocked === undefined ? [] : blocked.split(',').map(id => id.trim());
    if (blockedFolderIds.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
      return new Response('Invalid Worker configuration', { status: 503 });
    }
    const parsedBody = await readBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const config = { ...RUNTIME_DEFAULTS, disableResources: true, blockedFolderIds };
    const server = new Server({ name: 'google-drive-mcp', version: '1.0.0-workers' }, { capabilities: { tools: {} } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params;
      if (!definitions.some(tool => tool.name === name)) return errorResponse('Tool is not available in Workers.');
      if ('localPath' in args || 'account' in args) return errorResponse('Host paths and account overrides are not supported in Workers.');
      try {
        const context = createWorkerContext(env, config);
        for (const module of modules) {
          const result = await module.handleTool(name, args, context);
          if (result !== null) return result;
        }
      } catch {
        return errorResponse('Google API request failed. Check the configured credentials and scopes.');
      }
      return errorResponse('Tool not found');
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      await server.close();
    }
  },
};
