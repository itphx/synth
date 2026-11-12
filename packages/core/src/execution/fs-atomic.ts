/**
 * Запись файла, создание каталога и удаление — общая реализация для порта
 * исполнения (PROP-135, Ф2).
 *
 * ## Зачем отдельный модуль
 *
 * Файловые операции агента уезжают в **тот же** контур, что и команды
 * (PROP-135 «Контракт порта»): реализации взаимозаменяемы (inline — локальная
 * ФС, remote — HTTP к исполнителю). Правила записи должны быть **одними и
 * теми же** в обеих топологиях — иначе файл, записанный локально и по
 * проводу, отличался бы по правам, атомарности и обращению с симлинками.
 *
 * Поэтому реализация вынесена сюда, а исполнитель зовёт **этот же** код
 * (точечный runtime-импорт `@itphx/synth-core` — как `createSshEnv` в
 * `packages/executor/src/secrets.ts`).
 *
 * ## Правила записи
 *
 * - **Атомарно**: временный файл `<name>.synth-tmp-<uuid>` в том же
 *   каталоге → `chmod` → `rename` (в пределах каталога `rename` атомарен:
 *   читатель видит либо старую версию, либо новую — целиком);
 * - **родительские каталоги создаются** (`mkdir -p`);
 * - **права существующего файла сохраняются** (`mode & 0o777`);
 * - **симлинк разыменовывается**: пишем в цель, а не заменяем ссылку
 *   (иначе `.env -> ../secrets/.env` превратился бы в обычный файл, а связь
 *   с секретом потерялась бы); битый симлинк — пишем по самому пути (цели
 *   нет, терять нечего);
 * - **крайний случай — отказ по правам**: если временный файл создать нельзя
 *   (read-only каталог или том), а целевой файл доступен на запись, делается
 *   прямая запись (атомарность в этом крае **не** гарантируется — осознанный
 *   компромисс, см. `writeFileAtomic`);
 * - **ошибки — типизированные** (`FsPathError` с машинным кодом): вызывающий
 *   различает «нет такого пути» (`not_found`), «нет доступа» (`permission`),
 *   «путь невалиден» (`invalid`) и «не разрешается» (`unresolvable`) — иначе
 *   все сбои выглядели бы одинаково.
 *
 * ## Публикация байтов (`uploadBytes`)
 *
 * Обратное направление (PROP-135, Ф3): байты кладутся в файл **на точке
 * исполнения**. Правила те же, что у записи текста:
 *
 * - **атомарно**: временный файл `.synth-tmp-<uuid>` в том же каталоге →
 *   публикация; временный файл не остаётся никогда (уборка в `finally`);
 * - **родительские каталоги создаются**;
 * - **`ifExists: 'fail'`** (по умолчанию) — цель **не перезаписывается**:
 *   публикация через `link` (жёсткая ссылка атомарна и не перезаписывает), а на
 *   ФС без жёстких ссылок — `copyFile` с `COPYFILE_EXCL`; занятая цель →
 *   отказ с машинным кодом `exists`;
 * - **`ifExists: 'overwrite'`** — атомарная замена (`rename`), права
 *   существующего файла сохраняются, симлинк разыменовывается (те же правила,
 *   что у `writeTextFileAtomic`).
 */

import { randomUUID } from 'node:crypto';
import {
  chmod,
  constants as fsConstants,
  copyFile,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { FsPathError, fsErrorCodeFromErrno, type FsErrorCode } from './ports/execution-fs.js';
import type { FsUploadMode, FsUploadOptions } from './ports/execution-fs.js';

/**
 * Ошибки, при которых атомарная схема невозможна, а прямая запись в целевой
 * файл ещё может сработать: каталог без прав на создание файлов (read-only
 * каталог, read-only том) — tmp создать нельзя, а сам файл доступен на запись.
 */
const FALLBACK_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function isFallbackEligible(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && FALLBACK_ERROR_CODES.has(code);
}

/** errno ошибки ФС (пусто — не FS-ошибка). */
function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Путь операции: непустой и без NUL — иначе `invalid`.
 *
 * Та же проверка, что у порта (`requireValidFsPath` в inline-реализации):
 * пустой путь — это корень процесса, а не «каталог по умолчанию».
 */
function requirePath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new FsPathError('invalid', path, 'путь не задан');
  }
  if (path.includes('\0')) {
    throw new FsPathError('invalid', path, 'путь содержит недопустимые символы');
  }
  return path;
}

