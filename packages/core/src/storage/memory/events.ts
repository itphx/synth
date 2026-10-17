/**
 * In-memory реализации портов событий, ключей привязок/service-key, реестра MCP,
 * claim-кодов и дедупа (PROP-032, шаг W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`/массивах.
 * Семантика повторяет файловую (ADR-051/ADR-071/ADR-089/ADR-052): append-журнал
 * в порядке добавления, `list(limit)` → последние N (`slice(-N)`), уникальность
 * `label` (регистронезависимо) → доменная ошибка того же типа
 * (`EventApiKeyConflictError`/`ServiceApiKeyConflictError`), одноразовость
 * claim-кода, атомарный claim дедупа, идемпотентный сид реестра MCP.
 *
 * Секреты (`synth_evt_…`/`synth_svc_…`) в памяти хранятся только как sha256-хеш,
 * plaintext отдаётся единожды при `create`/`ensure` — как в файловых сторах.
 *
 * Импорт типов и доменных ошибок идёт из файловых сторов (`import type` +
 * runtime-импорт классов ошибок/префиксов): имена классов ошибок — часть
 * публичной семантики портов, поэтому memory-реализация обязана бросать ровно
 * те же типы. ФС-операций здесь нет.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import type {
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreated,
  EventRouteRule,
  McpRegistryAuthor,
  McpRegistryEntry,
  McpRegistryOrigin,
  McpRegistryTrust,
  McpServerConfig,
  ServiceApiKey,
  ServiceApiKeyCreated,
  CreateServiceApiKeyInput,
  UpdateServiceApiKeyPatch,
} from '@itphx/synth-shared';
import { GlobalRole, MCP_REGISTRY_SCHEMA_VERSION, generateId, nowISO } from '@itphx/synth-shared';
import type { EventKeyCredential } from '../../engine/events/credential.js';
import type {
  DedupRepository,
  EventApiKeyRepository,
  EventApiKeyResolution,
  EventBindingRepository,
  EventJournalRepository,
  EventRouteRepository,
  IdentityClaimRepository,
  McpRegistryRepository,
  ServiceKeyRepository,
  ServiceKeyResolution,
} from '../ports/index.js';
import type { UpsertEventBindingInput } from '../event-binding-store.js';
import type { UpsertRouteRuleInput } from '../route-rule-store.js';
import type { EventJournalEntry } from '../event-journal-store.js';
import type {
  CreateEventApiKeyInput,
  EventApiKeyRecord,
  UpdateEventApiKeyPatch,
} from '../event-api-key-store.js';
import { EVENT_API_KEY_SECRET_PREFIX, EventApiKeyConflictError } from '../event-api-key-store.js';
import type { IdentityClaimRecord } from '../identity-claim-store.js';
import type { AddMcpRegistryEntryInput, UpdateMcpRegistryEntryInput } from '../mcp-registry-store.js';
import type {
  EnsureServiceKeyInput,
  ServiceApiKeyRecord,
  ServiceKeyCredential,
  ServiceKeyEnsureStatus,
} from '../service-api-key-store.js';
import {
  BOOTSTRAP_CREATED_BY,
  SERVICE_KEY_SECRET_PREFIX,
  ServiceApiKeyConflictError,
} from '../service-api-key-store.js';

const SECRET_PREFIX_VISIBLE = 12;
/** Дефолтные роли service-key, если `roles` не заданы (least privilege). */
const DEFAULT_SERVICE_KEY_ROLES: GlobalRole[] = [GlobalRole.USER];

/** sha256 hex секрета — то, что хранится at-rest вместо plaintext. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Нормализованный ключ метки: trim + lower-case (регистронезависимая уникальность). */
function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/** Нормализует и проверяет метку: непустая строка после trim. */
function normalizeLabel(label: string | undefined): string {
  const normalized = label?.trim() ?? '';
  if (!normalized) throw new Error('label обязателен');
  return normalized;
}

/** Порт реестра привязок событий поверх `Map` (семантика `EventBindingStore`). */
export class MemoryEventBindingRepository implements EventBindingRepository {
  private readonly _bindings = new Map<string, EventBinding>();

  async list(): Promise<EventBinding[]> {
    return [...this._bindings.values()].map((b) => structuredClone(b));
  }

