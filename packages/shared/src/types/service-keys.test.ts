import { describe, it, expect } from 'vitest';
import {
  SERVICE_SCOPES,
  SERVICE_SCOPE_FAMILIES,
  isKnownScope,
  hasServiceScope,
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
    // (без wildcard-семейства): llm:chat, addons:install, users:read.
    const standaloneNamespaces = ['llm', 'addons', 'users'];
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
    expect(isKnownScope('users:read')).toBe(true);
    expect(isKnownScope('events:*')).toBe(true);
    expect(isKnownScope('schedules:*')).toBe(true);
    expect(isKnownScope('bogus:read')).toBe(false);
    expect(isKnownScope('events:')).toBe(false);
    expect(isKnownScope('*')).toBe(false);
    expect(isKnownScope('')).toBe(false);
  });

  it('hasServiceScope: одиночные скоупы вне семейств (addons/users)', () => {
    expect(hasServiceScope(['addons:install'], 'addons:install')).toBe(true);
    expect(hasServiceScope(['users:read'], 'users:read')).toBe(true);
    // Нет wildcard-семейств addons/users — точечные скоупы не покрываются ничем иным.
    expect(hasServiceScope(['events:*'], 'addons:install')).toBe(false);
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
