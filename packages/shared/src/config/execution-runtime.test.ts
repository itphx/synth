import { describe, it, expect } from 'vitest';
import { defaultConfig } from './defaults.js';
import { resolveExecutionConfig } from './execution.js';
import { EXECUTION_ENV } from './execution.js';
import {
  applyExecutionRuntimeSettings,
  effectiveExecutionProfileNames,
  executionRuntimeFingerprint,
  executionRuntimeSettingsFromResolved,
  mergeExecutionRuntimeSettings,
  parseExecutionRuntimeSettings,
} from './execution-runtime.js';
import type { ExecutionRuntimeSettings } from '../types/execution.js';

/** Config-уровень секции `execution` с одним профилем `base`. */
function resolvedBase(env: NodeJS.ProcessEnv = {}) {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: 'remote',
        remote: {
          ...defaultConfig.execution.remote,
          url: ['http://executor:8080'],
          defaultProfile: 'base',
          browserProfile: 'browser',
          profiles: {
            base: { url: ['http://base:8080'] },
            legacy: { url: ['http://legacy:8080'], image: 'img:legacy' },
          },
        },
      },
    },
    env,
  );
}

describe('parseExecutionRuntimeSettings (ADR-135)', () => {
  it('принимает корректную секцию', () => {
    const parsed = parseExecutionRuntimeSettings({
      defaultProfile: 'p1',
      pooling: 'project',
      profiles: { p1: { image: 'img:1' } },
    });
    expect(parsed).toEqual({
      defaultProfile: 'p1',
      pooling: 'project',
      profiles: { p1: { image: 'img:1' } },
    });
  });

  it('неизвестное поле → секция невалидна (fail-soft)', () => {
    expect(parseExecutionRuntimeSettings({ unknownField: 1 })).toBeUndefined();
    expect(parseExecutionRuntimeSettings({ profiles: { p: { nope: true } } })).toBeUndefined();
  });

  it('пустая/отсутствующая секция → undefined', () => {
    expect(parseExecutionRuntimeSettings(undefined)).toBeUndefined();
    expect(parseExecutionRuntimeSettings(null)).toBeUndefined();
    expect(parseExecutionRuntimeSettings({})).toEqual({});
  });

  it('неверный enum → невалидно', () => {
    expect(parseExecutionRuntimeSettings({ pooling: 'projekt' })).toBeUndefined();
    expect(parseExecutionRuntimeSettings({ fallback: 'nope' })).toBeUndefined();
  });
});

describe('applyExecutionRuntimeSettings (ADR-135)', () => {
  it('runtime перекрывает дефолты config-уровня', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { defaultProfile: 'runtime', pooling: 'session', fallback: 'fail' },
      {},
    );
    expect(applied.remote.defaultProfile).toBe('runtime');
    expect(applied.remote.pooling).toBe('session');
    expect(applied.remote.fallback).toBe('fail');
  });

  it('env выше runtime (ADR-023) — переменная окружения не перекрывается', () => {
    const env = { [EXECUTION_ENV.defaultProfile]: 'from-env' };
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(env),
      { defaultProfile: 'runtime', pooling: 'session' },
      env,
    );
    expect(applied.remote.defaultProfile).toBe('from-env');
    // Не заданное env поле — runtime перекрывает.
    expect(applied.remote.pooling).toBe('session');
  });

  it('каталог профилей runtime заменяет каталог config целиком', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { profiles: { only: { url: ['http://only:8080'] } } },
      {},
    );
    expect(Object.keys(applied.remote.profiles)).toEqual(['only']);
  });

  it('профиль без url наследует общий адрес секции', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { profiles: { p: { image: 'img:p' } } },
      {},
    );
    expect(applied.remote.profiles.p?.url).toEqual(['http://executor:8080']);
    expect(applied.remote.profiles.p?.image).toBe('img:p');
    expect(applied.remote.profiles.p?.timeoutMs).toBe(resolvedBase().remote.timeoutMs);
  });

  it('метаданные профиля материализуются (сеть/ресурсы/rootfs/env/mcp)', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      {
        profiles: {
          p: {
            description: 'описание',
            image: 'img:p',
            network: 'restricted',
            resources: { requests: { cpu: '500m' } },
            runtimeClass: 'gvisor',
            readOnlyRootFilesystem: true,
            env: { FOO: 'bar' },
            mcpServers: ['playwright-mcp'],
          },
        },
      },
      {},
    );
    const profile = applied.remote.profiles.p;
    expect(profile?.description).toBe('описание');
    expect(profile?.network).toBe('restricted');
    expect(profile?.resources?.requests?.cpu).toBe('500m');
    expect(profile?.runtimeClass).toBe('gvisor');
    expect(profile?.readOnlyRootFilesystem).toBe(true);
    expect(profile?.env).toEqual({ FOO: 'bar' });
    expect(profile?.mcpServers).toEqual(['playwright-mcp']);
  });

  it('без runtime-секции секция не меняется', () => {
    const base = resolvedBase();
    expect(applyExecutionRuntimeSettings(base, undefined, {})).toBe(base);
  });
});

