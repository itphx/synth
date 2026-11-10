// ADR-133: фоновый планировщик проверки обновлений.
//
// Запускается при эффективном `updates.check === true`
// (env `SYNTH_UPDATES_CHECK` > runtime `settings.json`/PG > config.yaml >
// default `false`). Если runtime-порт передан, таймеры живут и при выключенной
// проверке — тумблер в UI может включить её без рестарта, а выключенный тик
// запросов не делает. Первый тик — с задержкой 30 с (не мешать старту), затем
// `setInterval(intervalHours)`; таймеры `unref` — не держат процесс.
//
// На каждом тике настройка перечитывается: тумблер в UI («Обновления»)
// применяется без рестарта. Ошибки — тихо в лог (офлайн не должен шуметь).
import { defaultConfig, type UpdatesConfig } from '@itphx/synth-shared';
import type { SettingsRepository } from './storage/ports/settings-repository.js';
import { resolveUpdatesCheck, type UpdatesRuntimeSettings } from './storage/runtime-settings.js';
import { checkForUpdates, type UpdateInfo } from './update-checker.js';

/** Задержка первого тика по умолчанию — 30 с (старт важнее проверки). */
const DEFAULT_INITIAL_DELAY_MS = 30_000;

export interface UpdateSchedulerOptions {
  /** Каталог данных инстанса (кэш `update-check.json`). */
  dataDir: string;
  /** Секция `updates` из config.yaml/env (без runtime). */
  config?: Partial<UpdatesConfig>;
  /** Порт runtime-настроек (тумблер автопроверки). */
  settingsStore?: SettingsRepository;
  /** Колбэк при найденном обновлении (лог/уведомление). */
  onUpdate?: (info: UpdateInfo) => void;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Задержка первого тика, мс (тесты; по умолчанию 30 000). */
  initialDelayMs?: number;
  /** Период проверки, мс (тесты; по умолчанию — `updates.intervalHours`). */
  intervalMs?: number;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (msg: string) => void;
}

export interface UpdateSchedulerHandle {
  /** Остановить таймеры (graceful shutdown/тесты). */
  stop(): void;
  /** Один прогон проверки (тесты/ручной вызов); ошибки глотаются. */
  runCheck(): Promise<UpdateInfo | null>;
}

/**
 * Запустить фоновую проверку обновлений.
 *
 * Возвращает no-op-хендл (таймеры не создаются), только если автопроверка
 * выключена **и** runtime-источника нет (включить её после старта нечем).
 * Если порт runtime-настроек передан, таймеры живут всегда: тумблер в UI может
 * включить проверку позже, а выключенное состояние тик просто пропускает — без
 * запросов к реестру (`runCheck` выходит до `checkForUpdates`).
 */
export async function startUpdateScheduler(
  opts: UpdateSchedulerOptions,
): Promise<UpdateSchedulerHandle> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const config: UpdatesConfig = { ...defaultConfig.updates, ...(opts.config ?? {}) };

  const readRuntimeCheck = async (): Promise<boolean | undefined> => {
    if (!opts.settingsStore) return undefined;
    const runtime = await opts.settingsStore
      .getUpdates()
      .catch((): Partial<UpdatesRuntimeSettings> => ({}));
    return typeof runtime.check === 'boolean' ? runtime.check : undefined;
  };

  const noop: UpdateSchedulerHandle = {
    stop: () => {},
    runCheck: async () => null,
  };

  const initialCheck = resolveUpdatesCheck(config.check, await readRuntimeCheck(), env).check;
  // Без runtime-порта включить автопроверку после старта нечем — таймеры не нужны.
  if (!initialCheck && !opts.settingsStore) return noop;

  let stopped = false;
  let firstTimer: NodeJS.Timeout | undefined;
  let periodic: NodeJS.Timeout | undefined;

  const runCheck = async (): Promise<UpdateInfo | null> => {
    if (stopped) return null;
    try {
      const enabled = resolveUpdatesCheck(config.check, await readRuntimeCheck(), env).check;
      if (!enabled) return null;

      const info = await checkForUpdates(opts.dataDir, {
        // `check` в эффективной секции — уже с учётом env/runtime.
        updates: { ...config, check: enabled },
        channel: config.channel,
        force: false,
        background: true,
      });
      if (info.hasUpdate) {
        log(
          `[updates] Доступна новая версия ${info.latestVersion} ` +
          `(канал ${info.channel}; текущая ${info.currentVersion})`,
        );
        opts.onUpdate?.(info);
      }
      return info;
    } catch (err) {
      log(`[updates] проверка не удалась: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const intervalMs = opts.intervalMs ?? config.intervalHours * 60 * 60 * 1000;
  firstTimer = setTimeout(() => {
    void runCheck();
  }, opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  firstTimer.unref?.();

  periodic = setInterval(() => {
    void runCheck();
  }, intervalMs);
  periodic.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (periodic) clearInterval(periodic);
      firstTimer = undefined;
      periodic = undefined;
    },
    runCheck,
  };
}
