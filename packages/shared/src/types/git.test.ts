/**
 * Политика SSH-ключа (PROP-124): нормализация и валидация.
 *
 * Проверяем: нормализацию `usages` (легаси без поля → `['git']`), запрет пустого
 * списка назначений (ключ, который не умеет ни git, ни ssh) и остальные
 * границы политики (хосты/порты).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSshKeyAllowHosts,
  normalizeSshKeyAllowPorts,
  normalizeSshKeyUsages,
  validateSshKeyPolicy,
} from './git.js';

describe('normalizeSshKeyUsages (PROP-124)', () => {
  it('поле отсутствует → [git] (fail-closed для ключей до Ф1)', () => {
    expect(normalizeSshKeyUsages(undefined)).toEqual(['git']);
  });

  it('явный список сохраняется как есть', () => {
    expect(normalizeSshKeyUsages(['git', 'ssh'])).toEqual(['git', 'ssh']);
    expect(normalizeSshKeyUsages(['ssh'])).toEqual(['ssh']);
  });
});

describe('normalizeSshKeyAllowHosts / AllowPorts', () => {
  it('хосты: отсутствуют → [], пустые отбрасываются, пробелы срезаются', () => {
    expect(normalizeSshKeyAllowHosts(undefined)).toEqual([]);
    expect(normalizeSshKeyAllowHosts([' git.example.com ', '', '  '])).toEqual(['git.example.com']);
  });

  it('порты: отсутствуют → [], значения сохраняются', () => {
    expect(normalizeSshKeyAllowPorts(undefined)).toEqual([]);
    expect(normalizeSshKeyAllowPorts([22, 2222])).toEqual([22, 2222]);
  });
});

describe('validateSshKeyPolicy (PROP-124)', () => {
  it('пустой список назначений → отказ (ключ без назначения бесполезен)', () => {
    const result = validateSshKeyPolicy({ usages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('usages');
  });

  it('одно или два назначения → допустимо', () => {
    expect(validateSshKeyPolicy({ usages: ['git'] }).ok).toBe(true);
    expect(validateSshKeyPolicy({ usages: ['git', 'ssh'] }).ok).toBe(true);
  });

  it('недопустимое назначение → отказ', () => {
    const result = validateSshKeyPolicy({
      usages: ['ftp' as unknown as 'git'],
    });
    expect(result.ok).toBe(false);
  });

  it('поле отсутствует → проверка не выполняется (не менять политику)', () => {
    expect(validateSshKeyPolicy({}).ok).toBe(true);
  });

  it('пустые/невалидные хосты и порты вне диапазона → отказ', () => {
    expect(validateSshKeyPolicy({ allowHosts: [''] }).ok).toBe(false);
    expect(validateSshKeyPolicy({ allowHosts: ['*'] }).ok).toBe(false);
    expect(validateSshKeyPolicy({ allowPorts: [0] }).ok).toBe(false);
    expect(validateSshKeyPolicy({ allowPorts: [70000] }).ok).toBe(false);
    expect(validateSshKeyPolicy({ allowHosts: ['git.example.com'], allowPorts: [22] }).ok).toBe(
      true,
    );
  });
});
