/**
 * ADR-094: метрики терминального сервиса.
 *
 * ## Каталог
 *
 * - `synth_terminal_sessions{status}` — **живое** число терминалов по статусу
 *   (`starting`/`running`);
 * - `synth_terminal_bytes_total{op}` — объём обмена по направлению
 *   (`input`/`output`).
 *
 * ## Отклонение от дизайна §3 (и почему)
 *
 * Дизайн предлагал `synth_terminal_sessions{state}` и
 * `synth_terminal_bytes_total{direction}`. Лейблы `state`/`direction` **не входят**
 * в фиксированный список ADR-094 (`method`/`route`/`status`/`provider`/`model`/
 * `kind`/`outcome`/`source`/`op`/`currency`/`backend`/`store`/`action`/`effect`),
 * а контракт метрик — не список (инвариант 25): лишний лейбл ломает
 * сопоставление с дашбордами и алертами.
 *
 * Поэтому:
 *
 * - `state` → **`status`** (тот же смысл: `starting`/`running`; значения
 *   приводятся к конечному набору, неизвестное → `other`);
 * - `direction` → **`op`** (тот же смысл: `input`/`output`; `op` — разрешённый
 *   лейбл, в нём же живёт операция изменения ФС в `fs.changed`).
 *
 * ## Чего в метриках нет
 *
 * Никаких идентификаторов (терминала/проекта/сессии), путей и содержимого
 * вывода: иначе кардинальность серий взорвётся (ADR-094 п. 5). Ошибки
 * метрик не влияют на работу терминала (вызовы обёрнуты в try/catch).
 */
import type { MetricsRegistry } from '../../metrics/registry.js';

/** Статус терминала в метриках (конечный набор). */
export type TerminalMetricStatus = 'starting' | 'running';

/** Направление обмена (конечный набор). */
export type TerminalMetricOp = 'input' | 'output';

const TERMINAL_STATUSES: readonly string[] = ['starting', 'running'];
const TERMINAL_OPS: readonly string[] = ['input', 'output'];

/** Приведение значения к конечному набору: неизвестное → `other`. */
function normalize(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return 'other';
  return allowed.includes(value) ? value : 'other';
}

/** Нормализация статуса терминала для метрики. */
export function normalizeTerminalMetricStatus(value: string | undefined): string {
  return normalize(value, TERMINAL_STATUSES);
}

/** Нормализация направления обмена для метрики. */
export function normalizeTerminalMetricOp(value: string | undefined): string {
  return normalize(value, TERMINAL_OPS);
}

/** Колбэки метрик терминалов — их вызывает сервис. */
export interface TerminalMetricsHooks {
  /** Синхронизировать живое число терминалов по статусам (gauge). */
  syncSessions: (counts: { starting: number; running: number }) => void;
  /** Посчитать объём обмена (ввод/вывод), байт. */
  addBytes: (op: TerminalMetricOp, bytes: number) => void;
}

/**
 * Создать колбэки метрик терминалов (ADR-094).
 *
 * Реестр метрик — общий (`MetricsRegistry`); новых зависимостей нет.
 */
export function createTerminalMetrics(registry: MetricsRegistry): TerminalMetricsHooks {
  const sessions = registry.gauge(
    'synth_terminal_sessions',
    'Number of live terminals by status.',
    ['status'],
  );
  const bytes = registry.counter(
    'synth_terminal_bytes_total',
    'Total number of bytes exchanged with terminals by direction.',
    ['op'],
  );

  return {
    syncSessions(counts): void {
      try {
        sessions.set({ status: 'starting' }, Math.max(0, counts.starting));
        sessions.set({ status: 'running' }, Math.max(0, counts.running));
      } catch {
        // Метрики не должны ломать работу терминала.
      }
    },
    addBytes(op, value): void {
      try {
        if (!Number.isFinite(value) || value <= 0) return;
        bytes.inc({ op: normalizeTerminalMetricOp(op) }, value);
      } catch {
        // Метрики не должны ломать работу терминала.
      }
    },
  };
}
