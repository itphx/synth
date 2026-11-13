/**
 * PROP-135 Ф6a: binding профиля исполнения (сессия → агент → проект → дефолт).
 *
 * Проверяется чистый резолвер: приоритет источников, потолки
 * (`allowedProfiles` проекта/агента), каталог профилей и fail-closed откат на
 * `defaultProfile` с предупреждением. Без конфигурации/K8s — входы подаются
 * напрямую.
 */
import { describe, it, expect } from 'vitest';
import {
  isProfileAllowed,
  resolveBrowserProfile,
  resolveExecutionProfile,
  type ExecutionProfileBindingInput,
} from './profile-binding.js';

/** Минимальный вход: только дефолт (все источники пусты). */
function input(overrides: Partial<ExecutionProfileBindingInput> = {}): ExecutionProfileBindingInput {
  return { defaultProfile: 'default', ...overrides };
}

describe('resolveExecutionProfile: приоритет источников', () => {
  it('session → agent → project → default', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: 's',
      agentProfile: 'a',
      projectProfile: 'p',
    }))).toMatchObject({ profile: 's', source: 'session' });

    expect(resolveExecutionProfile(input({
      agentProfile: 'a',
      projectProfile: 'p',
    }))).toMatchObject({ profile: 'a', source: 'agent' });

    expect(resolveExecutionProfile(input({ projectProfile: 'p' })))
      .toMatchObject({ profile: 'p', source: 'project' });

    expect(resolveExecutionProfile(input()))
      .toMatchObject({ profile: 'default', source: 'default' });
  });

  it('пустые/пробельные значения источников пропускаются', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: '   ',
      agentProfile: '',
      projectProfile: ' p ',
    }))).toMatchObject({ profile: 'p', source: 'project' });
  });

  it('без предупреждения, когда кандидат разрешён', () => {
    const resolution = resolveExecutionProfile(input({
      sessionProfile: 's',
      projectAllowed: ['s', 'p'],
      agentAllowed: ['s'],
    }));
    expect(resolution.warning).toBeUndefined();
    expect(resolution.deniedBy).toBeUndefined();
  });
});

describe('resolveExecutionProfile: потолки (allowedProfiles)', () => {
  it('потолок проекта: профиль вне списка → default + deniedBy=project + warning', () => {
    const resolution = resolveExecutionProfile(input({
      sessionProfile: 'forbidden',
      projectAllowed: ['a', 'b'],
    }));
    expect(resolution).toMatchObject({
      profile: 'default',
      source: 'default',
      deniedBy: 'project',
    });
    expect(resolution.warning).toContain('"forbidden"');
    // Предупреждение без секретов: только имена профилей/источники.
    expect(resolution.warning).not.toMatch(/token|secret|password/i);
  });

  it('потолок агента: профиль вне списка → default + deniedBy=agent', () => {
    const resolution = resolveExecutionProfile(input({
      agentProfile: 'forbidden',
      agentAllowed: ['a'],
    }));
    expect(resolution).toMatchObject({
      profile: 'default',
      source: 'default',
      deniedBy: 'agent',
    });
    expect(resolution.warning).toContain('denied by agent');
  });

  it('оба потолка: профиль обязан входить в каждый непустой список', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: 'a',
      projectAllowed: ['a', 'b'],
      agentAllowed: ['b'],
    })).profile).toBe('default');

    expect(resolveExecutionProfile(input({
      sessionProfile: 'b',
      projectAllowed: ['a', 'b'],
      agentAllowed: ['b'],
    })).profile).toBe('b');
  });

  it('пустой/не заданный потолок = без ограничения (обратная совместимость)', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: 'x',
      projectAllowed: [],
      agentAllowed: [],
    }))).toMatchObject({ profile: 'x', source: 'session' });

    expect(resolveExecutionProfile(input({ sessionProfile: 'x' })))
      .toMatchObject({ profile: 'x', source: 'session' });
  });

  it('запрещённый кандидат пропускается: берётся следующий разрешённый источник', () => {
    const resolution = resolveExecutionProfile(input({
      sessionProfile: 'forbidden',
      agentProfile: 'a',
      projectAllowed: ['a'],
    }));
    expect(resolution).toMatchObject({ profile: 'a', source: 'agent' });
    // Отказ по сессии зафиксирован в предупреждении.
    expect(resolution.warning).toContain('"forbidden"');
  });
});

describe('resolveExecutionProfile: каталог профилей', () => {
  it('неизвестный профиль (не в каталоге) → default + deniedBy=catalog + warning', () => {
    const resolution = resolveExecutionProfile(input({
      sessionProfile: 'ghost',
      knownProfiles: ['default', 'devops'],
    }));
    expect(resolution).toMatchObject({
      profile: 'default',
      source: 'default',
      deniedBy: 'catalog',
    });
    expect(resolution.warning).toContain('"ghost"');
    expect(resolution.warning).toContain('catalog');
  });

  it('известный профиль выбирается; пустой каталог = проверка не применяется', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: 'devops',
      knownProfiles: ['default', 'devops'],
    })).profile).toBe('devops');

    expect(resolveExecutionProfile(input({
      sessionProfile: 'devops',
      knownProfiles: [],
    })).profile).toBe('devops');
  });

  it('неизвестный session-профиль не мешает известному agent-профилю', () => {
    expect(resolveExecutionProfile(input({
      sessionProfile: 'ghost',
      agentProfile: 'devops',
      knownProfiles: ['default', 'devops'],
    }))).toMatchObject({ profile: 'devops', source: 'agent' });
  });
});

