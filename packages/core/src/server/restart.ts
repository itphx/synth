// Graceful restart инстанса из UI.
//
// Схема: рестарт — это не «перезапуск внутри процесса», а **graceful shutdown
// с exit code 75 (`EX_TEMPFAIL`)**; процесс поднимает внешний супервизор
// (K8s `restartPolicy: Always`, Docker `restart: unless-stopped`, systemd/pm2)
// или локальный `scripts/dev.sh` (режим `supervisor`).
//
// Режимы (`SYNTH_RESTART_MODE`, CLI `--restart-mode` приоритетнее env):
// - `disabled` (default) — рестарт недоступен: `GET /restart` → `supported:false`,
//   `POST /restart` → 409 `RESTART_UNSUPPORTED`;
// - `process` — выход с кодом 75, перезапуск внешним супервизором;
// - `supervisor` — то же, но локальный `dev.sh` сам поднимает процесс.
//
// Состояние модуля глобальное (один процесс — один инстанс): HTTP-фабрики
// (core и backend) не прокидывают callback, а читают статус/просят рестарт
// здесь. `configureRestart` вызывается на старте процесса (`main.ts`).
import { SYNTH_VERSION, generateId } from '@itphx/synth-shared';

/** Режим рестарта инстанса. */
export type RestartMode = 'disabled' | 'process' | 'supervisor';

/** Exit code «временно не могу работать» — стандартный сигнал супервизору. */
export const RESTART_EXIT_CODE = 75;

/** Публичный статус рестарта (`GET /api/v2/maintenance/restart`). */
export interface RestartStatus {
  /** Рестарт доступен (режим не `disabled`). */
  supported: boolean;
  mode: RestartMode;
  /** Почему рестарт недоступен (или пояснение режима). */
  reason?: string;
  /** ISO-метка старта процесса — UI ждёт её изменения после рестарта. */
  startedAt: string;
  /** Версия пакета. */
  version: string;
}

/** Итог запроса на рестарт (`POST /api/v2/maintenance/restart`). */
export interface RestartRequestOutcome {
  /** Запрос принят (или уже был принят ранее — идемпотентность). */
  accepted: boolean;
  mode: RestartMode;
  /** `rst_<uuid>` — идентификатор запроса (в аудите и ответе). */
  restartId?: string;
  /** Причина отказа (`disabled`). */
  reason?: string;
  /** Повторный вызов: рестарт уже запрошен, вернули тот же `restartId`. */
  alreadyRequested?: boolean;
}

/** Параметры `configureRestart` (вызывается на старте процесса). */
export interface ConfigureRestartOptions {
  mode: RestartMode;
  /** Фактический graceful shutdown процесса; по умолчанию — `process.exit`. */
  request?: (restartId: string) => void | Promise<void>;
  /** Пояснение для `GET /restart` (напр., что перезапуск делает супервизор). */
  reason?: string;
  /** Задержка перед вызовом `request` — чтобы HTTP-ответ успел уйти. */
  delayMs?: number;
}

/** Задержка перед инициированием shutdown (ответ клиенту уходит раньше). */
const DEFAULT_RESTART_DELAY_MS = 50;

/** Причина по умолчанию для `disabled`: режим не включён на инстансе. */
const DISABLED_REASON = 'SYNTH_RESTART_MODE=disabled (или не задан)';

const RESTART_MODES: readonly RestartMode[] = ['disabled', 'process', 'supervisor'];

/**
 * ISO-метка старта процесса (модуль загружается в начале жизни процесса).
 * Одна и та же для `/health` и `/maintenance/restart`, поэтому UI может
 * сравнить значение до и после рестарта.
 */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

let currentConfig: ConfigureRestartOptions = { mode: 'disabled' };
let pendingRestartId: string | null = null;

/**
 * Резолвит режим: `override` (CLI-флаг) приоритетнее `SYNTH_RESTART_MODE`
 * (инвариант «CLI > env»). Неизвестное значение — `disabled` + предупреждение
 * (fail-safe: лучше «недоступно», чем внезапный выход процесса).
 */
