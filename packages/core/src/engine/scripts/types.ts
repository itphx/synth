import type { ScriptDiagnostic, ScriptOrigin } from '@itphx/synth-shared';

/**
 * ADR-126 §5: внутренние типы модуля скриптов проекта (`!`-запуск).
 *
 * Контракты (для HTTP-роута, тула и UI) — в `@itphx/synth-shared`
 * (`types/scripts.ts`); здесь — вид внутренней записи реестра и ошибки
 * доменного слоя.
 */

/**
 * Декларация скрипта (ADR-126 §5) — разобранная `.md`-запись реестра.
 *
 * Скрипт — **декларация**, а не исполняемый файл: интерпретатор и аргументы —
 * данные декларации. Тело (`body`) — описание действия для человека и агента,
 * в системный промпт оно не уходит.
 */
export interface TemplateScript {
  /** Имя скрипта (`^[a-z0-9]+(-[a-z0-9]+)*$`). */
  name: string;
  /** Описание действия (1..1024 символов) — для человека и агента. */
  description: string;
  /** Advisory-подсказка по аргументам (из `argument-hint`). */
  argumentHint?: string;
  /** Команда запуска: путь к файлу (argv-форма) или строка (shell-форма). */
  run: string;
  /** `true` — `run` исполняется оболочкой; иначе — прямой запуск файла. */
  shell: boolean;
  /** Принимает ли скрипт аргументы (`args`, по умолчанию `false`). */
  args: boolean;
  /** Рабочий каталог относительно рабочего каталога сессии. */
  cwd?: string;
  /** Таймаут запуска, **секунды** (1…86 400; по умолчанию 86 400). */
  timeout?: number;
  /** Бинарные требования запуска (ADR-077). */
  requires?: string[];
  /** Дополнительное окружение запуска (безопасные имена переменных). */
  env?: Record<string, string>;
  /** Признак готовности (`ready`) — сохраняется, детект вне объёма (ADR-126 §5). */
  ready?: string;
  /** Тело декларации (описание действия). */
  body: string;
  /** Абсолютный путь файла декларации (внутри ядра; наружу — относительный). */
  file: string;
  /** Абсолютный путь каталога-источника (внутри ядра). */
  dir: string;
  /** Источник скрипта (приоритет: project > instance > config). */
  origin: ScriptOrigin;
  /** `false` — источник недоверенный: скрипт виден, но не запускается. */
  trusted: boolean;
  /** Время изменения файла декларации (мс) — для ленивой инвалидации кэша. */
  mtimeMs: number;
}

/** Результат сканирования одного каталога-источника скриптов. */
export interface ScriptScanResult {
  scripts: TemplateScript[];
  diagnostics: ScriptDiagnostic[];
}

/** Каталог-источник скриптов. */
export interface ScriptSource {
  origin: ScriptOrigin;
  dir: string;
  /** Доверен ли каталог (project-trust гейт, ADR-126 §9). По умолчанию — да. */
  trusted?: boolean;
}

/** Рантайм-конфиг модуля скриптов. */
export interface ScriptRuntimeConfig {
  /** Каталог данных инстанса (`{dataDir}/scripts` — каталог инстанса). */
  dataDir: string;
  /** `config.scripts.paths` — дополнительные каталоги-источники. */
  scriptsPaths: readonly string[];
  /** `config.skills.trustedProjectDirs` — доверенные проектные каталоги. */
  trustedProjectDirs?: readonly string[];
  /** Домашний каталог (раскрытие `~` в путях источников). */
  home?: string;
}

/** Машинные коды ошибок подсистемы скриптов. */
export const SCRIPT_ERROR_CODES = [
  'script_not_found',
  'script_untrusted',
  'script_args_not_allowed',
  'script_args_invalid',
  'script_cwd_outside',
  'script_background_disabled',
] as const;

/** Код ошибки подсистемы скриптов. */
export type ScriptErrorCode = (typeof SCRIPT_ERROR_CODES)[number];

/**
 * База ошибок подсистемы скриптов: машинный код + текст.
 *
 * Коды разбирает **вызывающий** (HTTP-роут/тул), а не сам сервис: сервис
 * не знает ни формат ответа, ни коды API.
 */
export class ScriptError extends Error {
  readonly code: ScriptErrorCode;

  constructor(code: ScriptErrorCode, message: string) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}
