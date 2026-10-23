/**
 * ADR-090, шаг 2: целостность бандла плагина.
 *
 * `content_hash` — **sha256 от отсортированного набора файлов** (ADR-090,
 * модель `lock.json` из PROP-068 §4.4). Состав хеша фиксирован здесь, чтобы
 * установщик (Ф2/Ф5) и загрузчик (Ф1) считали одинаково:
 *
 * ```text
 * для каждого файла (пути отсортированы по возрастанию codepoint'ов):
 *   <относительный путь> \0 <sha256 hex содержимого> \n
 * итог: sha256 hex от конкатенации
 * ```
 *
 * Хеш содержимого каждого файла считается отдельно — так перестановка
 * содержимого между файлами меняет итог, а одинаковые файлы с разными именами
 * — нет. Пустой набор файлов → sha256 от пустой строки.
 */
import { createHash } from 'node:crypto';

import type { PluginActivationDescriptor } from './activation.js';

/** Разделитель пути и хеша содержимого в канонической строке. */
const PATH_HASH_SEPARATOR = '\0';
/** Разделитель записей в канонической строке. */
const RECORD_SEPARATOR = '\n';

/**
 * Content-hash бандла плагина: sha256 от отсортированного набора файлов.
 *
 * @param files относительный путь → содержимое файла.
 */
export function computePluginContentHash(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    const fileHash = createHash('sha256').update(files[path] ?? '', 'utf8').digest('hex');
    hash.update(path, 'utf8');
    hash.update(PATH_HASH_SEPARATOR, 'utf8');
    hash.update(fileHash, 'utf8');
    hash.update(RECORD_SEPARATOR, 'utf8');
  }
  return hash.digest('hex');
}

/** Вердикт шага integrity. */
export type PluginIntegrityVerdict =
  | {
      ok: true;
      /** `verified` — хеш сверился; `skipped` — сверять нечего. */
      status: 'verified' | 'skipped';
      /** Фактически вычисленный хеш (при `verified`). */
      actual?: string;
    }
  | {
      ok: false;
      /** Код отказа (машиночитаемый). */
      code: 'plugin.integrity_mismatch' | 'plugin.integrity_unverifiable';
      /** Человекочитаемое сообщение. */
      message: string;
      /** Ожидаемый хеш (из lock/`PLUGIN_INTEGRITY.json`). */
      expected?: string;
      /** Фактически вычисленный хеш. */
      actual?: string;
    };

/**
 * Шаг 2 пайплайна активации: сверка content-hash с ожидаемым.
 *
 * Правила:
 * - ожидаемый хеш не задан → сверять нечего (`skipped`, шаг пройден);
 * - ожидаемый хеш задан, но файлов нет → **fail-closed**
 *   (`plugin.integrity_unverifiable`): подтвердить целостность нечем;
 * - хеши разошлись → `plugin.integrity_mismatch`.
 */
export function verifyPluginIntegrity(
  descriptor: PluginActivationDescriptor,
): PluginIntegrityVerdict {
  const expected = descriptor.contentHash;
  if (!expected) return { ok: true, status: 'skipped' };

  const files = descriptor.files;
  if (!files) {
    return {
      ok: false,
      code: 'plugin.integrity_unverifiable',
      message:
        'Ожидаемый content-hash задан, но файлы бандла не переданы — целостность подтвердить нечем.',
      expected,
    };
  }

  const actual = computePluginContentHash(files);
  if (actual !== expected) {
    return {
      ok: false,
      code: 'plugin.integrity_mismatch',
      message: 'content-hash бандла не совпал с ожидаемым (файлы изменены или подменены).',
      expected,
      actual,
    };
  }
  return { ok: true, status: 'verified', actual };
}
