/**
 * FS-операции исполнителя (протокол 7, PROP-135 Ф1).
 *
 * Исполнитель — единственное место, где в split-топологии лежит рабочий
 * каталог проекта; значит, канонические пути, сведения о файлах **и содержимое**
 * получаются **у него** (PROP-135 «Контракт порта»).
 *
 * ## Границы
 *
 * - **`cwd` — тот же containment, что у команд** (`resolveContainedCwd`):
 *   базовый каталог обязан лежать внутри workspace исполнителя. Относительный
 *   `path` резолвится от него;
 * - **абсолютный `path` разрешён** — тот же уровень доверия, что у
 *   shell-команд: исполнитель исполняет произвольные команды в своём
 *   окружении, а внешние пути уже отфильтрованы permission-слоем в control
 *   plane (`external_directory` → ask/deny);
 * - **ошибки — типизированные причины на проводе** (`not_found`,
 *   `not_directory`, `permission`, `unresolvable`, `too_large`): вызывающий
 *   различает их без разбора текста;
 * - **чтение содержимого — общим кодом core** (`execution/fs-text.ts`): тем же
 *   модулем читает control plane, поэтому формат вывода (нумерация строк
 *   `N: текст`, капы, детект бинаря, MIME по сигнатуре) **не зависит** от
 *   топологии. Исполнитель зовёт core точечным runtime-импортом — так же,
 *   как `createSshEnv` в `secrets.ts`;
 * - **запись/создание каталога/удаление — общим кодом core**
 *   (`execution/fs-atomic.ts`): правила записи (атомарность, права
 *   существующего файла, разыменование симлинка) одни и те же в обеих
 *   топологиях.
 */

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type {
  ExecutorErrorReason,
  FsBytesBody,
  FsBytesRequestBody,
  FsDirEntryBody,
  FsEntryKindBody,
  FsMkdirRequestBody,
  FsRawTextBody,
  FsRawTextRequestBody,
  FsRemoveRequestBody,
  FsRenameRequestBody,
  FsRequestBody,
  FsSniffBody,
  FsSniffRequestBody,
  FsStatBody,
  FsTextPageBody,
  FsTextRequestBody,
  FsWriteRequestBody,
} from './protocol.js';
import { resolveContainedCwd } from './workspace.js';

/** Типизированная ошибка FS-операции (причина едет на проводе). */
export class ExecutorFsError extends Error {
  readonly reason: ExecutorErrorReason;
  readonly code: string;

  constructor(reason: ExecutorErrorReason, message: string, code: string) {
    super(message);
    this.name = 'ExecutorFsError';
    this.reason = reason;
    this.code = code;
  }
}

/** errno ошибки ФС (пусто — не FS-ошибка). */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Вид объекта по `stat`.
 *
 * `other` — всё, что не файл и не каталог (сокет, устройство, FIFO): такие
 * объекты в листинг показываем, но их размер meaningless.
 */
function entryKind(isDirectory: boolean, isFile: boolean): FsEntryKindBody {
  if (isDirectory) return 'directory';
  if (isFile) return 'file';
  return 'other';
}

/**
 * Битый симлинк (существует как ссылка, цель — нет).
 *
 * Различение нужно для `realpath`: «пути нет» (`not_found`) и «путь есть,
 * но разрешить его нельзя» (`unresolvable`) — разные причины, и вторая
 * означает потенциальный обход периметра (fail-closed).
 */
async function isDanglingSymlink(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isSymbolicLink();
  } catch {
    // Компонент не существует вовсе — это «пути нет», а не «битый симлинк».
    return false;
  }
}

/**
 * Машинный код ошибки core (`FsPathError`) → причина на проводе.
 *
 * Коды ядра и причины провода совпадают по смыслу (`not_found`/
 * `not_directory`/`permission`/`unresolvable`/`too_large`); `invalid`
 * отображается в `invalid_request` (невалидный запрос, а не сбой ФС).
 */
function fsPathErrorReason(code: string): ExecutorErrorReason | undefined {
  switch (code) {
    case 'not_found':
      return 'not_found';
    case 'not_directory':
      return 'not_directory';
    case 'permission':
      return 'permission';
    case 'unresolvable':
      return 'unresolvable';
    case 'too_large':
      return 'too_large';
    case 'invalid':
      return 'invalid_request';
    default:
      return undefined;
  }
}

