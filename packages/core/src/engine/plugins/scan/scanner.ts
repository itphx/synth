/**
 * PROP-068 §4.3 / PROP-090 §9: статический сканер расширений.
 *
 * Сканер — **advisory**: он не исполняет код, а выносит вердикт
 * (`safe | caution | dangerous`). Вердикт = **максимум** severity по находкам
 * (границы `severity → verdict` — канон PROP-068 §4.3).
 *
 * Вход — **распакованный каталог** бандла (плагин — self-contained бандл,
 * PROP-090 §9) либо карта файлов (`descriptor.files` — тот же бандль в памяти).
 *
 * Квоты структуры (PROP-068 §4.3):
 * - `MAX_FILE_COUNT=50`, `MAX_TOTAL_SIZE_KB=1024` — превышение → минимум
 *   `caution`;
 * - `MAX_SINGLE_FILE_KB=256` — превышение лимита **одного** файла → `dangerous`;
 * - бинарный исполняемый файл → `dangerous`.
 *
 * Находки квот структуры отнесены к категории `destructive` (ресурсная
 * нагрузка/риск для инстанса) — отдельной «структурной» категории в
 * PROP-068 §4.3 нет.
 *
 * **Content-hash** считается той же функцией, что и в шаге integrity Ф1
 * (`computePluginContentHash`), — дублировать нельзя: установщик (Ф5) и
 * загрузчик должны считать одинаково. Для каталога хеш покрывает **текстовые**
 * файлы (бинарные исключены — они всё равно дают `dangerous`).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  PluginScanCategory,
  PluginScanFinding,
  PluginScanQuotas,
  PluginScanSeverity,
  PluginScanVerdict,
} from '@itphx/synth-shared';
import {
  DEFAULT_PLUGIN_SCAN_QUOTAS,
  PLUGIN_SCAN_QUOTA_SEVERITIES,
  verdictFromFindings,
} from '@itphx/synth-shared';

import type { DictionaryRepository } from '../../../storage/ports/dictionary-repository.js';
import { detectPromptInjection } from '../../security/prompt-injection.js';
import { computePluginContentHash } from '../integrity.js';
import { PluginScanCache } from './cache.js';
import { isIgnored, parseIgnorePatterns } from './ignore.js';
import { INVISIBLE_UNICODE_PATTERNS, PLUGIN_SCAN_RULES } from './rules.js';

/** Имя файла исключений обхода (PROP-068 §4.3). */
export const PLUGIN_IGNORE_FILE = '.skillignore';

/** Расширения бинарных (неисполняемых) файлов — флагуются, но не опасны. */
export const BINARY_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov',
];

/** Расширения исполняемых файлов — находка `dangerous` (PROP-068 §4.3). */
export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  '.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.msi', '.com', '.scr', '.pif',
  '.apk', '.jar', '.class', '.wasm', '.app',
];

/** Каталоги, которые не обходятся (служебные, не часть бандла). */
const SKIPPED_DIRS: readonly string[] = ['node_modules', '.git'];

/** Один файл бандла, подготовленный к сканированию. */
export interface PluginScanEntry {
  /** Относительный путь (posix-разделители). */
  path: string;
  /** Содержимое (для бинарных — пустая строка). */
  text: string;
  /** Размер в байтах. */
  sizeBytes: number;
  /** Бинарный файл? */
  binary: boolean;
}

/** Опции сканера. */
export interface PluginScanOptions {
  /** Словарь системных словарей — детектор prompt-injection (категория `injection`). */
  dictionaryStore?: DictionaryRepository;
  /** Язык словаря (по умолчанию `ru`). */
  lang?: string;
  /** Кэш сканов (повторный скан идентичного содержимого не выполняется). */
  cache?: PluginScanCache;
  /** Переопределение квот (тесты/инстанс). */
  quotas?: Partial<PluginScanQuotas>;
  /** Источник установки (часть ключа кэша). */
  source?: string;
  /** URL/идентификатор источника (часть ключа кэша). */
  sourceUrl?: string;
}

/** Отчёт скана (результат работы сканера). */
export interface PluginScanReport {
  /** Вердикт (максимум severity по находкам). */
  verdict: PluginScanVerdict;
  /** Находки (по файлам, в порядке обхода). */
  findings: PluginScanFinding[];
  /** Content-hash просканированного содержимого. */
  contentHash: string;
  /** Число просканированных файлов. */
  scannedFiles: number;
  /** Обход прерван по квоте числа файлов? */
  truncated?: boolean;
  /** Скан выполнен? `false` — сканировать было нечего. */
  performed: boolean;
  /** Отчёт взят из кэша? */
  cached?: boolean;
}

