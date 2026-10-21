import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CATALOG_DEFAULT_SKILL_CATEGORY,
  CATALOG_INDEX_FORMAT,
  CATALOG_SOURCES,
  CATALOG_TRUST_LEVELS,
  CATALOG_UNKNOWN_LICENSE,
  isCatalogIndexDocument,
  isCatalogSkillEntry,
  parseCatalogEntries,
  catalogEntrySchema,
  catalogIndexSchema,
} from './catalog.js';

/**
 * Фикстура — валидный канонический индекс каталога расширений (`format: 1`)
 * с записями **всех пяти классов** (`plugin`/`gateway`/`addon`/`pack`/
 * `storage`). Лежит рядом с тестом (конвенция `__fixtures__`).
 */
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'catalog-index-format1.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as unknown;

/** Базовая валидная карточка записи каталога. */
const BASE_ENTRY = {
  name: 'acme-addon',
  kind: 'addon',
  version: '1.0.0',
  description: { ru: 'Аддон', en: 'An add-on' },
  license: 'MIT',
  category: 'plugins',
  trust_level: 'community',
  identifier: 'acme/addon',
  source: 'npm',
} as const;

describe('Индекс каталога расширений — канонический документ (PROP-068 §3/§12)', () => {
  it('принимает валидный индекс (фикстура format: 1)', () => {
    const parsed = catalogIndexSchema.safeParse(FIXTURE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.format).toBe(CATALOG_INDEX_FORMAT);
    expect(parsed.data.plugins).toHaveLength(5);
    expect(parsed.data.generated_at).toBe('2026-10-21T06:00:00Z');
    expect(parsed.data.metadata.categories.skills?.title.ru).toBe('Скиллы');
    expect(parsed.data.metadata.labels?.featured?.title.en).toBe('Featured');
  });

  it('применяет дефолты к записи (screenshots/tags/versions/extra)', () => {
    const parsed = catalogEntrySchema.safeParse(BASE_ENTRY);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.screenshots).toEqual([]);
    expect(parsed.data.tags).toEqual([]);
    expect(parsed.data.versions).toEqual([]);
    expect(parsed.data.extra).toEqual({});
  });

  it('отвергает невалидную запись: пустое имя', () => {
    expect(catalogEntrySchema.safeParse({ ...BASE_ENTRY, name: '' }).success).toBe(false);
  });

  it('отвергает невалидную запись: неизвестный kind', () => {
    expect(catalogEntrySchema.safeParse({ ...BASE_ENTRY, kind: 'unknown' }).success).toBe(false);
  });

  it('отвергает невалидную запись: без license', () => {
    const { license: _license, ...withoutLicense } = BASE_ENTRY;
    expect(catalogEntrySchema.safeParse(withoutLicense).success).toBe(false);
  });

  it('требует packType для kind «pack»', () => {
    const parsed = catalogEntrySchema.safeParse({ ...BASE_ENTRY, kind: 'pack' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'packType')).toBe(true);
  });

  it('запрещает packType у другого kind', () => {
    const parsed = catalogEntrySchema.safeParse({ ...BASE_ENTRY, kind: 'addon', packType: 'skills' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'packType')).toBe(true);
  });

  it('в канонической форме локализация ru/en обязательна', () => {
    expect(
      catalogEntrySchema.safeParse({ ...BASE_ENTRY, description: { ru: 'Только RU' } }).success,
    ).toBe(false);
    expect(
      catalogEntrySchema.safeParse({ ...BASE_ENTRY, description: { en: 'Only EN' } }).success,
    ).toBe(false);
    expect(
      catalogEntrySchema.safeParse({ ...BASE_ENTRY, description: { ru: 'RU', en: 'EN' } }).success,
    ).toBe(true);
  });

  it('в канонической форме обязательны license/category/identifier/source', () => {
    for (const field of ['license', 'category', 'identifier', 'source'] as const) {
      const entry: Record<string, unknown> = { ...BASE_ENTRY };
      delete entry[field];
      expect(catalogEntrySchema.safeParse(entry).success).toBe(false);
    }
  });

  it('отвергает индекс с неизвестным форматом', () => {
    expect(catalogIndexSchema.safeParse({ ...(FIXTURE as object), format: 2 }).success).toBe(false);
  });
});

