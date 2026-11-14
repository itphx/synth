/**
 * Сборка терминального сервиса для инстанса (PROP-132, Ф3б).
 *
 * Сервис терминалов — **одна точка**: реестр живых терминалов, поток вывода,
 * ввод, лимиты, аудит и метрики. Собирается один раз на инстанс и живёт
 * вместе с процессом (реестр — в памяти: терминал не переживает рестарт —
 * это свойство, а не дефект, дизайн §1).
 *
 * ## Что откуда берётся
 *
 * | Зависимость        | Источник                                    |
 * |--------------------|---------------------------------------------|
 * | `port`             | порт исполнения (ADR-077) — PTY открывается на точке исполнения |
 * | `eventBus`         | шина сессий — метаданные терминала           |
 * | `commandAuditLog`  | журнал исполнений команд (ADR-136) — только метаданные |
 * | `metrics`          | реестр метрик инстанса (ADR-094)             |
 * | `sessions`         | проверка «идёт ли ход в сессии» — правило idle |
 *
 * Прямое чтение `$SYNTH_DATA_DIR` в обход портов запрещено (инвариант 2) —
 * здесь только уже собранные зависимости процесса.
 */
import type { ExecutionPort } from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { CommandAuditLog } from '../../engine/security/command-audit.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { Session } from '@itphx/synth-shared';
import { createCommandAuditTerminalSink } from '../../engine/terminal/audit.js';
import { createTerminalMetrics } from '../../engine/terminal/metrics.js';
import { TerminalService } from '../../engine/terminal/service.js';

/** Зависимости сборки терминального сервиса. */
export interface TerminalServiceWiring {
  /** Порт исполнения (PTY открывается через него). */
  port: ExecutionPort;
  /** Шина событий (метаданные терминала публикуются в канал сессии). */
  eventBus?: EventBus;
  /** Журнал исполнений команд (аудит терминалов — только метаданные). */
  commandAuditLog?: CommandAuditLog;
  /** Реестр метрик инстанса (ADR-094). */
  metrics?: MetricsRegistry;
  /** Загрузка сессии — признак «идёт ли ход» (правило idle). */
  sessions?: { getSession(id: string): Promise<Session | null> };
}

/**
 * Собрать сервис терминалов инстанса.
 *
 * Отсутствующие зависимости не ломают сервис: без журнала — нет аудита,
 * без реестра метрик — нет метрик, без загрузчика сессий — правило idle
 * считает сессию активной (fail-safe: живой терминал не убиваем, потому что
 * не смогли проверить).
 */
export function createTerminalService(wiring: TerminalServiceWiring): TerminalService {
  return new TerminalService({
    port: wiring.port,
    ...(wiring.eventBus ? { eventBus: wiring.eventBus } : {}),
    ...(wiring.commandAuditLog
      ? { audit: createCommandAuditTerminalSink(wiring.commandAuditLog) }
      : {}),
    ...(wiring.metrics ? { metrics: createTerminalMetrics(wiring.metrics) } : {}),
    ...(wiring.sessions
      ? {
          isSessionActive: async (sessionId: string): Promise<boolean> => {
            try {
              const session = await wiring.sessions!.getSession(sessionId);
              // Идёт ход — у сессии есть живой поток (`currentStream`).
              return Boolean(session?.currentStream);
            } catch {
              // Не смогли проверить — считаем сессию активной (терминал не трогаем).
              return true;
            }
          },
        }
      : {}),
  });
}