/** Квоты с учётом переопределений. */
function resolveQuotas(overrides?: Partial<PluginScanQuotas>): PluginScanQuotas {
  return { ...DEFAULT_PLUGIN_SCAN_QUOTAS, ...(overrides ?? {}) };
}

/** Номер строки (1-based) по смещению в тексте. */
function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Расширение файла (в нижнем регистре, с точкой). */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Бинарный ли файл по содержимому и расширению? */
export function isBinaryContent(buffer: Buffer, path: string): boolean {
  const ext = extensionOf(path);
  if (BINARY_EXTENSIONS.includes(ext)) return true;
  if (EXECUTABLE_EXTENSIONS.includes(ext)) return true;
  // NUL-байт в начале — признак бинарника.
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

/** Исполняемый ли файл (по расширению)? */
export function isExecutableFile(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.includes(extensionOf(path));
}

/** Находка структурного нарушения квоты. */
function quotaFinding(
  path: string,
  category: PluginScanCategory,
  severity: PluginScanSeverity,
  description: string,
): PluginScanFinding {
  return { category, severity, file: path, line: 0, description };
}

/**
 * Скан одного текстового файла: правила + невидимый unicode + словарь
 * prompt-injection.
 */
function scanTextFile(
  path: string,
  text: string,
  opts: PluginScanOptions,
): { findings: PluginScanFinding[]; hits: Set<string> } {
  const findings: PluginScanFinding[] = [];
  const hits = new Set<string>();
  const lineByRule = new Map<string, number>();

  // Проход 1 — правила с текстовым шаблоном.
  for (const rule of PLUGIN_SCAN_RULES) {
    if (!rule.pattern) continue;
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const re = new RegExp(rule.pattern.source, flags);
    const match = re.exec(text);
    if (!match) continue;
    hits.add(rule.id);
    lineByRule.set(rule.id, lineOfIndex(text, match.index));
    findings.push({
      category: rule.category,
      severity: rule.severity,
      file: path,
      line: lineOfIndex(text, match.index),
      description: rule.description,
    });
  }

  // Проход 2 — составные правила (по находкам прохода 1).
  for (const rule of PLUGIN_SCAN_RULES) {
    if (!rule.when) continue;
    if (!rule.when({ path, text, hits })) continue;
    hits.add(rule.id);
    const lines = (rule.lineFrom ?? [])
      .map((id) => lineByRule.get(id))
      .filter((value): value is number => value !== undefined);
    findings.push({
      category: rule.category,
      severity: rule.severity,
      file: path,
      line: lines.length > 0 ? Math.min(...lines) : 0,
      description: rule.description,
    });
  }

  // Невидимый unicode — отдельная категория (вердикт не ниже `caution`).
  for (const { name, pattern } of INVISIBLE_UNICODE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      category: 'invisible_unicode',
      severity: 'medium',
      file: path,
      line: lineOfIndex(text, match.index),
      description: `Невидимые символы (${name}) — возможное скрытие инструкций для модели`,
    });
  }

  // Словарный детектор prompt-injection (переиспользуем существующий механизм
  // `engine/security/prompt-injection.ts` — свой словарь не заводим).
  if (opts.dictionaryStore) {
    const detection = detectPromptInjection(text, opts.dictionaryStore, opts.lang ?? 'ru');
    if (detection.suspicious) {
      const first = detection.matches[0];
      const index = first ? text.toLowerCase().indexOf(first.toLowerCase()) : -1;
      findings.push({
        category: 'injection',
        severity: 'medium',
        file: path,
        line: index >= 0 ? lineOfIndex(text, index) : 0,
        description: `Сработал словарь prompt-injection: ${detection.matches.slice(0, 3).join(', ')}`,
      });
    }
  }

  return { findings, hits };
}

/**
 * Общий проход скана: находки по файлам + квоты структуры + вердикт.
 *
 * @param entries файлы бандла.
 * @param contentHash content-hash содержимого (считается вызывающим — той же
 *   функцией, что и в шаге integrity).
 */
