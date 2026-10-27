import type { drive_v3, google as GoogleApis } from 'googleapis';

export type FileApi = 'drive' | 'docs' | 'sheets' | 'slides';

class BlockedFolderError extends Error {
  constructor() { super('Access denied by blocked folder policy.'); }
}

const ID_KEYS = new Set(['fileId', 'documentId', 'spreadsheetId', 'presentationId', 'sourcePresentationId', 'destinationSpreadsheetId', 'targetId']);
const READ_METHODS = new Set(['get', 'list', 'export', 'getThumbnail', 'getByDataFilter', 'batchGet', 'batchGetByDataFilter']);

/** Server-side access policy; Google credential permissions remain unchanged. */
export class FolderAccessPolicy {
  constructor(private readonly drive: drive_v3.Drive, private readonly blockedIds: readonly string[]) {}

  protect<T extends object>(service: T, api: FileApi): T {
    if (!this.blockedIds.length) return service;
    const wrap = (object: any, path: string[]): any => new Proxy(object, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof key !== 'string' || key === 'context' || key.startsWith('_')) return value;
        if (typeof value === 'function') {
          return async (params: any = {}, ...rest: any[]) => {
            // Google services support callbacks too, but policy checks must finish
            // before any request. The MCP uses only their promise interface.
            if (rest.some(arg => typeof arg === 'function')) {
              throw new Error('Folder policy requires the promise-based Google API interface.');
            }
            await this.check(params, api, [...path, key]);
            const response = await value.call(target, params, ...rest);
            if (api === 'drive' && path[0] === 'files' && key === 'list') {
              const visible = [];
              for (const file of response.data.files ?? []) {
                if (!file.id) throw new Error('Cannot verify file ancestry: list results require file IDs.');
                try {
                  await this.check({ fileId: file.id }, 'drive', ['files', 'get']);
                  visible.push(file);
                } catch (error) {
                  if (!(error instanceof BlockedFolderError)) throw error;
                  // A named parent-scoped lookup drives create-on-miss and
                  // duplicate guards. Hiding a match must not trigger a write.
                  if (typeof params.q === 'string' && /\bname\s*=/.test(params.q) && /\bin parents\b/.test(params.q)) throw error;
                }
              }
              return { ...response, data: { ...response.data, files: visible } };
            }
            return response;
          };
        }
        return value && typeof value === 'object' ? wrap(value, [...path, key]) : value;
      },
    });
    return wrap(service, []);
  }

  protectGoogle(google: typeof GoogleApis): typeof GoogleApis {
    if (!this.blockedIds.length) return google;
    return new Proxy(google, {
      get: (target, key) => {
        const factory = Reflect.get(target, key);
        if (!['drive', 'docs', 'sheets', 'slides'].includes(String(key))) return factory;
        return (...args: any[]) => this.protect(factory.apply(target, args), key as FileApi);
      },
    });
  }

  private async check(params: any, api: FileApi, path: string[]): Promise<void> {
    // Per-request metadata only: caching across calls would permit a file moved
    // into a blocked subtree to retain its previous authorization.
    const metadata = new Map<string, Promise<drive_v3.Schema$File>>();
    const get = (id: string): Promise<drive_v3.Schema$File> => {
      if (!metadata.has(id)) {
        metadata.set(id, this.drive.files.get({
          fileId: id, fields: 'id,parents,mimeType,shortcutDetails', supportsAllDrives: true,
        }).then(result => {
          if (!result.data.id) throw new Error('Missing file ID');
          return result.data;
        }).catch(() => { throw new Error('Cannot verify file ancestry; access denied.'); }));
      }
      return metadata.get(id)!;
    };
    const blocked = new Set(this.blockedIds);
    if (blocked.has('root')) blocked.add((await get('root')).id!);
    const visit = async (id: string, ancestry = new Set<string>()): Promise<void> => {
      if (blocked.has(id)) throw new BlockedFolderError();
      if (ancestry.has(id) || ancestry.size >= 100) {
        throw new Error('Cannot verify file ancestry: cycle or depth limit; access denied.');
      }
      const file = await get(id);
      if (blocked.has(file.id!)) throw new BlockedFolderError();
      const next = new Set(ancestry).add(id);
      for (const parent of file.parents ?? []) await visit(parent, next);
      if (file.shortcutDetails?.targetId) await visit(file.shortcutDetails.targetId, next);
    };
    const ids = new Set<string>();
    const collect = (value: any, key = ''): void => {
      if (typeof value === 'string' && ID_KEYS.has(key)) ids.add(value);
      else if (typeof value === 'string' && ['addParents', 'removeParents'].includes(key)) {
        for (const id of value.split(',')) ids.add(id);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (key === 'parents' && typeof item === 'string') ids.add(item);
          else collect(item);
        }
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
      }
    };
    collect(params);
    if (api === 'drive' && path.join('.') === 'files.list' && typeof params.q === 'string') {
      for (const match of params.q.matchAll(/'([a-zA-Z0-9_-]+)'\s+in\s+parents\b/g)) ids.add(match[1]);
    }
    const method = path.at(-1)!;
    const operation = path.join('.');
    const createsFile = (api === 'drive' && operation === 'files.create') ||
      (api === 'docs' && operation === 'documents.create') ||
      (api === 'sheets' && operation === 'spreadsheets.create') ||
      (api === 'slides' && operation === 'presentations.create');
    if (createsFile && !params.requestBody?.parents?.length) ids.add('root');
    if (api !== 'drive' && !ids.size) {
      throw new Error('Operation is unavailable with the blocked folder policy: no verifiable file target.');
    }
    if (api === 'drive' && !ids.size && !['files.list', 'files.generateIds', 'about.get', 'drives.list'].includes(operation)) {
      throw new Error('Operation is unavailable with the blocked folder policy: no verifiable file target.');
    }
    for (const id of ids) await visit(id);

    // Mutating an ancestor (trash, move, permission changes) can affect a
    // configured blocked folder indirectly. Reject those operations as well.
    if (!READ_METHODS.has(method) && params.fileId) {
      const containsTarget = async (id: string, seen = new Set<string>()): Promise<boolean> => {
        const file = await get(id);
        if (id === params.fileId || file.id === params.fileId) return true;
        if (seen.has(id) || seen.size >= 100) throw new Error('Cannot verify file ancestry; access denied.');
        const next = new Set(seen).add(id);
        for (const parent of file.parents ?? []) if (await containsTarget(parent, next)) return true;
        return false;
      };
      for (const id of blocked) if (await containsTarget(id)) throw new BlockedFolderError();
    }
  }
}
