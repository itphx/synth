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