/**
 * errno → машинный код ошибки FS-операции.
 *
 * База — общий маппинг (`fsErrorCodeFromErrno`); `overrides` уточняют код для
 * конкретной операции (например, `EISDIR` при удалении — это «нельзя», а не
 * «путь не найден»).
 */
function errorCode(errno: string | undefined, overrides: Record<string, FsErrorCode>): FsErrorCode {
  const override = errno ? overrides[errno] : undefined;
  return override ?? fsErrorCodeFromErrno(errno);
}

/** Ошибка ФС → `FsPathError` (с сохранением текста системы). */
function toFsPathError(
  err: unknown,
  path: string,
  overrides: Record<string, FsErrorCode> = {},
): FsPathError {
  if (err instanceof FsPathError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FsPathError(errorCode(errnoCode(err), overrides), path, message);
}

/**
 * Цель записи: симлинк разыменовывается, чтобы запись шла в файл-цель, а не
 * заменяла сам симлинк (иначе `.env -> ../secrets/.env` превратился бы в
 * обычный файл, а связь с секретом потерялась бы).
 *
 * Битый симлинк (`realpath` не резолвится) — пишем по самому пути: цели нет,
 * терять нечего.
 */
async function resolveWriteTarget(targetPath: string): Promise<string> {
  const link = await lstat(targetPath).catch(() => null);
  if (!link?.isSymbolicLink()) return targetPath;
  return (await realpath(targetPath).catch(() => null)) ?? targetPath;
}

/**
 * Записать файл атомарно (низкоуровневая часть, **сырые** ошибки ФС).
 *
 * Используется там, где вызывающий сам решает судьбу ошибки (тул `patch` —
 * он откатывает правки и показывает свой текст отказа).
 *
 * @param targetPath — путь целевого файла;
 * @param content — новое содержимое;
 * @param mode — права существующего файла (сохраняются); `undefined` — права
 *   по умолчанию (umask), как у нового файла.
 */
export async function writeFileAtomic(
  targetPath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const target = await resolveWriteTarget(targetPath);
  const tmp = join(dirname(target), `${basename(target)}.synth-tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, content, 'utf-8');
    // Права выставляем явно: `mode` при создании файла маскируется umask,
    // а переименование должно сохранить права существующего файла.
    if (mode !== undefined) {
      await chmod(tmp, mode);
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    // Фоллбэк на прямую запись в целевой файл (прежнее поведение `writeFile`).
    //
    // Почему: атомарная схема держится на создании tmp В ТОМ ЖЕ каталоге, что и
    // цель. Если каталог не даёт создавать файлы (права 0555, read-only том),
    // tmp не создаётся — и запись падает, хотя сам целевой файл доступен на
    // запись. Прежнее поведение (прямая запись) в таком окружении работало,
    // поэтому возвращаем его для кодов «нет прав»/«нет владения».
    //
    // Чем платим: атомарность в этом краевом случае НЕ гарантируется — сбой
    // посреди прямой записи оставит файл усечённым (как и до появления
    // атомарной схемы). Это осознанный компромисс: лучше частичная запись
    // известного файла, чем полный отказ писать в него.
    if (isFallbackEligible(err)) {
      // `mode` у Node применяется только при СОЗДАНИИ файла; существующий файл
      // сохраняет свои права (в атомарном пути ту же роль играет chmod по tmp).
      await writeFile(target, content, { encoding: 'utf-8', mode });
      return;
    }
    throw err;
  }
}

/**
 * Записать текст в файл — **правила порта** (PROP-135, Ф2).
 *
 * Порядок: разыменование симлинка → `mkdir -p` родительского каталога →
 * права существующего файла (`mode & 0o777`) → атомарная запись
 * (tmp → `chmod` → `rename`).
 *
 * Ошибки — типизированные (`FsPathError`): `not_found` / `permission` /
 * `invalid` / `unresolvable`.
 */
export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const target = await resolveWriteTarget(requirePath(path));
  try {
    await mkdir(dirname(target), { recursive: true });
    const existing = await stat(target).catch(() => null);
    const mode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    await writeFileAtomic(target, content, mode);
  } catch (err) {
    throw toFsPathError(err, path);
  }
}

/**
 * Создать каталог (с родительскими каталогами) — **правила порта** (Ф2).
 *
 * Ошибки — типизированные (`FsPathError`): `permission` (нет прав) /
 * `invalid` (путь существует и это не каталог) / `not_found` / `unresolvable`.
 */
export async function mkdirRecursive(path: string): Promise<void> {
  const target = requirePath(path);
  try {
    await mkdir(target, { recursive: true });
  } catch (err) {
    throw toFsPathError(err, path, { EEXIST: 'invalid' });
  }
}

/**
 * Удалить файл или **пустой** каталог — **правила порта** (Ф2).
 *
 * Рекурсивного удаления нет: каталог с содержимым — отказ (`invalid`), а не
 * тихая очистка. Пустой каталог удаляется (`rmdir` — тоже не рекурсивно).
 * Ошибки — типизированные (`FsPathError`): `not_found` (пути нет) /
 * `permission` (нет прав) / `invalid` (каталог непустой).
 */
export async function removePath(path: string): Promise<void> {
  const target = requirePath(path);
  try {
    await rm(target, { force: false });
    return;
  } catch (err) {
    const errno = errnoCode(err);
    if (errno === 'ENOENT') {
      throw new FsPathError('not_found', path, `путь не найден: ${path}`);
    }
    if (isDirectoryErrno(errno)) {
      // Каталог: `rm` без `recursive` отказывает (EISDIR). Пустой — удаляем
      // через `rmdir` (тоже не рекурсивно), непустой — отказ.
      await removeDirectory(target, path);
      return;
    }
    throw toFsPathError(err, path, { EISDIR: 'invalid', ENOTEMPTY: 'invalid' });
  }
}

/**
 * «Это каталог» — errno Node для отказа `rm` на каталоге.
 *
 * Внутренняя ошибка Node оборачивает `EISDIR` в `ERR_FS_EISDIR`, поэтому
 * проверяются оба кода.
 */
function isDirectoryErrno(errno: string | undefined): boolean {
  return errno === 'EISDIR' || errno === 'ERR_FS_EISDIR';
}

/** Удаление каталога: пустой — да, непустой — отказ (`invalid`). */
async function removeDirectory(target: string, path: string): Promise<void> {
  try {
    await rmdir(target);
  } catch (err) {
    const errno = errnoCode(err);
    if (errno === 'ENOENT') {
      throw new FsPathError('not_found', path, `путь не найден: ${path}`);
    }
    if (errno === 'ENOTEMPTY' || errno === 'EEXIST') {
      throw new FsPathError(
        'invalid',
        path,
        `непустой каталог удалить нельзя: ${path} (рекурсивное удаление не поддерживается)`,
      );
    }
    throw toFsPathError(err, path, { ENOTEMPTY: 'invalid', EEXIST: 'invalid' });
  }
}

/**
 * Переименовать/переместить файл — **правила порта** (PROP-135, Ф2).
 *
 * Обе стороны — абсолютные пути (резолвит вызывающий: тул — от
 * `workingDir`, исполнитель — от `cwd` своего workspace).
 *
 * Правила:
 *
 * - **цель, которая уже существует, — отказ** (`invalid`): на POSIX
 *   `rename` молча перезаписал бы файл, а вызывающий (тул `patch`) проверяет
 *   цель заранее — контракт порта не должен зависеть от дисциплины вызова;
 * - источника нет → `not_found`; нет прав → `permission`;
 * - перенос **атомарен** (тот же `rename` ОС) и сохраняет права файла.
 */
export async function renamePath(from: string, to: string): Promise<void> {
  const source = requirePath(from);
  const target = requirePath(to);
  try {
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      throw new FsPathError('invalid', target, `цель уже существует: ${target}`);
    }
    await rename(source, target);
  } catch (err) {
    if (err instanceof FsPathError) throw err;
    throw toFsPathError(err, source, { EEXIST: 'invalid', ENOTEMPTY: 'invalid', EISDIR: 'invalid' });
  }
}

/**
 * Опубликовать байты в файл без перезаписи существующего — внутренний шаг
 * `uploadBytes` (`ifExists: 'fail'`).
 *
 * `link` атомарен и **не перезаписывает**: занятая цель → `EEXIST` (отказ
 * `exists`). На ФС без жёстких ссылок `link` падает с `EPERM`/`ENOSYS` —
 * тогда публикация идёт через `copyFile` с `COPYFILE_EXCL` (та же гарантия:
 * занятая цель не перезаписывается).
 */
async function publishWithoutOverwrite(tmp: string, target: string, path: string): Promise<void> {
  try {
    await link(tmp, target);
    return;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') {
      throw new FsPathError('exists', path, `путь уже существует: ${target}`);
    }
    // Жёсткие ссылки недоступны — фоллбэк на копирование с `EXCL`.
  }
  try {
    await copyFile(tmp, target, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') {
      throw new FsPathError('exists', path, `путь уже существует: ${target}`);
    }
    throw err;
  }
}

/**
 * Опубликовать байты в файл — **правила порта** (PROP-135, Ф3).
 *
 * Обратное направление: байты кладутся в файл **на точке исполнения** (в
 * split-топологии — на исполнителе, где лежит рабочий каталог проекта).
 * Тем же кодом пишет исполнитель, поэтому опубликованный файл не зависит от
 * топологии.
 *
 * Порядок: `mkdir -p` родительского каталога → запись во временный файл
 * `.synth-tmp-<uuid>` **того же** каталога → публикация:
 *
 * - `ifExists: 'fail'` (по умолчанию) — `link` (фоллбэк — `copyFile` с
 *   `COPYFILE_EXCL`): занятая цель **не перезаписывается**, отказ — машинный
 *   код `exists`;
 * - `ifExists: 'overwrite'` — `rename` (атомарно), права существующего файла
 *   сохраняются, симлинк разыменовывается (как у `writeTextFileAtomic`).
 *
 * Временный файл убирается в `finally` — и при успехе, и при отказе.
 *
 * Ошибки — типизированные (`FsPathError`): `exists`/`permission`/`invalid`/
 * `not_found`/`unresolvable`.
 */
export async function uploadBytes(
  path: string,
  bytes: Buffer,
  opts?: FsUploadOptions,
): Promise<void> {
  const target = requirePath(path);
  const mode: FsUploadMode = opts?.ifExists ?? 'fail';
  const dir = dirname(target);
  const tmp = join(dir, `.synth-tmp-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, bytes);
    if (mode === 'overwrite') {
      // Цель — как у `writeTextFileAtomic`: симлинк разыменовывается, права
      // существующего файла сохраняются.
      const dest = await resolveWriteTarget(target);
      const existing = await stat(dest).catch(() => null);
      const fileMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
      if (fileMode !== undefined) {
        await chmod(tmp, fileMode);
      }
      await rename(tmp, dest);
      return;
    }
    await publishWithoutOverwrite(tmp, target, path);
  } catch (err) {
    if (err instanceof FsPathError) throw err;
    throw toFsPathError(err, path, { EEXIST: 'exists' });
  } finally {
    // Временный файл не остаётся ни при успехе, ни при отказе.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
