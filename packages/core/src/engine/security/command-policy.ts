/**
 * PROP-136b (слайс 136b-2a): **зеркальный** внешний чекер команд в control
 * plane (`security.commandPolicy`).
 *
 * ## Зачем
 *
 * Точка принуждения — **исполнитель**: там проверка идёт синхронно до
 * `spawn` (единственное место, где команда реально запускается). Control plane
 * проверить команду может только ради **раннего отказа и UX**: модель получает
 * `deny` до постановки вызова в исполнение, а вердикт попадает в аудит
 * исполнений (`CommandAuditEntry.provider`). Это зеркало, **не** граница
 * безопасности: в режиме `inline` (standalone) команда исполняется в процессе и
 * чекер — единственный «внешний» голос, в `remote` — решает исполнитель.
 *
 * Без чекера (`enabled: false`, дефолт) поведение прежнее: провайдер не
 * создаётся, оркестратор пишет `decidedBy: 'permission'`.
 *
 * ## Провайдеры
 *
 * - `http` — `POST {url}/v1/check` `{command, cwd, timeout_ms?, background}` →
 *   `{action, reason?, rule_id?, ttl_ms?}`;
 * - `opa` — `POST {url}{opaPath}` `{input: {...}}` →
 *   `{result: {allow, reason?, rule_id?}}`.
 *
 * Bearer-токен — из файла `tokenSecret` через `readExecutorToken` (путь, не
 * значение — инвариант 13): читается лениво при первой проверке и живёт только
 * в замыкании; в конфиг/логи/тексты ошибок не попадает. Нечитаемый файл —
 * «чекер недоступен» (по `failMode`), а не молчаливая проверка без авторизации.
 *
 * ## Ошибки и fail mode
 *
 * Таймаут, сбой сети, не-2xx, невалидный ответ, нечитаемый токен — «чекер
 * недоступен»:
 *
 * - `failMode: 'closed'` → `deny` (`command policy unavailable`);
 * - `failMode: 'open'` (дефолт схемы, standalone) → `allow`
 *   (`command policy unavailable (fail-open)`) + warning в лог.
 *
 * Недоступность **не кэшируется**: временный сбой не «прилипает» к команде.
 *
 * ## Кэш
 *
 * Ключ — `sha256(command + '\0' + cwd + '\0' + background)`; TTL — `ttl_ms`
 * вердикта либо 60 с. `deny` кэшируется наравне с `allow`. У кэш-попадания
 * `latencyMs: 0` (сети не было).
 *
 * ## Транспорт
 *
 * Исходящие запросы — через общий egress-транспорт core (`egressFetch`,
 * ADR-099): единый источник доверия TLS/CA и прокси, собственных агентов нет
 * (инвариант 22).
 */
import { createHash } from 'node:crypto';
import type { CommandPolicyConfig } from '@itphx/synth-shared';
import { readExecutorToken } from '../../execution/remote.js';
import { egressFetch } from '../../security/tls.js';
import type { CommandPolicyMetricsSink } from '../../metrics/collectors/command-policy.js';

/** Вход проверки: то, что политика реально видит. */
export interface CommandPolicyInput {
  /** Текст команды (`execute_shell` — строка, `sandbox_exec` — `join(' && ')`). */
  command: string;
  /** Рабочий каталог (после резолва относительно рабочего каталога сессии). */
  cwd: string;
  /** Таймаут команды, мс (подсказка политике; на решение не влияет). */
  timeoutMs?: number;
  /** Фоновый запуск. */
  background?: boolean;
}

/** Вердикт чекера. */
export interface CommandPolicyVerdict {
  action: 'allow' | 'deny';
  /** Причина (уезжает модели при `deny`; EN, без секретов). */
  reason?: string;
  /** Идентификатор сработавшего правила (в аудит — `matchedRule`). */
  ruleId?: string;
  /** Провайдер, вынесший вердикт. */
  kind: 'http' | 'opa';
  /** Длительность сетевой проверки, мс (кэш — 0). */
  latencyMs: number;
}

/** Провайдер чекера команд (control plane). */
export interface CommandPolicyProvider {
  /** Проверить команду до исполнения. */
  check(input: CommandPolicyInput): Promise<CommandPolicyVerdict>;
  /** Провайдер (лейбл `provider` в метриках/аудите). */
  readonly kind: 'http' | 'opa';
}

/** Зависимости провайдера (инъекция для тестов). */
export interface CommandPolicyProviderDeps {
  /** Транспорт (по умолчанию `egressFetch` — ADR-099). */
  fetchImpl?: typeof fetch;
  /** Источник времени (TTL кэша). */
  now?: () => number;
  /** Чтение токена (по умолчанию `readExecutorToken`). */
  readToken?: (tokenSecret: string) => Promise<string>;
  /** Метрики (`synth_command_policy_*`; не заданы — не считаются). */
  metrics?: CommandPolicyMetricsSink;
  /** Лог предупреждений (fail-open); по умолчанию `console.warn`. */
  warn?: (message: string) => void;
}

/** Предел числа записей кэша вердиктов (старые вытесняются). */
export const COMMAND_POLICY_CACHE_MAX_ENTRIES = 512;

/** TTL кэша вердикта по умолчанию, мс. */
export const COMMAND_POLICY_DEFAULT_TTL_MS = 60_000;

/** Причина отказа при недоступном чекере (`failMode: closed`). */
export const COMMAND_POLICY_UNAVAILABLE_REASON = 'command policy unavailable';

/** Причина пропуска при недоступном чекере (`failMode: open`). */
export const COMMAND_POLICY_UNAVAILABLE_OPEN_REASON = 'command policy unavailable (fail-open)';

