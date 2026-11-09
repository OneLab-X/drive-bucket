import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { auth } from '@googleapis/drive';
import { SCOPES, type ScopeName } from '@drivebucket/core';

/** The slice of google-auth-library's OAuth2Client used here (injectable for tests). */
export interface OAuthClientLike {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Record<string, unknown>): string;
  getToken(opts: { code: string; codeVerifier?: string; redirect_uri?: string }): Promise<{ tokens: { refresh_token?: string | null; scope?: string | null } }>;
}

export interface LoginOptions {
  clientId: string;
  clientSecret: string;
  scope?: ScopeName;
  /** Loopback port. 0 = random free port. */
  port?: number;
  /** Open the consent URL (default: print only). */
  openUrl?: (url: string) => void;
  log: (line: string) => void;
  timeoutMs?: number;
  createClient?: (o: { clientId: string; clientSecret: string; redirectUri: string }) => OAuthClientLike;
}

export interface LoginResult {
  refreshToken: string;
  scopes: string[];
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

/**
 * OAuth "installed app" loopback flow with PKCE (RFC 8252). Needs an OAuth client of type
 * "Desktop app". Returns the refresh token; never logs it.
 */
export async function oauthLogin(o: LoginOptions): Promise<LoginResult> {
  const scope = o.scope ?? 'drive.file';
  const state = randomBytes(16).toString('base64url');
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(o.port ?? 0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const client =
      o.createClient?.({ clientId: o.clientId, clientSecret: o.clientSecret, redirectUri }) ??
      (new auth.OAuth2({ clientId: o.clientId, clientSecret: o.clientSecret, redirectUri }) as unknown as OAuthClientLike);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [SCOPES[scope]],
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      state,
      include_granted_scopes: false,
    });

    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the browser sign-in')), o.timeoutMs ?? 5 * 60_000);
      server!.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400).end(page('Sign-in failed', 'Google returned an error. Check the terminal.'));
          reject(new Error(`Google returned "${err}"`));
          return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400).end(page('Sign-in failed', 'State mismatch. Start again from the terminal.'));
          reject(new Error('OAuth state mismatch (possible CSRF); start again'));
          return;
        }
        const c = u.searchParams.get('code');
        if (!c) {
          res.writeHead(400).end(page('Sign-in failed', 'No authorization code.'));
          reject(new Error('No authorization code in callback'));
          return;
        }
        res.writeHead(200).end(page('drivebucket is authorized', 'You can close this tab and return to the terminal.'));
        resolve(c);
      });
      o.log('Open this URL in a browser and approve access:');
      o.log('');
      o.log(`  ${url}`);
      o.log('');
      o.log(`Waiting for Google to redirect to ${redirectUri} ...`);
      o.openUrl?.(url);
    });

    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Remove drivebucket from https://myaccount.google.com/permissions and run login again.',
      );
    }
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    return { refreshToken: tokens.refresh_token, scopes };
  } finally {
    if (timer) clearTimeout(timer);
    server?.closeAllConnections?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  }
}