describe('parseCatalogEntries — tolerant-парсер трёх форм', () => {
  it('форма 1: канонический { format: 1, plugins: [...] }', () => {
    const entries = parseCatalogEntries(FIXTURE);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'pack',
      'plugin',
      'gateway',
      'addon',
      'storage',
    ]);
    const skill = entries[0]!;
    expect(skill.packType).toBe('skills');
    expect(skill.trust_level).toBe('verified');
    expect(skill.identifier).toBe('acme/skill-pack#skills/review');
    expect(isCatalogSkillEntry(skill)).toBe(true);
    expect(entries.slice(1).some((entry) => isCatalogSkillEntry(entry))).toBe(false);
  });

  it('форма 2: { skills: [...] } — записи скиллов', () => {
    const entries = parseCatalogEntries({
      skills: [{ name: 'alpha', path: 'nested/alpha', description: 'A' }],
    });
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe('pack');
    expect(entry.packType).toBe('skills');
    expect(entry.trust_level).toBe('community');
    expect(entry.source).toBe('registry');
    expect(entry.identifier).toBe('nested/alpha');
    expect(entry.license).toBe(CATALOG_UNKNOWN_LICENSE);
    expect(entry.category).toBe(CATALOG_DEFAULT_SKILL_CATEGORY);
    expect(entry.minSynth).toBeUndefined();
    expect(isCatalogSkillEntry(entry)).toBe(true);
  });

  it('форма 3: голый массив [{ name, path? }] — legacy-формат', () => {
    const entries = parseCatalogEntries([{ name: 'alpha' }, { name: 'beta', path: 'dir/beta' }]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.identifier).toBe('alpha');
    expect(entries[1]!.identifier).toBe('dir/beta');
    expect(entries[1]!.extra['path']).toBe('dir/beta');
    expect(entries.every((entry) => isCatalogSkillEntry(entry))).toBe(true);
  });

  it('пропускает битые записи, не бросая исключений', () => {
    const entries = parseCatalogEntries([
      { name: 'ok' },
      { name: '' },
      { path: 'only-path' },
      'строка',
      42,
      null,
      undefined,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('ok');
  });

  it('в канонической форме битые записи пропускаются, валидные — остаются', () => {
    const entries = parseCatalogEntries({
      format: 1,
      plugins: [
        BASE_ENTRY,
        { ...BASE_ENTRY, name: '' },
        { ...BASE_ENTRY, kind: 'unknown' },
        { ...BASE_ENTRY, license: undefined },
        { ...BASE_ENTRY, name: 'acme-second' },
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual(['acme-addon', 'acme-second']);
  });

  it('в канонической форме запись без локализации ru/en отбрасывается', () => {
    const entries = parseCatalogEntries({
      format: 1,
      plugins: [{ ...BASE_ENTRY, description: { ru: 'Только RU' } }],
    });
    expect(entries).toEqual([]);
  });

  it('неизвестный формат документа → пустой список', () => {
    expect(parseCatalogEntries({ format: 2, plugins: [BASE_ENTRY] })).toEqual([]);
  });

  it('неизвестный корень → пустой список, без исключения', () => {
    expect(parseCatalogEntries({ nope: [] })).toEqual([]);
    expect(parseCatalogEntries('строка')).toEqual([]);
    expect(parseCatalogEntries(null)).toEqual([]);
  });

  it('запись другого класса в форме «скиллов» не становится скиллом', () => {
    // Полноценная карточка другого класса — сохраняется как есть (не скилл).
    const canonical = parseCatalogEntries({ skills: [{ ...BASE_ENTRY, kind: 'plugin' }] });
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.kind).toBe('plugin');
    expect(isCatalogSkillEntry(canonical[0]!)).toBe(false);

    // Неполная запись с чужим классом — отбрасывается, скиллом не станет.
    const broken = parseCatalogEntries({ skills: [{ name: 'x', kind: 'plugin' }] });
    expect(broken).toEqual([]);
  });
});

describe('isCatalogIndexDocument — узнавание корня документа', () => {
  it('узнаёт канонический индекс, legacy-формы и голый массив', () => {
    expect(isCatalogIndexDocument(FIXTURE)).toBe(true);
    expect(isCatalogIndexDocument({ skills: [] })).toBe(true);
    expect(isCatalogIndexDocument([])).toBe(true);
  });

  it('не узнаёт мусор и неизвестный формат', () => {
    expect(isCatalogIndexDocument({ nope: [] })).toBe(false);
    expect(isCatalogIndexDocument('html')).toBe(false);
    expect(isCatalogIndexDocument({ format: 2, plugins: [] })).toBe(false);
  });
});

describe('Реестры каталога', () => {
  it('уровни доверия — из PROP-068 §4.1', () => {
    expect([...CATALOG_TRUST_LEVELS]).toEqual(['builtin', 'verified', 'trusted', 'community']);
  });

  it('источники — адаптеры PROP-068 §3.1', () => {
    expect([...CATALOG_SOURCES]).toEqual(['npm', 'github', 'helm', 'builtin', 'registry']);
  });
});
