# Google Drive MCP Server

[![MCP Toplist](https://mcptoplist.com/badge/io.github.piotr-agier%2Fgoogle-drive-mcp.svg)](https://mcptoplist.com/server/io.github.piotr-agier%2Fgoogle-drive-mcp)

Connect an MCP client to Google Drive, Docs, Sheets, Slides, and Calendar through one self-hosted server. Search and organize files, create and edit Workspace content, manage sharing, and automate multi-step workflows while keeping control of the Google identity and credentials used for every call.

## Why this server

- **Drive-first workflows:** 130 tools cover file management, Shared Drives, permissions, revisions, rich Docs editing, Sheets formatting, Slides authoring, and Calendar events.
- **Local or hosted:** use stdio for a personal desktop client, Streamable HTTP for a hosted integration, or OAuth-protected team mode for a shared service.
- **Identity control:** local OAuth supports multiple Google accounts and per-tool account selection; service accounts and externally managed OAuth tokens are also supported.
- **Agent-friendly access:** tools expose targeted operations, while the optional `gdrive:///` resource interface supports direct reading and discovery.
- **Open and self-hosted:** credentials and tokens stay in the environment you operate.

This project remains focused on deep Drive and editor workflows rather than attempting to expose every Google Workspace API.

## Client compatibility

Compatibility is determined by the transport and authentication flow a client supports.

| Client type | Transport | Recommended mode |
|---|---|---|
| Claude Desktop | stdio | Local OAuth |
| Other local MCP clients, including Gemini CLI | stdio | Local OAuth |
| claude.ai custom connectors | Streamable HTTP | Team mode |
| Other remote MCP clients | Streamable HTTP | Single identity behind access control, or team mode with OAuth 2.1 |

See [Client configuration](docs/clients.md#client-configuration) for configuration examples and transport requirements.

For a single-account server on Cloudflare Workers, see the [Workers setup guide](docs/cloudflare-workers.md). It uses a protected stateless `/mcp` endpoint; local filesystem tools and team OAuth are not available in that adapter.

## Cloudflare Workers and ChatGPT setup

Use this path to host the stateless `/mcp` endpoint on Cloudflare Workers for **one preconfigured Google account**. Clients can authenticate with the existing private bearer token or, when configured, OAuth. OAuth sign-in must match the Google account associated with the configured refresh token; this is not a multi-user Google-account service. The OAuth integration has not yet been verified end to end with ChatGPT.

### 1. Prepare Google credentials and a refresh token

1. Enable the Google Drive, Docs, Sheets, Slides, and Calendar APIs you need. Configure the Google OAuth consent screen and add your account as a test user if the app is in testing.
2. Create a Google OAuth **Web application** client. In Google Cloud Console, open **APIs & Services → Credentials**, select that client, and add these authorized redirect URIs:
   - `http://127.0.0.1:3000/oauth2callback` for the local authorization flow.
   - `https://<worker>.<subdomain>.workers.dev/oauth/google/callback` for the Worker OAuth flow. Replace the host with your actual Worker origin; keep the local URI too.
3. Download the client JSON to a private location. Use the same client's `client_id` and `client_secret` throughout; never commit or upload the JSON.
4. Obtain a refresh token for the Google account to expose. The token must include both `openid` and `https://www.googleapis.com/auth/userinfo.email` as well as the Google API scopes your tools need. The normal `npm run auth` flow does **not** request the identity scopes by default. In a local Node MCP client, use `manage_accounts(action="add", account_id="personal")` to authorize the same account with those identity scopes. See [Multi-Account Support](docs/authentication.md#multi-account-support).
5. The resulting account record is stored in `tokens.json` (by default `~/.config/google-drive-mcp/tokens.json`; on Windows, `%USERPROFILE%\.config\google-drive-mcp\tokens.json`). Copy its `refreshToken` value privately for Cloudflare. Do not share or commit the token file. The configured path may differ when `GOOGLE_DRIVE_MCP_TOKEN_PATH` or `XDG_CONFIG_HOME` is set.

### 2. Create KV and configure Workers Builds

1. Create a Workers KV namespace in the Cloudflare dashboard. Copy its **namespace ID**, not the Cloudflare account ID.
2. Connect this repository to a Worker. After merging these changes into **`cloudflare-worker`**, push that branch to the remote and select `cloudflare-worker` as the production branch under the Worker's **Settings → Build → Branch control**. Do not select `master` or `main` for these changes.
3. In the build's **Variables and secrets**, add `OAUTH_KV_ID` as a text variable with the namespace ID. It is a **build variable**, not a Worker runtime secret.
4. Set the build command to `npm run build` and the deploy command to `npm run workers:deploy`. The deploy script generates an ignored Wrangler configuration with the `OAUTH_KV` binding. Missing or invalid `OAUTH_KV_ID` stops deployment; each deployer supplies their own ID without editing `wrangler.jsonc`.

### 3. Set Worker runtime variables and secrets

Build variables are not automatically available to the running Worker. In the Worker's **Settings → Variables & Secrets**, configure these separately:

| Runtime name | Recommended type | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Text or Secret | Client ID from the Google OAuth Web client |
| `GOOGLE_CLIENT_SECRET` | Secret | Secret from that same client |
| `GOOGLE_REFRESH_TOKEN` | Secret | Refresh token for the configured Google account |
| `MCP_ACCESS_TOKEN` | Secret | Independent cryptographically random bearer token, at least 32 characters |
| `OAUTH_ISSUER` | Text | Worker origin, e.g. `https://<worker>.<subdomain>.workers.dev`, without `/mcp` or a trailing slash |
| `GOOGLE_DRIVE_MCP_BLOCKED_FOLDER_IDS` | Text or Secret | Optional comma-separated folder IDs |

For a folder URL such as `https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing`, use only `FOLDER_ID`, without the path or query parameters. The policy blocks the listed folders and their descendants; Google permissions remain the primary authorization boundary. Never put credentials in URLs or logs.

### 4. Deploy and connect

1. Commit and push the branch containing the Worker changes according to your repository workflow. Confirm Cloudflare's **production branch** is that branch, then trigger a build and check its branch, commit, and result. Build settings apply to the next build. Enable the `workers.dev` URL or configure a domain if necessary.
2. Verify the runtime variables and secrets are still present after deployment. A successful build alone does not verify Google authorization or the complete OAuth flow.
3. In ChatGPT, enable developer mode if available for your account or workspace, create a custom MCP app, select **OAuth**, and use `https://<worker>.<subdomain>.workers.dev/mcp`. Sign in to the same Google account as the refresh token and review the consent screen. If the connection fails, inspect the build and Worker logs without sharing secrets.
4. For an MCP client that supports a custom header, the existing bearer-token path remains available: `Authorization: Bearer <MCP_ACCESS_TOKEN>`. OAuth revocation does not revoke that separate bearer token. Anyone holding it can exercise the configured Google account's permissions, including writes.

See the [Workers setup guide](docs/cloudflare-workers.md) for local development, runtime limitations, and troubleshooting. Do not disable authentication to connect a client.

## Quick start

### 1. Create Google OAuth credentials

In a Google Cloud project:

1. Enable the Drive, Docs, Sheets, Slides, and Calendar APIs.
2. Configure the OAuth consent screen and add your Google account as a test user when the app is in testing.
3. Create an OAuth client with application type **Desktop app**.
4. Download the JSON file and save it as:

```text
~/.config/google-drive-mcp/gcp-oauth.keys.json
```

The [setup guide](docs/setup.md) has the complete Google Cloud walkthrough and alternative credential locations.

### 2. Authenticate

```bash
npx -y @piotr-agier/google-drive-mcp auth
```

Complete the Google consent flow in the browser. Tokens are stored by default at `~/.config/google-drive-mcp/tokens.json`.

### 3. Add the server to your MCP client

For clients that use the common `mcpServers` configuration shape:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@piotr-agier/google-drive-mcp"]
    }
  }
}
```

Restart the client after saving its configuration. Claude Desktop paths and HTTP examples are documented in [Client configuration](docs/clients.md#client-configuration).

### 4. Make a first tool call

Ask your client:

```text
Run authGetStatus and tell me which Google account is active.
```

Then try a read-only Drive request:

```text
Search my Google Drive for files modified in the last seven days.
```

If the identity is wrong or search returns no files, use the [troubleshooting guide](docs/troubleshooting.md).

## What you can do

### Organize Drive

```text
Find PDF files in /Reports, create an Archive folder there, and move files older
than one year into it.
```

### Build a report

```text
Create a Google Sheet for monthly results, summarize it in a Google Doc, and
create a short Google Slides presentation from the summary.
```

### Edit a document

```text
Find the "Project Plan" document, replace the old launch date, format the new
date in bold, and add a comment describing the change.
```

### Prepare a meeting

```text
Create a Calendar event with a Google Meet link and attach the project brief
from Drive.
```

<!--
  Anchors for sections that lived in this README before the guides moved to docs/.
  External deep links (directory listings, issue replies, blog posts) land on the
  table below, which names the guide each section moved to. Do not remove.
-->
<a id="features"></a><a id="example-usage"></a><a id="requirements"></a>
<a id="google-cloud-setup"></a><a id="installation"></a><a id="docker-usage"></a>
<a id="configuration"></a><a id="runtime-configuration-cli-args-or-env-vars"></a>
<a id="usage-with-claude-desktop"></a><a id="streamable-http-transport"></a>
<a id="team-mode-multi-user-http-deployments"></a><a id="available-tools"></a>
<a id="external-authentication"></a><a id="multi-account-support"></a>
<a id="authentication-flow"></a><a id="troubleshooting"></a><a id="development"></a>
<a id="advanced-configuration"></a><a id="contributing"></a><a id="support"></a>

## Documentation

Every section that used to live in this README is now in one of these guides.

| Guide | Contents |
|---|---|
| [Setup](docs/setup.md) | Requirements, Google Cloud APIs, OAuth credentials, and installation |
| [Client configuration](docs/clients.md) | Supported transports and client configuration |
| [Authentication](docs/authentication.md) | Local OAuth, multi-account, service accounts, external tokens, and scopes |
| [Configuration](docs/configuration.md) | CLI flags, environment variables, defaults, and precedence |
| [Deployment](docs/deployment.md) | Docker, Streamable HTTP, team mode, and reverse-proxy security |
| [Tool reference](docs/tools.md) | All Drive, Docs, Sheets, Slides, Calendar, and account tools |
| [Troubleshooting](docs/troubleshooting.md) | Authentication, API, identity, Docker, and rate-limit problems |
| [Development](docs/development.md) | Repository structure, build commands, tests, and contributions |

## Security

- Never commit OAuth credentials, service-account keys, access tokens, refresh tokens, or `tokens.json`.
- Use the narrowest OAuth scopes that support the tools you need.
- Keep the default HTTP bind address on `127.0.0.1` unless the server is protected by TLS and access control.
- Use [team mode](docs/deployment.md#team-mode-multi-user-http-deployments) for shared deployments so every request is authenticated as its caller.
- Treat `team-store.json` as a secret because it contains members' Google refresh tokens.

See [Authentication](docs/authentication.md) and [Deployment](docs/deployment.md) for the complete security and identity model.

## Development and support

See the [development guide](docs/development.md) to build and test the project.

- Report defects and request features in [GitHub Issues](https://github.com/piotr-agier/google-drive-mcp/issues).
- Review released changes in the [changelog](CHANGELOG.md).
- Contributions are welcome through pull requests.

## License

[MIT](LICENSE)

## Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io).
- Uses the [Google APIs Node.js Client](https://github.com/googleapis/google-api-nodejs-client).