export function resolveRestartMode(
  env: NodeJS.ProcessEnv = process.env,
  override?: string | null,
): RestartMode {
  const raw = String(override ?? env.SYNTH_RESTART_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'disabled';
  if ((RESTART_MODES as readonly string[]).includes(raw)) return raw as RestartMode;
  console.warn(
    `[restart] неизвестный SYNTH_RESTART_MODE="${raw}" — рестарт отключён (disabled)`,
  );
  return 'disabled';
}

/** Настраивает модуль на старте процесса. Сбрасывает незавершённый запрос. */
export function configureRestart(options: ConfigureRestartOptions): void {
  currentConfig = { ...options };
  pendingRestartId = null;
}

/** Сбрасывает состояние модуля (герметичные тесты). */
export function resetRestartForTests(): void {
  currentConfig = { mode: 'disabled' };
  pendingRestartId = null;
}

/** ISO-метка старта процесса (`/health`, `startedAt`). */
export function getProcessStartedAt(): string {
  return PROCESS_STARTED_AT;
}

/** Текущий статус рестарта (для `GET /api/v2/maintenance/restart`). */
export function getRestartStatus(): RestartStatus {
  const mode = currentConfig.mode;
  const reason =
    currentConfig.reason ?? (mode === 'disabled' ? DISABLED_REASON : undefined);
  return {
    supported: mode !== 'disabled',
    mode,
    ...(reason ? { reason } : {}),
    startedAt: PROCESS_STARTED_AT,
    version: SYNTH_VERSION,
  };
}

/**
 * Запрашивает graceful restart.
 *
 * - `disabled` → `{accepted:false}` (роут отдаёт 409);
 * - идемпотентность: повторный вызов до фактического выхода возвращает тот же
 *   `restartId` (`alreadyRequested:true`) и **не** планирует второй shutdown;
 * - `beforeRequest` вызывается **до** инициации (аудит `restart.requested`);
 * - фактический `request` (graceful shutdown с кодом 75) — через `setTimeout`,
 *   чтобы HTTP-ответ 202 успел уйти клиенту.
 */
export async function requestRestart(opts: {
  beforeRequest?: (restartId: string, mode: RestartMode) => void | Promise<void>;
} = {}): Promise<RestartRequestOutcome> {
  const status = getRestartStatus();
  if (!status.supported) {
    return {
      accepted: false,
      mode: status.mode,
      ...(status.reason ? { reason: status.reason } : {}),
    };
  }

  if (pendingRestartId) {
    return {
      accepted: true,
      mode: status.mode,
      restartId: pendingRestartId,
      alreadyRequested: true,
    };
  }

  const restartId = `rst_${generateId()}`;
  pendingRestartId = restartId;

  try {
    await opts.beforeRequest?.(restartId, status.mode);
  } catch (err) {
    // Аудит/подготовка упали — запрос не инициируем, состояние откатываем.
    pendingRestartId = null;
    throw err;
  }

  const delayMs = currentConfig.delayMs ?? DEFAULT_RESTART_DELAY_MS;
  const request = currentConfig.request;
  const timer = setTimeout(() => {
    if (!request) {
      // Без обработчика выходим как обычно: так рестарт не «зависает».
      console.warn('[restart] обработчик рестарта не задан — выход с кодом 75');
      process.exit(RESTART_EXIT_CODE);
      return;
    }
    try {
      void Promise.resolve(request(restartId)).catch((err: unknown) => {
        console.error(
          `[restart] ошибка graceful shutdown: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(RESTART_EXIT_CODE);
      });
    } catch (err) {
      console.error(
        `[restart] ошибка graceful shutdown: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RESTART_EXIT_CODE);
    }
  }, delayMs);
  // Таймер не должен удерживать процесс (при штатном рестарте сервер и так жив).
  timer.unref?.();

  return { accepted: true, mode: status.mode, restartId };
}
