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
