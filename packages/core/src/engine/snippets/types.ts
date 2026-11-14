/**
 * PROP-126 §4: сниппеты (`#`) — именованные текстовые фрагменты, которые
 * раскрываются в сообщении **до отправки** (не команда, не промпт, не скилл).
 *
 * Модель:
 *
 * - сниппет — markdown-файл с YAML-frontmatter (`description`, `aliases`);
 * - имя — `[a-z][a-z0-9_-]{0,79}` (frontmatter `name` либо имя файла);
 * - три уровня: `instance` / `project` / `user`, приоритет `user > project > instance`;
 * - каноническое имя важнее алиаса; коллизии — диагностика `shadowed`;
 * - рекурсии нет (решение владельца): `#` внутри тела сниппета остаётся текстом;
 * - лимиты раскрытия: не более 15 раскрытий и 64 КБ на сообщение;
 * - проектные сниппеты недоверенные, пока не доверен проект (как скиллы/команды).
 *
 * Контракт — только типы модуля; разбор текста и I/O живут в `discovery.ts`,
 * слияние источников — в `registry.ts`, раскрытие — в `expand.ts`,
 * фасад (список/чтение/запись/раскрытие) — в `service.ts`.
 */

/** Уровень сниппета (PROP-126 §4 «Три уровня»). */
export type SnippetScope = 'instance' | 'project' | 'user';

/** Все уровни сниппетов (для валидации входа). */
export const SNIPPET_SCOPES = ['instance', 'project', 'user'] as const;

/**
 * Имя сниппета: `[a-z][a-z0-9_-]{0,79}` (PROP-126 §4 «Формат»; имя начинается с буквы, чтобы `#123` оставался текстом).
 * Имя каноническое; алиасы живут в `Snippet.aliases` и не могут его перекрыть.
 */
export const SNIPPET_NAME_REGEX = /^[a-z][a-z0-9_-]{0,79}$/;

/** Предел числа раскрытий сниппетов на одно сообщение (PROP-126 §4). */
export const MAX_SNIPPET_EXPANSIONS = 15;

/** Предел размера сообщения после раскрытия сниппетов — 64 КБ (PROP-126 §4). */
export const MAX_SNIPPET_BYTES = 64 * 1024;

/** Сниппет одного уровня. */
export interface Snippet {
  /** Каноническое имя (`[a-z][a-z0-9_-]{0,79}`). */
  name: string;
  /** Описание из frontmatter (необязательно). */
  description?: string;
  /** Алиасы из frontmatter (необязательные; не перекрывают канонические имена). */
  aliases: string[];
  /** Тело сниппета (markdown без frontmatter). */
  body: string;
  /** Уровень (instance/project/user). */
  scope: SnippetScope;
  /** Файл-источник (absolute path). */
  file: string;
  /**
   * `false` — сниппет виден в списке, но не раскрывается (недоверенный проект,
   * ADR-046 §4.4 / PROP-126 §4 «Безопасность»).
   */
  trusted: boolean;
}

/** Уровень диагностики discovery/валидации сниппетов. */
export type SnippetDiagnosticLevel = 'error' | 'warning' | 'info';

/**
 * Коды диагностики сниппетов:
 *
 * - `shadowed` — коллизия имён/алиасов (проигравший не исчезает молча);
 * - `untrusted` — недоверенный проектный каталог (виден, но не раскрывается);
 * - `read-error` — файл не прочитан;
 * - `invalid-frontmatter` — битый frontmatter/недопустимое имя/алиас;
 * - `limit-exceeded` — исчерпан лимит раскрытий или размера сообщения.
 */
export type SnippetDiagnosticCode =
  | 'shadowed'
  | 'untrusted'
  | 'read-error'
  | 'invalid-frontmatter'
  | 'limit-exceeded';

/** Диагностика реестра сниппетов (видна в настройках/диагностике). */
export interface SnippetDiagnostic {
  level: SnippetDiagnosticLevel;
  code: SnippetDiagnosticCode;
  message: string;
  /** Имя сниппета (если известно). */
  snippet?: string;
  /** Путь к файлу (если применимо). */
  path?: string;
}

/** Каталог-источник сниппетов. */
export interface SnippetSource {
  /** Уровень источника. */
  scope: SnippetScope;
  /** Каталог с `*.md`-файлами сниппетов. */
  dir: string;
  /** Доверен ли каталог (project-trust гейт). */
  trusted: boolean;
}

/** Результат сканирования одного каталога-источника. */
export interface SnippetScanResult {
  snippets: Snippet[];
  diagnostics: SnippetDiagnostic[];
}
