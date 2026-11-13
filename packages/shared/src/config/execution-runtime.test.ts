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
    expect(parseExecutionRuntimeSettings({ profiles: { p: { class: 'sandbox' } } })).toBeUndefined();
  });

  it('legacy-строки MCP-серверов нормализуются в объекты (ADR-135 §11)', () => {
    const parsed = parseExecutionRuntimeSettings({
      profiles: { p: { image: 'img:p', mcpServers: ['playwright-mcp'] } },
    });
    expect(parsed?.profiles?.p?.mcpServers).toEqual([{ name: 'playwright-mcp' }]);
  });

  it('класс профиля и отключённые профили принимаются', () => {
    const parsed = parseExecutionRuntimeSettings({
      disabledProfiles: ['legacy'],
      profiles: { p: { image: 'img:p', class: 'browser' } },
    });
    expect(parsed?.disabledProfiles).toEqual(['legacy']);
    expect(parsed?.profiles?.p?.class).toBe('browser');
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

  it('каталог профилей runtime сливается с каталогом config (override по имени)', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { profiles: { only: { url: ['http://only:8080'] } } },
      {},
    );
    // Config-профили сохраняются, runtime-запись добавляется.
    expect(Object.keys(applied.remote.profiles).sort()).toEqual(['base', 'legacy', 'only']);
    // Одноимённая runtime-запись переопределяет config-запись целиком.
    const applied2 = applyExecutionRuntimeSettings(
      resolvedBase(),
      { profiles: { base: { image: 'img:override' } } },
      {},
    );
    expect(applied2.remote.profiles.base?.image).toBe('img:override');
    expect(applied2.remote.profiles.base?.url).toEqual(['http://executor:8080']);
    expect(Object.keys(applied2.remote.profiles).sort()).toEqual(['base', 'legacy']);
  });

  it('отключение config-профиля убирает его из каталога (disabledProfiles)', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { disabledProfiles: ['legacy'] },
      {},
    );
    expect(Object.keys(applied.remote.profiles).sort()).toEqual(['base']);
    expect(applied.remote.disabledProfiles).toEqual(['legacy']);
    expect(applied.remote.profileOrigins?.legacy).toBeUndefined();
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

  it('метаданные профиля материализуются (сеть/ресурсы/rootfs/env/mcp/класс)', () => {
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
            class: 'browser',
            mcpServers: [
              { name: 'playwright-mcp', command: 'npx', args: ['-y', 'playwright-mcp'] },
            ],
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
    expect(profile?.class).toBe('browser');
    expect(profile?.mcpServers).toEqual([
      { name: 'playwright-mcp', command: 'npx', args: ['-y', 'playwright-mcp'] },
    ]);
  });

  it('legacy-строки MCP-серверов нормализуются в объекты (обратная совместимость)', () => {
    const applied = applyExecutionRuntimeSettings(
      resolvedBase(),
      { profiles: { p: { image: 'img:p', mcpServers: ['playwright-mcp' as never] } } },
      {},
    );
    expect(applied.remote.profiles.p?.mcpServers).toEqual([{ name: 'playwright-mcp' }]);
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

  it('каталог runtime сливается с каталогом base (одноимённая запись перекрывает)', () => {
    const merged = mergeExecutionRuntimeSettings(base, { profiles: { other: { image: 'i' } } });
    expect(Object.keys(merged.profiles ?? {}).sort()).toEqual(['base', 'other']);
  });

  it('отключённые профили объединяются с базовыми', () => {
    const merged = mergeExecutionRuntimeSettings(
      { ...base, disabledProfiles: ['x'] },
      { disabledProfiles: ['y'] },
    );
    expect(merged.disabledProfiles).toEqual(['x', 'y']);
  });

  it('без runtime-секции остаётся base', () => {
    expect(mergeExecutionRuntimeSettings(base, undefined).profiles).toEqual({
      base: { image: 'img:base' },
    });
  });
});

describe('effectiveExecutionProfileNames (ADR-135)', () => {
  it('каталог runtime сливается с каталогом base', () => {
    const names = effectiveExecutionProfileNames(
      { profiles: { base: {}, legacy: {} } },
      { profiles: { only: {} } },
    );
    expect(names.sort()).toEqual(['base', 'legacy', 'only']);
  });

  it('отключённые профили не входят в эффективный каталог', () => {
    const names = effectiveExecutionProfileNames(
      { profiles: { base: {}, legacy: {} } },
      { disabledProfiles: ['legacy'] },
    );
    expect(names).toEqual(['base']);
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
    // Эффективный класс профиля — в снимке (exec по умолчанию).
    expect(snapshot?.profiles?.base?.class).toBe('exec');
  });

  it('снимок без секции — null', () => {
    expect(executionRuntimeSettingsFromResolved(undefined)).toBeNull();
  });

  it('отпечаток устойчив к порядку профилей и списков', () => {
    const a = executionRuntimeFingerprint({
      profiles: { b: { mcpServers: [{ name: 'z' }, { name: 'a' }] }, a: { image: 'i' } },
    });
    const b = executionRuntimeFingerprint({
      profiles: { a: { image: 'i' }, b: { mcpServers: [{ name: 'a' }, { name: 'z' }] } },
    });
    expect(a).toBe(b);
  });

  it('отпечаток учитывает отключённые профили и класс', () => {
    const base = executionRuntimeFingerprint({ profiles: { a: { image: 'i' } } });
    expect(executionRuntimeFingerprint({ profiles: { a: { image: 'i' } }, disabledProfiles: ['b'] }))
      .not.toBe(base);
    expect(executionRuntimeFingerprint({ profiles: { a: { image: 'i', class: 'browser' } } }))
      .not.toBe(base);
  });

  it('разные каталоги — разные отпечатки; пусто и null — одинаковые', () => {
    expect(executionRuntimeFingerprint({ profiles: { a: {} } })).not.toBe(
      executionRuntimeFingerprint({ profiles: { b: {} } }),
    );
    expect(executionRuntimeFingerprint({})).not.toBe(executionRuntimeFingerprint(null));
  });
});