  async get(id: string): Promise<EventBinding | null> {
    const binding = this._bindings.get(id);
    return binding ? structuredClone(binding) : null;
  }

  async findByKey(input: { source: string; chatKey?: string; threadKey?: string }): Promise<EventBinding | null> {
    if (input.threadKey) {
      for (const b of this._bindings.values()) {
        if (b.source === input.source && b.threadKey === input.threadKey) return structuredClone(b);
      }
    }
    if (input.chatKey) {
      for (const b of this._bindings.values()) {
        if (b.source === input.source && b.chatKey === input.chatKey) return structuredClone(b);
      }
    }
    return null;
  }

  async upsert(input: UpsertEventBindingInput): Promise<EventBinding> {
    const id = input.id ?? `bnd_${generateId()}`;
    const binding: EventBinding = { ...input, id };
    this._bindings.set(id, structuredClone(binding));
    return structuredClone(binding);
  }

  async remove(id: string): Promise<boolean> {
    return this._bindings.delete(id);
  }
}

/** Порт правил маршрутизации событий поверх `Map` (семантика `RouteRuleStore`). */
export class MemoryEventRouteRepository implements EventRouteRepository {
  private readonly _rules = new Map<string, EventRouteRule>();

  async list(): Promise<EventRouteRule[]> {
    return [...this._rules.values()].map((r) => structuredClone(r));
  }

  async listEnabled(): Promise<EventRouteRule[]> {
    return [...this._rules.values()].filter((r) => r.enabled).map((r) => structuredClone(r));
  }

  async get(id: string): Promise<EventRouteRule | null> {
    const rule = this._rules.get(id);
    return rule ? structuredClone(rule) : null;
  }

  async upsert(input: UpsertRouteRuleInput): Promise<EventRouteRule> {
    const id = input.id ?? `rule_${generateId()}`;
    const rule: EventRouteRule = { ...input, id };
    this._rules.set(id, structuredClone(rule));
    return structuredClone(rule);
  }

  async remove(id: string): Promise<boolean> {
    return this._rules.delete(id);
  }
}

/** Порт append-журнала событий поверх массива (семантика `EventJournalStore`). */
export class MemoryEventJournalRepository implements EventJournalRepository {
  private _entries: EventJournalEntry[] = [];

  async record(entry: EventJournalEntry): Promise<void> {
    this._entries.push(structuredClone(entry));
  }

  async list(limit?: number): Promise<EventJournalEntry[]> {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      return this._entries.map((e) => structuredClone(e));
    }
    return this._entries.slice(-Math.floor(limit)).map((e) => structuredClone(e));
  }

  async prune(retentionDays: number): Promise<number> {
    if (this._entries.length === 0) return 0;
    const days = Number.isFinite(retentionDays) ? retentionDays : 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = this._entries.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    const removed = this._entries.length - kept.length;
    if (removed === 0) return 0;
    this._entries = kept;
    return removed;
  }
}

/** Внутренняя запись API-ключа привязки: публичные поля + sha256-хеш секрета. */
interface MemoryEventApiKeyRecord extends EventBindingApiKey {
  hash: string;
}

/** Порт API-ключей привязок поверх `Map` (семантика `EventApiKeyStore`). */
export class MemoryEventApiKeyRepository implements EventApiKeyRepository {
  private readonly _keys = new Map<string, MemoryEventApiKeyRecord>();

  private _toPublic(record: MemoryEventApiKeyRecord): EventBindingApiKey {
    const { hash, ...pub } = record;
    void hash;
    return structuredClone(pub);
  }

  private _assertLabelUnique(label: string, excludeKeyId?: string): void {
    const target = labelKey(label);
    for (const record of this._keys.values()) {
      if (record.id !== excludeKeyId && labelKey(record.label ?? '') === target) {
        throw new EventApiKeyConflictError(label);
      }
    }
  }

  async listByBinding(bindingId: string): Promise<EventBindingApiKey[]> {
    return [...this._keys.values()]
      .filter((k) => k.bindingId === bindingId)
      .map((k) => this._toPublic(k));
  }

  async get(bindingId: string, keyId: string): Promise<EventBindingApiKey | null> {
    const record = this._keys.get(keyId);
    return record && record.bindingId === bindingId ? this._toPublic(record) : null;
  }

