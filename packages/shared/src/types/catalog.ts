/**
 * PROP-068 §3/§12: контракт индекса каталога расширений (`format: 1`).
 *
 * Индекс — **versioned JSON-документ**, который собирает CI каталога и который
 * читают и портал-витрина, и инстанс Synth (загрузчик внешнего каталога
 * скиллов, `core/src/engine/skills/remote.ts`). Формат индекса — из референса
 * dshmarket (`format: 1`), поля карточки — из PROP-068 §12 (все классы
 * расширений: `plugin`/`gateway`/`addon`/`pack`/`storage`).
 *
 * Источник истины по техническим полям расширения — манифест `synth.pack`
 * (`types/pack.ts`): здесь переиспользуются `packNameSchema`,
 * `packVersionSchema`, `packKindSchema`, `packTypeSchema` и общий инвариант
 * `packType` (`refinePackType`): обязателен для `kind: 'pack'`, запрещён у
 * остальных.
 *
 * Локализация: RU — канонический язык, EN — зеркало; обе строки обязательны
 * в канонической форме (`description`, `title`, категории/метки).
 *
 * Модуль browser-safe (`zod` + локальные типы), в UI-бандл `node:*` не попадает.
 */
import { z } from 'zod';

import {
  PACK_KINDS,
  packHostSchema,
  packKindSchema,
  packNameSchema,
  packTypeSchema,
  packVersionSchema,
  refinePackType,
} from './pack.js';

/** Версия формата индекса каталога расширений. */
export const CATALOG_INDEX_FORMAT = 1;

/**
 * Локализованный текст карточки: RU — канонический, EN — зеркало.
 * Обе строки обязательны (в канонической форме).
 */
export const catalogLocalizedTextSchema = z.object({
  ru: z.string().min(1),
  en: z.string().min(1),
});
export type CatalogLocalizedText = z.infer<typeof catalogLocalizedTextSchema>;

/**
 * Уровни доверия записи (PROP-068 §4.1). Для каталога расширений
 * `agent-created` не используется — записи каталога публикуются из репозиториев.
 */
export const CATALOG_TRUST_LEVELS = ['builtin', 'verified', 'trusted', 'community'] as const;
export type CatalogTrustLevel = (typeof CATALOG_TRUST_LEVELS)[number];
export const catalogTrustLevelSchema = z.enum(CATALOG_TRUST_LEVELS);

/** Источник/адаптер происхождения записи (PROP-068 §3.1). */
export const CATALOG_SOURCES = ['npm', 'github', 'helm', 'builtin', 'registry'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];
export const catalogSourceSchema = z.enum(CATALOG_SOURCES);

/** Метка времени в формате ISO-8601 (UTC или со смещением). */
const CATALOG_ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export const catalogTimestampSchema = z
  .string()
  .min(1)
  .refine(
    (value) => CATALOG_ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value)),
    { message: 'метка времени: ISO-8601 (например, 2026-09-17T06:00:00Z)' },
  );

/**
 * Версия записи каталога в истории релизов: версия, момент публикации
 * (unix-время, мс), источник и требования к окружению (`engines`).
 */
export const catalogVersionSchema = z.object({
  /** Semver версии. */
  version: packVersionSchema,
  /** Момент публикации (unix-время, мс). */
  publishTimestamp: z.number().int().optional(),
  /** Источник публикации. */
  source: catalogSourceSchema,
  /** Требования к окружению (напр. `{ node: '>=20' }`). */
  engines: z.record(z.string(), z.string()).optional(),
});
export type CatalogVersion = z.infer<typeof catalogVersionSchema>;

/**
 * Карточка записи каталога расширений (PROP-068 §12).
 *
 * Инварианты, зашитые в схему:
 * - `kind: 'pack'` **требует** `packType`; у остальных `kind` `packType`
 *   запрещён (тот же инвариант, что в манифесте `synth.pack`);
 * - `license` обязателен (SPDX-идентификатор) — для сторонних записей;
 * - `description` локализован (RU + EN).
 */
