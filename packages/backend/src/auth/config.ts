import type { AuthConfig, TestUser } from '@synth/shared';

const env = (key: string, fallback = '') => process.env[key] || fallback;

export function loadAuthConfig(): AuthConfig {
  const debugMode = env('SYNTH_AUTH_DEBUG', 'false') === 'true';

  let testUsers: TestUser[] = [];
  if (debugMode) {
    testUsers = [
      {
        username: 'admin',
        apiKey: env('SYNTH_TEST_ADMIN_KEY', 'admin-key-123'),
        roles: ['ADMIN'],
        displayName: 'Администратор',
      },
      {
        username: 'developer',
        apiKey: env('SYNTH_TEST_USER_KEY', 'user-key-456'),
        roles: ['USER'],
        displayName: 'Разработчик',
      },
      {
        username: 'lead',
        apiKey: env('SYNTH_TEST_LEAD_KEY', 'lead-key-789'),
        roles: ['LEAD'],
        displayName: 'Тимлид',
      },
      {
        username: 'auditor',
        apiKey: env('SYNTH_TEST_AUDITOR_KEY', 'auditor-key-012'),
        roles: ['AUDITOR'],
        displayName: 'Аудитор',
      },
    ];
  }

  return {
    debugMode,
    apiKey: env('SYNTH_API_KEY', ''),
    testUsers,
    sessionMaxAgeMinutes: parseInt(env('SYNTH_SESSION_MAX_AGE', '1440'), 10),
    oidc: env('SYNTH_OIDC_ENABLED', 'false') === 'true' ? {
      enabled: true,
      issuer: env('SYNTH_OIDC_ISSUER', ''),
      clientId: env('SYNTH_OIDC_CLIENT_ID', ''),
      clientSecret: env('SYNTH_OIDC_CLIENT_SECRET', ''),
      redirectUri: env('SYNTH_OIDC_REDIRECT_URI', 'http://localhost:5002/auth/callback'),
    } : undefined,
  };
}