function runScan(
  entries: readonly PluginScanEntry[],
  contentHash: string,
  opts: PluginScanOptions,
  truncated: boolean,
): PluginScanReport {
  const quotas = resolveQuotas(opts.quotas);
  const findings: PluginScanFinding[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    totalBytes += entry.sizeBytes;

    if (entry.sizeBytes > quotas.maxSingleFileKb * 1024) {
      findings.push(
        quotaFinding(
          entry.path,
          'destructive',
          PLUGIN_SCAN_QUOTA_SEVERITIES.singleFile,
          `Файл превышает лимит ${quotas.maxSingleFileKb} КиБ (${Math.round(entry.sizeBytes / 1024)} КиБ)`,
        ),
      );
    }

    if (entry.binary) {
      findings.push(
        isExecutableFile(entry.path)
          ? quotaFinding(
              entry.path,
              'obfuscation',
              'high',
              'Бинарный исполняемый файл в бандле — содержимое непрозрачно и может быть запущено',
            )
          : quotaFinding(
              entry.path,
              'obfuscation',
              'info',
              'Бинарный файл в бандле — содержимое не исполняется, но исключается из разбора',
            ),
      );
      continue;
    }

    findings.push(...scanTextFile(entry.path, entry.text, opts).findings);
  }

  if (entries.length > quotas.maxFileCount) {
    findings.push(
      quotaFinding(
        '',
        'destructive',
        PLUGIN_SCAN_QUOTA_SEVERITIES.fileCount,
        `Число файлов в бандле превышает лимит ${quotas.maxFileCount} (${entries.length})`,
      ),
    );
  }

  const totalKb = Math.round(totalBytes / 1024);
  if (totalKb > quotas.maxTotalSizeKb) {
    findings.push(
      quotaFinding(
        '',
        'destructive',
        PLUGIN_SCAN_QUOTA_SEVERITIES.totalSize,
        `Суммарный размер бандла превышает лимит ${quotas.maxTotalSizeKb} КиБ (${totalKb} КиБ)`,
      ),
    );
  }

  return {
    verdict: verdictFromFindings(findings),
    findings,
    contentHash,
    scannedFiles: entries.length,
    ...(truncated ? { truncated: true } : {}),
    performed: true,
  };
}

/**
 * Скан карты файлов (бандл в памяти — `descriptor.files`).
 *
 * Content-hash считается **той же** функцией, что и в шаге integrity Ф1.
 */
export function scanPluginFiles(
  files: Record<string, string>,
  opts: PluginScanOptions = {},
): PluginScanReport {
  const contentHash = computePluginContentHash(files);
  const cacheKey = PluginScanCache.key(opts.source ?? '', opts.sourceUrl ?? '', contentHash);
  const cached = opts.cache?.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const entries: PluginScanEntry[] = Object.entries(files).map(([path, text]) => ({
    path,
    text,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    binary: false,
  }));

  const report = runScan(entries, contentHash, opts, false);
  opts.cache?.set(cacheKey, report);
  return report;
}

/**
 * Скан распакованного каталога бандла.
 *
 * Обход: рекурсивный, без симлинков (PROP-068 §4.5), с исключениями
 * `.skillignore`; каталоги `node_modules`/`.git` не обходятся.
 */
export async function scanPluginDirectory(
  rootDir: string,
  opts: PluginScanOptions = {},
): Promise<PluginScanReport> {
  const quotas = resolveQuotas(opts.quotas);
  const patterns = parseIgnorePatterns(await readIgnoreFile(rootDir));

  const entries: PluginScanEntry[] = [];
  const textFiles: Record<string, string> = {};
  let truncated = false;

  const walk = async (dir: string, rel: string): Promise<void> => {
    if (truncated) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) return;
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory() && SKIPPED_DIRS.includes(item.name)) continue;
      if (isIgnored(patterns, relPath, item.isDirectory())) continue;
      // Симлинки не следуем (PROP-068 §4.5) — защита от выхода за пределы бандла.
      if (item.isSymbolicLink()) continue;
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!item.isFile()) continue;
      if (entries.length > quotas.maxFileCount) {
        truncated = true;
        return;
      }
      const buffer = await readFile(abs);
      const binary = isBinaryContent(buffer, relPath);
      const text = binary ? '' : buffer.toString('utf8');
      entries.push({ path: relPath, text, sizeBytes: buffer.byteLength, binary });
      if (!binary) textFiles[relPath] = text;
    }
  };

  await walk(rootDir, '');

  // Хеш — по текстовым файлам (бинарные исключены: они всё равно `dangerous`).
  const contentHash = computePluginContentHash(textFiles);
  const cacheKey = PluginScanCache.key(opts.source ?? '', opts.sourceUrl ?? '', contentHash);
  const cached = opts.cache?.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const report = runScan(entries, contentHash, opts, truncated);
  opts.cache?.set(cacheKey, report);
  return report;
}

/** Прочитать `.skillignore` (нет файла — пустой набор правил). */
async function readIgnoreFile(rootDir: string): Promise<string> {
  try {
    return await readFile(join(rootDir, PLUGIN_IGNORE_FILE), 'utf8');
  } catch {
    return '';
  }
}
