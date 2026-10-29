import { OAuthProvider, AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import type { WorkerEnv } from './worker.js';
import { googleSubject, googleToken, matchesGoogleSubject } from './workerGoogleIdentity.js';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function handleOAuth(
  request: Request,
  env: WorkerEnv,
  ctx: unknown,
  handleMcp: (request: Request, env: WorkerEnv) => Promise<Response>,
): Promise<Response> {
  const issuer = env.OAUTH_ISSUER;
  if (!issuer || !env.OAUTH_KV || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return new Response('OAuth is not configured', { status: 503 });
  }
  let base: URL;
  try { base = new URL(issuer); } catch { return new Response('OAuth is not configured', { status: 503 }); }
  if (base.protocol !== 'https:' || base.origin !== issuer || new URL(request.url).origin !== issuer) {
    return new Response('OAuth is not configured', { status: 503 });
  }
  const resource = `${issuer}/mcp`;
  const provider = new OAuthProvider<WorkerEnv>({
    apiRoute: '/mcp',
    apiHandler: { async fetch(req: Request, bindings: WorkerEnv, context: unknown) {
      // Rebind every request: rotating the configured Google refresh token must
      // not silently grant an existing OAuth client access to a different account.
      try {
        const props = (context as unknown as { props?: { subject?: string } }).props;
        if (!props?.subject) return new Response('Unauthorized', { status: 401 });
        if (!await matchesGoogleSubject(props.subject, bindings.GOOGLE_CLIENT_ID, bindings.GOOGLE_CLIENT_SECRET, bindings.GOOGLE_REFRESH_TOKEN)) return new Response('Google account does not match configured Drive account', { status: 403 });
      } catch { return new Response('Authorization unavailable', { status: 503 }); }
      // Provider has already validated the OAuth credential. Reuse the existing
      // adapter without weakening its independent static-token authentication.
      const headers = new Headers(req.headers);
      headers.set('Authorization', `Bearer ${bindings.MCP_ACCESS_TOKEN}`);
      return handleMcp(new Request(req, { headers }), bindings);
    } },
    defaultHandler: { async fetch(req: Request, bindings: WorkerEnv) {
      const url = new URL(req.url);
      const oauth = bindings.OAUTH_PROVIDER;
      if (!oauth) return new Response('OAuth is not configured', { status: 503 });
      try {
        if (url.pathname === '/authorize' && req.method === 'GET') {
          const auth = await oauth.parseAuthRequest(req);
          const details = await oauth.describeConsent(auth);
          const consent = await oauth.beginConsent(auth);
          const domain = details.clientDomain ? escapeHtml(details.clientDomain) : 'Unverified client';
          const host = escapeHtml(details.redirectHost);
          const name = escapeHtml(details.clientName);
          const scope = details.scope.map(s => escapeHtml(s)).join(', ');
          consent.headers.set('Content-Type', 'text/html; charset=utf-8');
          return new Response(`<!doctype html><meta charset="utf-8"><title>Authorize access</title><h1>Authorize ${name}?</h1><p>Client: ${domain}; redirect: ${host}</p><p>Scopes: ${scope}</p><p>This client can access your configured Google account, including writes.</p><form method="post"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></form>`, { headers: consent.headers });
        }
        if (url.pathname === '/authorize' && req.method === 'POST') {
          const form = await req.formData();
          const handle = String(form.get('handle') ?? '');
          if (form.get('decision') !== 'approve') {
            const denied = await oauth.denyConsent(req, handle);
            return new Response(null, { status: 302, headers: denied.headers });
          }
          const approved = await oauth.approveConsent(req, handle);
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
          const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          google.search = new URLSearchParams({ client_id: bindings.GOOGLE_CLIENT_ID, redirect_uri: `${issuer}/oauth/google/callback`, response_type: 'code', scope: 'openid', state: upstream.state, code_challenge: await challenge(verifier), code_challenge_method: 'S256' }).toString();
          upstream.headers.set('Location', google.toString());
          return new Response(null, { status: 302, headers: upstream.headers });
        }
        if (url.pathname === '/oauth/google/callback' && req.method === 'GET') {
          const resumed = await oauth.finishUpstream<{ verifier: string }>(req);
          if (url.searchParams.has('error')) {
            resumed.headers.set('Location', authorizationErrorRedirect(resumed.request, 'access_denied'));
            return new Response(null, { status: 302, headers: resumed.headers });
          }
          const code = url.searchParams.get('code');
          if (!code || !resumed.data?.verifier) return new Response('Authorization failed', { status: 400 });
          const common = { client_id: bindings.GOOGLE_CLIENT_ID, client_secret: bindings.GOOGLE_CLIENT_SECRET };
          const loginToken = await googleToken(new URLSearchParams({ ...common, code, code_verifier: resumed.data.verifier, redirect_uri: `${issuer}/oauth/google/callback`, grant_type: 'authorization_code' }));
          const loginSubject = await googleSubject(loginToken);
          if (!await matchesGoogleSubject(loginSubject, bindings.GOOGLE_CLIENT_ID, bindings.GOOGLE_CLIENT_SECRET, bindings.GOOGLE_REFRESH_TOKEN)) return new Response('Google account does not match configured Drive account', { status: 403, headers: resumed.headers });
          const completed = await oauth.completeAuthorization({ request: resumed.request, userId: loginSubject, metadata: {}, scope: resumed.request.scope, props: { subject: loginSubject } });
          resumed.headers.set('Location', completed.redirectTo);
          return new Response(null, { status: 302, headers: resumed.headers });
        }
        return new Response('Not found', { status: 404 });
      } catch (error) {
        if (error instanceof AuthorizationError) {
          if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
          return new Response('Invalid or expired authorization request', { status: 400 });
        }
        return new Response('Authorization unavailable', { status: 503 });
      }
    } },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true, resourceMetadata: { resource },
  });
  return provider.fetch(request, env, ctx as never);
}