describe('mergeExecutionRuntimeSettings (ADR-135)', () => {
  const base: ExecutionRuntimeSettings = {
    defaultProfile: 'base',
    pooling: 'instance',
    profiles: { base: { image: 'img:base' } },
  };

  it('runtime перекрывает скалярные поля', () => {
    const merged = mergeExecutionRuntimeSettings(base, { defaultProfile: 'runtime' });
    expect(merged.defaultProfile).toBe('runtime');
    expect(merged.pooling).toBe('instance');
  });

  it('каталог runtime заменяет каталог base целиком (удаление профиля)', () => {
    const merged = mergeExecutionRuntimeSettings(base, { profiles: { other: { image: 'i' } } });
    expect(Object.keys(merged.profiles ?? {})).toEqual(['other']);
  });

  it('без runtime-секции остаётся base', () => {
    expect(mergeExecutionRuntimeSettings(base, undefined).profiles).toEqual({
      base: { image: 'img:base' },
    });
  });
});

describe('effectiveExecutionProfileNames (ADR-135)', () => {
  it('каталог runtime заменяет каталог base', () => {
    const names = effectiveExecutionProfileNames(
      { profiles: { base: {}, legacy: {} } },
      { profiles: { only: {} } },
    );
    expect(names).toEqual(['only']);
  });

  it('без runtime-каталога — имена base', () => {
    expect(effectiveExecutionProfileNames({ profiles: { base: {} } }, undefined)).toEqual(['base']);
  });
});

describe('executionRuntimeSettingsFromResolved / fingerprint (ADR-135)', () => {
  it('снимок отдаёт runtime-форму секции', () => {
    const snapshot = executionRuntimeSettingsFromResolved(resolvedBase());
    expect(snapshot?.defaultProfile).toBe('base');
    expect(snapshot?.profiles?.base?.url).toEqual(['http://base:8080']);
    expect(snapshot?.profiles?.legacy?.image).toBe('img:legacy');
  });

  it('снимок без секции — null', () => {
    expect(executionRuntimeSettingsFromResolved(undefined)).toBeNull();
  });

  it('отпечаток устойчив к порядку профилей и списков', () => {
    const a = executionRuntimeFingerprint({
      profiles: { b: { mcpServers: ['z', 'a'] }, a: { image: 'i' } },
    });
    const b = executionRuntimeFingerprint({
      profiles: { a: { image: 'i' }, b: { mcpServers: ['a', 'z'] } },
    });
    expect(a).toBe(b);
  });

  it('разные каталоги — разные отпечатки; пусто и null — одинаковые', () => {
    expect(executionRuntimeFingerprint({ profiles: { a: {} } })).not.toBe(
      executionRuntimeFingerprint({ profiles: { b: {} } }),
    );
    expect(executionRuntimeFingerprint({})).not.toBe(executionRuntimeFingerprint(null));
  });
});