/**
 * Сервис FS-операций исполнителя.
 *
 * Экземпляр **без состояния**: workspace-корень — единственный вход.
 */
export class ExecutorFsService {
  private readonly _workspaceRoot: string;

  constructor(opts: { workspaceRoot: string }) {
    this._workspaceRoot = opts.workspaceRoot;
  }

  /** Сведения о файле/каталоге (`POST /fs/stat`). */
  async stat(req: FsRequestBody): Promise<FsStatBody> {
    const target = this._resolve(req);
    try {
      const info = await stat(target);
      const kind = entryKind(info.isDirectory(), info.isFile());
      return {
        kind,
        size: kind === 'directory' ? 0 : info.size,
        mtimeMs: info.mtimeMs,
      };
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /** Канонический путь (`POST /fs/realpath`). */
  async realpath(req: FsRequestBody): Promise<string> {
    const target = this._resolve(req);
    try {
      return await realpath(target);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EACCES' || code === 'EPERM') {
        throw new ExecutorFsError('permission', 'нет доступа к пути', 'EACCES');
      }
      if (code === 'ENOENT') {
        // Ссылка есть, цели нет — путь не разрешается (fail-closed);
        // пути нет вовсе — обычный `not_found`.
        const dangling = await isDanglingSymlink(target);
        throw new ExecutorFsError(
          dangling ? 'unresolvable' : 'not_found',
          dangling ? 'путь не разрешается (битый симлинк)' : 'путь не найден',
          dangling ? 'ELOOP' : 'ENOENT',
        );
      }
      throw new ExecutorFsError('unresolvable', 'путь не разрешается', code ?? 'EUNRESOLVED');
    }
  }

  /** Записи каталога (`POST /fs/list`) — в файловом порядке. */
  async list(req: FsRequestBody): Promise<FsDirEntryBody[]> {
    const target = this._resolve(req);
    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (err) {
      throw this._toError(err, target);
    }
    const entries: FsDirEntryBody[] = [];
    for (const dirent of dirents) {
      const kind = entryKind(dirent.isDirectory(), dirent.isFile());
      let size = 0;
      try {
        size = (await stat(join(target, dirent.name))).size;
      } catch {
        // `stat` записи не удался (битый симлинк, нет доступа) — размер
        // неизвестен: отдаём `0`, листинг не падает.
        size = 0;
      }
      entries.push({ name: dirent.name, kind, size });
    }
    return entries;
  }

  /**
   * Страница текста файла (`POST /fs/read-text`).
   *
   * Чтение — **общим модулем core** (`execution/fs-text.ts`): тем же кодом
   * читает control plane, поэтому нумерация строк, капы и маркер усечения
   * строки совпадают в обеих топологиях.
   */
  async readText(req: FsTextRequestBody): Promise<FsTextPageBody> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      return await core.readTextPageFromFile(target, {
        offset: req.offset ?? 0,
        limit: req.limit ?? core.MAX_READ_LINES,
        maxBytes: req.maxBytes ?? core.MAX_READ_BYTES,
      });
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Признак «бинарь» + MIME по сигнатуре (`POST /fs/sniff`).
   *
   * Смотрится только начало файла — как и в control plane (тот же модуль
   * core, тот же детектор).
   */
  async sniff(req: FsSniffRequestBody): Promise<FsSniffBody> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      return await core.sniffFileHeadFromFile(target, req.maxBytes ?? core.BINARY_SNIFF_BYTES);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Байты файла, base64 (`POST /fs/read-bytes`).
   *
   * Файл больше `maxBytes` → `too_large` (400): размер известен **до**
   * чтения, поэтому лишнее не читается и не едет по проводу.
   */
  async readBytes(req: FsBytesRequestBody): Promise<FsBytesBody> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      return await core.readBytesFromFile(target, req.maxBytes);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Запись файла (`POST /fs/write-file`, протокол 7, PROP-135 Ф2).
   *
   * Правила записи — **общим кодом core** (`execution/fs-atomic.ts`): тем же
   * кодом пишет control plane, поэтому записанный файл не зависит от
   * топологии (права существующего файла, атомарность, симлинки).
   */
  async writeFile(req: FsWriteRequestBody): Promise<void> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      await core.writeTextFileAtomic(target, req.content);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Создание каталога (`POST /fs/mkdir`, протокол 7, PROP-135 Ф2).
   *
   * Общий код core (`execution/fs-atomic.ts`) — те же правила, что у control plane.
   */
  async mkdir(req: FsMkdirRequestBody): Promise<void> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      await core.mkdirRecursive(target);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Удаление файла или пустого каталога (`POST /fs/remove`, протокол 7,
   * PROP-135 Ф2).
   *
   * Рекурсивного удаления нет: непустой каталог → `invalid` (400).
   */
  async remove(req: FsRemoveRequestBody): Promise<void> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      await core.removePath(target);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Текст файла как есть (`POST /fs/read-raw`, протокол 7, PROP-135 Ф2).
   *
   * Чтение — **общим кодом core** (`execution/fs-text.ts`): тем же кодом
   * читает control plane, поэтому содержимое не зависит от топологии.
   * Файл больше `maxBytes` → `too_large` (размер известен **до** чтения).
   */
  async readRawText(req: FsRawTextRequestBody): Promise<FsRawTextBody> {
    const target = this._resolve(req);
    try {
      const core = await import('@itphx/synth-core');
      return await core.readRawTextFromFile(target, req.maxBytes);
    } catch (err) {
      throw this._toError(err, target);
    }
  }

  /**
   * Переименование/перемещение файла (`POST /fs/rename`, протокол 7,
   * PROP-135 Ф2).
   *
   * Обе стороны (источник и цель) резолвятся от того же `cwd` и проходят
   * тот же containment, что и прочие FS-операции. Правила переноса — **общим
   * кодом core** (`execution/fs-atomic.ts`): цель, которая уже существует, —
   * отказ (`invalid`), источника нет → `not_found`.
   */
  async rename(req: FsRenameRequestBody): Promise<void> {
    const from = this._resolve(req);
    const to = this._resolvePath(req, req.to);
    try {
      const core = await import('@itphx/synth-core');
      await core.renamePath(from, to);
    } catch (err) {
      throw this._toError(err, from);
    }
  }

  /**
   * Путь операции: базовый каталог (`cwd`) проходит containment, относительный
   * `path` резолвится от него, абсолютный — используется как есть.
   */
  private _resolve(req: FsRequestBody): string {
    return this._resolvePath(req, req.path);
  }

  /**
   * Путь относительно `cwd` запроса (абсолютный — как есть).
   *
   * `cwd` проходит containment — тот же, что у `cwd` команды
   * (`resolveContainedCwd`).
   */
  private _resolvePath(req: FsRequestBody, path: string): string {
    const cwd = resolveContainedCwd(this._workspaceRoot, req.cwd);
    if (!cwd.ok) {
      throw new ExecutorFsError('cwd_outside_workspace', cwd.message, 'EWORKSPACE');
    }
    return isAbsolute(path) ? normalize(path) : resolve(cwd.path, path);
  }

  /** Ошибка ФС → типизированная причина на проводе. */
  private _toError(err: unknown, target: string): ExecutorFsError {
    // Типизированная ошибка core (`FsPathError`) — её код переносим как есть:
    // «файл больше лимита» и «пути нет» — разные причины.
    const core = err as { name?: unknown; code?: unknown; message?: unknown };
    if (core?.name === 'FsPathError' && typeof core.code === 'string') {
      const reason = fsPathErrorReason(core.code);
      if (reason) {
        return new ExecutorFsError(
          reason,
          typeof core.message === 'string' ? core.message : `путь: ${target}`,
          core.code,
        );
      }
    }
    const code = errnoCode(err);
    switch (code) {
      case 'ENOENT':
        return new ExecutorFsError('not_found', `путь не найден: ${target}`, 'ENOENT');
      case 'ENOTDIR':
        return new ExecutorFsError('not_directory', `путь не каталог: ${target}`, 'ENOTDIR');
      case 'EACCES':
      case 'EPERM':
        return new ExecutorFsError('permission', `нет доступа к пути: ${target}`, 'EACCES');
      default:
        return new ExecutorFsError('unresolvable', `путь не разрешается: ${target}`, code ?? 'EUNRESOLVED');
    }
  }
}