/** Вердикт с TTL из ответа политики (служебное поле кэша). */
interface ParsedVerdict {
  action: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
  ttlMs?: number;
}

/** Запись кэша. */
interface CacheEntry {
  verdict: CommandPolicyVerdict;
  expiresAt: number;
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

/** Разбор ответа `http` (`{action, reason?, rule_id?, ttl_ms?}`). */
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

/** Разбор ответа OPA (`{result: {allow, reason?, rule_id?}}`). */
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
 * Создать провайдер зеркального чекера команд.
 *
 * `enabled: false` → `null` (вызовов нет вовсе, поведение прежнее).
 *
 * @throws Error если чекер включён без адреса (fail-closed старта; схема
 *   конфигурации ловит это раньше — здесь защита от ручной сборки).
 */
export function createCommandPolicyProvider(
  config: CommandPolicyConfig,
  deps: CommandPolicyProviderDeps = {},
): CommandPolicyProvider | null {
  if (!config.enabled) return null;

  const kind = config.provider;
  const baseUrl = (config.url ?? '').trim().replace(/\/+$/, '');
  if (baseUrl.length === 0) {
    throw new Error(
      '[commandPolicy] чекер команд включён без адреса (security.commandPolicy.url) — провайдер не создаётся (fail-closed)',
    );
  }

  const endpoint = kind === 'opa' ? `${baseUrl}${config.opaPath}` : `${baseUrl}/v1/check`;
  const now = deps.now ?? ((): number => Date.now());
  const warn = deps.warn ?? ((message: string): void => console.warn(message));
  const metrics = deps.metrics;
  const readToken = deps.readToken ?? readExecutorToken;
  // ADR-099: по умолчанию — общий egress-транспорт core (TLS/CA/прокси);
  // тесты инжектят свой `fetch`.
  const fetchImpl: typeof fetch = deps.fetchImpl ?? egressFetch;
  const cache = new Map<string, CacheEntry>();

  /**
   * Токен: путь → значение, лениво и один раз. Ошибка чтения **не** кэшируется
   * (файл могут починить без рестарта), но и не логируется со значением.
   */
  let tokenPromise: Promise<string | undefined> | undefined;
  function getToken(): Promise<string | undefined> {
    const tokenSecret = (config.tokenSecret ?? '').trim();
    if (tokenSecret.length === 0) return Promise.resolve(undefined);
    tokenPromise ??= readToken(tokenSecret)
      .then((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      })
      .catch((err: unknown) => {
        // Следующий вызов попробует прочитать снова.
        tokenPromise = undefined;
        throw err;
      });
    return tokenPromise;
  }

  function cacheKey(input: CommandPolicyInput): string {
    const background = input.background === true ? 'true' : 'false';
    return createHash('sha256')
      .update(`${input.command}\0${input.cwd}\0${background}`, 'utf8')
      .digest('hex');
  }

  function toVerdict(parsed: ParsedVerdict, latencyMs: number): CommandPolicyVerdict {
    return {
      action: parsed.action,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      ...(parsed.ruleId !== undefined ? { ruleId: parsed.ruleId } : {}),
      kind,
      latencyMs,
    };
  }

  function recordOutcome(action: 'allow' | 'deny' | 'unavailable'): void {
    try {
      metrics?.onChecked(action, kind);
    } catch {
      // Метрики не влияют на решение.
    }
  }

  function recordLatency(durationMs: number): void {
    try {
      metrics?.onLatency(kind, durationMs);
    } catch {
      // Метрики не влияют на решение.
    }
  }

  /** Недоступность чекера — по `failMode`. */
  function unavailable(cause: unknown, latencyMs: number): CommandPolicyVerdict {
    recordOutcome('unavailable');
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (config.failMode === 'open') {
      warn(`[commandPolicy] чекер команд недоступен (${kind}) — fail-open: ${detail}`);
      return {
        action: 'allow',
        reason: COMMAND_POLICY_UNAVAILABLE_OPEN_REASON,
        kind,
        latencyMs,
      };
    }
    return {
      action: 'deny',
      reason: COMMAND_POLICY_UNAVAILABLE_REASON,
      kind,
      latencyMs,
    };
  }

  return {
    kind,
    async check(input: CommandPolicyInput): Promise<CommandPolicyVerdict> {
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAt > now()) {
          // Кэш-попадание — тоже решение (считаем исход; латентность не меряем).
          recordOutcome(cached.verdict.action);
          return { ...cached.verdict, latencyMs: 0 };
        }
        cache.delete(key);
      }

      const startedAt = now();
      let parsed: ParsedVerdict | undefined;
      let failure: unknown;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      timer.unref?.();

      try {
        const token = await getToken();
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
          body: JSON.stringify(kind === 'opa' ? { input: payload } : payload),
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
          parsed = kind === 'opa' ? parseOpaVerdict(json) : parseHttpVerdict(json);
          if (parsed === undefined) failure = new Error('чекер вернул невалидный ответ');
        }
      } catch (err) {
        failure = err;
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Math.max(0, now() - startedAt);
      if (parsed === undefined) {
        recordLatency(durationMs);
        return unavailable(failure, durationMs);
      }

      recordOutcome(parsed.action);
      recordLatency(durationMs);

      const ttlMs = parsed.ttlMs ?? COMMAND_POLICY_DEFAULT_TTL_MS;
      if (Number.isFinite(ttlMs) && ttlMs > 0) {
        if (cache.size >= COMMAND_POLICY_CACHE_MAX_ENTRIES) {
          // Самая старая запись (Map хранит порядок вставки).
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, { verdict: toVerdict(parsed, durationMs), expiresAt: now() + ttlMs });
      }

      return toVerdict(parsed, durationMs);
    },
  };
}
