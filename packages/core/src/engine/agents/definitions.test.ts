/**
 * Инвариант «все встроенные агенты корректны»: у каждого агента с непустым
 * `contextFile` ролевой промпт существует **и в RU, и в EN**, а у агента без
 * `contextFile` (саб-агент) существует собственный файл `prompts/subagents/<id>.{ru,en}.md`.
 *
 * Дефект, который этот тест закрывает: при переименовании роли (как замена
 * набора `pm`/`developer`/`qa`/`analyst`/`auditor` на `leader`/`fixer`/`tester`/
 * `researcher`/`security-auditor`) файл `prompts/roles/<ROLE>.{ru,en}.md` мог
 * остаться со старым именем, а `contextFile` в определении — указывать на новый.
 * Тогда `ContextConfig.getRolePrompt` молча не находил файл, и агент работал без
 * ролевой инструкции (блок `role` подменялся общим `ROLES_DESCRIPTION`).
 *
 * Промпт саб-агента задаётся **только файлами** (`resolveSubagentPrompt`):
 * `prompts/subagents/<id>.*` → `prompts/roles/<ID>.*`; наследуемого поля
 * промпта в определении агента больше нет (`agent.ts`), поэтому отсутствие файла = пустой промпт.
 *
 * Тест падает, если роль переименовали/удалили файл, но не поправили агента.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSystemAgentDefinitions } from './index.js';

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'prompts',
);
const ROLES_DIR = join(PROMPTS_DIR, 'roles');
const SUBAGENTS_DIR = join(PROMPTS_DIR, 'subagents');

/**
 * Кандидаты имени ролевого файла — та же логика, что у
 * `ContextConfig.getRolePrompt`: `contextFile` может быть с `.md` (`LEADER.md`)
 * или без расширения (`title`), а системные файлы ролей лежат в верхнем
 * регистре (`TITLE.ru.md` — так их читает `sessions/auto-title.ts`).
 */
function roleFileCandidates(contextFile: string, language: 'ru' | 'en'): string[] {
  const withExtension = /\.md$/i.test(contextFile) ? contextFile : `${contextFile}.md`;
  const stem = withExtension.replace(/\.md$/i, '');
  return [`${stem}.${language}.md`, `${stem.toUpperCase()}.${language}.md`];
}

function findRoleFile(contextFile: string, language: 'ru' | 'en'): string | null {
  return (
    roleFileCandidates(contextFile, language).find((name) => existsSync(join(ROLES_DIR, name))) ??
    null
  );
}

/**
 * PROP-135 Ф6a: встроенные профили исполнения. До этого у встроенных агентов
 * полей `executorProfile`/`allowedProfiles` не было вовсе: профиль выбирался
 * только сессией/проектом, а роли (лёгкие исследователи, devops/admin) не могли
 * закрепить свой профиль и потолок. Таблица — решение владельца: тяжёлые роли
 * по умолчанию на `default`, лёгкие — на `light`, инфраструктурные — `devops`.
 */
describe('Встроенные агенты: профили исполнения (PROP-135 Ф6a)', () => {
  const agents = new Map(loadSystemAgentDefinitions().map((agent) => [agent.id, agent]));

  const EXPECTED: Record<string, { executorProfile: string; allowedProfiles: string[] }> = {
    leader: { executorProfile: 'default', allowedProfiles: ['default', 'light', 'devops'] },
    fixer: { executorProfile: 'default', allowedProfiles: ['default', 'light'] },
    tester: { executorProfile: 'default', allowedProfiles: ['default', 'light'] },
    general: { executorProfile: 'default', allowedProfiles: ['default', 'light'] },
    assistant: { executorProfile: 'default', allowedProfiles: ['default', 'light'] },
    researcher: { executorProfile: 'light', allowedProfiles: ['light', 'default'] },
    explore: { executorProfile: 'light', allowedProfiles: ['light'] },
    'security-auditor': { executorProfile: 'light', allowedProfiles: ['light', 'default'] },
    devops: { executorProfile: 'devops', allowedProfiles: ['devops', 'default'] },
    admin: { executorProfile: 'devops', allowedProfiles: ['devops', 'default'] },
  };

  it('у каждого агента таблицы — ожидаемые профиль и потолок', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const agent = agents.get(id);
      expect(agent, `агент «${id}» отсутствует`).toBeDefined();
      expect(agent!.executorProfile, `executorProfile «${id}»`).toBe(expected.executorProfile);
      expect(agent!.allowedProfiles, `allowedProfiles «${id}»`).toEqual(expected.allowedProfiles);
    }
  });

  it('системный генератор заголовков профилей не имеет', () => {
    const title = agents.get('title');
    expect(title).toBeDefined();
    expect(title!.executorProfile).toBeUndefined();
    expect(title!.allowedProfiles).toBeUndefined();
  });

  it('leader может исполняться на devops', () => {
    expect(agents.get('leader')!.allowedProfiles).toContain('devops');
  });

  it('профиль по умолчанию агента входит в его потолок разрешённых', () => {
    for (const [id, expected] of Object.entries(EXPECTED)) {
      expect(
        expected.allowedProfiles,
        `executorProfile «${id}» вне allowedProfiles`,
      ).toContain(expected.executorProfile);
    }
  });
});

describe('Определения встроенных агентов: ролевые файлы и файлы саб-агентов RU/EN', () => {
  const agents = loadSystemAgentDefinitions();

  it('набор встроенных агентов не пуст', () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it('у каждого агента с contextFile есть и RU-, и EN-версия роли', () => {
    const withRole = agents.filter((a) => (a.contextFile ?? '') !== '');
    expect(withRole.length).toBeGreaterThan(0);

    for (const agent of withRole) {
      const contextFile = agent.contextFile!;
      for (const language of ['ru', 'en'] as const) {
        const found = findRoleFile(contextFile, language);
        expect(
          found,
          `агент «${agent.id}»: нет ролевого файла ${language} для contextFile «${contextFile}» ` +
            `(искали: ${roleFileCandidates(contextFile, language).join(', ')})`,
        ).not.toBeNull();
      }
    }
  });

  it('агенты без contextFile — промпт только файлами: prompts/subagents/<id>.{ru,en}.md существуют', () => {
    const withoutRole = agents.filter((a) => (a.contextFile ?? '') === '');
    // У встроенных саб-агентов (general/explore) нет ролевого файла —
    // их промпт обязан лежать в `prompts/subagents/`, иначе роль пустая.
    expect(withoutRole.length).toBeGreaterThan(0);
    for (const agent of withoutRole) {
      for (const language of ['ru', 'en'] as const) {
        const path = join(SUBAGENTS_DIR, `${agent.id}.${language}.md`);
        expect(
          existsSync(path),
          `агент «${agent.id}»: нет файла промпта ${language} (ожидался ${path})`,
        ).toBe(true);
      }
    }
  });
});
