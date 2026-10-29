# Run the MCP on Cloudflare Workers

The Worker exposes **`POST /mcp`**, using stateless Streamable HTTP and one preconfigured Google account. Requests require either your private MCP bearer token or, when configured, an OAuth access token. The existing Node CLI, stdio, and team deployments are unchanged.

## Local setup

1. Use Node.js 22 or newer and install dependencies with `npm ci`.
2. Follow [Google setup](setup.md) and authenticate locally with `npm run auth` after building. For the optional ChatGPT OAuth flow, use a Google OAuth **Web application** client instead of the Desktop client recommended in the general setup guide; it must support the HTTPS callback described below. Enable the APIs and grant the scopes needed by your tools. Use the resulting Google refresh token with the **same OAuth client ID and secret** that issued it. Never commit or paste credentials into issue reports.
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

Initialize the connection, then call `tools/list` or `search`. Clients requiring an interactive remote OAuth flow can use the optional OAuth setup below. Cross-origin browser requests to the MCP endpoint are rejected; this endpoint does not offer CORS.

## Checks before deployment

```sh
npm run test:workers
npm run workers:check
npm run test:workers:runtime
```

`workers:check` only bundles locally (`wrangler deploy --dry-run`). The runtime check starts local workerd with synthetic credentials, verifies authentication and MCP discovery, and stops it; it does not contact Google. Unit tests mock token refresh and Drive search, including the folder denylist. Real Google authorization, API permissions, and production quotas still need validation with your own account.

## Deploy when you are ready

Deployment is a separate operation. Choose the Worker name in `wrangler.jsonc`, authenticate Wrangler to your intended Cloudflare account, and set the build environment variable `OAUTH_KV_ID` to your KV namespace ID. The deploy command generates `.cache/worker-deploy/wrangler.json` locally and uses it to bind that namespace as `OAUTH_KV`; the generated configuration is ignored by Git. An absent or invalid ID stops deployment. Then store secrets interactively:

```sh
npx wrangler secret put MCP_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npm run workers:deploy
```

Point the client at `https://<your-worker>.<your-subdomain>.workers.dev/mcp` with the bearer header. Anyone holding that token can use the configured Google account's granted permissions, including writes. Rotate it if exposed. There is no per-user Google account isolation; optional OAuth protects access to the single configured account.

Optionally add `GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS` to Wrangler `vars` or secrets: a nonempty comma-separated list of Drive folder IDs. The existing folder policy blocks those folders and their descendants across Drive, Docs, Sheets, and Slides. An invalid list fails closed. Google permissions remain the primary authorization boundary.

## ChatGPT OAuth setup

The optional OAuth integration requires a Cloudflare KV namespace bound as `OAUTH_KV`, and an `OAUTH_ISSUER` runtime variable set to the exact HTTPS Worker origin without a trailing slash. Set `OAUTH_KV_ID` as a **build environment variable** to your namespace ID; it is used by `npm run workers:deploy` to generate the binding, not exposed as a Worker runtime variable. For Cloudflare Workers Builds, set the deploy command to `npm run workers:deploy` instead of `npx wrangler deploy`. OAuth remains unavailable until both the KV binding and issuer are configured; the existing `MCP_ACCESS_TOKEN` continues to work.

Register `<OAUTH_ISSUER>/oauth/google/callback` as an authorized redirect URI on the same Google OAuth client used for the Drive refresh token. The Google refresh token must have the `openid` and `https://www.googleapis.com/auth/userinfo.email` scopes so that its account subject can be verified through Google userinfo. The normal `npm run auth` flow does not request these identity scopes by default. If needed, use the Node MCP's `manage_accounts` tool with action `add` to reauthorize the same account; that flow requests the identity scopes in addition to the configured Google scopes. Then update `GOOGLE_REFRESH_TOKEN` with the new record's `refreshToken`. This is separate from ChatGPT's OAuth login. The Worker compares the Google sign-in subject with the refresh token's subject before issuing an OAuth grant and again on each OAuth-authenticated MCP request. If Google identity verification fails, access fails closed. This extra Google lookup adds latency and consumes API requests. The static bearer path remains independent.

In ChatGPT, use `<OAUTH_ISSUER>/mcp` and select OAuth. Only grant access to clients you trust: an authorized client can exercise the configured Google account's permissions, including writes. Existing static bearer holders retain access independently of OAuth revocation. Keep all credentials out of source control.

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