  /** Полные записи (включая `hash`) — только для переноса между backend'ами. */
  async exportAll(): Promise<EventApiKeyRecord[]> {
    return [...this._keys.values()].map((record) => ({ ...record }));
  }

  /**
   * Импорт готовой записи как есть (PROP-032): `id`/`prefix`/`hash` сохраняются.
   * Идемпотентно: при совпадении `id`, метки или хеша возвращается существующая.
   */
  async importExisting(record: EventApiKeyRecord): Promise<EventBindingApiKey> {
    if (!record.hash) throw new Error('hash обязателен');
    const label = normalizeLabel(record.label);
    const sameId = this._keys.get(record.id);
    if (sameId) return this._toPublic(sameId);
    for (const existing of this._keys.values()) {
      if (labelKey(existing.label ?? '') === labelKey(label) || existing.hash === record.hash) {
        return this._toPublic(existing);
      }
    }
    const { name, ...rest } = record;
    void name;
    const stored: MemoryEventApiKeyRecord = { ...rest, label };
    this._keys.set(stored.id, stored);
    return this._toPublic(stored);
  }

  async create(input: CreateEventApiKeyInput): Promise<EventBindingApiKeyCreated> {
    const label = normalizeLabel(input.label);
    const secret = `${EVENT_API_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    const record: MemoryEventApiKeyRecord = {
      id: `eak_${generateId()}`,
      bindingId: input.bindingId,
      label,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: input.rateLimitPerMinute } : {}),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
      hash: hashSecret(secret),
    };
    this._assertLabelUnique(label);
    this._keys.set(record.id, record);
    return { ...this._toPublic(record), key: secret };
  }

  async update(bindingId: string, keyId: string, patch: UpdateEventApiKeyPatch): Promise<EventBindingApiKey | null> {
    const record = this._keys.get(keyId);
    if (!record || record.bindingId !== bindingId) return null;

    if (patch.label !== undefined) {
      const label = normalizeLabel(patch.label);
      this._assertLabelUnique(label, keyId);
      record.label = label;
    }
    if (patch.description !== undefined) {
      if (patch.description === null) delete record.description;
      else record.description = patch.description;
    }
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt === null) delete record.expiresAt;
      else record.expiresAt = patch.expiresAt;
    }
    if (patch.rateLimitPerMinute !== undefined) {
      if (patch.rateLimitPerMinute === null) delete record.rateLimitPerMinute;
      else record.rateLimitPerMinute = patch.rateLimitPerMinute;
    }
    return this._toPublic(record);
  }

  async remove(bindingId: string, keyId: string): Promise<boolean> {
    const record = this._keys.get(keyId);
    if (!record || record.bindingId !== bindingId) return false;
    return this._keys.delete(keyId);
  }

  async removeByBinding(bindingId: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of this._keys) {
      if (record.bindingId === bindingId) {
        this._keys.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async revoke(bindingId: string, keyId: string): Promise<boolean> {
    const record = this._keys.get(keyId);
    if (!record || record.bindingId !== bindingId) return false;
    if (!record.revokedAt) record.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveBySecret(rawSecret: string): Promise<EventApiKeyResolution | null> {
    if (!rawSecret) return null;
    const hash = hashSecret(rawSecret);
    let found: MemoryEventApiKeyRecord | undefined;
    for (const record of this._keys.values()) {
      if (record.hash === hash) {
        found = record;
        break;
      }
    }
    if (!found) return null;
    if (found.revokedAt) return null;
    if (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()) return null;

    const key = this._toPublic(found);
    const credential: EventKeyCredential = {
      keyId: key.id,
      bindingId: key.bindingId,
      ...(key.createdBy ? { ownerId: key.createdBy } : {}),
      ...(key.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: key.rateLimitPerMinute } : {}),
    };
    return { key, credential };
  }

  async touch(id: string): Promise<void> {
    const record = this._keys.get(id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
  }
}

/** ADR-089 (claim-flow): TTL claim-кода по умолчанию — 10 минут. */
const IDENTITY_CLAIM_TTL_SEC = 600;
/** Алфавит кода — base32 без похожих символов (`0/O/1/I` исключены). */
const IDENTITY_CLAIM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Длина значимой части кода (без дефиса). `32^6 ≈ 2^30`. */
const IDENTITY_CLAIM_LENGTH = 6;
/** Дней до удаления потреблённых claim'ов при `cleanup`. */
const CONSUMED_RETENTION_SEC = IDENTITY_CLAIM_TTL_SEC;

/** Нормализация вводимого кода: верхний регистр, удаление дефисов/пробелов. */
function normalizeClaimCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Канонический вид кода с дефисом: `ABCDEF` → `ABC-DEF`. */
function formatClaimCode(raw: string): string {
  const mid = Math.floor(raw.length / 2);
  return `${raw.slice(0, mid)}-${raw.slice(mid)}`;
}

/** Генерация одного «сырого» кода (без дефиса). */
function generateClaimRaw(): string {
  let out = '';
  for (let i = 0; i < IDENTITY_CLAIM_LENGTH; i += 1) {
    out += IDENTITY_CLAIM_ALPHABET[randomInt(IDENTITY_CLAIM_ALPHABET.length)];
  }
  return out;
}

/** Порт одноразовых claim-кодов поверх `Map` (семантика `IdentityClaimStore`). */
export class MemoryIdentityClaimRepository implements IdentityClaimRepository {
  private readonly _claims = new Map<string, IdentityClaimRecord>();

  async create(input: {
    provider: string;
    externalId: string;
    chatKey?: string;
    principalId: string;
    ttlSec?: number;
  }): Promise<IdentityClaimRecord> {
    const existing = new Set([...this._claims.values()].map((c) => c.code));
    let code = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = formatClaimCode(generateClaimRaw());
      if (!existing.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('не удалось сгенерировать уникальный claim-код');

    const ttlSec = input.ttlSec ?? IDENTITY_CLAIM_TTL_SEC;
    const now = Date.now();
    const claim: IdentityClaimRecord = {
      code,
      provider: input.provider,
      externalId: input.externalId,
      ...(input.chatKey ? { chatKey: input.chatKey } : {}),
      principalId: input.principalId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
    };
    this._claims.set(code, claim);
    return structuredClone(claim);
  }

  async consume(
    code: string,
    opts: { userId: string; provider?: string; externalId?: string },
  ): Promise<IdentityClaimRecord | null> {
    void opts.userId;
    const normalized = normalizeClaimCode(code);
    if (!normalized) return null;

    for (const claim of this._claims.values()) {
      if (normalizeClaimCode(claim.code) !== normalized) continue;
      if (claim.consumedAt) return null;
      if (Date.parse(claim.expiresAt) <= Date.now()) return null;
      if (opts.provider && opts.provider !== claim.provider) return null;
      if (opts.externalId && opts.externalId !== claim.externalId) return null;
      claim.consumedAt = new Date().toISOString();
      return structuredClone(claim);
    }
    return null;
  }

  async cleanup(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const [code, claim] of this._claims) {
      const expired = Date.parse(claim.expiresAt) <= now;
      const consumedStale = !!claim.consumedAt && now - Date.parse(claim.consumedAt) > CONSUMED_RETENTION_SEC * 1000;
      if (expired || consumedStale) {
        this._claims.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  async list(activeOnly = false): Promise<IdentityClaimRecord[]> {
    const all = [...this._claims.values()];
    if (!activeOnly) return all.map((c) => structuredClone(c));
    const now = Date.now();
    return all
      .filter((c) => !c.consumedAt && Date.parse(c.expiresAt) > now)
      .map((c) => structuredClone(c));
  }
}

/** Порт дедупа поверх `Set` (семантика `MemoryDedupStore`). */
export class MemoryDedupRepository implements DedupRepository {
  private readonly _seen = new Set<string>();

  seed(keys: Iterable<string>): void {
    for (const key of keys) this._seen.add(key);
  }

  async tryClaim(key: string): Promise<boolean> {
    if (this._seen.has(key)) return false;
    this._seen.add(key);
    return true;
  }
}

/** Порт единого реестра MCP-серверов поверх `Map` (семантика `McpRegistryStore`). */
export class MemoryMcpRegistryRepository implements McpRegistryRepository {
  private readonly _entries = new Map<string, McpRegistryEntry>();

  async list(): Promise<McpRegistryEntry[]> {
    return [...this._entries.values()]
      .map((e) => structuredClone(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<McpRegistryEntry | null> {
    const entry = this._entries.get(id);
    return entry ? structuredClone(entry) : null;
  }

  async getByName(name: string): Promise<McpRegistryEntry | null> {
    for (const entry of this._entries.values()) {
      if (entry.name === name) return structuredClone(entry);
    }
    return null;
  }

  async add(input: AddMcpRegistryEntryInput): Promise<McpRegistryEntry> {
    for (const entry of this._entries.values()) {
      if (entry.name === input.name) throw new Error(`MCP-сервер "${input.name}" уже существует в реестре`);
    }
    const now = nowISO();
    const entry: McpRegistryEntry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      id: input.id ?? generateId(),
      name: input.name,
      config: input.config,
      origin: input.origin,
      author: input.author ?? null,
      trust: input.trust ?? (input.origin === 'instance' ? 'builtin' : 'community'),
      enabled: input.enabled ?? true,
      enabledByDefault: input.enabledByDefault ?? input.config.enabledByDefault ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this._entries.set(entry.id, entry);
    return structuredClone(entry);
  }

  async update(id: string, patch: UpdateMcpRegistryEntryInput): Promise<McpRegistryEntry | null> {
    const current = this._entries.get(id);
    if (!current) return null;
    if (patch.name && patch.name !== current.name) {
      for (const entry of this._entries.values()) {
        if (entry.id !== id && entry.name === patch.name) {
          throw new Error(`MCP-сервер "${patch.name}" уже существует в реестре`);
        }
      }
    }
    const updated: McpRegistryEntry = {
      ...current,
      name: patch.name ?? current.name,
      config: patch.config ?? current.config,
      origin: patch.origin ?? current.origin,
      trust: patch.trust ?? current.trust,
      enabled: patch.enabled ?? current.enabled,
      enabledByDefault: patch.enabledByDefault ?? current.enabledByDefault,
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      updatedAt: nowISO(),
    };
    this._entries.set(id, updated);
    return structuredClone(updated);
  }

  async remove(id: string): Promise<boolean> {
    return this._entries.delete(id);
  }

  async seedFromConfig(servers: Record<string, McpServerConfig>): Promise<number> {
    let added = 0;
    for (const [name, config] of Object.entries(servers)) {
      if ([...this._entries.values()].some((e) => e.name === name)) continue;
      const now = nowISO();
      const id = generateId();
      this._entries.set(id, {
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        id,
        name,
        config,
        origin: 'instance',
        author: null,
        trust: 'builtin',
        enabled: config.enabled !== false,
        enabledByDefault: config.enabledByDefault ?? false,
        createdAt: now,
        updatedAt: now,
      });
      added += 1;
    }
    return added;
  }

  async toServerConfigMap(): Promise<Record<string, McpServerConfig>> {
    const map: Record<string, McpServerConfig> = {};
    for (const entry of await this.list()) map[entry.name] = entry.config;
    return map;
  }

  async toOriginMap(): Promise<Record<string, McpRegistryOrigin>> {
    const map: Record<string, McpRegistryOrigin> = {};
    for (const entry of await this.list()) map[entry.name] = entry.origin;
    return map;
  }

  async toTrustMap(): Promise<Record<string, McpRegistryTrust>> {
    const map: Record<string, McpRegistryTrust> = {};
    for (const entry of await this.list()) map[entry.name] = entry.trust;
    return map;
  }

  async toAuthorMap(): Promise<Record<string, McpRegistryAuthor>> {
    const map: Record<string, McpRegistryAuthor> = {};
    for (const entry of await this.list()) {
      if (entry.author) map[entry.name] = entry.author;
    }
    return map;
  }

  async toDefaultServers(): Promise<string[]> {
    return (await this.list())
      .filter((e) => e.origin === 'instance' && e.enabledByDefault)
      .map((e) => e.name);
  }

  async toManagerMaps(): Promise<{
    servers: Record<string, McpServerConfig>;
    origins: Record<string, McpRegistryOrigin>;
    trusts: Record<string, McpRegistryTrust>;
    authors: Record<string, McpRegistryAuthor>;
    systemEnabled: Record<string, boolean>;
    defaults: string[];
  }> {
    const servers: Record<string, McpServerConfig> = {};
    const origins: Record<string, McpRegistryOrigin> = {};
    const trusts: Record<string, McpRegistryTrust> = {};
    const authors: Record<string, McpRegistryAuthor> = {};
    const systemEnabled: Record<string, boolean> = {};
    const defaults: string[] = [];
    for (const entry of await this.list()) {
      servers[entry.name] = entry.config;
      origins[entry.name] = entry.origin;
      trusts[entry.name] = entry.trust;
      systemEnabled[entry.name] = entry.enabled !== false;
      if (entry.author) authors[entry.name] = entry.author;
      if (entry.origin === 'instance' && entry.enabledByDefault) defaults.push(entry.name);
    }
    return { servers, origins, trusts, authors, systemEnabled, defaults };
  }
}

/** Внутренняя запись service-key: публичные поля + sha256-хеш секрета. */
interface MemoryServiceKeyRecord extends ServiceApiKey {
  hash: string;
}

/** Порт service-key поверх `Map` (семантика `ServiceApiKeyStore`). */
export class MemoryServiceKeyRepository implements ServiceKeyRepository {
  private readonly _keys = new Map<string, MemoryServiceKeyRecord>();

  private _toPublic(record: MemoryServiceKeyRecord): ServiceApiKey {
    const { hash, ...pub } = record;
    void hash;
    return structuredClone(pub);
  }

  private _assertLabelUnique(label: string, excludeKeyId?: string): void {
    const target = labelKey(label);
    for (const record of this._keys.values()) {
      if (record.id !== excludeKeyId && labelKey(record.label ?? '') === target) {
        throw new ServiceApiKeyConflictError(label);
      }
    }
  }

  async list(): Promise<ServiceApiKey[]> {
    return [...this._keys.values()].map((k) => this._toPublic(k));
  }

  async get(id: string): Promise<ServiceApiKey | null> {
    const record = this._keys.get(id);
    return record ? this._toPublic(record) : null;
  }

  /** Полные записи (включая `hash`) — только для переноса между backend'ами. */
  async exportAll(): Promise<ServiceApiKeyRecord[]> {
    return [...this._keys.values()].map((record) => ({
      ...record,
      roles: [...record.roles],
      scopes: [...record.scopes],
      ...(record.allowedProjects ? { allowedProjects: [...record.allowedProjects] } : {}),
    }));
  }

  /**
   * Импорт готовой записи как есть (PROP-032): `id`/`prefix`/`hash` сохраняются.
   * Идемпотентно: при совпадении `id`, метки или хеша возвращается существующая.
   */
  async importExisting(record: ServiceApiKeyRecord): Promise<ServiceApiKey> {
    if (!record.hash) throw new Error('hash обязателен');
    const label = normalizeLabel(record.label);
    const sameId = this._keys.get(record.id);
    if (sameId) return this._toPublic(sameId);
    for (const existing of this._keys.values()) {
      if (labelKey(existing.label ?? '') === labelKey(label) || existing.hash === record.hash) {
        return this._toPublic(existing);
      }
    }
    const stored: MemoryServiceKeyRecord = {
      ...record,
      label,
      roles: [...record.roles],
      scopes: [...record.scopes],
      ...(record.allowedProjects ? { allowedProjects: [...record.allowedProjects] } : {}),
    };
    this._keys.set(stored.id, stored);
    return this._toPublic(stored);
  }

  async create(input: CreateServiceApiKeyInput, createdBy: string): Promise<ServiceApiKeyCreated> {
    const label = normalizeLabel(input.label);
    const secret = `${SERVICE_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    const record: MemoryServiceKeyRecord = {
      id: `svk_${generateId()}`,
      label,
      ...(input.description !== undefined ? { description: input.description } : {}),
      roles: input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES],
      scopes: [...input.scopes],
      ...(input.allowedProjects !== undefined ? { allowedProjects: [...input.allowedProjects] } : {}),
      ...(input.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: input.rateLimitPerMinute } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdBy,
      createdAt: new Date().toISOString(),
      prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
      hash: hashSecret(secret),
    };
    this._assertLabelUnique(label);
    this._keys.set(record.id, record);
    return { ...this._toPublic(record), key: secret };
  }

