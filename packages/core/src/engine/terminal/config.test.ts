/**
 * PROP-132: параметры выполнения терминалов — резолвер секции `terminal`.
 *
 * Проверяется: дефолты, приоритет **по каждому полю** (env > runtime > config >
 * default), env-фиксация только своего поля, отбрасывание невалидных значений
 * env/runtime/config, `sources`/общий `source`, база `defaults` (config ?? default),
 * нормализация `shell` и совместимость плоских параметров (`@deprecated`).
 *
 * Функция чистая, env подменяется объектом — `process.env` в тестах не читается.
 */
import { describe, expect, it } from 'vitest';
import { ENV_OVERRIDES, envOverrideName } from '@itphx/synth-shared/config';
import {
  DEFAULT_TERMINAL_AUDIT_INPUT,
  DEFAULT_TERMINAL_AUTO_RESTORE,
  DEFAULT_TERMINAL_ENABLED,
  DEFAULT_TERMINAL_IDLE_MINUTES,
  DEFAULT_TERMINAL_MAX_PER_INSTANCE,
  DEFAULT_TERMINAL_MAX_PER_PROJECT,
  TERMINAL_AUDIT_INPUT_ENV,
  TERMINAL_AUTO_RESTORE_ENV,
  TERMINAL_ENABLED_ENV,
  TERMINAL_IDLE_MINUTES_ENV,
  TERMINAL_MAX_PER_INSTANCE_ENV,
  TERMINAL_MAX_PER_PROJECT_ENV,
  TERMINAL_SHELL_ENV,
  resolveTerminalSettings,
  type TerminalSettingsField,
} from './config.js';

/** Пустое окружение (иначе тест зависел бы от `process.env`). */
const NO_ENV: NodeJS.ProcessEnv = {};

/** Полный набор полей секции — для проверок «все на одном слое». */
const ALL_FIELDS: TerminalSettingsField[] = [
  'enabled',
  'autoRestore',
  'idleMinutes',
  'maxPerProject',
  'maxPerInstance',
  'shell',
  'auditInput',
];

describe('resolveTerminalSettings: дефолты', () => {
  it('без слоёв отдаёт дефолты и source=default', () => {
    const resolved = resolveTerminalSettings({ env: NO_ENV });

    expect(resolved.enabled).toBe(DEFAULT_TERMINAL_ENABLED);
    expect(resolved.autoRestore).toBe(DEFAULT_TERMINAL_AUTO_RESTORE);
    expect(resolved.idleMinutes).toBe(2880);
    expect(resolved.idleMinutes).toBe(DEFAULT_TERMINAL_IDLE_MINUTES);
    expect(resolved.maxPerProject).toBe(8);
    expect(resolved.maxPerProject).toBe(DEFAULT_TERMINAL_MAX_PER_PROJECT);
    expect(resolved.maxPerInstance).toBe(32);
    expect(resolved.maxPerInstance).toBe(DEFAULT_TERMINAL_MAX_PER_INSTANCE);
    expect(resolved.shell).toBeNull();
    expect(resolved.auditInput).toBe(true);
    expect(resolved.auditInput).toBe(DEFAULT_TERMINAL_AUDIT_INPUT);

    expect(resolved.source).toBe('default');
    for (const field of ALL_FIELDS) {
      expect(resolved.sources[field]).toBe('default');
      expect(resolved.envLock[field]).toBe(false);
    }
    expect(resolved.envLocked).toBe(false);
  });

  it('defaults = config ?? default (config без runtime)', () => {
    const resolved = resolveTerminalSettings({
      config: { idleMinutes: 60, shell: '/bin/sh' },
      env: NO_ENV,
    });

    expect(resolved.defaults).toEqual({
      enabled: DEFAULT_TERMINAL_ENABLED,
      autoRestore: DEFAULT_TERMINAL_AUTO_RESTORE,
      idleMinutes: 60,
      maxPerProject: DEFAULT_TERMINAL_MAX_PER_PROJECT,
      maxPerInstance: DEFAULT_TERMINAL_MAX_PER_INSTANCE,
      shell: '/bin/sh',
      auditInput: DEFAULT_TERMINAL_AUDIT_INPUT,
    });
  });

  it('defaults не зависят от runtime (база сброса)', () => {
    const resolved = resolveTerminalSettings({
      runtime: { idleMinutes: 120, maxPerProject: 4 },
      env: NO_ENV,
    });

    expect(resolved.idleMinutes).toBe(120);
    expect(resolved.maxPerProject).toBe(4);
    expect(resolved.defaults.idleMinutes).toBe(DEFAULT_TERMINAL_IDLE_MINUTES);
    expect(resolved.defaults.maxPerProject).toBe(DEFAULT_TERMINAL_MAX_PER_PROJECT);
  });
});

