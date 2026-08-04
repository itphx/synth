import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextConfig } from './config.js';

describe('ContextConfig.getModePrompt (AD-025)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-mode-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('встроенный файл prompts/modes/{mode}.md существует и загружается', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru');
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('Текущий режим: plan');

    const act = config.getModePrompt('act', 'ru');
    expect(act).not.toBeNull();
    expect(act!).toContain('Текущий режим: act');

    const yolo = config.getModePrompt('yolo', 'ru');
    expect(yolo).not.toBeNull();
    expect(yolo!).toContain('Текущий режим: yolo');
  });

  it('встроенный промпт описывает другие режимы и ограничения', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru')!;
    expect(prompt).toContain('act');
    expect(prompt).toContain('yolo');
    expect(prompt).toContain('Не вноси никаких изменений');
  });

  it('override из dataDir/context/modes приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'modes'), { recursive: true });
    await writeFile(join(userDataDir, 'modes', 'plan.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ ПРОМПТ PLAN', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru');
    expect(prompt).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ ПРОМПТ PLAN');
  });

  it('локализованный override {mode}.ru.md приоритетнее базового override', async () => {
    await mkdir(join(userDataDir, 'modes'), { recursive: true });
    await writeFile(join(userDataDir, 'modes', 'plan.md'), 'BASE OVERRIDE', 'utf-8');
    await writeFile(join(userDataDir, 'modes', 'plan.ru.md'), 'RU OVERRIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getModePrompt('plan', 'ru')).toBe('RU OVERRIDE');
    // для другого языка локализованный файл не подходит — fallback на базовый override
    expect(config.getModePrompt('plan', 'en')).toBe('BASE OVERRIDE');
  });

  it('неизвестный режим → null (fallback на встроенный текст движка)', async () => {
    const config = new ContextConfig({ userDataDir });
    expect(config.getModePrompt('unknown_mode', 'ru')).toBeNull();
  });
});