describe('isProfileAllowed', () => {
  it('пустые/отсутствующие потолки — разрешено', () => {
    expect(isProfileAllowed('x', {})).toBe(true);
    expect(isProfileAllowed('x', { projectAllowed: [], agentAllowed: [] })).toBe(true);
  });

  it('непустые потолки проверяются', () => {
    expect(isProfileAllowed('x', { projectAllowed: ['x'] })).toBe(true);
    expect(isProfileAllowed('x', { projectAllowed: ['y'] })).toBe(false);
    expect(isProfileAllowed('x', { agentAllowed: ['y'] })).toBe(false);
    expect(isProfileAllowed('x', { projectAllowed: ['x'], agentAllowed: ['y'] })).toBe(false);
  });

  it('пустое имя профиля не разрешено', () => {
    expect(isProfileAllowed('', {})).toBe(false);
    expect(isProfileAllowed('   ', { projectAllowed: [''] })).toBe(false);
  });
});

describe('resolveBrowserProfile: браузерный контур (PROP-135)', () => {
  /** Вход браузерного контура: дефолт инстанса — `browser`. */
  function browserInput(
    overrides: Partial<ExecutionProfileBindingInput> = {},
  ): ExecutionProfileBindingInput {
    return { defaultProfile: 'browser', ...overrides };
  }

  it('приоритет: session → agent → project → default', () => {
    expect(resolveBrowserProfile(browserInput({
      sessionProfile: 's',
      agentProfile: 'a',
      projectProfile: 'p',
    }))).toMatchObject({ profile: 's', source: 'session' });

    expect(resolveBrowserProfile(browserInput({
      agentProfile: 'a',
      projectProfile: 'p',
    }))).toMatchObject({ profile: 'a', source: 'agent' });

    expect(resolveBrowserProfile(browserInput({ projectProfile: 'p' })))
      .toMatchObject({ profile: 'p', source: 'project' });

    expect(resolveBrowserProfile(browserInput()))
      .toMatchObject({ profile: 'browser', source: 'default' });
  });

  it('потолки проекта и агента пересекаются: профиль обязан войти в каждый непустой', () => {
    expect(resolveBrowserProfile(browserInput({
      sessionProfile: 'browser-full',
      projectAllowed: ['browser', 'browser-full'],
      agentAllowed: ['browser-mobile'],
    }))).toMatchObject({ profile: 'browser', source: 'default', deniedBy: 'agent' });

    expect(resolveBrowserProfile(browserInput({
      sessionProfile: 'browser-full',
      projectAllowed: ['browser-full'],
      agentAllowed: ['browser-full', 'browser-mobile'],
    }))).toMatchObject({ profile: 'browser-full', source: 'session' });

    // Пустые потолки — без ограничения (обратная совместимость).
    expect(resolveBrowserProfile(browserInput({
      sessionProfile: 'browser-full',
      projectAllowed: [],
      agentAllowed: [],
    }))).toMatchObject({ profile: 'browser-full', source: 'session' });
  });

  it('запрещённый потолком кандидат не выбирается: берётся следующий/дефолт + warning', () => {
    const resolution = resolveBrowserProfile(browserInput({
      sessionProfile: 'forbidden',
      agentProfile: 'browser-mobile',
      projectAllowed: ['browser-mobile'],
    }));
    expect(resolution).toMatchObject({ profile: 'browser-mobile', source: 'agent' });
    expect(resolution.warning).toContain('Browser profile');
    expect(resolution.warning).toContain('"forbidden"');
    expect(resolution.warning).not.toMatch(/token|secret|password/i);
  });

  it('неизвестный каталогу профиль → дефолт инстанса (fail-closed)', () => {
    const resolution = resolveBrowserProfile(browserInput({
      sessionProfile: 'ghost',
      knownProfiles: ['browser', 'browser-full'],
    }));
    expect(resolution).toMatchObject({
      profile: 'browser',
      source: 'default',
      deniedBy: 'catalog',
    });
    expect(resolution.warning).toContain('"ghost"');
  });

  it('exec-имена не адресуют браузерный пул: неизвестный кандидат отбрасывается', () => {
    // Каталог браузерного контура не содержит `devops` (exec-профиль).
    expect(resolveBrowserProfile(browserInput({
      agentProfile: 'devops',
      knownProfiles: ['browser', 'browser-full'],
    }))).toMatchObject({ profile: 'browser', source: 'default', deniedBy: 'catalog' });
  });
});
