import { describe, it, expect } from 'vitest';
import {
  gitRepoConfigSchema,
  normalizeGitRepoConfig,
  projectCreateSchema,
  projectUpdateSchema,
  sshKeyCreateSchema,
  sshKeyUpdateSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  normalizeIconKey,
  normalizeColorKey,
  isProjectIconKey,
  isProjectColorKey,
} from './index.js';
import { PROJECT_ICON_KEYS, PROJECT_COLOR_KEYS } from '../types/index.js';

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

describe('иконки/цвета проектов и сессий', () => {
  it('канонические списки непустые, уникальные и без дублей', () => {
    expect(PROJECT_ICON_KEYS.length).toBeGreaterThanOrEqual(19 + 18);
    expect(PROJECT_COLOR_KEYS.length).toBe(8);
    expect(new Set(PROJECT_ICON_KEYS).size).toBe(PROJECT_ICON_KEYS.length);
    expect(new Set(PROJECT_COLOR_KEYS).size).toBe(PROJECT_COLOR_KEYS.length);
  });

  it('дефолтные иконки (folder/chat/cpu) входят в канонический список', () => {
    expect(PROJECT_ICON_KEYS).toContain('folder');
    expect(PROJECT_ICON_KEYS).toContain('chat');
    expect(PROJECT_ICON_KEYS).toContain('cpu');
  });

  it('isProjectIconKey/isProjectColorKey: только канонические ключи', () => {
    expect(isProjectIconKey('rocket')).toBe(true);
    expect(isProjectIconKey('🚀')).toBe(false);
    expect(isProjectIconKey(42)).toBe(false);
    expect(isProjectColorKey('primary')).toBe(true);
    expect(isProjectColorKey('blue')).toBe(false);
    expect(isProjectColorKey(null)).toBe(false);
  });

  it('normalizeIconKey: канонический ключ → как есть, всё прочее → undefined', () => {
    expect(normalizeIconKey('code')).toBe('code');
    expect(normalizeIconKey('🚀')).toBeUndefined();
    expect(normalizeIconKey('')).toBeUndefined();
    expect(normalizeIconKey(undefined)).toBeUndefined();
    expect(normalizeIconKey(null)).toBeUndefined();
  });

  it('normalizeColorKey: канонические ключи + legacy-алиасы, прочее → undefined', () => {
    expect(normalizeColorKey('success')).toBe('success');
    expect(normalizeColorKey('blue')).toBe('primary');
    expect(normalizeColorKey('red')).toBe('error');
    expect(normalizeColorKey('green')).toBe('success');
    expect(normalizeColorKey('--primary')).toBe('primary');
    expect(normalizeColorKey('--status-info')).toBe('primary');
    expect(normalizeColorKey('--syntax-keyword')).toBe('keyword');
    expect(normalizeColorKey('weird')).toBeUndefined();
    expect(normalizeColorKey('🚀')).toBeUndefined();
  });

  it('projectCreate/UpdateSchema: enum-валидация icon/color, null — сброс', () => {
    expect(projectCreateSchema.safeParse({ name: 'p', icon: 'rocket', color: 'primary' }).success).toBe(true);
    expect(projectCreateSchema.safeParse({ name: 'p', icon: '🚀' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ name: 'p', color: 'blue' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ name: 'p', icon: null, color: null }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ icon: 'heart' }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ color: 'nope' }).success).toBe(false);
  });

  it('sessionCreate/UpdateSchema: icon/color с той же валидацией', () => {
    expect(sessionCreateSchema.safeParse({ icon: 'server', color: 'type' }).success).toBe(true);
    expect(sessionCreateSchema.safeParse({ icon: 'x' }).success).toBe(false);
    expect(sessionUpdateSchema.safeParse({ color: 'error' }).success).toBe(true);
    expect(sessionUpdateSchema.safeParse({ color: 'red' }).success).toBe(false);
    expect(sessionUpdateSchema.safeParse({ icon: null, color: null }).success).toBe(true);
  });
});
