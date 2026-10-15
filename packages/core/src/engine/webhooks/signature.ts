import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ADR-052 (этап II): HMAC-SHA256-подпись тела webhook.
 *
 * Заголовки доставки:
 * - `X-Synth-Event`    — тип события;
 * - `X-Synth-Delivery` — id доставки;
 * - `X-Synth-Signature` — `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<rawBody>")>`.
 *
 * Получатель проверяет подпись по **сырому телу** (до парсинга JSON) и сверяет
 * `t` с текущим временем в пределах `WEBHOOK_SIGNATURE_TOLERANCE_SEC` (окно 300 c)
 * — защита от replay. Версия схемы подписи — `v1`.
 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** Допустимое расхождение timestamp подписи, секунды (окно анти-replay). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

/** HMAC-SHA256 hex от строки `"<timestamp>.<rawBody>"`. */
export function computeWebhookSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Значение заголовка `X-Synth-Signature` для доставки. */
export function buildSignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},${WEBHOOK_SIGNATURE_VERSION}=${computeWebhookSignature(secret, timestamp, rawBody)}`;
}

export interface ParsedSignature {
  timestamp: number;
  version: string;
  signature: string;
}

/** Разбирает `X-Synth-Signature`; `null` — некорректный формат. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp = Number.NaN;
  let version = '';
  let signature = '';
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number.parseInt(value, 10);
    else if (key && key !== 't') {
      version = key;
      signature = value;
    }
  }
  if (!Number.isFinite(timestamp) || !version || !signature) return null;
  return { timestamp, version, signature };
}

/**
 * Проверяет подпись: версия, окно timestamp (анти-replay) и постоянное по
 * времени сравнение HMAC. `nowSec` — текущее unix-время (для тестов).
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
  options?: { nowSec?: number; toleranceSec?: number },
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (parsed.version !== WEBHOOK_SIGNATURE_VERSION) return false;

  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSec ?? WEBHOOK_SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;

  const expected = computeWebhookSignature(secret, parsed.timestamp, rawBody);
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(parsed.signature, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
