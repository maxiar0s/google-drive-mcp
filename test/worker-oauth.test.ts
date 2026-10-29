import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { googleSubject, googleToken, matchesGoogleSubject } from '../src/workerGoogleIdentity.js';

test('OAuth discovery fails closed when owner configuration is absent', async () => {
  const response = await worker.fetch(new Request('https://worker.example/.well-known/oauth-protected-resource/mcp'), {
    MCP_ACCESS_TOKEN: 'test-only-access-token-with-32-chars',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REFRESH_TOKEN: 'test-refresh',
  });
  assert.equal(response.status, 503);
});

test('Identity binding compares the refresh token subject, including after rotation', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/token')) {
        const params = new URLSearchParams(String(init?.body));
        return Response.json({ access_token: params.get('refresh_token') });
      }
      const bearer = new Headers(init?.headers).get('authorization');
      return Response.json({ sub: bearer === 'Bearer owner-refresh' ? 'owner-sub' : 'other-sub' });
    };
    assert.equal(await matchesGoogleSubject('owner-sub', 'client', 'secret', 'owner-refresh'), true);
    assert.equal(await matchesGoogleSubject('owner-sub', 'client', 'secret', 'other-refresh'), false);
    assert.equal(await matchesGoogleSubject('', 'client', 'secret', 'owner-refresh'), false);
  } finally { globalThis.fetch = previous; }
});

test('Google identity lookup fails closed on missing subject and token errors', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(googleSubject('synthetic'), /identity unavailable/);
    await assert.rejects(googleToken(new URLSearchParams()), /token exchange failed/);
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(googleSubject('synthetic'), /identity unavailable/);
    await assert.rejects(googleToken(new URLSearchParams()), /token exchange failed/);
  } finally { globalThis.fetch = previous; }
});
