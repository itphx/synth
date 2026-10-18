/**
 * PROP-102 §10: тело CLI-команды `synth analytics rebuild` — переиспользуется
 * dev-CLI (`packages/core/src/main.ts`) и тестами; домен — `analytics/rebuild.ts`.
 *
 * Паттерн ADR-091/ADR-092: без `--yes` и без `--dry-run` — отказ (ненулевой код);
 * `--dry-run` — сводка без записи. Хранилище приходит готовым `StorageContext`
 * (backend `file`/`memory`/`postgres`), прямой записи в `$SYNTH_DATA_DIR` нет
 * (инвариант 2).
 */

import { join } from 'node:path';
import type { StorageContext } from '../storage/storage-context.js';
import { rebuildAnalyticsRollups, type AnalyticsRebuildResult } from './rebuild.js';

/** Опции команды `synth analytics rebuild`. */
export interface AnalyticsRebuildCommandOptions {
  /** Каталог данных инстанса (путь журнала аудита по умолчанию). */
  dataDir: string;
  /** Готовый контекст слоя хранения (backend-aware, PROP-032). */
  storage: Pick<StorageContext, 'analyticsRollups' | 'sessions'>;
  /** Начало окна включительно (`YYYY-MM-DD`, UTC). */
  from?: string;
  /** Только расчёт и сводка, без записи. */
  dryRun?: boolean;
  /** Подтверждение перезаписи агрегатов (обязательно без `--dry-run`). */
  yes?: boolean;
  /** Сводка в JSON (включая пересчитанные бакеты). */
  json?: boolean;
  /** Путь к JSONL-журналу LLM Gateway (по умолчанию `{dataDir}/audit/llm-gateway.jsonl`). */
  auditLogPath?: string;
  /** Источник текущего времени (тесты). */
  now?: () => Date;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (message: string) => void;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (message: string) => void;
}

/**
 * Выполнить `synth analytics rebuild`: отказ без `--yes`/`--dry-run`, иначе —
 * идемпотентная пересборка роллапов и сводка.
 *
 * @returns код выхода процесса (0 — успех, 1 — отказ/ошибка).
 */
export async function runAnalyticsRebuildCommand(
  opts: AnalyticsRebuildCommandOptions,
): Promise<number> {
  const log = opts.log ?? ((message: string) => console.log(message));
  const error = opts.error ?? ((message: string) => console.error(message));
  const dryRun = opts.dryRun === true;

  if (!dryRun && opts.yes !== true) {
    error(
      'Ошибка: пересборка перезаписывает агрегаты аналитики. ' +
        'Используйте --dry-run для предпросмотра или --yes для записи.',
    );
    return 1;
  }

  try {
    const result = await rebuildAnalyticsRollups({
      repo: opts.storage.analyticsRollups,
      sessions: opts.storage.sessions,
      auditLogPath: opts.auditLogPath ?? join(opts.dataDir, 'audit', 'llm-gateway.jsonl'),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      dryRun,
      ...(opts.now ? { now: opts.now } : {}),
    });

    if (opts.json) {
      log(JSON.stringify(result, null, 2));
      return 0;
    }

    printSummary(result, log);
    return 0;
  } catch (err) {
    error(`Ошибка пересборки: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Человекочитаемая сводка (данные — из `AnalyticsRebuildResult`). */
function printSummary(result: AnalyticsRebuildResult, log: (message: string) => void): void {
  const usage = result.rows.filter((bucket) => bucket.family === 'usage').length;
  const activity = result.rows.filter((bucket) => bucket.family === 'activity').length;

  log(`${result.dryRun ? '[dry-run] ' : ''}Пересборка роллапов аналитики`);
  log(`  окно: ${result.from} … ${result.to} (сутки UTC, включительно)`);
  log(`  сессий обработано: ${result.sessions}`);
  log(`  сообщений учтено: ${result.messages}`);
  log(
    `  бакетов ${result.dryRun ? '(будет записано)' : 'записано'}: ${result.buckets} ` +
      `(usage: ${usage}, activity: ${activity})`,
  );
  log(`  суток с данными: ${result.days.length}`);
  log(`  аудит: записей ${result.auditEntries}, добавок к сообщениям: ${result.auditGaps}`);
  if (result.statsMismatched > 0) {
    log(
      `  расхождений с computeSessionStats: ${result.statsMismatched} из ${result.statsChecked} ` +
        '(суммы не правятся — истина: сообщения)',
    );
  }
  for (const warning of result.warnings) log(`  Предупреждение: ${warning}`);
  if (result.dryRun) log('  (dry-run: изменения не записаны)');
}
