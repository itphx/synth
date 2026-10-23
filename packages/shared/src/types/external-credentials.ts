/**
 * ADR-105 (Ф0): «внешний доступ» — сущность слоя доступа к внешним сервисам
 * (коннекторам). Носитель OAuth-кредов (access/refresh-токен) внешнего провайдера.
 *
 * Ключевые свойства модели (ADR-105 §1–§2):
 * - **доступ — ресурс с временем жизни**, а не «ещё один ключ»: у него есть
 *   срок (`expiresAt`), статус (`status`) и отзыв (`revokedAt`);
 * - **токен нужен в исходном виде** (его подставляет транспорт), поэтому
 *   at-rest он лежит **зашифрованным** мастер-ключом (`enc:v1:…`, ADR-076), а не
 *   хешем (как у service-key/binding-key, где секрет только проверяется);
 * - **секрет наружу не отдаётся**: публичная форма — `ExternalCredentialMeta`
 *   (метаданные + маска), а `secretEnc`/`refreshEnc` живут только внутри
 *   хранилища;
 * - **владелец — часть записи**: `owner.kind` = `user` | `instance` | `local`
 *   (инвариант 19: в standalone всё нормализуется к `local`).
 *
 * Модуль browser-safe (zod + чистые функции) — используется и в UI, и в ядре.
 */
import { z } from 'zod';

/** Статусы внешнего доступа (ADR-105 §1). */
export const EXTERNAL_CREDENTIAL_STATUSES = ['active', 'expired', 'revoked', 'error'] as const;
export type ExternalCredentialStatus = (typeof EXTERNAL_CREDENTIAL_STATUSES)[number];

/**
 * Виды владения доступом (ADR-105 §2):
 * - `user` — конкретный пользователь инстанса;
 * - `instance` — инстансный доступ (выдал `ADMIN`/`LEAD`, владельца-пользователя нет);
 * - `local` — локальный доступ standalone-инстанса (единственный владелец, инвариант 19).
 */
export const EXTERNAL_CREDENTIAL_OWNER_KINDS = ['user', 'instance', 'local'] as const;
export type ExternalCredentialOwnerKind = (typeof EXTERNAL_CREDENTIAL_OWNER_KINDS)[number];

/** Владелец доступа: вид владения + идентификатор (userId / `instance` / `local`). */
export interface ExternalCredentialOwner {
  kind: ExternalCredentialOwnerKind;
  id: string;
}

/**
 * Persisted-запись внешнего доступа (ADR-105 §1). Это **внутренняя** форма
 * хранилища: `secretEnc`/`refreshEnc` — зашифрованные мастер-ключом токены
 * (`enc:v1:…`), наружу (API/UI) они не отдаются — только `ExternalCredentialMeta`.
 */
export interface ExternalCredential {
  id: string;
  /** Провайдер/коннектор: ключ описания OAuth-провайдера или id MCP-сервера. */
  provider: string;
  /** id записи реестра MCP (ADR-071), если доступ привязан к коннектору. */
  connectorId?: string;
  /** `client_id` приложения/коннектора (публичное значение, не секрет). */
  clientId: string;
  /** Запрошенные scope'ы. */
  scopes: string[];
  /** Владелец доступа (часть записи, не вычисляемое поле). */
  owner: ExternalCredentialOwner;
  /** Опциональная привязка к проекту (доступ уровня проекта виден его участникам). */
  projectId?: string;
  /** Зашифровано мастер-ключом: access-токен (`enc:v1:…`). */
  secretEnc: string;
  /** Зашифровано мастер-ключом: refresh-токен (`enc:v1:…`). */
  refreshEnc?: string;
  /** Текущее состояние доступа. */
  status: ExternalCredentialStatus;
  /** ISO-8601 срок действия access-токена. */
  expiresAt?: string;
  /** ISO-8601 отзыв доступа. */
  revokedAt?: string;
  /** Кто выдал доступ (id пользователя инстанса). */
  createdBy: string;
  /** ISO-8601 создание. */
  createdAt: string;
  /** ISO-8601 последнее использование (best-effort). */
  lastUsedAt?: string;
  /** Фактически выданные провайдером scope'ы (если провайдер их сообщил). */
  scopesGranted?: string[];
}

/**
 * Публичные метаданные доступа — единственная форма, которая отдаётся наружу
 * (API/UI). Секрета здесь нет: вместо него `secretMask` (маска) и признак
 * наличия refresh-токена.
 */
export interface ExternalCredentialMeta {
  id: string;
  provider: string;
  connectorId?: string;
  clientId: string;
  scopes: string[];
  owner: ExternalCredentialOwner;
  projectId?: string;
  status: ExternalCredentialStatus;
  expiresAt?: string;
  revokedAt?: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  scopesGranted?: string[];
  /** Маска секрета (необратимая сводка): секрет наружу не отдаётся никогда. */
  secretMask: string;
  /** Есть ли refresh-токен (сам токен не раскрывается). */
  hasRefreshToken: boolean;
}

/**
 * Вход создания доступа (ADR-105 Ф2/F3 — выдача кода). Токены приходят
 * **plaintext** и шифруются мастер-ключом внутри хранилища (ADR-076); наружу
 * plaintext не возвращается.
 */
