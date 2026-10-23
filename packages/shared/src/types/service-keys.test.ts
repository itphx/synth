import { describe, it, expect } from 'vitest';
import {
  SERVICE_SCOPES,
  SERVICE_SCOPE_FAMILIES,
  SERVICE_SCOPE_SETS,
  isKnownScope,
  hasServiceScope,
  hasAnyServiceScope,
} from './service-keys.js';
import {
  serviceApiKeySchema,
  serviceApiKeyCreateSchema,
  serviceApiKeyUpdateSchema,
  serviceApiKeyCreatedSchema,
} from '../schemas/index.js';

describe('service-key scopes (ADR-052)', () => {
  it('каталог скоупов и семейства непусты и согласованы', () => {
    expect(SERVICE_SCOPES.length).toBeGreaterThan(0);
    // Каждый скоуп либо из wildcard-семейства, либо из «одиночного» пространства
    // (без wildcard-семейства): llm:chat, addons:install, automation:install,
    // users:read, plugins:invoke (ADR-090 Ф7 — server-scoped токен плагина).
    const standaloneNamespaces = ['llm', 'addons', 'automation', 'users', 'plugins'];
    for (const scope of SERVICE_SCOPES) {
      const family = scope.split(':')[0] ?? '';
      expect(
        (SERVICE_SCOPE_FAMILIES as readonly string[]).includes(family) ||
          standaloneNamespaces.includes(family),
      ).toBe(true);
    }
  });

  it('isKnownScope: каталог, wildcard-семейства и отказ глобальному *', () => {
    expect(isKnownScope('events:ingest')).toBe(true);
    expect(isKnownScope('llm:chat')).toBe(true);
    expect(isKnownScope('addons:install')).toBe(true);
    expect(isKnownScope('automation:install')).toBe(true);
    expect(isKnownScope('users:read')).toBe(true);
    // Ф7: scope server-scoped токена плагина (Уровень 2).
    expect(isKnownScope('plugins:invoke')).toBe(true);
    // Wildcard-семейства `plugins` нет — точечный scope не покрывается ничем иным.
    expect(isKnownScope('plugins:*')).toBe(false);
    expect(isKnownScope('events:*')).toBe(true);
    expect(isKnownScope('schedules:*')).toBe(true);
    // Зонтичный скоуп не образует wildcard-семейства: `automation:*` неизвестен.
    expect(isKnownScope('automation:*')).toBe(false);
    expect(isKnownScope('bogus:read')).toBe(false);
    expect(isKnownScope('events:')).toBe(false);
    expect(isKnownScope('*')).toBe(false);
    expect(isKnownScope('')).toBe(false);
  });

  it('hasServiceScope: одиночные скоупы вне семейств (addons/automation/users)', () => {
    expect(hasServiceScope(['addons:install'], 'addons:install')).toBe(true);
    expect(hasServiceScope(['automation:install'], 'automation:install')).toBe(true);
    expect(hasServiceScope(['users:read'], 'users:read')).toBe(true);
    expect(hasServiceScope(['plugins:invoke'], 'plugins:invoke')).toBe(true);
    // Нет wildcard-семейств addons/automation/users/plugins — точечные скоупы не покрываются ничем иным.
    expect(hasServiceScope(['events:*'], 'addons:install')).toBe(false);
    expect(hasServiceScope(['events:*'], 'automation:install')).toBe(false);
    expect(hasServiceScope(['events:*'], 'users:read')).toBe(false);
    expect(hasServiceScope(['events:*'], 'plugins:invoke')).toBe(false);
    expect(hasServiceScope(['plugins:invoke'], 'addons:install')).toBe(false);
    expect(hasServiceScope(['addons:install'], 'automation:install')).toBe(false);
    expect(hasServiceScope(['addons:install'], 'users:read')).toBe(false);
  });

  it('hasServiceScope: точное совпадение', () => {
    expect(hasServiceScope(['events:ingest'], 'events:ingest')).toBe(true);
    expect(hasServiceScope(['events:ingest'], 'events:watch')).toBe(false);
    expect(hasServiceScope([], 'events:ingest')).toBe(false);
  });

  it('hasServiceScope: wildcard-семейство покрывает свои скоупы', () => {
    expect(hasServiceScope(['events:*'], 'events:ingest')).toBe(true);
    expect(hasServiceScope(['events:*'], 'events:watch')).toBe(true);
    // Не покрывает чужое семейство.
    expect(hasServiceScope(['events:*'], 'bindings:read')).toBe(false);
  });

  it('hasServiceScope: запрос wildcard покрыт только тем же wildcard', () => {
    expect(hasServiceScope(['events:*'], 'events:*')).toBe(true);
    expect(hasServiceScope(['events:ingest'], 'events:*')).toBe(false);
    expect(hasServiceScope(['*'], 'events:ingest')).toBe(false);
  });
});

