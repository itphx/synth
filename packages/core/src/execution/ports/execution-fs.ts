/**
 * Контракт FS-операций порта исполнения (PROP-135, Ф1).
 *
 * Файловые операции агента уезжают в **тот же** контур, что и команды
 * исполнения: при `execution.mode=remote` control plane — тонкий, а рабочий
 * каталог живёт на исполнителе (PROP-135 «Контракт порта»). Поэтому FS —
 * не «прямой вызов `node:fs` в туле», а **порт** рядом с `execute()`:
 * реализации взаимозаменяемы (inline — локальная ФС, remote — HTTP к
 * исполнителю), а домен не различает физических исполнителей.
 *
 * ## Правила контракта
 *
 * - **Пути — абсолютные.** Относительные резолвит вызывающий тул (от
 *   `workingDir`): порт не знает про рабочий каталог сессии, а путь «от
 *   сессии» и путь «от исполнителя» — разные вещи в split-топологии;
 * - **Ошибки — типизированные** (`FsPathError` с машинным кодом): вызывающий
 *   различает «нет такого пути» (`not_found`), «это не каталог»
 *   (`not_directory`), «нет доступа» (`permission`), «путь невалиден»
 *   (`invalid`) и «путь не разрешается» (`unresolvable`) — иначе все сбои
 *   выглядели бы одинаково;
 * - **`realpath` — канонический путь.** Разрешается симлинк; неразрешимый путь
 *   (битый симлинк, цикл, ошибка ФС) → `unresolvable` (fail-closed);
 * - **`readdir` — в файловом порядке.** Сортировку делает вызывающий (тул):
 *   порядок каталога — свой формат вывода, а не свойство ФС;
 * - **чтение содержимого — теми же правилами, что у локального тула.**
 *   `readText` отдаёт **готовые строки вывода** (`N: текст`, нумерация
 *   исходная 1-based) — формат вывода принадлежит домену, а не ФС;
 *   `sniff` отдаёт признак «бинарь» и MIME по сигнатуре; `readBytes` отдаёт
 *   байты (base64) с жёстким лимитом размера;
 * - **запись — теми же правилами, что у локального тула.** `writeFile`
 *   создаёт родительские каталоги, пишет атомарно (tmp → `rename`),
 *   сохраняет права существующего файла и разыменовывает симлинк (пишем в
 *   цель, а не заменяем ссылку); `mkdir` создаёт каталог с родительскими,
 *   `remove` удаляет файл или **пустой** каталог (рекурсии нет). Реализация
 *   — общая (`execution/fs-atomic.ts`): тем же кодом пишет исполнитель;
 * - **правка читает «сырой» текст.** `readRawText` отдаёт содержимое файла
 *   **как есть** (UTF-8, без нумерации строк): тулы правки (`edit_file`/
 *   `patch`) сопоставляют правку с точным текстом, а `readText` для этого не
 *   годится. `rename` переносит файл в пределах точки исполнения;
 * - **бинарная передача файла — `download`.** `readBytes` отдаёт байты в
 *   base64 (раздувание ×4/3), а вложения идут **бинарно**: `download`
 *   возвращает `Buffer` без промежуточного кодирования. Потолок размера —
 *   тот же машинный код `too_large`, файл при превышении не читается вовсе
 *   (размер известен **до** чтения);
 * - **обратное направление — `upload` и `hash`.** `upload` публикует байты в
 *   файл **на точке исполнения** (в split-топологии это исполнитель): запись
 *   атомарная (временный файл → `link`/`rename`), без перезаписи существующего
 *   файла по умолчанию (`ifExists: 'fail'` → машинный код `exists`). `hash`
 *   считает sha256 **потоком** (файл целиком в память не поднимается) — тоже
 *   на точке исполнения: там, где лежит файл.
 */

/** Вид объекта ФС. */
export type FsEntryKind = 'file' | 'directory' | 'other';

/** Сведения о файле/каталоге. */
export interface FsStat {
  /** Вид объекта. */
  kind: FsEntryKind;
  /** Размер в байтах; у каталога — `0`. */
  size: number;
  /** Время последнего изменения, мс (Unix epoch). */
  mtimeMs: number;
}