export interface CreateExternalCredentialInput {
  /** Явный id записи (импорт/перенос); не задан — сгенерирует хранилище. */
  id?: string;
  provider: string;
  connectorId?: string;
  clientId: string;
  scopes?: string[];
  owner: ExternalCredentialOwner;
  projectId?: string;
  /** Access-токен ( plaintext) — хранилище зашифрует его мастер-ключом. */
  accessToken: string;
  /** Refresh-токен (plaintext, опционально). */
  refreshToken?: string;
  expiresAt?: string;
  scopesGranted?: string[];
  createdBy: string;
}

/**
 * Патч обновления токенов (refresh/ротация). `undefined` — поле не трогать.
 * Статус по умолчанию возвращается в `active` (свежий токен).
 */
export interface UpdateExternalCredentialTokensInput {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scopesGranted?: string[];
  /** Явный статус (напр. `expired`, если провайдер не выдал срок). */
  status?: ExternalCredentialStatus;
}

/** Фильтр выборки доступов (владелец/коннектор/провайдер/проект/статус). */
export interface ExternalCredentialFilter {
  owner?: ExternalCredentialOwner;
  connectorId?: string;
  provider?: string;
  projectId?: string;
  status?: ExternalCredentialStatus;
}

// --- Zod-схемы ---

export const externalCredentialOwnerSchema = z.object({
  kind: z.enum(EXTERNAL_CREDENTIAL_OWNER_KINDS),
  id: z.string().min(1),
});

export const externalCredentialStatusSchema = z.enum(EXTERNAL_CREDENTIAL_STATUSES);

/** Persisted-запись доступа (внутренняя форма хранилища). */
export const externalCredentialSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  connectorId: z.string().min(1).optional(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  owner: externalCredentialOwnerSchema,
  projectId: z.string().min(1).optional(),
  secretEnc: z.string().min(1),
  refreshEnc: z.string().min(1).optional(),
  status: externalCredentialStatusSchema,
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
  scopesGranted: z.array(z.string()).optional(),
});

/** Публичные метаданные доступа (то, что отдаётся в API/UI). */
export const externalCredentialMetaSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  connectorId: z.string().min(1).optional(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  owner: externalCredentialOwnerSchema,
  projectId: z.string().min(1).optional(),
  status: externalCredentialStatusSchema,
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
  scopesGranted: z.array(z.string()).optional(),
  secretMask: z.string().min(1),
  hasRefreshToken: z.boolean(),
});

/** Вход создания доступа (access/refresh-токены — plaintext на входе). */
export const createExternalCredentialInputSchema = z.object({
  id: z.string().min(1).optional(),
  provider: z.string().min(1),
  connectorId: z.string().min(1).optional(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  owner: externalCredentialOwnerSchema,
  projectId: z.string().min(1).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scopesGranted: z.array(z.string()).optional(),
  createdBy: z.string().min(1),
});

/** Патч обновления токенов доступа. */
export const updateExternalCredentialTokensSchema = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scopesGranted: z.array(z.string()).optional(),
  status: externalCredentialStatusSchema.optional(),
});

export type ExternalCredentialOwnerInput = z.infer<typeof externalCredentialOwnerSchema>;
export type ExternalCredentialRecord = z.infer<typeof externalCredentialSchema>;
export type ExternalCredentialMetaInput = z.infer<typeof externalCredentialMetaSchema>;
export type CreateExternalCredentialRequest = z.infer<typeof createExternalCredentialInputSchema>;
export type UpdateExternalCredentialTokensRequest = z.infer<
  typeof updateExternalCredentialTokensSchema
>;

/**
 * Маска секрета доступа — необратимая сводка зашифрованного значения.
 *
 * Секрет наружу не отдаётся **никогда** (ADR-105 §1): вместо него UI/API
 * показывают маску. У OAuth-токенов внешних провайдеров нет осмысленного
 * «префикса» (как `synth_svc_` у service-key), поэтому маска — короткий
 * необратимый отпечаток: он позволяет отличить один записанный токен от
 * другого и заметить ротацию, не раскрывая секрет.
 *
 * Считается по **зашифрованному** значению (AES-GCM с случайным IV — данные
 * высокоэнтропийные), поэтому восстановить из маски plaintext нельзя.
 */
export function maskExternalSecret(encrypted: string): string {
  // FNV-1a (64 бит) — достаточно для необратимого отпечатка; крипто-хеш
  // тут не нужен (вход — шифротекст, а не секрет в исходном виде).
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < encrypted.length; i += 1) {
    hash ^= BigInt(encrypted.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `mask:${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Маппер «запись → метаданные»: убирает зашифрованные секреты и добавляет
 * маску. Единственное место, где секрет «прячется» из публичной выдачи.
 */
export function toExternalCredentialMeta(credential: ExternalCredential): ExternalCredentialMeta {
  return {
    id: credential.id,
    provider: credential.provider,
    ...(credential.connectorId !== undefined ? { connectorId: credential.connectorId } : {}),
    clientId: credential.clientId,
    scopes: [...credential.scopes],
    owner: { ...credential.owner },
    ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
    status: credential.status,
    ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.revokedAt !== undefined ? { revokedAt: credential.revokedAt } : {}),
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    ...(credential.lastUsedAt !== undefined ? { lastUsedAt: credential.lastUsedAt } : {}),
    ...(credential.scopesGranted !== undefined
      ? { scopesGranted: [...credential.scopesGranted] }
      : {}),
    secretMask: maskExternalSecret(credential.secretEnc),
    hasRefreshToken: credential.refreshEnc !== undefined && credential.refreshEnc !== '',
  };
}
