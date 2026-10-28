# Run the MCP on Cloudflare Workers

The Worker exposes **`POST /mcp`**, using stateless Streamable HTTP and one preconfigured Google account. Every request requires your private MCP bearer token. The existing Node CLI, stdio, and team deployments are unchanged.

## Local setup

1. Use Node.js 22 or newer and install dependencies with `npm ci`.
2. Follow [Google setup](setup.md) and authenticate locally with `npm run auth` after building. Enable the APIs and grant the scopes needed by your tools. Use the resulting Google refresh token with the **same OAuth client ID and secret** that issued it. Never commit or paste credentials into issue reports.
3. Copy `.env.example` to a private file **outside this checkout** and fill in its four required values. Generate `MCP_ACCESS_TOKEN` with a cryptographic random generator (at least 32 characters); it is an independent secret, not a Google access token. Keep it out of URLs.
4. Start the local Worker, passing the absolute path to that private file:

   ```sh
   npm run workers:dev -- --env-file /absolute/private/worker.env
   ```

   On Windows, use a path such as `C:\private\worker.env`. The default local endpoint is `http://localhost:8787/mcp`.

Your MCP client must support Streamable HTTP and a custom header:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Initialize the connection, then call `tools/list` or `search`. Clients requiring an interactive remote OAuth flow are not supported by this adapter; use the existing team deployment instead. Cross-origin browser requests are rejected; this endpoint does not offer CORS.

## Checks before deployment

```sh
npm run test:workers
npm run workers:check
npm run test:workers:runtime
```

`workers:check` only bundles locally (`wrangler deploy --dry-run`). The runtime check starts local workerd with synthetic credentials, verifies authentication and MCP discovery, and stops it; it does not contact Google. Unit tests mock token refresh and Drive search, including the folder denylist. Real Google authorization, API permissions, and production quotas still need validation with your own account.

## Deploy when you are ready

Deployment is a separate operation. Choose the Worker name in `wrangler.jsonc`, authenticate Wrangler to your intended Cloudflare account, then store secrets interactively:

```sh
npx wrangler secret put MCP_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npm run workers:deploy
```

Point the client at `https://<your-worker>.<your-subdomain>.workers.dev/mcp` with the bearer header. Anyone holding that token can use the configured Google account's granted permissions, including writes. Rotate it if exposed. There is no per-user isolation or OAuth discovery endpoint.

Optionally add `GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS` to Wrangler `vars` or secrets: a nonempty comma-separated list of Drive folder IDs. The existing folder policy blocks those folders and their descendants across Drive, Docs, Sheets, and Slides. An invalid list fails closed. Google permissions remain the primary authorization boundary.

## Runtime boundaries

| Area | Worker behavior |
| --- | --- |
| Credentials | Refresh token supplied through secrets; access tokens refreshed in memory per tool request. No `tokens.json`, OAuth callback listener, or disk writes. |
| Sessions | No persistent session IDs, account selection, SSE subscription, or resumability; each request is independent. GET and DELETE return 405. |
| Tools | Reuses Drive, Docs, Sheets, Slides, and Calendar handlers. `manage_accounts`, `authGetStatus`, `authListScopes`, `downloadFile`, and `uploadPdfWithSplit` are not offered and cannot be invoked directly. |
| Uploads | `uploadFile` requires `contentBase64`; `localPath` is rejected, including when combined with Base64 content. |
| Resources | The optional `gdrive:///` resources interface is not advertised. Use the corresponding tools. |
| Limits | JSON body limit is 4 MiB, including Base64 overhead. Worker CPU, memory, bundle size, and subrequest limits still apply. Large files and long batch operations may require the Node deployment or a different Workers plan. |

Narrow Google service imports keep unrelated APIs out of the bundle. `nodejs_compat` remains necessary for the libraries and stream-based handlers. A successful dry-run is not proof that a workload fits your plan; check the [current Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Reference: [Web Standards MCP transport](https://github.com/modelcontextprotocol/typescript-sdk) and [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).