  async ensure(input: EnsureServiceKeyInput): Promise<{ status: ServiceKeyEnsureStatus; key: ServiceApiKey }> {
    const label = normalizeLabel(input.label);
    const rawSecret = input.secret?.trim() ?? '';
    if (!rawSecret) throw new Error('secret обязателен');
    const secret = rawSecret.startsWith(SERVICE_KEY_SECRET_PREFIX)
      ? rawSecret
      : `${SERVICE_KEY_SECRET_PREFIX}${rawSecret}`;
    const roles = input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES];

    let existing: MemoryServiceKeyRecord | undefined;
    for (const record of this._keys.values()) {
      if (labelKey(record.label ?? '') === labelKey(label)) {
        existing = record;
        break;
      }
    }

    if (!existing) {
      const record: MemoryServiceKeyRecord = {
        id: `svk_${generateId()}`,
        label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        roles,
        scopes: [...input.scopes],
        createdBy: input.createdBy ?? BOOTSTRAP_CREATED_BY,
        createdAt: new Date().toISOString(),
        prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
        hash: hashSecret(secret),
      };
      this._keys.set(record.id, record);
      return { status: 'created', key: this._toPublic(record) };
    }

    const sameScopes =
      existing.scopes.length === input.scopes.length && existing.scopes.every((s, i) => s === input.scopes[i]);
    const sameRoles =
      !input.roles
      || input.roles.length === 0
      || (existing.roles.length === roles.length && existing.roles.every((r, i) => r === roles[i]));

