/**
 * ADR-126 §5: скрипты проекта (`!`-запуск) — контракты.
 *
 * Скрипт — это **декларация** (markdown + frontmatter), а не сам исполняемый
 * файл: интерпретатор и аргументы — данные декларации. Реестр скриптов живёт
 * в `.synth/scripts/<name>.md` (проект) > `{dataDir}/scripts` (инстанс) >
 * `config.scripts.paths`; приоритет, trust-гейт и диагностика — те же, что у
 * команд и скиллов (ADR-126 §9).
 *
 * Здесь только типы (без бизнес-логики движка); разбор декларации и запуск —
 * в core (`engine/scripts/*`).
 */

/** Источник скрипта (приоритет — как у команд/скиллов). */
export const SCRIPT_ORIGINS = ['project', 'instance', 'config'] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** Уровень диагностики discovery/валидации скриптов. */
export type ScriptDiagnosticLevel = 'error' | 'warning' | 'info';

/**
 * Коды диагностики скриптов.
 *
 * - `invalid-frontmatter` — нет frontmatter, невалидный YAML, неверные
 *   значения необязательных полей;
 * - `missing-name` — имя скрипта не задано или не соответствует
 *   `^[a-z0-9]+(-[a-z0-9]+)*$`;
 * - `invalid-run` — неверные параметры исполнения (`run`/`cwd`/`env`/
 *   `timeout`/`requires`);
 * - `shadowed` — одноимённый скрипт перекрыт источником с большим приоритетом;
 * - `read-error` — файл скрипта не прочитан;
 * - `untrusted` — проектный каталог недоверенный: скрипт виден, но не
 *   запускается (ADR-126 §9);
 * - `undeclared-executable` — исполняемый файл проекта без декларации
 *   (подсказка «объявите скрипт», исполняемой записи не создаёт).
 */
export type ScriptIssueCode =
  | 'invalid-frontmatter'
  | 'missing-name'
  | 'shadowed'
  | 'read-error'
  | 'untrusted'
  | 'invalid-run'
  | 'undeclared-executable';

/** Диагностика реестра скриптов (видна в списке скриптов и в диагностике). */
export interface ScriptDiagnostic {
  level: ScriptDiagnosticLevel;
  code: ScriptIssueCode;
  message: string;
  /** Имя скрипта (если известно). */
  script?: string;
  /** Путь к файлу (если применимо). */
  path?: string;
}

/** Сводка скрипта (для списка и автокомплита `!`). */
export interface ScriptSummary {
  name: string;
  description: string;
  origin: ScriptOrigin;
  /** Подсказка по аргументам (advisory, из `argument-hint`). */
  argumentHint?: string;
  /** `false` — скрипт виден, но недоступен к запуску. */
  available: boolean;
  /** Причина недоступности: `trusted` — недоверенный каталог, `denied` — правило прав. */
  unavailableReason?: 'trusted' | 'denied';
  /** Доверен ли источник скрипта (project-trust гейт, ADR-126 §9). */
  trusted: boolean;
}

/**
 * Детали скрипта (декларация целиком).
 *
 * `file` — путь **относительно** источника (workspace проекта / каталога
 * инстанса / каталога конфигурации): абсолютные пути наружу не отдаются.
 */
export interface ScriptDetail extends ScriptSummary {
  /** Команда запуска (argv-форма — путь к файлу; shell-форма — строка). */
  run: string;
  /** `true` — `run` исполняется оболочкой, иначе — как argv. */
  shell: boolean;
  /** Рабочий каталог относительно рабочего каталога сессии. */
  cwd?: string;
  /** Принимает ли скрипт аргументы (`args` в декларации). */
  args: boolean;
  /** Таймаут запуска, **секунды** (1…86 400; по умолчанию 86 400). */
  timeout?: number;
  /** Бинарные требования запуска. */
  requires?: string[];
  /** Файл декларации (относительный путь). */
  file: string;
  /** Тело декларации — описание действия для человека и агента. */
  body: string;
}

/**
 * Ответ запуска скрипта — по смыслу совпадает с ответом фонового процесса.
 *
 * Скрипт всегда стартует фоновым процессом (ADR-113): отдельного режима
 * «с ожиданием завершения» нет — декларация такого поля не предусматривает.
 */
export interface ScriptRunResponse {
  /** id записи реестра фоновых прогонов (`bgr_<uuid>`). */
  run_id: string;
  /** Идентификатор процесса у порта исполнения (`proc_<uuid>`). */
  process_id: string;
  /** Путь лога процесса в blob-хранилище (`processes/<runId>.log`). */
  log_path: string;
  /** Статус запуска — всегда `running` (запуск неблокирующий). */
  status: 'running';
}
