/**
 * Внешний чекер команд исполнителя (PROP-136b, Ф2).
 *
 * Shell считается произвольным кодом: `shell-guard` и permission-слой —
 * guardrail и UX, а не граница безопасности. Поэтому решение `allow`/`deny`
 * может принимать **внешняя политика**, и точка принуждения — **исполнитель**:
 * проверка идёт синхронно **до** `spawn` (единственное место, где команда
 * реально запускается). Зеркальная проверка в control plane и запись вердикта
 * в аудит — слайс 136b-2.
 *
 * ## Провайдеры
 *
 * - `http` — `POST {url}/v1/check` с телом
 *   `{ command, cwd, timeout_ms, background }` → `{ action, reason?, rule_id?, ttl_ms? }`;
 * - `opa` — `POST {url}{opaPath}` (по умолчанию `/v1/data/synth/exec/decision`)
 *   с телом `{ input: { command, cwd, timeout_ms, background } }` →
 *   `{ result: { allow: boolean, reason?, rule_id? } }`.
 *
 * `ask` чекер **не возвращает**: человеческое подтверждение остаётся в
 * permission-слое (ADR-029). Чекер судит только по тексту команды и не видит
 * ФС, сеть и окружение — это ограничение, а не недосмотр.
 *
 * ## Ошибки и fail mode
 *
 * Таймаут, сбой сети, не-2xx и невалидный ответ — «чекер недоступен»:
 *
 * - `failMode: 'closed'` (дефолт) → `deny` с причиной `command policy unavailable`;
 * - `failMode: 'open'` → `allow` с причиной `command policy unavailable (fail-open)`
 *   и предупреждением в лог (осознанная настройка оператора).
 *
 * Недоступность **не кэшируется**: временный сбой политики не должен
 * «прилипать» к команде на весь TTL.
 *
 * ## Кэш
 *
 * Ключ — `sha256(command + '\0' + cwd + '\0' + background)`; TTL — `ttl_ms`
 * из вердикта (если прокси-политика его прислала) либо `cacheTtlMs` конфига.
 * `deny` кэшируется наравне с `allow` (повторный запуск запрещённой команды
 * не должен каждый раз ходить в политику); кэшированный ответ помечается
 * `cached: true`. `cacheTtlMs: 0` — кэш выключен.
 *
 * ## Токен
 *
 * Bearer-токен читается из файла (`SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE`)
 * **при создании guard'а** (старт процесса) и живёт только в замыкании:
 * в `ExecutorConfig` и в `process.env` его нет, в лог и тексты ошибок он не
 * попадает. Заданный, но нечитаемый файл — ошибка старта (fail-closed).
 *
 * ## Транспорт
 *
 * Исходящие запросы — через общий egress-транспорт core (`egressFetch`,
 * ADR-099): единый источник доверия TLS/CA и прокси. Собственных
 * `Agent`/диспетчеров пакет не создаёт (инвариант 22). Транспорт подгружается
 * лениво — только когда чекер включён.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExecCommand } from '@itphx/synth-core';
import type { CommandPolicyConfig } from './config.js';
import type { ExecutorMetrics } from './metrics.js';

/** Вход проверки: то, что политика реально видит. */
export interface CommandPolicyInput {
  /** Текст команды: shell-строка либо `argv.join(' ')`. */
  command: string;
  /** Рабочий каталог (уже прошедший containment исполнителя). */
  cwd: string;
  /** Таймаут команды, мс (подсказка политике; на решение не влияет). */
  timeoutMs?: number;
  /** Фоновый запуск (`POST /exec/spawn`). */
  background?: boolean;
}

/** Вердикт чекера. */
export interface CommandPolicyVerdict {
  action: 'allow' | 'deny';
  /** Причина (текст политики; уезжает модели при `deny`). */
  reason?: string;
  /** Идентификатор сработавшего правила (для аудита 136b-2). */
  ruleId?: string;
  /** Вердикт взят из кэша. */
  cached?: boolean;
}

/** Guard внешнего чекера команд. */
export interface CommandPolicyGuard {
  /** Проверить команду до запуска. */
  check(input: CommandPolicyInput): Promise<CommandPolicyVerdict>;
  /** Провайдер (лейбл `provider` в метриках: `http`/`opa`). */
  readonly provider: 'http' | 'opa';
}

