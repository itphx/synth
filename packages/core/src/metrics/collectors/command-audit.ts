/**
 * ADR-094 / PROP-136: метрики журнала исполнений команд (слайс 136a).
 *
 * Каталог:
 * - `synth_command_audit_written_total{phase,tool}` — записи журнала успешно добавлены;
 * - `synth_command_audit_failed_total{phase,tool}` — запись не удалась (при
 *   включённом журнале `started` это ещё и блокировка исполнения);
 * - `synth_command_audit_dropped_total` — записи, удалённые `prune` (retention).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`; лейблы — `phase`/`tool` (id сессий/пользователей
 *   и тексты команд в лейблы не попадают);
 * - значения лейблов приводятся к **конечным** наборам (`normalize*` ниже):
 *   неизвестное значение → `other` — иначе кардинальность не ограничена;
 * - ошибка метрик не влияет на исполнение команды (вызовы обёрнуты в try/catch).
 *
 * Модуль **browser-safe**: только реестр метрик, ни `node:*`.
 */
import type { MetricsRegistry } from '../registry.js';

/** Фаза записи в метрике (конечный набор). */
export type CommandAuditMetricPhase = 'started' | 'finished';

/** Тул в метрике (конечный набор). */
export type CommandAuditMetricTool = 'execute_shell' | 'sandbox_exec';

/** Счётчики журнала (sink для `CommandAuditLog`). */
export interface CommandAuditMetrics {
  onWritten(phase: string, tool: string): void;
  onFailed(phase: string, tool: string): void;
  onDropped(count: number): void;
}

export function normalizeCommandAuditPhase(value: string): CommandAuditMetricPhase | 'other' {
  return value === 'started' || value === 'finished' ? value : 'other';
}

export function normalizeCommandAuditTool(value: string): CommandAuditMetricTool | 'other' {
  return value === 'execute_shell' || value === 'sandbox_exec' ? value : 'other';
}

/** Создать sink метрик журнала исполнений (один на реестр). */
export function createCommandAuditMetrics(registry: MetricsRegistry): CommandAuditMetrics {
  const written = registry.counter(
    'synth_command_audit_written_total',
    'Command audit entries written.',
    ['phase', 'tool'],
  );
  const failed = registry.counter(
    'synth_command_audit_failed_total',
    'Command audit writes that failed.',
    ['phase', 'tool'],
  );
  const dropped = registry.counter(
    'synth_command_audit_dropped_total',
    'Command audit entries removed by retention (prune).',
  );

  return {
    onWritten(phase, tool) {
      try {
        written.inc({ phase: normalizeCommandAuditPhase(phase), tool: normalizeCommandAuditTool(tool) }, 1);
      } catch {
        // Метрики не ломают журнал.
      }
    },
    onFailed(phase, tool) {
      try {
        failed.inc({ phase: normalizeCommandAuditPhase(phase), tool: normalizeCommandAuditTool(tool) }, 1);
      } catch {
        // Метрики не ломают журнал.
      }
    },
    onDropped(count) {
      if (!Number.isFinite(count) || count <= 0) return;
      try {
        dropped.inc(Math.floor(count));
      } catch {
        // Метрики не ломают журнал.
      }
    },
  };
}
