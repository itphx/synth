// --- User role ---

export enum GlobalRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
  LEAD = 'LEAD',
  AUDITOR = 'AUDITOR',
}

// --- User & Auth ---
export interface User {
  id: string;
  username: string;
  email?: string;
  roles: string[];
  preferredLanguage: string;
  createdAt: string;
  teamRole: string;
  notes: string;
  interviewCompleted: boolean;
  isLocal?: boolean;
  isTestUser?: boolean;
}

export interface TestUser {
  username: string;
  apiKey: string;
  roles: string[];
  displayName: string;
}

export interface AuthConfig {
  debugMode: boolean;
  apiKey?: string;
  testUsers?: TestUser[];
  sessionMaxAgeMinutes: number;
  oidc?: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Public client_id для локального CLI/core (ROPC/device flow). Не секрет. */
    cliClientId?: string;
  };
}

/**
 * ADR-089: внешняя идентичность, привязанная к профилю пользователя.
 * Ключ — `provider` + `externalId` (числовой id источника). `username`/
 * `displayName` — display-кэш (может устареть), НЕ ключ.
 */
export interface ExternalIdentity {
  /** Префикс principalId (ADR-089), напр. 'tg' (Telegram). */
  provider: string;
  /** Числовой id в источнике, строкой (напр. '450316139'). */
  externalId: string;
  /** Display-кэш: username источника (может устареть). */
  username?: string;
  /** Display-кэш: отображаемое имя источника. */
  displayName?: string;
  /** ISO: когда привязано. */
  linkedAt: string;
  /** Кто подтвердил (id пользователя инстанса). */
  linkedBy?: string;
}

/**
 * ADR-089: principalId внешнего отправителя из пары провайдер+id.
 * Формат — `<provider>:<externalId>` (напр. `tg:450316139`).
 */
export function buildPrincipalId(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/**
 * ADR-089: разбор principalId на `provider`/`externalId` — деление по **первому**
 * `:`. Невалидное (нет `:`, пустые части) → `null`.
 */
export function parsePrincipalId(principalId: string): { provider: string; externalId: string } | null {
  if (typeof principalId !== 'string') return null;
  const idx = principalId.indexOf(':');
  if (idx <= 0 || idx === principalId.length - 1) return null;
  const provider = principalId.slice(0, idx);
  const externalId = principalId.slice(idx + 1);
  if (!provider || !externalId) return null;
  return { provider, externalId };
}

export interface ProfileData {
  id: string;
  username: string;
  email?: string;
  phone?: string;
  roles: string[];
  teamRoles: string[];
  isActive: boolean;
  preferences: Record<string, unknown>;
  notes: string;
  /**
   * Онбординг-интервью пройдено. Отдельное поле вместо legacy-метки
   * `[ИНТЕРВЬЮ]` в свободном `notes`. Не задано (legacy-профиль) — бэкфилл при
   * чтении по наличию метки (`FileProfileStore._deserialize`).
   */
  interviewCompleted: boolean;
  /** ISO-время завершения интервью (для аудита/аналитики). */
  interviewCompletedAt?: string;
  displayName?: string;
  /**
   * ADR-089: внешние идентичности (Telegram и др.), привязанные к профилю.
   * Опционально — legacy-профили без поля трактуются как `[]`. Ключ — пара
   * `provider`+`externalId`; `username`/`displayName` — display-кэш.
   */
  identities?: ExternalIdentity[];
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

export interface InterviewQuestion {
  id: string;
  question: string;
  order: number;
}

export interface InterviewStatus {
  inProgress: boolean;
  completed: boolean;
  currentQuestion?: InterviewQuestion;
  totalQuestions: number;
  answered: number;
}
