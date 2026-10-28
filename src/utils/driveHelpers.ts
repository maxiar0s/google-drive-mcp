import type { drive_v3 } from 'googleapis';
import { escapeDriveQuery, getExtensionFromFilename, PARENT_SCOPED_LIST_PARAMS } from '../utils.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export async function resolvePath(pathStr: string, drive: drive_v3.Drive, verifyAccess = false): Promise<string> {
  if (verifyAccess) await drive.files.get({ fileId: 'root', fields: 'id', supportsAllDrives: true });
  if (!pathStr || pathStr === '/') return 'root';
  const parts = pathStr.replace(/^\/+|\/+$/g, '').split('/');
  let currentFolderId = 'root';
  for (const part of parts) {
    if (!part) continue;
    const response = await drive.files.list({
      q: `'${currentFolderId}' in parents and name = '${escapeDriveQuery(part)}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
      fields: 'files(id)', spaces: 'drive',
      // Parent-scoped lookup must not miss Shared Drive matches and create duplicates.
      ...PARENT_SCOPED_LIST_PARAMS,
    });
    if (!response.data.files?.length) {
      const folder = await drive.files.create({
        requestBody: { name: part, mimeType: FOLDER_MIME_TYPE, parents: [currentFolderId] },
        fields: 'id', supportsAllDrives: true,
      });
      if (!folder.data.id) throw new Error(`Failed to create intermediate folder: ${part}`);
      currentFolderId = folder.data.id;
    } else {
      currentFolderId = response.data.files[0].id!;
    }
  }
  return currentFolderId;
}

export async function resolveFolderId(input: string | undefined, drive: drive_v3.Drive, verifyAccess = false): Promise<string> {
  const folderId = input?.startsWith('/') ? await resolvePath(input, drive, verifyAccess) : input || 'root';
  if (verifyAccess) await drive.files.get({ fileId: folderId, fields: 'id', supportsAllDrives: true });
  return folderId;
}

export function validateTextFileExtension(name: string): void {
  if (!['txt', 'md'].includes(getExtensionFromFilename(name))) {
    throw new Error('File name must end with .txt or .md for text files.');
  }
}

export async function checkFileExists(
  name: string, parentFolderId = 'root', drive: drive_v3.Drive, failClosed = false,
  log: (message: string, error: unknown) => void = () => {},
): Promise<string | null> {
  try {
    const res = await drive.files.list({
      q: `name = '${escapeDriveQuery(name)}' and '${parentFolderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)', pageSize: 1,
      ...PARENT_SCOPED_LIST_PARAMS,
    });
    return res.data.files?.[0]?.id || null;
  } catch (error) {
    if (failClosed) throw error;
    log('Error checking file existence:', error);
    return null;
  }
}
