/**
 * Проверка режима исполнения при старте процесса (ADR-077, шаги 3 и 7b).
 *
 * `execution.mode` — **параметр запуска** (инвариант 24): смена режима — только
 * рестартом. Режим `inline` (исполнение в процессе) работает всегда; режим
 * `remote` (отдельные исполнители) требует:
 *
 * - хотя бы одного адреса исполнителя (`execution.remote.url`);
 * - установленного пакета `@itphx/synth-executor` (динамический `import()`);
 * - читаемого токена исполнителя (`execution.remote.tokenSecret` — **путь** к
 *   файлу, инвариант 13).
 *
 * Нарушение любого условия — **fail-closed**: старт прерывается с понятным
 * сообщением, а не «молча уходит в inline». Молчаливый возврат в inline означал
 * бы, что оператор запросил удалённое исполнение (изоляция control plane от
 * toolchain'а), а получил локальное — команды ушли бы в control plane.
 *
 * Тексты — через ключи `shared/i18n` (ADR-041), как остальные строки движка.
 */
import { resolveExecutionConfig } from '@itphx/synth-shared';
import type { ResolvedExecutionConfig, SynthConfig } from '@itphx/synth-shared';
import { t } from '../engine/system-messages.js';
import {
  EXECUTOR_PACKAGE_UNAVAILABLE_REASON,
  EXECUTOR_TOKEN_UNAVAILABLE_REASON,
  isExecutorPackageAvailable,
  readExecutorToken,
} from './remote.js';

/** Причина отказа на старте. */
export type ExecutionStartupIssue = 'remote_url_required' | 'remote_unavailable';

/**
 * Проба окружения для проверки режима `remote`.
 *
 * Шов для тестов: по умолчанию — реальные проверки (пакет исполнителя
 * импортируется, токен читается из файла). Тесты подменяют пробу, чтобы
 * проверять решение стартовой проверки без установленного пакета.
 */
export interface ExecutionEnvironmentProbe {
  /** Доступен ли пакет исполнителя (`@itphx/synth-executor`). */
  isPackageAvailable: () => Promise<boolean>;
  /** Читается ли токен исполнителя по пути из конфигурации. */
  readToken: (tokenSecret: string) => Promise<string>;
}

/** Проба по умолчанию — реальное окружение. */
const DEFAULT_PROBE: ExecutionEnvironmentProbe = {
  isPackageAvailable: isExecutorPackageAvailable,
  readToken: readExecutorToken,
};

/** Итог проверки режима исполнения. */
export interface ExecutionStartupCheck {
  /** `true` — старт можно продолжать. */
  ok: boolean;
  /** Причина отказа (при `ok: false`). */
  issue?: ExecutionStartupIssue;
  /** Локализованное сообщение для оператора (при `ok: false`). */
  message?: string;
}

/**
 * Проверяет, поддерживается ли заданный режим исполнения **в этом окружении**.
 *
 * - `inline` — всегда ок (прежнее поведение, обратная совместимость);
 * - `remote` без адресов исполнителей — `remote_url_required`;
 * - `remote` с адресами, но без пакета исполнителя / без читаемого токена —
 *   `remote_unavailable` (fail-closed, с технической причиной в сообщении).
 *
 * @param execution эффективная секция `execution`
 * @param probe проба окружения (тесты подменяют)
 */
export async function checkExecutionMode(
  execution: ResolvedExecutionConfig,
  probe: ExecutionEnvironmentProbe = DEFAULT_PROBE,
): Promise<ExecutionStartupCheck> {
  if (execution.mode !== 'remote') return { ok: true };

  if (execution.remote.url.length === 0) {
    return {
      ok: false,
      issue: 'remote_url_required',
      message: t('execution.remote_url_required'),
    };
  }

  if (!(await probe.isPackageAvailable())) {
    return {
      ok: false,
      issue: 'remote_unavailable',
      message: t('execution.remote_unavailable', { reason: EXECUTOR_PACKAGE_UNAVAILABLE_REASON }),
    };
  }

  try {
    await probe.readToken(execution.remote.tokenSecret);
  } catch {
    return {
      ok: false,
      issue: 'remote_unavailable',
      message: t('execution.remote_unavailable', { reason: EXECUTOR_TOKEN_UNAVAILABLE_REASON }),
    };
  }

  return { ok: true };
}

/**
 * То же, что `checkExecutionMode`, но бросает ошибку с локализованным
 * сообщением — для вызывающих, которые прерывают старт исключением.
 */
export async function assertExecutionModeSupported(
  execution: ResolvedExecutionConfig,
  probe?: ExecutionEnvironmentProbe,
): Promise<void> {
  const check = await checkExecutionMode(execution, probe);
  if (check.ok) return;
  throw new Error(check.message ?? 'execution mode is not supported');
}

/** Итог резолвинга режима исполнения на старте `serve`. */
export type ExecutionStartupResolution =
  | { ok: true; execution: ResolvedExecutionConfig }
  | { ok: false; message: string };

/**
 * Резолвинг секции `execution` для старта `serve` — **общий шов** обеих точек
 * входа standalone (core-`main.ts` и публичный CLI `@itphx/synth`).
 *
 * Порядок тот же, что раньше был в `main.ts`:
 * 1. `resolveExecutionConfig` — CLI-флаг (`--execution-mode`) > env
 *    `SYNTH_EXECUTION_*` > `config.yaml execution.*` > дефолты. Неизвестный
 *    `mode`/`failMode` — fail-closed (ошибка с текстом);
 * 2. `checkExecutionMode` — `remote` требует адресов, пакета исполнителя и
 *    читаемого токена (иначе `remote_url_required`/`remote_unavailable`).
 *
 * Функция **не** завершает процесс: решение об `process.exit(1)` принимает
 * вызывающий (так резолвинг тестируется без подмены `process.exit`).
 */
export async function resolveExecutionForStartup(
  config: SynthConfig,
  options: {
    /** CLI-флаг `--execution-mode` (приоритетнее env/config). */
    cliMode?: string;
    /** Env-слой (дефолт `process.env`). */
    env?: NodeJS.ProcessEnv;
    /** Проба окружения (тесты подменяют). */
    probe?: ExecutionEnvironmentProbe;
  } = {},
): Promise<ExecutionStartupResolution> {
  let execution: ResolvedExecutionConfig;
  try {
    execution = resolveExecutionConfig(config, options.env ?? process.env, { mode: options.cliMode });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const check = await checkExecutionMode(execution, options.probe);
  if (!check.ok) {
    return { ok: false, message: check.message ?? 'execution mode is not supported' };
  }
  return { ok: true, execution };
}
