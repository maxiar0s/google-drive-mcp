const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function googleSubject(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Google identity unavailable');
  const user = await response.json() as { sub?: unknown };
  if (typeof user.sub !== 'string' || !user.sub) throw new Error('Google identity unavailable');
  return user.sub;
}

export async function matchesGoogleSubject(subject: string, clientId: string, clientSecret: string, refreshToken: string): Promise<boolean> {
  if (!subject || !clientId || !clientSecret || !refreshToken) return false;
  const token = await googleToken(new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }));
  return (await googleSubject(token)) === subject;
}

export async function googleToken(params: URLSearchParams): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Google token exchange failed');
  const token = await response.json() as { access_token?: unknown };
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Google token exchange failed');
  return token.access_token;
}
