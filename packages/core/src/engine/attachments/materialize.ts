/**
 * ADR-115: материализация отброшенного вложения в рабочий каталог проекта.
 *
 * Вложение не уходит провайдеру (модель не принимает модальность / превышен
 * лимит объёма / объект недоступен), но пользователь его **приложил** — молча
 * терять файл нельзя. Поэтому копия кладётся в `<workspace>/attachments/<name>`,
 * а модели в блоке `[ATTACHMENTS NOT DELIVERED]` сообщается путь: она может
 * прочитать файл инструментами (`read_file`, `glob`, shell), обработать иначе
 * или честно сказать пользователю, что формат не поддержан.
 *
 * Правила:
 *  - каталог `attachments` создаётся при необходимости;
 *  - имя санитайзится (последний сегмент пути, без `..`, управляющих символов и
 *    кавычек), пустое — `attachment-<sha8>` от содержимого;
 *  - публикация атомарная: байты пишутся во временный файл того же каталога и
 *    публикуются ссылкой (`link` → fallback `copyFile` с `COPYFILE_EXCL`),
 *    поэтому существующий файл **никогда** не перезаписывается;
 *  - дедуп: если файл с тем же именем уже есть и содержимое совпадает —
 *    возвращается существующий путь (копий не появляется); иначе суффикс
 *    `-2`, `-3`, …;
 *  - ошибки (нет каталога, нет прав, объект не прочитан) → `null`: ход из-за
 *    материализации падать не должен.
 *
 * Возвращается путь **относительно workspace** (`attachments/<name>`, прямые
 * слэши) — ровно то, что модель передаст в `read_file`.
 */

import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sanitizeFileName } from './service.js';

/** Каталог материализованных вложений внутри workspace. */
export const ATTACHMENTS_DIR = 'attachments';

/** Предел длины имени файла (с запасом под суффикс коллизии и ФС). */
const MAX_NAME_LENGTH = 120;

/** Сколько суффиксов перебираем до отказа (`-2`…`-51`). */
const MAX_COLLISION_ATTEMPTS = 50;

/** Вход материализации: порт чтения blob-объекта + рабочее место. */
export interface MaterializeAttachmentInput {
  /** Чтение байтов объекта вложения (порт `HydrateDeps.read`). */
  read: (blobPath: string) => Promise<Buffer | null>;
  /** Путь объекта в blob-хранилище (`part.data.blobPath`). */
  blobPath: string;
  /** Исходное имя файла (из метаданных части сообщения). */
  name?: string;
  mime: string;
  /** Рабочий каталог сессии/проекта; пустой — материализация не выполняется. */
  workingDir: string;
}

/** sha256 буфера. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Имя файла для сохранения: последний сегмент пути (basename), без `..`,
 * управляющих символов и кавычек. Пустой результат → `fallback`.
 *
 * Обратные слэши считаем разделителями пути (Windows-имена), кавычки вырезаем
 * сами — `sanitizeFileName` их не трогает; остальное (basename, управляющие
 * символы, отказ от `.`/`..`) делает общий санитайзер сервиса вложений.
 */
export function sanitizeAttachmentName(name: string | undefined, fallback: string): string {
  // Обратные слэши — как разделители пути (Windows-имена), затем общий санитайзер.
  const normalized = (name ?? '').replace(/\\/g, '/').replace(/"/g, '');
  const sanitized = sanitizeFileName(normalized);
  if (!sanitized) return fallback;
  const limited = sanitized.slice(0, MAX_NAME_LENGTH).trim();
  return limited.length > 0 ? limited : fallback;
}

/** Имя с суффиксом коллизии: `file.pdf` → `file-2.pdf`, `file` → `file-2`. */
function withSuffix(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${attempt}`;
  return `${name.slice(0, dot)}-${attempt}${name.slice(dot)}`;
}

/**
 * Сравнение с уже существующим файлом: `absent` — файла нет (можно писать),
 * `same` — содержимое совпало (дедуп), `different` — имя занято.
 */
async function compareExisting(
  path: string,
  bytes: Buffer,
  contentSha: string,
): Promise<'absent' | 'same' | 'different'> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return 'different';
    if (info.size !== bytes.length) return 'different';
    const existing = await readFile(path);
    if (existing.length !== bytes.length) return 'different';
    return sha256(existing) === contentSha ? 'same' : 'different';
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';
    // Нечитаемый/недоступный путь считаем занятым — перезапись недопустима.
    return 'different';
  }
}

/**
 * Публикация временного файла под именем `target` **без перезаписи**.
 * `false` — имя занято (гонка), вызывающий берёт следующий суффикс.
 */
async function publishNoOverwrite(tmpPath: string, target: string): Promise<boolean> {
  try {
    // `link` атомарен и падает на существующем имени — перезаписи нет.
    await link(tmpPath, target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') return false;
    // ФС без hardlink (или другой раздел) — эксклюзивное копирование.
    try {
      await copyFile(tmpPath, target, fsConstants.COPYFILE_EXCL);
      return true;
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw copyErr;
    }
  }
}

/**
 * Сохранить вложение в `<workspace>/attachments/<name>`; вернуть относительный
 * путь или `null` (нет workspace/не прочиталось/запись не удалась).
 */
export async function materializeAttachment(
  input: MaterializeAttachmentInput,
): Promise<string | null> {
  const workingDir = input.workingDir?.trim();
  if (!workingDir) return null;

  let tmpPath: string | null = null;
  try {
    // Workspace должен существовать: материализация не создаёт каталог проекта
    // (это делает provisioning, ADR-075) и не пишет в несуществующее место.
    const dirInfo = await stat(workingDir);
    if (!dirInfo.isDirectory()) return null;

    const bytes = await input.read(input.blobPath);
    // Порт вернул `null` — объекта нет; пустой объект материализуем как есть
    // (модель хотя бы увидит, что файл пустой).
    if (!bytes) return null;

    const contentSha = sha256(bytes);
    const fallback = `attachment-${contentSha.slice(0, 8)}`;
    const baseName = sanitizeAttachmentName(input.name, fallback);

    const dir = join(workingDir, ATTACHMENTS_DIR);
    await mkdir(dir, { recursive: true });

    // Временный файл — в том же каталоге: публикация не пересекает ФС.
    tmpPath = join(dir, `.${baseName}.tmp-${randomUUID()}`);
    await writeFile(tmpPath, bytes, { flag: 'wx' });

    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
      const candidate = withSuffix(baseName, attempt);
      const target = join(dir, candidate);

      const verdict = await compareExisting(target, bytes, contentSha);
      if (verdict === 'same') {
        // Дедуп: та же копия уже лежит — второй не создаём.
        return `${ATTACHMENTS_DIR}/${candidate}`;
      }
      if (verdict === 'different') continue;

      if (await publishNoOverwrite(tmpPath, target)) {
        return `${ATTACHMENTS_DIR}/${candidate}`;
      }
      // Имя заняли между проверкой и публикацией — пробуем следующий суффикс.
    }
    return null;
  } catch {
    // Материализация — вспомогательная операция: ход не роняем.
    return null;
  } finally {
    if (tmpPath) await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}
