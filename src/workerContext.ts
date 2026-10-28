import { OAuth2Client } from 'google-auth-library';
import { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import { docs_v1 } from 'googleapis/build/src/apis/docs/v1.js';
import { sheets_v4 } from 'googleapis/build/src/apis/sheets/v4.js';
import { slides_v1 } from 'googleapis/build/src/apis/slides/v1.js';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/v3.js';
import type { google as GoogleApis } from 'googleapis';
import type { ToolContext } from './types.js';
import type { WorkerEnv } from './worker.js';
import type { RuntimeConfig } from './utils/cliArgs.js';
import { FolderAccessPolicy } from './utils/folderAccess.js';
import { resolvePath, resolveFolderId, validateTextFileExtension, checkFileExists } from './utils/driveHelpers.js';

/** Narrow imports avoid bundling every Google service into the Worker. */
const google = {
  drive: (options: object) => new drive_v3.Drive({ ...options, fetchImplementation: fetch }),
  docs: (options: object) => new docs_v1.Docs({ ...options, fetchImplementation: fetch }),
  sheets: (options: object) => new sheets_v4.Sheets({ ...options, fetchImplementation: fetch }),
  slides: (options: object) => new slides_v1.Slides({ ...options, fetchImplementation: fetch }),
  calendar: (options: object) => new calendar_v3.Calendar({ ...options, fetchImplementation: fetch }),
} as unknown as typeof GoogleApis;

export function createWorkerContext(env: WorkerEnv, config: RuntimeConfig): ToolContext {
  // Never persist tokens or mutate process.env: isolates serve concurrent requests.
  const authClient = new OAuth2Client({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
  authClient.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  authClient.transporter.defaults.fetchImplementation = fetch;
  authClient.transporter.defaults.timeout = config.tokenRefreshTimeout;
  const options = { auth: authClient, timeout: config.apiTimeout, fetchImplementation: fetch };
  const rawDrive = new drive_v3.Drive(options);
  const policy = new FolderAccessPolicy(rawDrive, config.blockedFolderIds ?? []);
  const drive = policy.protect(rawDrive, 'drive');
  const calendar = new calendar_v3.Calendar(options);
  const unavailable = (): never => { throw new Error('Account selection is not available in Workers.'); };
  const verifyAccess = !!config.blockedFolderIds?.length;
  return {
    authClient,
    google: policy.protectGoogle(google),
    getDrive: () => drive,
    getCalendar: () => calendar,
    log: () => {},
    resolvePath: path => resolvePath(path, drive, verifyAccess),
    resolveFolderId: input => resolveFolderId(input, drive, verifyAccess),
    checkFileExists: (name, parent) => checkFileExists(name, parent, drive, verifyAccess),
    validateTextFileExtension,
    runtimeConfig: config,
    sessionId: 'worker',
    resolveAccount: unavailable,
    getDriveFor: unavailable,
    getCalendarFor: unavailable,
    getAuthClientFor: unavailable,
    accountOps: {
      mode: 'external-token', list: unavailable, getDefault: unavailable,
      add: unavailable, remove: unavailable, setDefault: unavailable,
    },
  };
}
