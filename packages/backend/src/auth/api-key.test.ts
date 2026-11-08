/**
 * Аудит F5: единый API-ключ — постоянное по времени сравнение и роли только
 * явной настройкой (дефолт USER, не ADMIN).
 */
import { describe, it, expect } from 'vitest';
import { GlobalRole } from '@itphx/synth-shared';
import {
  ALLOWED_API_KEY_ROLES,
  DEFAULT_API_KEY_ROLE,
  apiKeyEquals,
  resolveApiKeyRoles,
} from './api-key.js';

describe('apiKeyEquals — постоянное по времени сравнение', () => {
  it('совпадающие ключи → true', () => {
    expect(apiKeyEquals('instance-secret-key', 'instance-secret-key')).toBe(true);
  });

  it('несовпадающие ключи одинаковой длины → false', () => {
    expect(apiKeyEquals('instance-secret-keY', 'instance-secret-key')).toBe(false);
  });

  it('несовпадающие ключи разной длины → false без исключений', () => {
    expect(() => apiKeyEquals('short', 'instance-secret-key')).not.toThrow();
    expect(apiKeyEquals('short', 'instance-secret-key')).toBe(false);
    expect(apiKeyEquals('instance-secret-key-longer', 'instance-secret-key')).toBe(false);
  });

  it('пустой представленный ключ → false', () => {
    expect(apiKeyEquals('', 'instance-secret-key')).toBe(false);
    expect(apiKeyEquals(undefined, 'instance-secret-key')).toBe(false);
    expect(apiKeyEquals(null, 'instance-secret-key')).toBe(false);
  });

  it('пустой ожидаемый ключ → false (незаданный ключ не аутентифицирует)', () => {
    expect(apiKeyEquals('instance-secret-key', '')).toBe(false);
    expect(apiKeyEquals('instance-secret-key', undefined)).toBe(false);
    expect(apiKeyEquals('', '')).toBe(false);
  });
});

describe('resolveApiKeyRoles — роли API-ключа только явной настройкой', () => {
  it('не задано / пустой список → USER (не ADMIN)', () => {
    expect(resolveApiKeyRoles(undefined)).toEqual([GlobalRole.USER]);
    expect(resolveApiKeyRoles([])).toEqual([GlobalRole.USER]);
    expect(DEFAULT_API_KEY_ROLE).toBe(GlobalRole.USER);
  });

  it('явный список (ADMIN,USER) применяется как есть', () => {
    expect(resolveApiKeyRoles(['ADMIN', 'USER'])).toEqual([GlobalRole.ADMIN, GlobalRole.USER]);
  });

  it('дубликаты схлопываются с сохранением порядка', () => {
    expect(resolveApiKeyRoles(['LEAD', 'LEAD', 'USER'])).toEqual([GlobalRole.LEAD, GlobalRole.USER]);
  });

  it('неизвестная роль → ошибка конфигурации с понятным текстом', () => {
    expect(() => resolveApiKeyRoles(['ADMIN', 'ROOT'])).toThrow(/auth\.apiKeyRoles/);
    expect(() => resolveApiKeyRoles(['ROOT'])).toThrow(/ROOT/);
  });

  it('допустимый набор ролей — ADMIN|USER|LEAD|AUDITOR', () => {
    expect([...ALLOWED_API_KEY_ROLES]).toEqual(['ADMIN', 'USER', 'LEAD', 'AUDITOR']);
  });
});
