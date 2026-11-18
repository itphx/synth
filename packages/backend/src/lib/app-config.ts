import type { AuthConfig, TestUser, SynthConfig } from '@itphx/synth-shared';
import { loadConfig, resolveDataDir, resolvePort, resolveWorkspacesRoot, resolveMaxUploadBytes, resolveMaxReadBytes, resolveMaxPreviewBytes } from '@itphx/synth-shared';
import type { LoadConfigOptions } from '@itphx/synth-shared/config';
import { resolveApiKeyRoles } from '../auth/api-key.js';

const envStr = (key: string, fallback = ''): string => process.env[key] || fallback;
const envBool = (key: string, fallback = false): boolean =>
  process.env[key] ? process.env[key] === 'true' : fallback;
const envInt = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
};

/**
 * ADR-140: разобрать CSV-список имён групп (`SYNTH_OIDC_GROUPS_ALLOW`).
 * По образцу соседних CSV-полей (`SYNTH_API_KEY_ROLES`,
 * `SYNTH_ATTACHMENTS_MODALITIES`): trim, пустые элементы отбрасываются.
 * Пустая строка → пустой список (групп нет — fail-closed).
 */
function parseCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export interface BackendConfig {
  synth: SynthConfig;
  dataDir: string;
  workspacesRoot: string;
  /** Максимальный размер загрузки файла (`POST /api/v2/fs/upload`), байт (config/env). */
  maxUploadBytes: number;
  /** Максимальный размер файла, отдаваемого `GET /api/v2/fs/read`, байт (config/env). */
  maxReadBytes: number;
  /** Максимальный размер файла, отдаваемого `GET /api/v2/fs/raw` (предпросмотр), байт (config/env). */
  maxPreviewBytes: number;
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

  // ADR-140: источник групп — claim IdP + allowlist имён групп.
  // Приоритет: env > config.yaml > дефолт (пустой allowlist → групп нет,
  // fail-closed; «принять все» невозможно). Явно заданная (в т.ч. пустая)
  // env-переменная перекрывает config.yaml — иначе «выключил» группы оператор
  // не смог бы.
  const groupsClaim = envStr('SYNTH_OIDC_GROUPS_CLAIM', defaults.oidc?.groups?.claim ?? 'groups');
  const groupsAllowEnv = process.env.SYNTH_OIDC_GROUPS_ALLOW;
  const groupsAllow = groupsAllowEnv !== undefined
    ? parseCsvList(groupsAllowEnv)
    : (defaults.oidc?.groups?.allow ?? []);

  return {
    debugMode,
    apiKey: envStr('SYNTH_API_KEY', defaults.apiKey ?? ''),
    // Аудит F5: роли API-ключа — только явная настройка (`auth.apiKeyRoles` /
    // `SYNTH_API_KEY_ROLES`), дефолт USER. Неизвестная роль — ошибка загрузки.
    apiKeyRoles: resolveApiKeyRoles(defaults.apiKeyRoles),
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
          groups: {
            claim: groupsClaim,
            allow: groupsAllow,
          },
        }
      : undefined,
  };
}

export async function loadBackendConfig(options?: LoadConfigOptions): Promise<BackendConfig> {
  const synth = await loadConfig({
    baseDefaults: {
      // PROP-136 (слайс 136a): managed-профиль включает аудит исполнений shell
      // по умолчанию (наблюдаемость произвольного кода обязательна); explicit
      // config.yaml/env (`SYNTH_COMMAND_AUDIT_ENABLED`) перебивают профиль,
      // standalone остаётся выключенным. PROP-136b: зеркальный чекер команд в
      // managed по умолчанию **fail-closed** (недоступность политики = deny);
      // standalone сохраняет `open` из схемы.
      security: { commandAudit: { enabled: true }, commandPolicy: { failMode: 'closed' } },
    },
    ...options,
  });
  const auth = buildAuthConfig(synth.auth);
  const dataDir = resolveDataDir(synth);
  const workspacesRoot = resolveWorkspacesRoot(synth);
  const maxUploadBytes = resolveMaxUploadBytes(synth);
  const maxReadBytes = resolveMaxReadBytes(synth);
  const maxPreviewBytes = resolveMaxPreviewBytes(synth);
  const port = resolvePort(synth, 'SYNTH_PORT', synth.server.port);

  return { synth, dataDir, workspacesRoot, maxUploadBytes, maxReadBytes, maxPreviewBytes, port, auth };
}
