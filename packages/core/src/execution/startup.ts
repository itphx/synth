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
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
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