/** Зависимости guard'а (инъекция для тестов). */
export interface CommandPolicyGuardDeps {
  /** Транспорт (по умолчанию `egressFetch` из core). */
  fetchImpl?: typeof fetch;
  /** Источник времени (TTL кэша). */
  now?: () => number;
  /** Метрики исполнителя (не заданы — не считаются). */
  metrics?: ExecutorMetrics;
}

/** Предел числа записей кэша вердиктов (старые вытесняются). */
export const COMMAND_POLICY_CACHE_MAX_ENTRIES = 512;

/** Причина отказа при недоступном чекере (`failMode: closed`). */
export const COMMAND_POLICY_UNAVAILABLE_REASON = 'command policy unavailable';

/** Причина пропуска при недоступном чекере (`failMode: open`). */
export const COMMAND_POLICY_UNAVAILABLE_OPEN_REASON = 'command policy unavailable (fail-open)';

/** Вердикт с TTL из ответа политики (служебное поле кэша). */
interface ParsedVerdict {
  action: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
  /** `ttl_ms` ответа (приоритетнее конфига). */
  ttlMs?: number;
}

/** Запись кэша. */
interface CacheEntry {
  verdict: CommandPolicyVerdict;
  expiresAt: number;
}

/**
 * Текст команды для политики.
 *
 * `shell` — строка как есть (политика судит по тексту), `argv` — аргументы
 * через пробел: иной формы у политики нет, а отдельный формат для argv
 * разошёлся бы между точками вызова.
 */
export function commandPolicyCommandText(command: ExecCommand): string {
  if (command.kind === 'shell') return command.command;
  return [command.file, ...(command.args ?? [])].join(' ');
}

/** Ленивая загрузка egress-транспорта core (ADR-099). */
let coreModule: typeof import('@itphx/synth-core') | undefined;

async function resolveFetch(override?: typeof fetch): Promise<typeof fetch> {
  if (override) return override;
  coreModule ??= await import('@itphx/synth-core');
  return coreModule.egressFetch as unknown as typeof fetch;
}

/** Непустая строка либо `undefined`. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Положительное число либо `undefined`. */
function optionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Разбор ответа `http-json`. */
function parseHttpVerdict(raw: unknown): ParsedVerdict | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.action !== 'allow' && record.action !== 'deny') return undefined;
  const verdict: ParsedVerdict = { action: record.action };
  const reason = optionalString(record.reason);
  if (reason !== undefined) verdict.reason = reason;
  const ruleId = optionalString(record.rule_id);
  if (ruleId !== undefined) verdict.ruleId = ruleId;
  const ttlMs = optionalPositiveNumber(record.ttl_ms);
  if (ttlMs !== undefined) verdict.ttlMs = ttlMs;
  return verdict;
}

/** Разбор ответа OPA (`result.allow`). */
function parseOpaVerdict(raw: unknown): ParsedVerdict | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const result = (raw as Record<string, unknown>).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.allow !== 'boolean') return undefined;
  const verdict: ParsedVerdict = { action: record.allow ? 'allow' : 'deny' };
  const reason = optionalString(record.reason);
  if (reason !== undefined) verdict.reason = reason;
  const ruleId = optionalString(record.rule_id);
  if (ruleId !== undefined) verdict.ruleId = ruleId;
  return verdict;
}

/**
 * Создать guard внешнего чекера команд.
 *
 * `provider: 'off'` → `null` (проверка не выполняется, вызовов нет вовсе).
 *
 * @throws Error если файл токена задан, но не читается (fail-closed старта).
 */
