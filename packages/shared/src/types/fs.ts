// --- File System ---
export enum FsErrorCode {
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  NOT_FOUND = 'NOT_FOUND',
  NOT_A_DIRECTORY = 'NOT_A_DIRECTORY',
  IS_DIRECTORY = 'IS_DIRECTORY',
  BINARY_FILE = 'BINARY_FILE',
  WORKSPACE_NOT_SET = 'WORKSPACE_NOT_SET',
  WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  DIR_NOT_EMPTY = 'DIR_NOT_EMPTY',
  /** ADR-075: путь вне `workspacesRoot` запрещён политикой (managed). */
  WORKSPACE_OUTSIDE_ROOT_DENIED = 'WORKSPACE_OUTSIDE_ROOT_DENIED',
  /**
   * Чтение файла отказано: размер больше лимита чтения либо файл бинарный
   * (HTTP 413). Машинный код ответа — `FILE_TOO_LARGE`, подробности —
   * в `details` (`maxReadBytes`/`size`/`reason`).
   */
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export interface DirectoryListResult {
  path: string;
  entries: FileEntry[];
  /**
   * Обход прерван по лимиту записей (`maxDepth > 0`): ответ — неполный.
   * `maxDepth = 0` (по умолчанию) лимит не применяется → `false`.
   */
  truncated?: boolean;
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
  encoding: 'utf-8' | 'binary';
}

export interface FileWriteBody {
  projectId: string;
  path: string;
  content: string;
}

export interface FileMkdirBody {
  projectId: string;
  path: string;
}

export interface FsError {
  error: string;
  code: FsErrorCode;
  /**
   * Подробности отказа (аддитивно): например, `maxReadBytes`/`size`/`reason`
   * для `FILE_TOO_LARGE`. Клиент читает их машинно, не разбирая текст.
   */
  details?: Record<string, unknown>;
}

/**
 * Лимит загрузки файла (`POST /api/v2/fs/upload`) по умолчанию, байт: 100 МиБ.
 * Щедро, но ограничивает DoS (тело буферизуется в память целиком). Переопределяется
 * конфигом (`storage.maxUploadBytes` / env `SYNTH_MAX_UPLOAD_BYTES`) или опцией
 * фабрики `createFsRoutes` (`FsRoutesOptions.maxUploadBytes`, для тестов).
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Нижняя граница настраиваемого лимита загрузки (байт) — нельзя «залимитировать всё». */
export const MIN_UPLOAD_BYTES = 1024;

/** Верхняя граница настраиваемого лимита загрузки (байт): 2 ГиБ (тело буферизуется в память). */
export const MAX_UPLOAD_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * Лимит чтения файла (`GET /api/v2/fs/read`) по умолчанию, байт: 5 МиБ.
 * Файл больше лимита (или бинарный) → `413` с машинным кодом `FILE_TOO_LARGE`
 * и `details.maxReadBytes`; содержимое в память не читается (размер известен
 * из `stat`). Переопределяется конфигом (`storage.maxReadBytes` / env
 * `SYNTH_MAX_READ_BYTES`) или опцией фабрики `createFsRoutes`
 * (`FsRoutesOptions.maxReadBytes`, для тестов).
 */
export const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024;

/** Нижняя граница настраиваемого лимита чтения (байт). */
export const MIN_READ_BYTES = 1024;

/** Верхняя граница настраиваемого лимита чтения (байт): 512 МиБ (файл читается в память). */
export const MAX_READ_BYTES_LIMIT = 512 * 1024 * 1024;

/**
 * Жёсткий предел глубины рекурсивного листинга (`GET /api/v2/fs?maxDepth=`):
 * значение из запроса ограничивается этим числом (было 10).
 */
export const MAX_FS_LIST_DEPTH = 3;

/**
 * Общий предел числа записей в рекурсивном листинге (`GET /api/v2/fs?maxDepth>0`):
 * при достижении обход прекращается, в ответе `truncated: true`.
 */
export const MAX_FS_LIST_ENTRIES = 10_000;
