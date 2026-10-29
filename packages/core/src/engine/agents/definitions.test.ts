/**
 * Инвариант «все встроенные агенты корректны»: у каждого агента с непустым
 * `contextFile` ролевой промпт существует **и в RU, и в EN**.
 *
 * Дефект, который этот тест закрывает: при переименовании роли (как замена
 * набора `pm`/`developer`/`qa`/`analyst`/`auditor` на `leader`/`fixer`/`tester`/
 * `researcher`/`security-auditor`) файл `prompts/roles/<ROLE>.{ru,en}.md` мог
 * остаться со старым именем, а `contextFile` в определении — указывать на новый.
 * Тогда `ContextConfig.getRolePrompt` молча не находил файл, и агент работал без
 * ролевой инструкции (блок `role` подменялся общим `ROLES_DESCRIPTION`).
 *
 * Тест падает, если роль переименовали/удалили файл, но не поправили агента.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSystemAgentDefinitions } from './index.js';

const ROLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'prompts',
  'roles',
);

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

describe('Определения встроенных агентов: ролевые файлы RU/EN', () => {
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

  it('агенты без contextFile (subagentPrompt) — исключение, ролевой файл не требуется', () => {
    const withoutRole = agents.filter((a) => (a.contextFile ?? '') === '');
    // Такие агенты обязаны нести собственный prompt — иначе роль пустая.
    for (const agent of withoutRole) {
      expect(
        (agent.subagentPrompt ?? '').trim().length,
        `агент «${agent.id}»: пустой contextFile и пустой subagentPrompt`,
      ).toBeGreaterThan(0);
    }
  });
});
