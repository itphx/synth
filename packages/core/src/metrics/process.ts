/**
 * ADR-094: процессные метрики Node.js.
 *
 * Значения обновляются коллектором перед каждым рендером (`registry.addCollector`),
 * поэтому скрейп видит актуальный снимок. Event loop lag снимается
 * `monitorEventLoopDelay` (интервальная гистограмма, `mean` в наносекундах) —
 * таймер не удерживает процесс (проверено), `stop()` освобождает его.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import type { MetricsRegistry } from './registry.js';

export interface ProcessMetricsHandle {
  /** Остановить сбор: снять коллектор и отключить event-loop-монитор. */
  stop(): void;
}

/**
 * Зарегистрировать базовые метрики процесса:
 * RSS, heap, CPU, event loop lag, uptime и `build_info{version,node}`.
 */
export function registerProcessMetrics(registry: MetricsRegistry): ProcessMetricsHandle {
  const rss = registry.gauge(
    'synth_process_resident_memory_bytes',
    'Resident memory size (RSS) in bytes.',
  );
  const heapUsed = registry.gauge(
    'synth_process_heap_used_bytes',
    'Node.js heap used in bytes.',
  );
  const cpuSeconds = registry.counter(
    'synth_process_cpu_seconds_total',
    'Total user and system CPU time spent in seconds.',
  );
  const eventLoopLag = registry.gauge(
    'synth_node_eventloop_lag_seconds',
    'Mean event loop delay in seconds.',
  );
  const uptime = registry.gauge(
    'synth_process_uptime_seconds',
    'Process uptime in seconds.',
  );
  const buildInfo = registry.gauge(
    'synth_build_info',
    'Build information (value is always 1).',
    ['version', 'node'],
  );
  buildInfo.set({ version: SYNTH_VERSION, node: process.version }, 1);

  const lagMonitor = monitorEventLoopDelay({ resolution: 1000 });
  let lastCpuSeconds = 0;
  let stopped = false;

  const collect = (): void => {
    if (stopped) return;
    const memory = process.memoryUsage();
    rss.set(memory.rss);
    heapUsed.set(memory.heapUsed);
    uptime.set(process.uptime());

    const usage = process.cpuUsage();
    const totalCpuSeconds = (usage.user + usage.system) / 1_000_000;
    if (totalCpuSeconds > lastCpuSeconds) {
      cpuSeconds.inc(totalCpuSeconds - lastCpuSeconds);
    }
    lastCpuSeconds = totalCpuSeconds;

    // `mean` — наносекунды; до первого интервала значение NaN → 0.
    const meanLag = lagMonitor.mean;
    eventLoopLag.set(Number.isFinite(meanLag) ? meanLag / 1_000_000_000 : 0);
  };

  const removeCollector = registry.addCollector(collect);
  collect();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      removeCollector();
      lagMonitor.disable();
    },
  };
}