export const catalogEntrySchema = z
  .object({
    /** Имя расширения (slug или npm-имя со scope) — как в манифесте. */
    name: packNameSchema,
    /** Класс расширения (`plugin`/`gateway`/`addon`/`pack`/`storage`). */
    kind: packKindSchema,
    /** Тип контент-пака — только для `kind: 'pack'`. */
    packType: packTypeSchema.optional(),
    /** Semver версия записи. */
    version: packVersionSchema,
    /** Краткое описание (поиск, витрина): RU + EN. */
    description: catalogLocalizedTextSchema,
    /** Репозиторий расширения. */
    repository: z.object({ url: z.string().url() }).optional(),
    /** Сайт/домашняя страница проекта. */
    homepage: z.string().url().optional(),
    /** SPDX-идентификатор лицензии — обязателен. */
    license: z.string().min(1),
    /** Иконка витрины (ключ/эмодзи/URL — по решению портала). */
    icon: z.string().optional(),
    /** Скриншоты витрины (URL; загрузка — под SSRF-политикой PROP-068 §4.5). */
    screenshots: z.array(z.string().url()).default([]),
    /** Теги для поиска и фильтров. */
    tags: z.array(z.string()).default([]),
    /** Категория витрины (ключ из `metadata.categories`). */
    category: z.string().min(1),
    /** Уровень доверия записи. */
    trust_level: catalogTrustLevelSchema,
    /** Устойчивый id записи (`owner/repo#path`, `url/<sha>`). */
    identifier: z.string().min(1),
    /** Минимальная версия Synth (semver-range) — как `host` в манифесте. */
    minSynth: packHostSchema.optional(),
    /** Источник/адаптер происхождения записи. */
    source: catalogSourceSchema,
    /** История версий записи. */
    versions: z.array(catalogVersionSchema).default([]),
    /** Источник-специфичные поля (рейтинги, даты, автор). */
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine(refinePackType);
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Категория витрины: локализованный заголовок и порядок вывода. */
export const catalogCategorySchema = z.object({
  title: catalogLocalizedTextSchema,
  order: z.number().int().optional(),
});
export type CatalogCategory = z.infer<typeof catalogCategorySchema>;

/** Метка каталога (`metadata.labels`) — локализованный заголовок. */
export const catalogLabelSchema = z.object({
  title: catalogLocalizedTextSchema,
});
export type CatalogLabel = z.infer<typeof catalogLabelSchema>;

/**
 * Канонический документ индекса каталога расширений (`format: 1`).
 *
 * - `title`/`description` — локализованные (RU канонический, EN зеркало);
 * - `generated_at` — момент сборки индекса (ISO-8601), база freshness-watchdog;
 * - `metadata.categories` — категории витрины, `metadata.labels` — метки;
 * - `plugins` — записи каталога (все классы расширений).
 */
export const catalogIndexSchema = z.object({
  /** Версия формата индекса. */
  format: z.literal(CATALOG_INDEX_FORMAT),
  /** Заголовок индекса (RU + EN). */
  title: catalogLocalizedTextSchema,
  /** Описание индекса (RU + EN). */
  description: catalogLocalizedTextSchema,
  /** Момент сборки индекса (ISO-8601). */
  generated_at: catalogTimestampSchema,
  /** Метаданные витрины. */
  metadata: z.object({
    /** Категории: ключ → заголовок (+ порядок). */
    categories: z.record(z.string(), catalogCategorySchema),
    /** Метки: ключ → заголовок. */
    labels: z.record(z.string(), catalogLabelSchema).optional(),
  }),
  /** Записи каталога расширений. */
  plugins: z.array(catalogEntrySchema),
});
export type CatalogIndex = z.infer<typeof catalogIndexSchema>;

/** Плейсхолдер лицензии для записей, у которых источник её не указал. */
export const CATALOG_UNKNOWN_LICENSE = 'UNKNOWN';
/** Категория по умолчанию для записей-скиллов без категории. */
export const CATALOG_DEFAULT_SKILL_CATEGORY = 'skills';
/** Версия по умолчанию для записей, у которых источник её не указал. */
export const CATALOG_UNKNOWN_VERSION = '0.0.0';

/** Запись каталога — скилл? (`kind: 'pack'` + `packType: 'skills'`). */
export function isCatalogSkillEntry(entry: CatalogEntry): boolean {
  return entry.kind === 'pack' && entry.packType === 'skills';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Локализованный текст из произвольного значения: строка → обе локали,
 * `{ ru, en }` — как есть (недостающая локаль — зеркалится).
 */
function localizedText(value: unknown): CatalogLocalizedText | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { ru: trimmed, en: trimmed } : undefined;
  }
  if (isRecord(value)) {
    const ru = trimmedString(value.ru);
    const en = trimmedString(value.en);
    if (ru && en) return { ru, en };
    if (ru) return { ru, en: ru };
    if (en) return { ru: en, en };
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function urlArray(value: unknown): string[] {
  return stringArray(value).filter((item) => z.string().url().safeParse(item).success);
}

/**
 * Запись «в форме скилла» (legacy-формы §3 `{ skills: [...] }` и голый массив
 * `[{ name, path? }]`) → запись каталога.
 *
 * Маппинг (PROP-068 §12): `kind: 'pack'`, `packType: 'skills'`,
 * `trust_level: 'community'`, `source: 'registry'`, `identifier` = `path`
 * (или `name`). `license`/`category`/`minSynth` у этих форм необязательны —
 * подставляются плейсхолдеры, парсер не падает на их отсутствии.
 */
function skillLikeEntry(raw: unknown): CatalogEntry | null {
  if (!isRecord(raw)) return null;

  // Запись может быть полноценной карточкой каталога — строгий контракт важнее.
  const strict = catalogEntrySchema.safeParse(raw);
  if (strict.success) return strict.data;

  const name = trimmedString(raw.name);
  if (!name) return null;

  // Явно указанный класс, отличный от контент-пака, — не скилл.
  const kind = trimmedString(raw.kind);
  if (kind !== undefined && !(PACK_KINDS as readonly string[]).includes(kind)) return null;
  const packType = trimmedString(raw.packType);
  if (packType !== undefined && packType !== 'skills') return null;
  if (kind !== undefined && kind !== 'pack') return null;

  const path = trimmedString(raw.path);
  const identifier = trimmedString(raw.identifier) ?? path ?? name;
  const description = localizedText(raw.description) ?? { ru: name, en: name };
  const license = trimmedString(raw.license) ?? CATALOG_UNKNOWN_LICENSE;
  const category = trimmedString(raw.category) ?? CATALOG_DEFAULT_SKILL_CATEGORY;

  const version = packVersionSchema.safeParse(raw.version);
  const minSynth = trimmedString(raw.minSynth);
  const minSynthRange = minSynth ? packHostSchema.safeParse(minSynth) : undefined;

  const extra: Record<string, unknown> = isRecord(raw.extra) ? { ...raw.extra } : {};
  // Путь внутри каталога — для загрузчика скиллов (`<base>/<path>/SKILL.md`).
  if (path) extra.path = path;

  const repositoryUrl = isRecord(raw.repository)
    ? trimmedString(raw.repository.url)
    : trimmedString(raw.repository);
  const homepage = trimmedString(raw.homepage);
  const icon = trimmedString(raw.icon);

  const versions = z.array(catalogVersionSchema).safeParse(raw.versions);

  return {
    name,
    kind: 'pack',
    packType: 'skills',
    version: version.success ? version.data : CATALOG_UNKNOWN_VERSION,
    description,
    ...(repositoryUrl && z.string().url().safeParse(repositoryUrl).success
      ? { repository: { url: repositoryUrl } }
      : {}),
    ...(homepage && z.string().url().safeParse(homepage).success ? { homepage } : {}),
    license,
    ...(icon ? { icon } : {}),
    screenshots: urlArray(raw.screenshots),
    tags: stringArray(raw.tags),
    category,
    trust_level: 'community',
    identifier,
    ...(minSynthRange && minSynthRange.success ? { minSynth: minSynthRange.data } : {}),
    source: 'registry',
    versions: versions.success ? versions.data : [],
    extra,
  };
}

/** Записи канонической формы (`plugins`) — строгий контракт, битые пропускаются. */
function canonicalEntries(raw: unknown[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    const parsed = catalogEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** Записи форм «скиллов» (`{ skills: [...] }` и голый массив) — толерантно. */
function skillLikeEntries(raw: unknown[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    const entry = skillLikeEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Похож ли корень на документ каталога? (`format: 1`, legacy `{ skills: [...] }`
 * или голый массив записей).
 *
 * Нужен потребителю, чтобы отличить «пустой каталог» от «по ссылке лежит не
 * каталог» (HTML/мусор) — без дублирования знания о формате.
 */
export function isCatalogIndexDocument(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  if (!isRecord(raw)) return false;
  if (raw.format !== undefined && raw.format !== CATALOG_INDEX_FORMAT) return false;
  return Array.isArray(raw.plugins) || Array.isArray(raw.skills);
}

/**
 * Tolerant-парсер индекса каталога: три формы → `CatalogEntry[]`.
 *
 * 1. Каноническая: `{ format: 1, plugins: [...] }` — записи валидируются
 *    строгим контрактом `catalogEntrySchema`, невалидные пропускаются молча;
 * 2. `{ skills: [...] }` — записи скиллов;
 * 3. Голый массив `[{ name, path? }]` — legacy-формат внешнего каталога скиллов
 *    (ADR-046 §4.3).
 *
 * Формы 2 и 3 — это **скиллы**: `kind: 'pack'`, `packType: 'skills'`,
 * `trust_level: 'community'`, `source: 'registry'`, `identifier` = `path`
 * (или `name`).
 *
 * Парсер **не бросает исключений** и не сигналит: битые записи пропускаются,
 * неизвестный формат документа → пустой список.
 */
export function parseCatalogEntries(raw: unknown): CatalogEntry[] {
  if (Array.isArray(raw)) return skillLikeEntries(raw);
  if (!isRecord(raw)) return [];
  // Неизвестный формат — структуру не угадываем (fail-closed к будущим версиям).
  if (raw.format !== undefined && raw.format !== CATALOG_INDEX_FORMAT) return [];
  if (Array.isArray(raw.plugins)) return canonicalEntries(raw.plugins);
  if (Array.isArray(raw.skills)) return skillLikeEntries(raw.skills);
  return [];
}
