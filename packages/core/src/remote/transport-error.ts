// ADR-099: человекочитаемая причина транспортной ошибки для гибрида.
//
// `fetch` (undici) бросает `TypeError: fetch failed`, а реальная причина лежит
// в `cause.code` (`SELF_SIGNED_CERT_IN_CHAIN`, `ENOTFOUND`, `ECONNREFUSED`, …).
// Без неё сообщение «Сервер недоступен: fetch failed» не подсказывает, что чинить.
// Текст без секретов: только машинный код и короткая подсказка, без PEM/URL.

/** TLS-коды Node/OpenSSL: сервер не прошёл проверку цепочки/имени/срока. */
const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const REFUSED_CODES = new Set(['ECONNREFUSED']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

const TLS_HINT =
  'TLS: сервер не доверен — проверьте CA (Настройки → Сеть → Доверенные CA или security.tls) и имя хоста';
const DNS_HINT = 'DNS: имя не разрешается';
const REFUSED_HINT = 'соединение отклонено (сеть/файрвол/порт)';
const TIMEOUT_HINT = 'таймаут соединения';

/** Опции описания транспортной ошибки. */
export interface DescribeTransportErrorOptions {
  /** Дедлайн запроса в мс: попадает в текст таймаута (`за 15 с`). */
  timeoutMs?: number;
}

/**
 * Признак сработавшего дедлайна: `AbortSignal.timeout` бросает DOMException
 * `TimeoutError` без `code`, ручная отмена — `AbortError`. Проверяем и сам
 * объект, и `cause` (fetch может обернуть причину).
 */
function isTimeoutLike(err: unknown, depth = 0): boolean {
  if (err === null || typeof err !== 'object' || depth > 5) return false;
  const value = err as { name?: unknown; cause?: unknown };
  if (value.name === 'TimeoutError' || value.name === 'AbortError') return true;
  return isTimeoutLike(value.cause, depth + 1);
}

/** Секунды с одним знаком после запятой; целые — без дробной части (`15 с`). */
function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function describeTimeout(timeoutMs?: number): string {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return ': timeout — сервер не ответил';
  }
  return `: timeout — сервер не ответил за ${formatTimeoutSeconds(timeoutMs)} с`;
}

/**
 * Достаёт `code` из ошибки, её `cause` и (для `AggregateError` undici) из
 * вложенных ошибок. Глубина ограничена, чтобы не зациклиться на кривых объектах.
 */
export function extractTransportErrorCode(err: unknown, depth = 0): string | undefined {
  if (err === null || typeof err !== 'object' || depth > 5) return undefined;
  const value = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof value.code === 'string' && value.code !== '') return value.code;
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) {
      const code = extractTransportErrorCode(nested, depth + 1);
      if (code !== undefined) return code;
    }
  }
  return extractTransportErrorCode(value.cause, depth + 1);
}

/** Подсказка по коду; `undefined` — код неизвестен (домыслов не добавляем). */
function hintForCode(code: string): string | undefined {
  if (TLS_CODES.has(code) || code.startsWith('ERR_SSL_')) return TLS_HINT;
  if (DNS_CODES.has(code)) return DNS_HINT;
  if (REFUSED_CODES.has(code)) return REFUSED_HINT;
  if (TIMEOUT_CODES.has(code)) return TIMEOUT_HINT;
  return undefined;
}

/**
 * Возвращает суффикс к сообщению об ошибке: `: <code> — <подсказка>`
 * (неизвестный код — только `: <code>`; кода нет — пустая строка).
 *
 * Явный таймаут (`AbortSignal.timeout` → `TimeoutError`) проверяется **до** кода:
 * у такого DOMException `code` нет, и без отдельной ветки причина терялась —
 * пользователь видел «Сервер недоступен» без объяснения.
 */
export function describeTransportError(
  err: unknown,
  opts: DescribeTransportErrorOptions = {},
): string {
  if (isTimeoutLike(err)) return describeTimeout(opts.timeoutMs);
  const code = extractTransportErrorCode(err);
  if (code === undefined) return '';
  const hint = hintForCode(code);
  return hint === undefined ? `: ${code}` : `: ${code} — ${hint}`;
}
