import { describe, it, expect } from 'vitest';
import { resolveCorsOrigin } from './cors.js';

// CORS fail-closed: пустой белый список НЕ отражает произвольный origin.
describe('resolveCorsOrigin (fail-closed)', () => {
  it('пустой allowlist + чужой origin → undefined (заголовок не выставляется)', () => {
    expect(resolveCorsOrigin('https://evil.example', { allowedOrigins: [] })).toBeUndefined();
  });

  it('origin отсутствует (same-origin/нативный клиент) → undefined', () => {
    expect(resolveCorsOrigin(undefined, { allowedOrigins: ['https://app.example'] })).toBeUndefined();
  });

  it('origin не входит в allowlist → undefined', () => {
    expect(
      resolveCorsOrigin('https://evil.example', { allowedOrigins: ['https://app.example'] }),
    ).toBeUndefined();
  });

  it('origin входит в allowlist → эхо', () => {
    expect(
      resolveCorsOrigin('https://app.example', { allowedOrigins: ['https://app.example'] }),
    ).toBe('https://app.example');
  });

  it('env SYNTH_CORS_ORIGIN приоритетнее allowlist', () => {
    expect(
      resolveCorsOrigin('https://evil.example', {
        allowedOrigins: [],
        envOrigin: 'https://fixed.example',
      }),
    ).toBe('https://fixed.example');
  });

  it('явный dev-флаг allowAll → эхо произвольного origin', () => {
    expect(
      resolveCorsOrigin('https://evil.example', { allowedOrigins: [], allowAll: true }),
    ).toBe('https://evil.example');
    expect(
      resolveCorsOrigin(undefined, { allowedOrigins: [], allowAll: true }),
    ).toBeUndefined();
  });
});