/**
 * ADR-052: «любой из»-наборы и зонтичный скоуп `automation:install`
 * (установщик пакетов расширений).
 */
describe('hasAnyServiceScope / SERVICE_SCOPE_SETS (ADR-052)', () => {
  it('hasAnyServiceScope: достаточно любого из набора', () => {
    expect(hasAnyServiceScope(['routes:write'], ['routes:write', 'automation:install'])).toBe(true);
    expect(hasAnyServiceScope(['automation:install'], ['routes:write', 'automation:install'])).toBe(true);
    expect(hasAnyServiceScope(['addons:install'], ['routes:write', 'automation:install'])).toBe(false);
    // Wildcard-семейство покрывает свой элемент набора.
    expect(hasAnyServiceScope(['routes:*'], ['routes:write', 'automation:install'])).toBe(true);
    // Пустой набор ничего не открывает (fail-closed).
    expect(hasAnyServiceScope(['routes:write'], [])).toBe(false);
    expect(hasAnyServiceScope([], ['routes:write', 'automation:install'])).toBe(false);
  });

  it('SERVICE_SCOPE_SETS: зонтичный automation:install замещает ресурсные скоупы', () => {
    expect(SERVICE_SCOPE_SETS.routesWrite).toEqual(['routes:write', 'automation:install']);
    expect(SERVICE_SCOPE_SETS.schedulesWrite).toEqual(['schedules:write', 'automation:install']);
    expect(SERVICE_SCOPE_SETS.agentsWrite).toEqual(['automation:install']);
  });
});

describe('service-key schemas (ADR-052)', () => {
  const base = {
    id: 'svk_1',
    label: 'gateway',
    roles: ['USER'],
    scopes: ['events:ingest'],
    createdBy: 'u-1',
    createdAt: new Date().toISOString(),
    prefix: 'synth_svc_a…',
  };

  it('serviceApiKeySchema: метаданные без секрета', () => {
    const parsed = serviceApiKeySchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.id).toBe('svk_1');
  });

  it('serviceApiKeyCreateSchema: label обязателен, scopes непусты и известны', () => {
    expect(serviceApiKeyCreateSchema.safeParse({ label: 'g', scopes: ['events:ingest'] }).success).toBe(true);
    expect(serviceApiKeyCreateSchema.safeParse({ label: 'g', scopes: [] }).success).toBe(false);
    expect(serviceApiKeyCreateSchema.safeParse({ label: 'g', scopes: ['bogus:read'] }).success).toBe(false);
    expect(serviceApiKeyCreateSchema.safeParse({ scopes: ['events:ingest'] }).success).toBe(false);
    // Неизвестная роль отклоняется.
    expect(
      serviceApiKeyCreateSchema.safeParse({ label: 'g', scopes: ['events:ingest'], roles: ['ROOT'] }).success,
    ).toBe(false);
    // Wildcard-семейство принимается.
    expect(serviceApiKeyCreateSchema.safeParse({ label: 'g', scopes: ['events:*'] }).success).toBe(true);
  });

  it('serviceApiKeyUpdateSchema: null сбрасывает опциональные поля', () => {
    const parsed = serviceApiKeyUpdateSchema.safeParse({
      description: null,
      allowedProjects: null,
      rateLimitPerMinute: null,
      expiresAt: null,
      scopes: ['sessions:*'],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.description).toBeNull();
    expect(serviceApiKeyUpdateSchema.safeParse({ rateLimitPerMinute: -1 }).success).toBe(false);
    expect(serviceApiKeyUpdateSchema.safeParse({ scopes: ['nope'] }).success).toBe(false);
  });

  it('serviceApiKeyCreatedSchema: метаданные + plaintext key', () => {
    const created = { ...base, key: 'synth_svc_secret' };
    expect(serviceApiKeyCreatedSchema.safeParse(created).success).toBe(true);
    expect(serviceApiKeyCreatedSchema.safeParse(base).success).toBe(false);
  });
});
