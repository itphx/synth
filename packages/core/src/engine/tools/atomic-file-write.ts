/**
 * Атомарная запись файла: временный файл в том же каталоге → `rename`.
 *
 * Прямая запись (`writeFile`) обрезает файл до записи содержимого: сбой
 * (падение процесса, ошибка диска) оставляет файл пустым или частично
 * записанным. `rename` в пределах одного каталога атомарен, поэтому читатель
 * видит либо старую версию, либо новую — целиком.
 *
 * Приём тот же, что в `patch` (ADR-101).
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
 * Записать файл атомарно.
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
    // Фолбэк на прямую запись в целевой файл (прежнее поведение `writeFile`).
    //
    // Почему: атомарная схема держится на создании tmp В ТОМ ЖЕ каталоге, что и
    // цель. Если каталог не даёт создавать файлы ( права 0555, read-only том),
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