    if (sameScopes && sameRoles) return { status: 'unchanged', key: this._toPublic(existing) };

    if (!sameScopes) existing.scopes = [...input.scopes];
    if (!sameRoles) existing.roles = roles;
    return { status: 'updated', key: this._toPublic(existing) };
  }

  async update(id: string, patch: UpdateServiceApiKeyPatch): Promise<ServiceApiKey | null> {
    const record = this._keys.get(id);
    if (!record) return null;

    if (patch.label !== undefined) {
      const label = normalizeLabel(patch.label);
      this._assertLabelUnique(label, id);
      record.label = label;
    }
    if (patch.description !== undefined) {
      if (patch.description === null) delete record.description;
      else record.description = patch.description;
    }
    if (patch.roles !== undefined) {
      record.roles = patch.roles.length > 0 ? [...patch.roles] : [...DEFAULT_SERVICE_KEY_ROLES];
    }
    if (patch.scopes !== undefined) {
      record.scopes = [...patch.scopes];
    }
    if (patch.allowedProjects !== undefined) {
      if (patch.allowedProjects === null) delete record.allowedProjects;
      else record.allowedProjects = [...patch.allowedProjects];
    }
    if (patch.rateLimitPerMinute !== undefined) {
      if (patch.rateLimitPerMinute === null) delete record.rateLimitPerMinute;
      else record.rateLimitPerMinute = patch.rateLimitPerMinute;
    }
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt === null) delete record.expiresAt;
      else record.expiresAt = patch.expiresAt;
    }
    return this._toPublic(record);
  }

  async remove(id: string): Promise<boolean> {
    return this._keys.delete(id);
  }

  async revoke(id: string): Promise<boolean> {
    const record = this._keys.get(id);
    if (!record) return false;
    if (!record.revokedAt) record.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveBySecret(rawSecret: string): Promise<ServiceKeyResolution | null> {
    if (!rawSecret) return null;
    const hash = hashSecret(rawSecret);
    let found: MemoryServiceKeyRecord | undefined;
    for (const record of this._keys.values()) {
      if (record.hash === hash) {
        found = record;
        break;
      }
    }
    if (!found) return null;
    if (found.revokedAt) return null;
    if (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()) return null;

    const key = this._toPublic(found);
    const credential: ServiceKeyCredential = {
      keyId: key.id,
      label: key.label,
      roles: [...key.roles],
      scopes: [...key.scopes],
      ...(key.allowedProjects ? { allowedProjects: [...key.allowedProjects] } : {}),
      ...(key.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: key.rateLimitPerMinute } : {}),
    };
    return { key, credential };
  }

  async touch(id: string): Promise<void> {
    const record = this._keys.get(id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
  }
}