describe('resolveTerminalSettings: приоритет по полям', () => {
  it('config задаёт все поля (source=config)', () => {
    const resolved = resolveTerminalSettings({
      config: {
        enabled: false,
        autoRestore: false,
        idleMinutes: 60,
        maxPerProject: 2,
        maxPerInstance: 4,
        shell: '/bin/sh',
        auditInput: false,
      },
      env: NO_ENV,
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.autoRestore).toBe(false);
    expect(resolved.idleMinutes).toBe(60);
    expect(resolved.maxPerProject).toBe(2);
    expect(resolved.maxPerInstance).toBe(4);
    expect(resolved.shell).toBe('/bin/sh');
    expect(resolved.auditInput).toBe(false);
    expect(resolved.source).toBe('config');
    for (const field of ALL_FIELDS) expect(resolved.sources[field]).toBe('config');
  });

  it('runtime перекрывает config по каждому полю', () => {
    const resolved = resolveTerminalSettings({
      config: {
        enabled: false,
        autoRestore: false,
        idleMinutes: 60,
        maxPerProject: 2,
        maxPerInstance: 4,
        shell: '/bin/sh',
        auditInput: false,
      },
      runtime: {
        enabled: true,
        autoRestore: true,
        idleMinutes: 120,
        maxPerProject: 3,
        maxPerInstance: 5,
        shell: '/bin/zsh',
        auditInput: true,
      },
      env: NO_ENV,
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.autoRestore).toBe(true);
    expect(resolved.idleMinutes).toBe(120);
    expect(resolved.maxPerProject).toBe(3);
    expect(resolved.maxPerInstance).toBe(5);
    expect(resolved.shell).toBe('/bin/zsh');
    expect(resolved.auditInput).toBe(true);
    expect(resolved.source).toBe('runtime');
    for (const field of ALL_FIELDS) {
      expect(resolved.sources[field]).toBe('runtime');
      expect(resolved.envLock[field]).toBe(false);
    }
  });

  it('env перекрывает runtime по каждому полю', () => {
    const resolved = resolveTerminalSettings({
      runtime: {
        enabled: false,
        autoRestore: false,
        idleMinutes: 120,
        maxPerProject: 3,
        maxPerInstance: 5,
        shell: '/bin/zsh',
        auditInput: false,
      },
      env: {
        [TERMINAL_ENABLED_ENV]: '1',
        [TERMINAL_AUTO_RESTORE_ENV]: 'true',
        [TERMINAL_IDLE_MINUTES_ENV]: '90',
        [TERMINAL_MAX_PER_PROJECT_ENV]: '6',
        [TERMINAL_MAX_PER_INSTANCE_ENV]: '7',
        [TERMINAL_SHELL_ENV]: '/usr/bin/fish',
        [TERMINAL_AUDIT_INPUT_ENV]: 'false',
      },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.autoRestore).toBe(true);
    expect(resolved.idleMinutes).toBe(90);
    expect(resolved.maxPerProject).toBe(6);
    expect(resolved.maxPerInstance).toBe(7);
    expect(resolved.shell).toBe('/usr/bin/fish');
    expect(resolved.auditInput).toBe(false);
    expect(resolved.source).toBe('env');
    for (const field of ALL_FIELDS) {
      expect(resolved.sources[field]).toBe('env');
      expect(resolved.envLock[field]).toBe(true);
    }
    expect(resolved.envLocked).toBe(true);
  });

  it('смешанные слои: общий source — самый специфичный', () => {
    const resolved = resolveTerminalSettings({
      config: { enabled: false, idleMinutes: 60 },
      runtime: { autoRestore: false, maxPerProject: 3 },
      env: { [TERMINAL_MAX_PER_INSTANCE_ENV]: '9' },
    });

    expect(resolved.sources).toEqual({
      enabled: 'config',
      autoRestore: 'runtime',
      idleMinutes: 'config',
      maxPerProject: 'runtime',
      maxPerInstance: 'env',
      shell: 'default',
      auditInput: 'default',
    });
    expect(resolved.source).toBe('env');
  });
});

describe('resolveTerminalSettings: env-фиксация по полю', () => {
  it('env фиксирует только своё поле', () => {
    const resolved = resolveTerminalSettings({
      runtime: { idleMinutes: 120, auditInput: false },
      env: { [TERMINAL_IDLE_MINUTES_ENV]: '45' },
    });

    expect(resolved.envLock.idleMinutes).toBe(true);
    // Остальные поля пришли из runtime и env НЕ зафиксированы.
    expect(resolved.envLock.auditInput).toBe(false);
    expect(resolved.envLock.enabled).toBe(false);
    expect(resolved.envLock.shell).toBe(false);
    expect(resolved.envLocked).toBe(true);
    expect(resolved.auditInput).toBe(false);
    expect(resolved.sources.auditInput).toBe('runtime');
  });

  it('env не задан — envLocked false, даже если runtime задан', () => {
    const resolved = resolveTerminalSettings({
      config: { enabled: false },
      runtime: { enabled: true },
      env: NO_ENV,
    });

    expect(resolved.envLocked).toBe(false);
    expect(Object.values(resolved.envLock).every((locked) => locked === false)).toBe(true);
  });
});

describe('resolveTerminalSettings: невалидные значения', () => {
  it('невалидный env игнорируется (как «не задано»)', () => {
    const resolved = resolveTerminalSettings({
      config: { idleMinutes: 60, maxPerProject: 2, maxPerInstance: 3, auditInput: false },
      runtime: { shell: '/bin/zsh' },
      env: {
        [TERMINAL_ENABLED_ENV]: 'maybe',
        [TERMINAL_IDLE_MINUTES_ENV]: 'не-число',
        [TERMINAL_MAX_PER_PROJECT_ENV]: '60.5',
        [TERMINAL_MAX_PER_INSTANCE_ENV]: '0',
        [TERMINAL_SHELL_ENV]: '/bin/my shell',
        [TERMINAL_AUDIT_INPUT_ENV]: 'yes',
      },
    });

    expect(resolved.enabled).toBe(DEFAULT_TERMINAL_ENABLED);
    expect(resolved.idleMinutes).toBe(60);
    expect(resolved.maxPerProject).toBe(2);
    expect(resolved.maxPerInstance).toBe(3);
    expect(resolved.shell).toBe('/bin/zsh');
    expect(resolved.auditInput).toBe(false);
    // Ни одно значение из env не применилось — фиксации нет.
    expect(resolved.envLocked).toBe(false);
    expect(Object.values(resolved.envLock).every((locked) => locked === false)).toBe(true);
  });

  it('env вне границ диапазона игнорируется', () => {
    const resolved = resolveTerminalSettings({
      env: {
        [TERMINAL_IDLE_MINUTES_ENV]: '10081',
        [TERMINAL_MAX_PER_PROJECT_ENV]: '65',
        [TERMINAL_MAX_PER_INSTANCE_ENV]: '257',
      },
    });

    expect(resolved.idleMinutes).toBe(DEFAULT_TERMINAL_IDLE_MINUTES);
    expect(resolved.maxPerProject).toBe(DEFAULT_TERMINAL_MAX_PER_PROJECT);
    expect(resolved.maxPerInstance).toBe(DEFAULT_TERMINAL_MAX_PER_INSTANCE);
    expect(resolved.sources.idleMinutes).toBe('default');
  });

  it('невалидные runtime/config значения отбрасываются (следующий слой)', () => {
    const resolved = resolveTerminalSettings({
      config: { idleMinutes: 60, maxPerProject: 1 },
      runtime: {
        idleMinutes: 10, // ниже 30
        maxPerProject: 999, // выше 64
        maxPerInstance: 0, // ниже 1
        shell: 'sh -c', // не проходит паттерн
        enabled: 'yes' as unknown as boolean, // мусор в settings.json
      },
      env: NO_ENV,
    });

    // runtime отброшен целиком по невалидным полям — работает config/default.
    expect(resolved.idleMinutes).toBe(60);
    expect(resolved.maxPerProject).toBe(1);
    expect(resolved.maxPerInstance).toBe(DEFAULT_TERMINAL_MAX_PER_INSTANCE);
    expect(resolved.shell).toBeNull();
    expect(resolved.enabled).toBe(DEFAULT_TERMINAL_ENABLED);
    expect(resolved.sources.idleMinutes).toBe('config');
    expect(resolved.sources.maxPerInstance).toBe('default');
    expect(resolved.sources.shell).toBe('default');
    expect(resolved.sources.enabled).toBe('default');
  });

  it('дробный номер в config отбрасывается', () => {
    const resolved = resolveTerminalSettings({
      config: { idleMinutes: 60.5, maxPerProject: 2.5 },
      env: NO_ENV,
    });

    expect(resolved.idleMinutes).toBe(DEFAULT_TERMINAL_IDLE_MINUTES);
    expect(resolved.maxPerProject).toBe(DEFAULT_TERMINAL_MAX_PER_PROJECT);
    expect(resolved.defaults.idleMinutes).toBe(DEFAULT_TERMINAL_IDLE_MINUTES);
  });
});

describe('resolveTerminalSettings: shell', () => {
  it('пустая строка и пробелы из runtime/config → null (платформенный дефолт)', () => {
    const empty = resolveTerminalSettings({ config: { shell: '' }, env: NO_ENV });
    expect(empty.shell).toBeNull();
    expect(empty.sources.shell).toBe('config');
    expect(empty.defaults.shell).toBeNull();

    const spaces = resolveTerminalSettings({ runtime: { shell: '   ' }, env: NO_ENV });
    expect(spaces.shell).toBeNull();
    expect(spaces.sources.shell).toBe('runtime');
  });

  it('явный null в runtime сбрасывает shell из config', () => {
    const resolved = resolveTerminalSettings({
      config: { shell: '/bin/sh' },
      runtime: { shell: null },
      env: NO_ENV,
    });

    expect(resolved.shell).toBeNull();
    expect(resolved.sources.shell).toBe('runtime');
    expect(resolved.defaults.shell).toBe('/bin/sh');
  });

  it('trim вокруг валидного значения', () => {
    const resolved = resolveTerminalSettings({
      runtime: { shell: '  /bin/bash  ' },
      env: NO_ENV,
    });
    expect(resolved.shell).toBe('/bin/bash');
  });

  it('пустой env-значение shell — «не задано»', () => {
    const resolved = resolveTerminalSettings({
      config: { shell: '/bin/sh' },
      env: { [TERMINAL_SHELL_ENV]: '   ' },
    });
    expect(resolved.shell).toBe('/bin/sh');
    expect(resolved.envLock.shell).toBe(false);
  });
});

describe('resolveTerminalSettings: совместимость плоских параметров', () => {
  it('плоские configEnabled/configAutoRestore работают', () => {
    const resolved = resolveTerminalSettings({
      configEnabled: false,
      configAutoRestore: false,
      env: NO_ENV,
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.autoRestore).toBe(false);
    expect(resolved.sources.enabled).toBe('config');
    expect(resolved.sources.autoRestore).toBe('config');
    expect(resolved.defaults.enabled).toBe(false);
    expect(resolved.defaults.autoRestore).toBe(false);
  });

  it('плоские runtimeEnabled/runtimeAutoRestore работают', () => {
    const resolved = resolveTerminalSettings({
      configEnabled: false,
      runtimeEnabled: true,
      runtimeAutoRestore: false,
      env: NO_ENV,
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.sources.enabled).toBe('runtime');
    expect(resolved.autoRestore).toBe(false);
    expect(resolved.sources.autoRestore).toBe('runtime');
  });

  it('объектные config/runtime приоритетнее плоских', () => {
    const resolved = resolveTerminalSettings({
      config: { enabled: true },
      configEnabled: false,
      runtime: { enabled: false },
      runtimeEnabled: true,
      env: NO_ENV,
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe('runtime');
  });

  it('плоский runtime не перекрывает env', () => {
    const resolved = resolveTerminalSettings({
      runtimeEnabled: false,
      env: { [TERMINAL_ENABLED_ENV]: '1' },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.envLock.enabled).toBe(true);
  });
});

describe('env-имена секции terminal', () => {
  it('совпадают с реестром ENV_OVERRIDES (общее правило секций)', () => {
    const terminalDefs = ENV_OVERRIDES.filter((def) => def.section === 'terminal');

    const byKey = new Map(terminalDefs.map((def) => [def.key, envOverrideName(def)]));
    expect(byKey.get('enabled')).toBe(TERMINAL_ENABLED_ENV);
    expect(byKey.get('autoRestore')).toBe(TERMINAL_AUTO_RESTORE_ENV);
    expect(byKey.get('idleMinutes')).toBe(TERMINAL_IDLE_MINUTES_ENV);
    expect(byKey.get('maxPerProject')).toBe(TERMINAL_MAX_PER_PROJECT_ENV);
    expect(byKey.get('maxPerInstance')).toBe(TERMINAL_MAX_PER_INSTANCE_ENV);
    expect(byKey.get('shell')).toBe(TERMINAL_SHELL_ENV);
    expect(byKey.get('auditInput')).toBe(TERMINAL_AUDIT_INPUT_ENV);
  });
});
