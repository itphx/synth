import type { AuthConfig, TestUser, SynthConfig } from '@itphx/synth-shared';
import { loadConfig, resolveDataDir, resolvePort, resolveWorkspacesRoot, resolveMaxUploadBytes } from '@itphx/synth-shared';
import type { LoadConfigOptions } from '@itphx/synth-shared/config';

const envStr = (key: string, fallback = ''): string => process.env[key] || fallback;
const envBool = (key: string, fallback = false): boolean =>
  process.env[key] ? process.env[key] === 'true' : fallback;
const envInt = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
};

export interface BackendConfig {
  synth: SynthConfig;
  dataDir: string;
  workspacesRoot: string;
  /** Максимальный размер загрузки файла (`POST /api/v2/fs/upload`), байт (config/env). */
  maxUploadBytes: number;
  port: number;
  auth: AuthConfig;
}

function buildAuthConfig(defaults: SynthConfig['auth']): AuthConfig {
  const debugMode = envBool('SYNTH_AUTH_DEBUG', defaults.debugMode);

  let testUsers: TestUser[] = [];
  if (debugMode) {
    testUsers = [
      {
        username: 'admin',
        apiKey: envStr('SYNTH_TEST_ADMIN_KEY', 'admin-key-123'),
        roles: ['ADMIN'],
        displayName: 'Администратор',
      },
      {
        username: 'developer',
        apiKey: envStr('SYNTH_TEST_USER_KEY', 'user-key-456'),
        roles: ['USER'],
        displayName: 'Разработчик',
      },
      {
        username: 'lead',
        apiKey: envStr('SYNTH_TEST_LEAD_KEY', 'lead-key-789'),
        roles: ['LEAD'],
        displayName: 'Тимлид',
      },
      {
        username: 'auditor',
        apiKey: envStr('SYNTH_TEST_AUDITOR_KEY', 'auditor-key-012'),
        roles: ['AUDITOR'],
        displayName: 'Аудитор',
      },
    ];
  }

  const oidcEnabled = envBool('SYNTH_OIDC_ENABLED', defaults.oidc?.enabled ?? false);

  return {
    debugMode,
    apiKey: envStr('SYNTH_API_KEY', defaults.apiKey ?? ''),
    testUsers,
    sessionMaxAgeMinutes: envInt('SYNTH_SESSION_MAX_AGE', defaults.sessionMaxAgeMinutes),
    oidc: oidcEnabled
      ? {
          enabled: true,
          issuer: envStr('SYNTH_OIDC_ISSUER', defaults.oidc?.issuer ?? ''),
          clientId: envStr('SYNTH_OIDC_CLIENT_ID', defaults.oidc?.clientId ?? ''),
          clientSecret: envStr('SYNTH_OIDC_CLIENT_SECRET', defaults.oidc?.clientSecret ?? ''),
          redirectUri: envStr('SYNTH_OIDC_REDIRECT_URI', defaults.oidc?.redirectUri ?? 'http://localhost:5002/auth/callback'),
          cliClientId: envStr('SYNTH_OIDC_CLI_CLIENT_ID', defaults.oidc?.cliClientId ?? 'synth-cli'),
        }
      : undefined,
  };
}

export async function loadBackendConfig(options?: LoadConfigOptions): Promise<BackendConfig> {
  const synth = await loadConfig(options);
  const auth = buildAuthConfig(synth.auth);
  const dataDir = resolveDataDir(synth);
  const workspacesRoot = resolveWorkspacesRoot(synth);
  const maxUploadBytes = resolveMaxUploadBytes(synth);
  const port = resolvePort(synth, 'SYNTH_PORT', synth.server.port);

  return { synth, dataDir, workspacesRoot, maxUploadBytes, port, auth };
}
