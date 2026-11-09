import { auth } from '@googleapis/drive';
import { ConfigError } from './errors.js';

export const SCOPES = {
  /** Default. Non-sensitive: only files this app created or the user picked. */
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  /** Opt-in. Restricted scope (Google verification required for public apps). Full Drive access. */
  drive: 'https://www.googleapis.com/auth/drive',
} as const;

export type ScopeName = keyof typeof SCOPES;

/** OAuth refresh token for a user account. Works with free Gmail accounts. */
export interface OAuthRefreshTokenAuth {
  type: 'oauthRefreshToken';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/**
 * Service account. Service accounts have no Drive storage quota, so either:
 *  - set `sharedDriveId` (or a `rootFolderId` inside a shared drive) on the adapter, or
 *  - set `subject` to impersonate a Workspace user via domain-wide delegation.
 */
export interface ServiceAccountAuth {
  type: 'serviceAccount';
  credentials?: ServiceAccountCredentials;
  /** Path to the JSON key file. Alternative to `credentials`. */
  keyFile?: string;
  /** Domain-wide delegation: the Workspace user to act as. */
  subject?: string;
}

export type AuthConfig = OAuthRefreshTokenAuth | ServiceAccountAuth;

/** The bits of a google-auth-library client drivebucket calls directly. */
export interface AuthClient {
  request<T = any>(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
  }): Promise<{ status: number; headers: unknown; data: T }>;
}

export function createAuthClient(config: AuthConfig, scope: ScopeName = 'drive.file'): AuthClient {
  const scopes = [SCOPES[scope]];
  if (config.type === 'oauthRefreshToken') {
    if (!config.clientId || !config.clientSecret || !config.refreshToken) {
      throw new ConfigError('oauthRefreshToken auth needs clientId, clientSecret and refreshToken');
    }
    const client = new auth.OAuth2({ clientId: config.clientId, clientSecret: config.clientSecret });
    client.setCredentials({ refresh_token: config.refreshToken });
    return client as unknown as AuthClient;
  }
  if (config.type === 'serviceAccount') {
    if (!config.credentials && !config.keyFile) {
      throw new ConfigError('serviceAccount auth needs `credentials` or `keyFile`');
    }
    const client = new auth.JWT({
      ...(config.credentials ? { email: config.credentials.client_email, key: config.credentials.private_key } : {}),
      ...(config.keyFile ? { keyFile: config.keyFile } : {}),
      ...(config.subject ? { subject: config.subject } : {}),
      scopes,
    });
    return client as unknown as AuthClient;
  }
  throw new ConfigError(`Unknown auth type: ${(config as { type?: string }).type}`);
}
