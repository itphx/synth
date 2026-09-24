import { describe, it, expect } from 'vitest';
import {
  gitRepoConfigSchema,
  normalizeGitRepoConfig,
  projectCreateSchema,
  projectUpdateSchema,
  sshKeyCreateSchema,
  sshKeyUpdateSchema,
} from './index.js';

describe('normalizeGitRepoConfig (AD-076)', () => {
  it('строка → { path }', () => {
    expect(normalizeGitRepoConfig('repos/app')).toEqual({ path: 'repos/app' });
  });

  it('пустая строка → null', () => {
    expect(normalizeGitRepoConfig('')).toBeNull();
  });

  it('объект с path → нормализованная запись', () => {
    const raw = { path: 'repos/app', name: 'app', type: 'ssh', sshKeyId: 'k1' };
    expect(normalizeGitRepoConfig(raw)).toEqual(raw);
  });

  it('legacy-объект { path, defaultBranch } сохраняется', () => {
    expect(normalizeGitRepoConfig({ path: 'r', defaultBranch: 'main' })).toEqual({
      path: 'r',
      defaultBranch: 'main',
    });
  });

  it('невалидный объект (без path) → null', () => {
    expect(normalizeGitRepoConfig({ name: 'app' })).toBeNull();
  });

  it('невалидный type → null', () => {
    expect(normalizeGitRepoConfig({ path: 'r', type: 'git' })).toBeNull();
  });

  it('не-строка/не-объект → null', () => {
    expect(normalizeGitRepoConfig(42)).toBeNull();
    expect(normalizeGitRepoConfig(null)).toBeNull();
    expect(normalizeGitRepoConfig(['r'])).toBeNull();
  });
});

describe('gitRepoConfigSchema (AD-076)', () => {
  it('path обязателен', () => {
    expect(gitRepoConfigSchema.safeParse({}).success).toBe(false);
    expect(gitRepoConfigSchema.safeParse({ path: 'r' }).success).toBe(true);
  });

  it('type ограничен https/ssh', () => {
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'https' }).success).toBe(true);
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'ssh' }).success).toBe(true);
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'ftp' }).success).toBe(false);
  });
});

describe('project repos: legacy + новая форма (AD-076)', () => {
  it('projectCreateSchema принимает string[] и объекты', () => {
    const parsed = projectCreateSchema.safeParse({
      name: 'demo',
      repos: ['repos/old', { path: 'repos/new', url: 'git@host:new.git', type: 'ssh' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('projectUpdateSchema принимает string[] и объекты', () => {
    const parsed = projectUpdateSchema.safeParse({ repos: ['repos/old'] });
    expect(parsed.success).toBe(true);
  });
});

describe('sshKeyCreateSchema (AD-076)', () => {
  it('валидный минимальный payload', () => {
    const parsed = sshKeyCreateSchema.safeParse({
      name: 'deploy',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('deploy');
      expect(parsed.data.agentIds).toBeUndefined();
    }
  });

  it('валидный payload со всеми полями', () => {
    const parsed = sshKeyCreateSchema.safeParse({
      name: 'deploy',
      type: 'deploy',
      privateKey: 'key',
      passphrase: 'secret',
      agentIds: ['a1', 'a2'],
    });
    expect(parsed.success).toBe(true);
  });

  it('пустое имя → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: '', privateKey: 'k' }).success).toBe(false);
  });

  it('пустой privateKey → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: 'x', privateKey: '' }).success).toBe(false);
  });

  it('без privateKey → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('sshKeyUpdateSchema — частичная схема (пустой объект валиден)', () => {
    expect(sshKeyUpdateSchema.safeParse({}).success).toBe(true);
    expect(sshKeyUpdateSchema.safeParse({ name: 'renamed' }).success).toBe(true);
    // id/createdAt в схему апдейта не входят
    const parsed = sshKeyUpdateSchema.safeParse({ id: 'x', createdAt: 'now' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('id' in parsed.data).toBe(false);
      expect('createdAt' in parsed.data).toBe(false);
    }
  });
});