/** Запись каталога. */
export interface FsDirEntry {
  /** Имя записи (без пути). */
  name: string;
  /** Вид объекта. */
  kind: FsEntryKind;
  /** Размер в байтах; `0`, если `stat` записи не удался. */
  size: number;
}

/**
 * Машинный код ошибки FS-операции.
 *
 * - `not_found` — пути нет (`ENOENT`);
 * - `not_directory` — путь есть, но это не каталог (`ENOTDIR`);
 * - `permission` — нет доступа (`EACCES`/`EPERM`);
 * - `invalid` — путь невалиден (пустой, содержит NUL);
 * - `unresolvable` — путь не разрешается (битый симлинк, цикл, ошибка ФС);
 * - `too_large` — объект больше запрошенного лимита (чтение байтов);
 * - `exists` — цель уже существует (`upload` с `ifExists: 'fail'`): отказ
 *   именно в «занятое имя», а не в «путь не найден» — вызывающий различает
 *   их без разбора текста.
 */
export type FsErrorCode =
  | 'not_found'
  | 'not_directory'
  | 'permission'
  | 'invalid'
  | 'unresolvable'
  | 'too_large'
  | 'exists';

/**
 * errno ФС → машинный код ошибки FS-операции.
 *
 * `ENOENT` → `not_found`, `ENOTDIR` → `not_directory`, `EACCES`/`EPERM` →
 * `permission`; остальное (в т.ч. `ELOOP`) → `unresolvable` (fail-closed:
 * неизвестная причина не должна выглядеть как «путь просто не найден»).
 *
 * Единственная точка маппинга — её используют и inline-реализация порта, и
 * общий читатель файлов (`execution/fs-text.ts`), и исполнитель (там — свой
 * вариант на проводе, с теми же кодами).
 */
export function fsErrorCodeFromErrno(code: string | undefined): FsErrorCode {
  switch (code) {
    case 'ENOENT':
      return 'not_found';
    case 'ENOTDIR':
      return 'not_directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission';
    default:
      return 'unresolvable';
  }
}

/**
 * Типизированная ошибка FS-операции.
 *
 * `code` — машинный код (см. `FsErrorCode`), `path` — путь, о котором операция.
 * Текст (`message`) — для показа человеку; различение ответов тулов строится
 * на `code`, а не на тексте.
 */
