import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultsStore } from './defaults-store.js';

describe('DefaultsStore', () => {
  let tmpDir: string;
  let store: DefaultsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-defaults-'));
    store = new DefaultsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loadDefaults при отсутствии файла возвращает {}', async () => {
    expect(await store.loadDefaults()).toEqual({});
  });

  it('save → load roundtrip', async () => {
    await store.saveDefaults({
      locale: 'en',
      themeMode: 'light',
      theme: 'github',
      uiScaleMobile: 0.9,
      uiScaleDesktop: 1.1,
    });
    expect(await store.loadDefaults()).toEqual({
      locale: 'en',
      themeMode: 'light',
      theme: 'github',
      uiScaleMobile: 0.9,
      uiScaleDesktop: 1.1,
    });
  });

  it('saveDefaults мёржит с текущими значениями', async () => {
    await store.saveDefaults({ locale: 'en' });
    await store.saveDefaults({ theme: 'nord' });
    const afterTheme = await store.saveDefaults({ themeMode: 'dark' });
    expect(afterTheme).toEqual({ locale: 'en', theme: 'nord', themeMode: 'dark' });
    expect(await store.loadDefaults()).toEqual({ locale: 'en', theme: 'nord', themeMode: 'dark' });
  });

  it('игнорирует некорректные поля, а не падает', async () => {
    const saved = await store.saveDefaults({
      locale: 'de' as never,
      themeMode: 'blue' as never,
      theme: '   ',
      uiScaleMobile: 5,
      uiScaleDesktop: 5,
    });
    expect(saved).toEqual({});
    expect(await store.loadDefaults()).toEqual({});
  });

  it('некорректный патч не затирает ранее сохранённые значения', async () => {
    await store.saveDefaults({
      locale: 'ru',
      theme: 'flexoki',
      uiScaleMobile: 1.1,
      uiScaleDesktop: 0.8,
    });
    const saved = await store.saveDefaults({
      locale: 'de' as never,
      uiScaleMobile: 99,
      uiScaleDesktop: 99,
    });
    expect(saved).toEqual({
      locale: 'ru',
      theme: 'flexoki',
      uiScaleMobile: 1.1,
      uiScaleDesktop: 0.8,
    });
  });

  it('принимает граничные значения обоих масштабов 0.5 и 1.2', async () => {
    const cases: Array<{ field: 'uiScaleMobile' | 'uiScaleDesktop'; value: number }> = [
      { field: 'uiScaleMobile', value: 0.5 },
      { field: 'uiScaleMobile', value: 1.2 },
      { field: 'uiScaleDesktop', value: 0.5 },
      { field: 'uiScaleDesktop', value: 1.2 },
    ];
    for (const { field, value } of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'synth-defaults-boundary-'));
      try {
        const isolated = new DefaultsStore({ dataDir: dir });
        expect(await isolated.saveDefaults({ [field]: value })).toEqual({ [field]: value });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('игнорирует масштабы вне диапазона 0.5..1.2 и NaN', async () => {
    expect(await store.saveDefaults({ uiScaleMobile: 0.49 })).toEqual({});
    expect(await store.saveDefaults({ uiScaleMobile: 1.21 })).toEqual({});
    expect(await store.saveDefaults({ uiScaleMobile: NaN })).toEqual({});
    expect(await store.saveDefaults({ uiScaleMobile: '0.8' as never })).toEqual({});
    expect(await store.saveDefaults({ uiScaleDesktop: 0.49 })).toEqual({});
    expect(await store.saveDefaults({ uiScaleDesktop: 1.21 })).toEqual({});
    expect(await store.saveDefaults({ uiScaleDesktop: NaN })).toEqual({});
    expect(await store.saveDefaults({ uiScaleDesktop: '0.8' as never })).toEqual({});
  });

  it('валидирует uiScaleMobile и uiScaleDesktop независимо', async () => {
    const saved = await store.saveDefaults({ uiScaleMobile: 0.7, uiScaleDesktop: 77 });
    expect(saved).toEqual({ uiScaleMobile: 0.7 });
    expect(await store.loadDefaults()).toEqual({ uiScaleMobile: 0.7 });
  });

  it('частичный патч меняет только пришедшее поле масштаба', async () => {
    await store.saveDefaults({ uiScaleMobile: 0.6, uiScaleDesktop: 1.15 });
    const saved = await store.saveDefaults({ uiScaleMobile: 0.9 });
    expect(saved).toEqual({ uiScaleMobile: 0.9, uiScaleDesktop: 1.15 });
    expect(await store.loadDefaults()).toEqual({ uiScaleMobile: 0.9, uiScaleDesktop: 1.15 });
  });

  it('значения переживают пересоздание стора (рестарт)', async () => {
    await store.saveDefaults({
      locale: 'en',
      themeMode: 'dark',
      theme: 'flexoki',
      uiScaleMobile: 0.85,
      uiScaleDesktop: 1.05,
    });
    const store2 = new DefaultsStore({ dataDir: tmpDir });
    expect(await store2.loadDefaults()).toEqual({
      locale: 'en',
      themeMode: 'dark',
      theme: 'flexoki',
      uiScaleMobile: 0.85,
      uiScaleDesktop: 1.05,
    });
  });

  it('битый JSON → {}', async () => {
    await writeFile(join(tmpDir, 'defaults.json'), '{ this is not json', 'utf-8');
    expect(await store.loadDefaults()).toEqual({});
  });

  it('не-объект в JSON → {}', async () => {
    await writeFile(join(tmpDir, 'defaults.json'), '42', 'utf-8');
    expect(await store.loadDefaults()).toEqual({});
  });

  it('подчищает невалидные поля из готового файла', async () => {
    await writeFile(
      join(tmpDir, 'defaults.json'),
      JSON.stringify({
        locale: 'en',
        themeMode: 'red',
        theme: '',
        uiScaleMobile: 9,
        uiScaleDesktop: 0.6,
      }),
      'utf-8',
    );
    expect(await store.loadDefaults()).toEqual({ locale: 'en', uiScaleDesktop: 0.6 });
  });

  it('запись атомарная — после save временных файлов не остаётся', async () => {
    await store.saveDefaults({ theme: 'flexoki' });
    const files = await readdir(tmpDir);
    expect(files).toEqual(['defaults.json']);
    const raw = await readFile(join(tmpDir, 'defaults.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ theme: 'flexoki' });
  });

  it('параллельные saveDefaults не теряют поля', async () => {
    await Promise.all([
      store.saveDefaults({ locale: 'en' }),
      store.saveDefaults({ themeMode: 'dark' }),
      store.saveDefaults({ uiScaleMobile: 0.9 }),
      store.saveDefaults({ uiScaleDesktop: 1.1 }),
    ]);
    expect(await store.loadDefaults()).toEqual({
      locale: 'en',
      themeMode: 'dark',
      uiScaleMobile: 0.9,
      uiScaleDesktop: 1.1,
    });
  });
});