export function createCommandPolicyGuard(
  config: { readonly commandPolicy: CommandPolicyConfig },
  deps: CommandPolicyGuardDeps = {},
): CommandPolicyGuard | null {
  const settings = config.commandPolicy;
  if (settings.provider === 'off') return null;

  const provider = settings.provider;
  const baseUrl = (settings.url ?? '').replace(/\/+$/, '');
  if (baseUrl.length === 0) {
    // Конфиг это уже запрещает; повторная проверка — на случай ручной сборки.
    throw new Error(
      '[executor] чекер команд включён без адреса — guard не создаётся (fail-closed)',
    );
  }

  // Значение токена живёт только здесь: в конфиге/`process.env` его нет.
  let token: string | undefined;
  if (settings.tokenFile !== undefined) {
    let content: string;
    try {
      content = readFileSync(settings.tokenFile, 'utf8');
    } catch {
      throw new Error(
        '[executor] файл токена чекера команд недоступен для чтения — исполнитель не стартует (fail-closed)',
      );
    }
    const trimmed = content.trim();
    token = trimmed.length > 0 ? trimmed : undefined;
  }

  const endpoint = provider === 'opa' ? `${baseUrl}${settings.opaPath}` : `${baseUrl}/v1/check`;
  const cache = new Map<string, CacheEntry>();
  const now = deps.now ?? ((): number => Date.now());

  /** Доступ к метрикам: приёмник приходит один раз при создании. */
  const metrics = deps.metrics;

  function cacheKey(input: CommandPolicyInput): string {
    const background = input.background === true ? 'true' : 'false';
    return createHash('sha256')
      .update(`${input.command}\0${input.cwd}\0${background}`, 'utf8')
      .digest('hex');
  }

  function rememberVerdict(key: string, verdict: ParsedVerdict): void {
    const ttl = verdict.ttlMs ?? settings.cacheTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    if (cache.size >= COMMAND_POLICY_CACHE_MAX_ENTRIES) {
      // Первая (самая старая) запись: Map хранит порядок вставки.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    // `ttl_ms` из ответа — приоритетнее конфига (политика знает лучше).
    cache.set(key, { verdict: toVerdict(verdict), expiresAt: now() + ttl });
  }

  function toVerdict(parsed: ParsedVerdict): CommandPolicyVerdict {
    return {
      action: parsed.action,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      ...(parsed.ruleId !== undefined ? { ruleId: parsed.ruleId } : {}),
    };
  }

  /** Недоступность чекера — по `failMode`. */
  function unavailable(cause: unknown, durationMs: number): CommandPolicyVerdict {
    if (metrics) {
      try {
        metrics.commandPolicyChecked('unavailable', provider);
        metrics.commandPolicyDuration(provider, durationMs);
      } catch {
        // метрики не должны влиять на решение
      }
    }
    if (settings.failMode === 'open') {
      console.warn(
        `[executor] чекер команд недоступен (${provider}) — fail-open: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return { action: 'allow', reason: COMMAND_POLICY_UNAVAILABLE_OPEN_REASON };
    }
    return { action: 'deny', reason: COMMAND_POLICY_UNAVAILABLE_REASON };
  }

  /** Учесть решение в метриках (ошибка метрик не влияет на решение). */
  function record(outcome: 'allow' | 'deny', durationMs?: number): void {
    if (!metrics) return;
    try {
      metrics.commandPolicyChecked(outcome, provider);
      if (durationMs !== undefined) metrics.commandPolicyDuration(provider, durationMs);
    } catch {
      // ignore
    }
  }

  return {
    provider,
    async check(input: CommandPolicyInput): Promise<CommandPolicyVerdict> {
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAt > now()) {
          // Решение из кэша — тоже решение (считаем; латентность не меряем).
          record(cached.verdict.action);
          return { ...cached.verdict, cached: true };
        }
        cache.delete(key);
      }

      const fetchImpl = await resolveFetch(deps.fetchImpl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      timer.unref?.();
      const startedAt = now();
      let parsed: ParsedVerdict | undefined;
      let failure: unknown;
      try {
        const payload = {
          command: input.command,
          cwd: input.cwd,
          ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
          background: input.background === true,
        };
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token !== undefined) headers.authorization = `Bearer ${token}`;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(provider === 'opa' ? { input: payload } : payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          failure = new Error(`чекер ответил статусом ${response.status}`);
        } else {
          const text = await response.text();
          let json: unknown;
          try {
            json = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            json = undefined;
          }
          parsed = provider === 'opa' ? parseOpaVerdict(json) : parseHttpVerdict(json);
          if (parsed === undefined) failure = new Error('чекер вернул невалидный ответ');
        }
      } catch (err) {
        failure = err;
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Math.max(0, now() - startedAt);
      if (parsed === undefined) return unavailable(failure, durationMs);

      record(parsed.action, durationMs);
      rememberVerdict(key, parsed);
      return toVerdict(parsed);
    },
  };
}