export class FsPathError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;

  constructor(code: FsErrorCode, path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    // Имя класса фиксировано: по нему ошибка опознаётся **структурно**
    // (`isFsPathError`) — как `ExecutionError` (клиент удалённого порта создаёт
    // ошибку из `dist`, а код в core импортирует класс из исходников, и
    // `instanceof` не срабатывает).
    this.name = 'FsPathError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Структурная проверка `FsPathError` (устойчива к копиям класса: src/dist).
 */
export function isFsPathError(value: unknown): value is FsPathError {
  if (value instanceof FsPathError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; code?: unknown; path?: unknown; message?: unknown };
  return (
    e.name === 'FsPathError' &&
    typeof e.code === 'string' &&
    typeof e.path === 'string' &&
    typeof e.message === 'string'
  );
}

/**
 * Исполнитель **не умеет** FS-операции (нет признака `features.fs`).
 *
 * Отдельная ошибка, а не «путь не найден»: причина — в **составе пула**, а не
 * в пути. Файловые тулы в remote-режиме при этом работают **fail-closed**
 * (PROP-135): тихого возврата к чтению ФС в control plane нет — рабочий
 * каталог в split-топологии живёт на исполнителе.
 *
 * Текст — английский (как и остальные технические сообщения порта
 * исполнения): его видит оператор, а не пользователь.
 */
export class ExecutionFsUnavailableError extends Error {
  constructor(
    message = 'executor does not support filesystem operations (features.fs); upgrade the executor (protocol >= 7)',
  ) {
    super(message);
    this.name = 'ExecutionFsUnavailableError';
  }
}

/**
 * Структурная проверка `ExecutionFsUnavailableError` (устойчива к копиям
 * класса: клиент удалённого порта создаёт ошибку из `dist`, а core импортирует
 * класс из исходников — `instanceof` не срабатывает).
 */
export function isExecutionFsUnavailableError(value: unknown): value is ExecutionFsUnavailableError {
  if (value instanceof ExecutionFsUnavailableError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; message?: unknown };
  return e.name === 'ExecutionFsUnavailableError' && typeof e.message === 'string';
}

/**
 * Опции чтения текстовой страницы.
 *
 * `offset` — 0-based (нумерация в выводе остаётся **исходной** 1-based);
 * `limit`/`maxBytes` — потолки страницы; не заданы — дефолты реализации
 * (те же, что у локального тула чтения).
 */
export interface FsTextOptions {
  offset?: number;
  limit?: number;
  maxBytes?: number;
}

/**
 * Страница текстового файла.
 *
 * `lines` — **готовые строки вывода** (`N: текст`, 1-based, исходная
 * нумерация): формат вывода принадлежит домену, а не ФС;
 * `totalLines` — всего строк в файле (счётчик, без хранения строк);
 * `truncated` — вывод усечён (по числу строк или по байтам);
 * `bytes` — размер вывода в UTF-8.
 */
export interface FsTextPage {
  lines: string[];
  totalLines: number;
  truncated: boolean;
  bytes: number;
}

/** Признак «это бинарь» и MIME по сигнатуре (если сигнатура распознана). */
export interface FsSniffResult {
  binary: boolean;
  mime?: string;
}

/** Байты файла (base64) и их размер. */
export interface FsBytesResult {
  /** Содержимое в base64 (без `data:`-префикса). */
  dataBase64: string;
  /** Размер в байтах. */
  size: number;
}

/**
 * Что делать, если целевой путь **уже существует** (режим `upload`).
 *
 * - `fail` (по умолчанию) — отказ с машинным кодом `exists`: занятое имя
 *   остаётся нетронутым (файл не перезаписывается никогда);
 * - `overwrite` — атомарная замена (`rename`): права существующего файла
 *   сохраняются, симлинк разыменовывается (те же правила, что у `writeFile`).
 */
export type FsUploadMode = 'fail' | 'overwrite';

/** Опции публикации байтов в файл (`ExecutionFs.upload`). */
export interface FsUploadOptions {
  /** Что делать, если цель уже существует (по умолчанию — `fail`). */
  ifExists?: FsUploadMode;
}

/**
 * Текст файла **как есть** (UTF-8, без нумерации строк) и его размер.
 *
 * Отдельный тип от `FsTextPage`: страница — это **формат вывода** (`N: текст`),
 * а здесь содержимое файла целиком — так его видят тулы правки.
 */
export interface FsRawTextResult {
  /** Содержимое файла (UTF-8, без нумерации строк и форматирования). */
  text: string;
  /** Размер файла в байтах. */
  size: number;
}

/**
 * FS-операции в контуре исполнения (PROP-135, Ф1).
 *
 * Необязательное поле порта: реализация без него — «FS недоступна»
 * (удалённый исполнитель протокола ≤ 6), и файловые тулы в remote-режиме
 * работают fail-closed (никакого тихого возврата в control plane).
 */
export interface ExecutionFs {
  /**
   * Канонический путь (симлинки разыменовываются).
   *
   * Неразрешимый путь (битый симлинк, цикл симлинков, ошибка ФС) →
   * `FsPathError` с кодом `unresolvable`.
   */
  realpath(path: string): Promise<string>;
  /** Сведения о файле/каталоге. */
  stat(path: string): Promise<FsStat>;
  /** Записи каталога — в файловом порядке (сортировка — на стороне вызывающего). */
  readdir(path: string): Promise<FsDirEntry[]>;
  /**
   * Страница текста файла.
   *
   * Чтение потоковое (файл целиком в память не поднимается); лимиты —
   * те же, что у локального тула чтения. Ошибка чтения (пути нет, нет
   * доступа) → `FsPathError`.
   */
  readText(path: string, opts?: FsTextOptions): Promise<FsTextPage>;
  /**
   * Признак «бинарь» + MIME по сигнатуре.
   *
   * Смотрится только начало файла (`maxBytes`, по умолчанию — 8 КиБ).
   */
  sniff(path: string, maxBytes?: number): Promise<FsSniffResult>;
  /**
   * Байты файла (base64).
   *
   * Файл больше `maxBytes` → `FsPathError` с кодом `too_large` (файл не
   * читается целиком: сначала размер известен из `stat`).
   */
  readBytes(path: string, maxBytes: number): Promise<FsBytesResult>;
  /**
   * Записать текст в файл (PROP-135, Ф2).
   *
   * Правила — **общие** для обеих топологий (`execution/fs-atomic.ts`):
   * родительские каталоги создаются, запись атомарна (tmp → `rename`), права
   * существующего файла сохраняются, симлинк разыменовывается (пишем в
   * цель). Ошибка записи → `FsPathError`.
   */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Создать каталог (с родительскими каталогами) — ПРОП-135, Ф2.
   *
   * Ошибка → `FsPathError` (`permission`/`invalid`/`not_found`).
   */
  mkdir(path: string): Promise<void>;
  /**
   * Удалить файл или **пустой** каталог (PROP-135, Ф2).
   *
   * Рекурсивного удаления нет: непустой каталог → `FsPathError` с кодом
   * `invalid`; отсутствующий путь → `not_found`.
   */
  remove(path: string): Promise<void>;
  /**
   * Текст файла **как есть** (UTF-8, без нумерации строк) — PROP-135, Ф2.
   *
   * Нужен тулам правки (`edit_file`/`patch`): они сопоставляют правку с
   * **точным** текстом файла, а `readText` отдаёт готовые строки вывода
   * (`N: текст`) — для этого не годится.
   *
   * Файл больше `maxBytes` → `FsPathError` с кодом `too_large` (размер
   * известен **до** чтения — файл не читается вовсе).
   */
  readRawText(path: string, maxBytes: number): Promise<FsRawTextResult>;
  /**
   * Переименовать/переместить файл — PROP-135, Ф2.
   *
   * Обе стороны проходят резолв и containment порта (путь «от сессии» и путь
   * «от исполнителя» — разные вещи). Цель, которая **уже существует**, —
   * отказ (`invalid`): молчаливая перезапись ломала бы гарантию «файла нет»
   * у вызывающего (тул `patch` проверяет цель сам, но контракт порта не
   * должен зависеть от дисциплины вызывающего).
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * Бинарная передача файла — PROP-135, Ф3 (слайс 3c).
   *
   * Отличие от `readBytes`: байты едут **без** base64 (вложения идут
   * бинарно — base64 раздувал бы 100 МиБ до 133 МиБ).
   *
   * Файл больше `maxBytes` → `FsPathError` с кодом `too_large` (файл не
   * читается: размер известен **до** чтения). Остальные ошибки — те же
   * типизированные коды (`not_found`/`permission`/…).
   */
  download(path: string, maxBytes: number): Promise<Buffer>;
  /**
   * Опубликовать байты в файл — обратное направление (PROP-135, Ф3).
   *
   * Правила — **общие** для обеих топологий (`execution/fs-atomic.ts`): тем
   * же кодом пишет исполнитель, поэтому опубликованный файл не зависит от
   * топологии (атомарность, права, симлинки).
   *
   * - **родительские каталоги создаются**;
   * - запись **атомарна**: временный файл `.synth-tmp-<uuid>` в том же
   *   каталоге → публикация (`link` при `ifExists: 'fail'`, `rename` при
   *   `'overwrite'`); временный файл не остаётся никогда;
   * - **`ifExists: 'fail'`** (по умолчанию) — занятая цель **не перезаписывается**:
   *   отказ с машинным кодом `exists`;
   * - **`ifExists: 'overwrite'`** — атомарная замена, права существующего
   *   файла сохраняются (как у `writeFile`).
   *
   * Ошибка записи → `FsPathError` (`exists`/`permission`/`invalid`/…).
   */
  upload(path: string, bytes: Buffer, opts?: FsUploadOptions): Promise<void>;
  /**
   * SHA-256 файла (hex) — **на точке исполнения** (PROP-135, Ф3).
   *
   * Хэш считается **потоком**: файл целиком в память не поднимается (файлы
   * бывают крупными). Ошибки чтения → `FsPathError` (`not_found`/
   * `permission`/…).
   */
  hash(path: string): Promise<string>;
}
