import { describe, it, expect } from 'vitest';
import {
  buildSignatureHeader,
  computeWebhookSignature,
  parseSignatureHeader,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_VERSION,
} from './signature.js';

describe('webhooks: HMAC-подпись (AD-052, этап II)', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'whd_1', type: 'session.created', data: { x: 1 } });
  const now = 1_700_000_000;

  it('computeWebhookSignature — HMAC-SHA256 от "<t>.<body>"', () => {
    const sig = computeWebhookSignature(secret, now, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Детерминированность и зависимость от тела/timestamp.
    expect(computeWebhookSignature(secret, now, body)).toBe(sig);
    expect(computeWebhookSignature(secret, now + 1, body)).not.toBe(sig);
    expect(computeWebhookSignature(secret, now, `${body} `)).not.toBe(sig);
  });

  it('buildSignatureHeader — формат t=..,v1=..; parseSignatureHeader — разбор', () => {
    const header = buildSignatureHeader(secret, now, body);
    expect(header).toBe(`t=${now},${WEBHOOK_SIGNATURE_VERSION}=${computeWebhookSignature(secret, now, body)}`);
    const parsed = parseSignatureHeader(header);
    expect(parsed?.timestamp).toBe(now);
    expect(parsed?.version).toBe('v1');
    expect(parseSignatureHeader('garbage')).toBeNull();
  });

  it('verifyWebhookSignature — валидная/невалидная/просроченная подпись', () => {
    const header = buildSignatureHeader(secret, now, body);
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now })).toBe(true);
    // Другой секрет.
    expect(verifyWebhookSignature('other', body, header, { nowSec: now })).toBe(false);
    // Изменённое тело.
    expect(verifyWebhookSignature(secret, `${body}x`, header, { nowSec: now })).toBe(false);
    // Просроченный timestamp (окно 300 c).
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now + 301 })).toBe(false);
    // В пределах окна.
    expect(verifyWebhookSignature(secret, body, header, { nowSec: now + 299 })).toBe(true);
  });
});
