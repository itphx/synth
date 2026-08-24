import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextConfig } from './config.js';

describe('ContextConfig.getSecurityMessage', () => {
  it('ru: deny-protected-path подставляет {{path}}, единственное число, без двойной точки', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    const msg = cc.getSecurityMessage('deny-protected-path', 'ru', { path: '/etc/passwd' });
    expect(msg).toBeTruthy();
    expect(msg!).toContain('Permission denied');
    expect(msg!).toContain('«/etc/passwd»');
    expect(msg!).toContain('выбери');
    expect(msg!).not.toContain('выберите');
    expect(msg!).not.toContain('.. ');
    expect(msg!).toContain('Действие запрещено политикой безопасности');
  });

  it('en: deny-protected-path переведён и подставляет {{path}}', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    const msg = cc.getSecurityMessage('deny-protected-path', 'en', { path: '/etc/passwd' });
    expect(msg).toBeTruthy();
    expect(msg!).toContain('Access denied');
    expect(msg!).toContain('«/etc/passwd»');
    expect(msg!).toContain('Do not repeat the call');
  });

  it('deny-protected-dir подставляет {{path}} и {{dir}}', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    const msg = cc.getSecurityMessage('deny-protected-dir', 'ru', { path: '/home/u/.ssh/x', dir: '/home/u/.ssh' });
    expect(msg!).toContain('«/home/u/.ssh/x»');
    expect(msg!).toContain('«/home/u/.ssh»');
  });

  it('ask-protected-path возвращает Permission required', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    const msg = cc.getSecurityMessage('ask-protected-path', 'ru', { path: '/etc/passwd' });
    expect(msg!).toContain('Permission required');
  });

  it('deny-command подставляет {{command}}', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    const msg = cc.getSecurityMessage('deny-command', 'ru', { command: 'rm -rf /' });
    expect(msg!).toContain('«rm -rf /»');
  });

  it('неизвестный messageId → null', () => {
    const cc = new ContextConfig({ userDataDir: join(tmpdir(), 'ctx-test') });
    expect(cc.getSecurityMessage('no-such-id', 'ru')).toBeNull();
  });
});

describe('ContextConfig.getSecurityMessage — каскад override', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctx-security-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('override локализованный приоритетнее встроенного', async () => {
    const userDir = join(dir, 'context');
    const overrideDir = join(userDir, 'user', 'system', 'security');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'deny-protected-path.en.md'), 'OVERRIDE_EN {{path}}', 'utf-8');
    const cc = new ContextConfig({ userDataDir: userDir, systemPromptsDir: join(dir, 'prompts') });
    expect(cc.getSecurityMessage('deny-protected-path', 'en', { path: '/x' })).toBe('OVERRIDE_EN /x');
  });

  it('override базовый (без языка) приоритетнее встроенного', async () => {
    const userDir = join(dir, 'context');
    const overrideDir = join(userDir, 'user', 'system', 'security');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'deny-protected-path.md'), 'OVERRIDE_BASE {{path}}', 'utf-8');
    const cc = new ContextConfig({ userDataDir: userDir, systemPromptsDir: join(dir, 'prompts') });
    expect(cc.getSecurityMessage('deny-protected-path', 'ru', { path: '/x' })).toBe('OVERRIDE_BASE /x');
  });

  it('без override и без встроенных файлов → null', async () => {
    const cc = new ContextConfig({ userDataDir: join(dir, 'context'), systemPromptsDir: join(dir, 'empty') });
    expect(cc.getSecurityMessage('deny-protected-path', 'ru')).toBeNull();
  });

  it('подстановка безопасна для значений с $ (не интерпретируются)', async () => {
    const userDir = join(dir, 'context');
    const cc = new ContextConfig({ userDataDir: userDir });
    const msg = cc.getSecurityMessage('deny-protected-path', 'ru', { path: '$HOME/a&b' });
    expect(msg!).toContain('«$HOME/a&b»');
  });
});
