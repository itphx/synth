import { describe, expect, it } from 'vitest';

import type { SynthConfig } from './types.js';
import { redactConfigSecrets } from './redact.js';

/** Частичный конфиг (полная схема для теста маскирования не нужна). */
function configOf(value: Record<string, unknown>): SynthConfig {
  return value as unknown as SynthConfig;
}

/** Объект как словарь (тест читает произвольные ветки частичного конфига). */
function rec(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Первый элемент массива (ветка конфига). */
function first(value: unknown): Record<string, unknown> {
  return (value as unknown[])[0] as Record<string, unknown>;
}

describe('redactConfigSecrets', () => {
  it('маскирует секреты во вложенных секциях', () => {
    const config = configOf({
      core: { apiKey: 'core-key', port: 4300 },
      security: { secretKey: 'master-key' },
      auth: {
        apiKey: 'auth-key',
        oidc: { clientSecret: 'oidc-secret', clientId: 'public-client' },
      },
      remote: { auth: { apiKey: 'remote-key' } },
      storage: { postgres: { password: 'pg-pass', host: 'db' } },
      execution: { remote: { tokenSecret: '/run/secrets/executor-token' } },
      webhooks: { endpoints: [{ url: 'https://example', secret: 'hook-secret' }] },
      proxy: { default: { password: 'proxy-pass' } },
    });

    const redacted = redactConfigSecrets(config);

    expect(rec(redacted.core).apiKey).toBe('***');
    expect(rec(redacted.security).secretKey).toBe('***');
    expect(rec(redacted.auth).apiKey).toBe('***');
    expect(rec(rec(redacted.auth).oidc).clientSecret).toBe('***');
    expect(rec(rec(redacted.remote).auth).apiKey).toBe('***');
    expect(rec(rec(redacted.storage).postgres).password).toBe('***');
    expect(rec(rec(redacted.execution).remote).tokenSecret).toBe('***');
    expect(first(rec(redacted.webhooks).endpoints).secret).toBe('***');
    expect(rec(rec(redacted.proxy).default).password).toBe('***');

    // Не-секретные ключи не тронуты.
    expect(rec(redacted.core).port).toBe(4300);
    expect(rec(rec(redacted.auth).oidc).clientId).toBe('public-client');
    expect(rec(rec(redacted.storage).postgres).host).toBe('db');
    expect(first(rec(redacted.webhooks).endpoints).url).toBe('https://example');
  });

  it('не маскирует пустые и отсутствующие значения', () => {
    const config = configOf({
      core: { apiKey: '' },
      security: { secretKey: '   ' },
      auth: { oidc: { clientSecret: undefined } },
      remote: { auth: {} },
      webhooks: {},
    });

    const redacted = redactConfigSecrets(config);

    expect(rec(redacted.core).apiKey).toBe('');
    expect(rec(redacted.security).secretKey).toBe('   ');
    expect(rec(rec(redacted.auth).oidc).clientSecret).toBeUndefined();
    expect('apiKey' in rec(rec(redacted.remote).auth)).toBe(false);
  });

  it('не мутирует исходный объект', () => {
    const config = configOf({
      core: { apiKey: 'secret' },
      security: { secretKey: 'master' },
    });

    const redacted = redactConfigSecrets(config);

    expect(redacted).not.toBe(config);
    expect(rec(redacted.core)).not.toBe(rec(config.core));
    expect(rec(rec(config).core).apiKey).toBe('secret');
    expect(rec(rec(config).security).secretKey).toBe('master');
  });

  it('ключи сравниваются по точному имени без учёта регистра', () => {
    const config = configOf({
      core: { apiKey: 'a', ApiKey: 'b', API_KEY: 'c' },
      llm: { timeout: 60, tokenizer: 'cl100k', tokenLimit: 5 },
      auth: { apiKeyRoles: ['ADMIN'] },
    });

    const redacted = redactConfigSecrets(config);

    expect(rec(redacted.core).apiKey).toBe('***');
    expect(rec(redacted.core).ApiKey).toBe('***');
    // `API_KEY` — не то же имя, что `apiKey` (сравнение по точному имени).
    expect(rec(redacted.core).API_KEY).toBe('c');
    // Похожие по подстроке ключи не маскируются.
    expect(rec(redacted.llm).timeout).toBe(60);
    expect(rec(redacted.llm).tokenizer).toBe('cl100k');
    expect(rec(redacted.llm).tokenLimit).toBe(5);
    expect(rec(redacted.auth).apiKeyRoles).toEqual(['ADMIN']);
  });
});
