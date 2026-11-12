/**
 * Конфигурация provisioner'а: env-парсинг и fail-closed.
 *
 * Проверяется контракт PROP-135 §4b-2a:
 * - дефолты (порт 5200, idle 15/5 мин, maxLifetime 12 ч, drain grace 30 с,
 *   лимит 50 пулов, период reaper 30 с);
 * - без токена процесс не стартует; токен не попадает в текст ошибок;
 * - неизвестный/нереализованный provider — ошибка (kubernetes → 4b-2b);
 * - битый JSON, профиль без url, нечисловые значения — ошибка;
 * - `scrubProvisionerToken` убирает токен из окружения.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVISIONER_DEFAULTS,
  PROVISIONER_ENV,
  parseJsonEnv,
  profilesSchema,
  resolveProvisionerConfig,
  scrubProvisionerToken,
} from './config.js';

// Токен собирается из частей: в исходнике нет литерала, похожего на кред.
const TOKEN = ['provisioner-config', 'token', 'test-1234567890'].join('-');

/** Валидный env с переопределениями (`undefined` — удалить переменную). */
function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    [PROVISIONER_ENV.token]: TOKEN,
    [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { url: 'http://executor:5100' } }),
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

describe('provisioner: конфигурация из env', () => {
  it('минимальный env даёт дефолты', () => {
    const config = resolveProvisionerConfig(makeEnv());
    expect(config.token).toBe(TOKEN);
    expect(config.host).toBe(PROVISIONER_DEFAULTS.host);
    expect(config.port).toBe(5200);
    expect(config.provider).toBe('static');
    expect(config.idleTimeoutMs).toBe(900_000);
    expect(config.sessionIdleTimeoutMs).toBe(300_000);
    expect(config.maxLifetimeMs).toBe(43_200_000);
    expect(config.drainGraceMs).toBe(30_000);
    expect(config.maxPools).toBe(50);
    expect(config.reaperIntervalMs).toBe(30_000);
    expect(config.profiles.default?.url).toBe('http://executor:5100');
    expect(config.staticPools).toEqual({});
  });

  it('переопределения env применяются', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_ENV.host]: '127.0.0.1',
        [PROVISIONER_ENV.port]: '5201',
        [PROVISIONER_ENV.idleTimeoutMs]: '1000',
        [PROVISIONER_ENV.sessionIdleTimeoutMs]: '500',
        [PROVISIONER_ENV.maxLifetimeMs]: '2000',
        [PROVISIONER_ENV.drainGraceMs]: '10',
        [PROVISIONER_ENV.maxPools]: '2',
        [PROVISIONER_ENV.reaperIntervalMs]: '50',
        [PROVISIONER_ENV.staticPools]: JSON.stringify({
          'project:p1:exec:default': 'http://executor-p1:5100',
        }),
      }),
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(5201);
    expect(config.idleTimeoutMs).toBe(1000);
    expect(config.sessionIdleTimeoutMs).toBe(500);
    expect(config.maxLifetimeMs).toBe(2000);
    expect(config.drainGraceMs).toBe(10);
    expect(config.maxPools).toBe(2);
    expect(config.reaperIntervalMs).toBe(50);
    expect(config.staticPools['project:p1:exec:default']).toBe('http://executor-p1:5100');
  });

  it('без токена — ошибка fail-closed с именем переменной', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.token]: undefined }))).toThrow(
      /SYNTH_PROVISIONER_TOKEN.*fail-closed/s,
    );
  });

  it('пустой токен — ошибка', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.token]: '   ' }))).toThrow(
      /SYNTH_PROVISIONER_TOKEN/,
    );
  });

  it('kubernetes не реализован в 4b-2a — ошибка с объяснением', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.provider]: 'kubernetes' })),
    ).toThrow(/kubernetes.*не реализован в 4b-2a/s);
  });

  it('неизвестный provider — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.provider]: 'nomad' })),
    ).toThrow(/неизвестный provider "nomad"/);
  });

  it('битый JSON профилей — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{not json' })),
    ).toThrow(/невалидный JSON в SYNTH_PROVISIONER_PROFILES/);
  });

  it('профиль без url в static-режиме — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { image: 'executor:1' } }) }),
      ),
    ).toThrow(/профиль "default" без url/);
  });

  it('невалидный url профиля — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.profiles]: JSON.stringify({ default: { url: 'not-a-url' } }) }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_PROFILES/);
  });

  it('невалидный url статического пула — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({ [PROVISIONER_ENV.staticPools]: JSON.stringify({ 'project:p1:exec:default': 'ftp://x' }) }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_STATIC_POOLS/);
  });

  it('неизвестное поле профиля — ошибка (fail-closed)', () => {
    expect(() =>
      resolveProvisionerConfig(
        makeEnv({
          [PROVISIONER_ENV.profiles]: JSON.stringify({
            default: { url: 'http://executor:5100', unknown: true },
          }),
        }),
      ),
    ).toThrow(/SYNTH_PROVISIONER_PROFILES/);
  });

  it('пустой каталог профилей и пулов — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{}' })),
    ).toThrow(/ни одного профиля и ни одного статического пула/);
  });

  it('только статические пулы без профилей допустимы', () => {
    const config = resolveProvisionerConfig(
      makeEnv({
        [PROVISIONER_ENV.profiles]: '{}',
        [PROVISIONER_ENV.staticPools]: JSON.stringify({
          'session:s1:exec:default': 'http://executor-s1:5100',
        }),
      }),
    );
    expect(config.profiles).toEqual({});
    expect(config.staticPools['session:s1:exec:default']).toBe('http://executor-s1:5100');
  });

  it('нечисловое значение — ошибка, а не молчаливый дефолт', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.maxPools]: 'many' })),
    ).toThrow(/SYNTH_PROVISIONER_MAX_POOLS="many"/);
  });

  it('ноль/отрицательное значение — ошибка', () => {
    expect(() =>
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.idleTimeoutMs]: '0' })),
    ).toThrow(/SYNTH_PROVISIONER_IDLE_TIMEOUT_MS="0"/);
  });

  it('порт вне 1..65535 — ошибка', () => {
    expect(() => resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.port]: '70000' }))).toThrow(
      /SYNTH_PROVISIONER_PORT="70000"/,
    );
  });

  it('текст ошибки не содержит токен', () => {
    try {
      resolveProvisionerConfig(makeEnv({ [PROVISIONER_ENV.profiles]: '{oops' }));
      expect.unreachable('ожидалась ошибка');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('scrubProvisionerToken удаляет токен из окружения', () => {
    const env = makeEnv();
    scrubProvisionerToken(env);
    expect(env[PROVISIONER_ENV.token]).toBeUndefined();
  });

  it('parseJsonEnv: пустое значение — fallback', () => {
    expect(parseJsonEnv(undefined, 'X', profilesSchema, {})).toEqual({});
    expect(parseJsonEnv('   ', 'X', profilesSchema, {})).toEqual({});
  });
});
