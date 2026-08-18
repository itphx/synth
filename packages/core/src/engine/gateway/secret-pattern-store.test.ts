/**
 * Юнит-тесты SecretPatternStore (AD-036): редактируемый список regex-паттернов.
 * Схема: дефолт в коде (DEFAULT_PATTERNS) → override в {dataDir}/gateway/patterns.json,
 * сброс = удаление override-файла.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PATTERNS, detectSecrets } from './secret-detector.js';
import { SecretPatternStore, type SecretPattern } from './secret-pattern-store.js';

function defaultAsStrings(): SecretPattern[] {
  return DEFAULT_PATTERNS.map((p) => ({
    type: p.type,
    regex: typeof p.regex === 'string' ? p.regex : p.regex.source,
  }));
}

describe('SecretPatternStore', () => {
  let dir: string;
  let store: SecretPatternStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-patterns-'));
    store = new SecretPatternStore({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('без override getPatterns = DEFAULT_PATTERNS (как строки)', () => {
    expect(store.hasOverride()).toBe(false);
    expect(store.getPatterns()).toEqual(defaultAsStrings());
    expect(store.getEffectivePatterns()).toEqual(defaultAsStrings());
  });

  it('savePatterns → getPatterns возвращает сохранённые паттерны', async () => {
    const custom: SecretPattern[] = [{ type: 'custom', regex: '\\bsk-custom-[A-Za-z0-9]{20,}' }];

    expect(await store.savePatterns(custom)).toBe(true);
    expect(store.hasOverride()).toBe(true);
    expect(store.getPatterns()).toEqual(custom);

    // файл реально записан как JSON-массив
    const raw = JSON.parse(await readFile(store.overridePath, 'utf-8')) as unknown;
    expect(raw).toEqual(custom);
  });

  it('reset удаляет override → снова дефолт', async () => {
    await store.savePatterns([{ type: 'custom', regex: 'x{5,}' }]);
    expect(store.hasOverride()).toBe(true);

    expect(await store.reset()).toBe(true);
    expect(store.hasOverride()).toBe(false);
    expect(store.getPatterns()).toEqual(defaultAsStrings());
  });

  it('reset без override → false', async () => {
    expect(await store.reset()).toBe(false);
  });

  it('невалидный regex → savePatterns false, файл не создаётся', async () => {
    const invalid: SecretPattern[] = [{ type: 'bad', regex: '(' }];

    expect(await store.savePatterns(invalid)).toBe(false);
    expect(store.hasOverride()).toBe(false);
    expect(store.getPatterns()).toEqual(defaultAsStrings());
  });

  it('невалидный элемент (пустой type / не строка) → savePatterns false', async () => {
    expect(await store.savePatterns([{ type: '', regex: 'abc{3}' }])).toBe(false);
    expect(await store.savePatterns([{ type: 'x', regex: 123 as unknown as string }])).toBe(false);
    expect(store.hasOverride()).toBe(false);
  });

  it('пустой массив валиден: детекция секретов отключается (документировано)', async () => {
    expect(await store.savePatterns([])).toBe(true);
    expect(store.getPatterns()).toEqual([]);
    expect(detectSecrets('секрет sk-abcdefghijklmnopqrst', store.getPatterns())).toEqual([]);
  });

  it('hasOverride отражает наличие override-файла', async () => {
    expect(store.hasOverride()).toBe(false);

    await store.savePatterns([{ type: 'custom', regex: 'abc{3}' }]);
    expect(store.hasOverride()).toBe(true);

    await store.reset();
    expect(store.hasOverride()).toBe(false);
  });

  it('getRawPatterns отдаёт isOverridden + эффективный и дефолтный списки', async () => {
    const raw = store.getRawPatterns();
    expect(raw.isOverridden).toBe(false);
    expect(raw.patterns).toEqual(raw.defaultPatterns);

    const custom: SecretPattern[] = [{ type: 'custom', regex: 'abc{3}' }];
    await store.savePatterns(custom);

    const overridden = store.getRawPatterns();
    expect(overridden.isOverridden).toBe(true);
    expect(overridden.patterns).toEqual(custom);
    expect(overridden.defaultPatterns).toEqual(defaultAsStrings());
  });

  it('паттерны из store работают в live-детекции', async () => {
    const custom: SecretPattern[] = [{ type: 'custom', regex: '\\bsk-custom-[A-Za-z0-9]{20,}' }];
    await store.savePatterns(custom);

    const secrets = detectSecrets('ключ sk-custom-abcdefghijklmnopqrstuvwxyz', store.getPatterns());
    expect(secrets).toContain('sk-custom-abcdefghijklmnopqrstuvwxyz');

    // override полностью заменяет дефолт: openai-ключ уже не детектится
    expect(detectSecrets('ключ sk-abcdefghijklmnopqrst', store.getPatterns())).toEqual([]);
  });

  it('повреждённый override-файл → warning и fallback на дефолт', async () => {
    await store.savePatterns([{ type: 'custom', regex: 'abc{3}' }]);
    // повреждаем файл вручную
    await writeFile(store.overridePath, 'not-json{', 'utf-8');

    expect(store.hasOverride()).toBe(true);
    expect(store.getPatterns()).toEqual(defaultAsStrings());
  });
});
