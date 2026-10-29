import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentRegistry,
  registerStoredAgents,
  loadSystemAgentDefinitions,
  migrateLegacyStoredAgents,
  LEGACY_AGENT_ROLE_ALIASES,
  resolveAgentRoleAlias,
} from './index.js';
import { MemoryDocumentRepository } from '../../storage/memory/document-repository.js';
import type { AgentDefinition } from '@itphx/synth-shared';

/**
 * ADR-096 + ADR-086 §5: стор агентов — не обязательно файлы в
 * `{dataDir}/agents` (при `storage.backend=postgres` это БД), а `createAgentRegistry`
 * читает только файловый каталог. `registerStoredAgents` — общий шов: определения
 * из стора попадают в реестр с той же семантикой merge, что и в
 * `GET /api/v2/agents` (`server/routes/agents.ts`, `resolveAgents`).
 */
describe('registerStoredAgents', () => {
  let overridesDir: string;

  beforeEach(async () => {
    overridesDir = await mkdtemp(join(tmpdir(), 'synth-stored-agents-'));
  });

  afterEach(async () => {
    await rm(overridesDir, { recursive: true, force: true });
  });

  function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id,
      displayName: id,
      capabilities: [],
      enabled: true,
      isOverridden: true,
      ...extra,
    };
  }

  it('агент, лежащий только в сторе, регистрируется в реестре', async () => {
    // Стор — как при storage.backend=postgres: агент есть в БД, файла в
    // `{dataDir}/agents` нет.
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save('publisher', agent('publisher', {
      displayName: 'Publisher',
      contextFile: 'PUBLISHER.md',
      agentMode: ['primary'],
    }));

    const registry = createAgentRegistry(undefined, overridesDir);
    expect(registry.get('publisher')).toBeUndefined();

    registerStoredAgents(registry, await store.list());

    const stored = registry.get('publisher');
    expect(stored).toBeDefined();
    expect(stored!.displayName).toBe('Publisher');
    expect(stored!.contextFile).toBe('PUBLISHER.md');
    expect(stored!.agentMode).toEqual(['primary']);
    // Находится по id — резолвер `agentTemplate` (deps) сможет его отдать.
    expect(registry.list().map((a) => a.id)).toContain('publisher');
  });

  it('запись из стора с id встроенного агента перекрывает встроенное определение', () => {
    const registry = createAgentRegistry(undefined, overridesDir);
    const builtinBefore = registry.get('assistant');
    expect(builtinBefore).toBeDefined();
    expect(builtinBefore!.isOverridden).toBe(false);

    registerStoredAgents(registry, [
      agent('assistant', { displayName: 'Мой ассистент', contextFile: 'MY_ASSISTANT.md' }),
    ]);

    const merged = registry.get('assistant');
    expect(merged).toBeDefined();
    // Поля записи из стора выигрывают.
    expect(merged!.displayName).toBe('Мой ассистент');
    expect(merged!.contextFile).toBe('MY_ASSISTANT.md');
    expect(merged!.isOverridden).toBe(true);
    // Поля, которых нет в записи, у встроенного сохраняются (merge, как в API).
    expect(merged!.icon).toBe(builtinBefore!.icon);
    expect(merged!.color).toBe(builtinBefore!.color);
  });

  it('custom-агент из стора регистрируется с isOverridden: true', () => {
    const registry = createAgentRegistry(undefined, overridesDir);

    registerStoredAgents(registry, [
      agent('publisher', { displayName: 'Publisher', isOverridden: false }),
    ]);

    const stored = registry.get('publisher');
    expect(stored).toBeDefined();
    expect(stored!.isOverridden).toBe(true);
    expect(stored!.displayName).toBe('Publisher');
  });

  it('запись без id пропускается', () => {
    const registry = createAgentRegistry(undefined, overridesDir);
    const before = registry.list().length;

    registerStoredAgents(registry, [
      { ...agent('x'), id: '' } as AgentDefinition,
      { ...agent('y'), id: undefined } as unknown as AgentDefinition,
      null as unknown as AgentDefinition,
      'битая запись' as unknown as AgentDefinition,
    ]);

    expect(registry.list().length).toBe(before);
    expect(registry.get('')).toBeUndefined();
  });

  it('пустой список и не-массив — без падения', () => {
    const registry = createAgentRegistry(undefined, overridesDir);
    const before = registry.list().length;

    expect(() => registerStoredAgents(registry, [])).not.toThrow();
    expect(() =>
      registerStoredAgents(registry, undefined as unknown as AgentDefinition[]),
    ).not.toThrow();
    expect(() =>
      registerStoredAgents(registry, 'битый список' as unknown as AgentDefinition[]),
    ).not.toThrow();

    expect(registry.list().length).toBe(before);
  });

  it('повторная регистрация идемпотентна', () => {
    const registry = createAgentRegistry(undefined, overridesDir);
    const stored = [agent('publisher', { displayName: 'Publisher' })];

    registerStoredAgents(registry, stored);
    const first = registry.get('publisher');
    registerStoredAgents(registry, stored);
    const second = registry.get('publisher');

    expect(second).toEqual(first);
    expect(registry.list().length).toBe(
      createAgentRegistry(undefined, overridesDir).list().length + 1,
    );
  });

  it('файловое хранилище: регистрация из стора не меняет результат (каталог и стор — одно)', async () => {
    // Файловое хранилище: стор агентов — это файлы в `{dataDir}/agents`,
    // которые `createAgentRegistry` уже читает как overridesDir.
    const fileAgent = agent('assistant', {
      displayName: 'Ассистент из файла',
      contextFile: 'FILE_ASSISTANT.md',
    });
    await writeFile(
      join(overridesDir, 'assistant.json'),
      JSON.stringify(fileAgent),
      'utf-8',
    );

    const registry = createAgentRegistry(undefined, overridesDir);
    const before = registry.get('assistant');

    // Тот же список, что вернул бы стор (файловый JsonStore).
    registerStoredAgents(registry, [fileAgent]);

    const after = registry.get('assistant');
    expect(after).toEqual(before);
    expect(after!.displayName).toBe('Ассистент из файла');
    expect(after!.contextFile).toBe('FILE_ASSISTANT.md');
    expect(after!.isOverridden).toBe(true);
  });

  it('отключённый агент из стора остаётся отключённым (реестр его не отдаёт)', () => {
    const registry = createAgentRegistry(undefined, overridesDir);

    registerStoredAgents(registry, [agent('publisher', { enabled: false })]);

    expect(registry.get('publisher')).toBeDefined();
    expect(registry.get('publisher')!.enabled).toBe(false);
    expect(registry.list().map((a) => a.id)).not.toContain('publisher');
  });
});

/**
 * Миграция устаревших stored-агентов: прежний набор ролей
 * (`pm`/`developer`/`qa`/`analyst`/`auditor`) заменён на
 * `leader`/`fixer`/`tester`/`researcher`/`security-auditor`.
 *
 * В сторе (при `storage.backend=postgres` — БД) оставалась полная копия старого
 * встроенного агента `pm`: PM-идентичность и PM-права (`file_write`/`git_write`,
 * `maxSteps: 0`) при вручную подменённом на `LEADER.ru.md` `contextFile`. В
 * списке агентов оказывались две роли, а `pm` работал как LEADER с правами PM.
 */
describe('migrateLegacyStoredAgents', () => {
  /** Запись `pm` из стора тестового инстанса (усечённая копия старого агента). */
  function legacyPm(extra: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id: 'pm',
      displayName: 'Менеджер проекта',
      description: 'Планирование, анализ требований…',
      capabilities: [
        'file_read',
        'file_write',
        'search',
        'git_read',
        'git_write',
        'task',
        'mcp',
        'runtime',
        'memory',
      ] as AgentDefinition['capabilities'],
      icon: 'clipboard',
      color: '--primary',
      contextFile: 'LEADER.ru.md',
      maxSteps: 0,
      provider: 'itphx',
      model: 'm1',
      temperature: 0.4,
      topP: 0.9,
      enabled: true,
      isOverridden: true,
      ...extra,
    };
  }

  function builtin(id: string): AgentDefinition {
    const found = loadSystemAgentDefinitions().find((a) => a.id === id);
    if (!found) throw new Error(`встроенный агент ${id} не найден`);
    return found;
  }

  it('pm-запись мигрирует в leader: идентичность, права и промпт — встроенные', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save('pm', legacyPm());

    const migrated = await migrateLegacyStoredAgents(store);

    expect(migrated).toEqual(['pm→leader']);
    expect(await store.exists('pm')).toBe(false);

    const leader = (await store.load('leader'))!;
    const builtinLeader = builtin('leader');
    expect(leader.id).toBe('leader');
    // Идентичность и промпт — встроенные (PM-описание и подменённый
    // `LEADER.ru.md` не переносятся).
    expect(leader.displayName).toBe(builtinLeader.displayName);
    expect(leader.description).toBe(builtinLeader.description);
    expect(leader.contextFile).toBe('LEADER.md');
    // Права — встроенные: PM-права (`file_write`/`git_write`) не переезжают.
    expect(leader.capabilities).toEqual(builtinLeader.capabilities);
    expect(leader.capabilities).not.toContain('file_write');
    expect(leader.capabilities).not.toContain('git_write');
    // Лимиты шагов — встроенные (у `pm` было `maxSteps: 0` — без ограничений).
    expect(leader.maxSteps).toBe(builtinLeader.maxSteps);
    // Запись сохранена как пользовательская (override встроенного).
    expect(leader.isOverridden).toBe(true);
  });

  it('переносятся пользовательские настройки: enabled, provider/model, сэмплинг, groups', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save(
      'pm',
      legacyPm({ enabled: false, temperature: 0.2, topK: 40, reasoningLevel: 'high' }),
    );

    await migrateLegacyStoredAgents(store);
    const leader = (await store.load('leader'))!;

    expect(leader.enabled).toBe(false);
    expect(leader.provider).toBe('itphx');
    expect(leader.model).toBe('m1');
    expect(leader.temperature).toBe(0.2);
    expect(leader.topP).toBe(0.9);
    expect(leader.topK).toBe(40);
    expect(leader.reasoningLevel).toBe('high');
  });

  it('существующая запись целевого агента не перетирается, устаревшая удаляется', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save('pm', legacyPm());
    await store.save('leader', {
      ...builtin('leader'),
      displayName: 'Мой лидер',
      model: 'custom-model',
      isOverridden: true,
    });

    const migrated = await migrateLegacyStoredAgents(store);

    expect(migrated).toEqual(['pm→leader']);
    const leader = (await store.load('leader'))!;
    expect(leader.displayName).toBe('Мой лидер');
    expect(leader.model).toBe('custom-model');
    // Устаревшая запись удалена — в списке агентов остаётся одна роль.
    expect(await store.exists('pm')).toBe(false);
  });

  it('повторный вызов идемпотентен', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save('pm', legacyPm());

    expect(await migrateLegacyStoredAgents(store)).toEqual(['pm→leader']);
    expect(await migrateLegacyStoredAgents(store)).toEqual([]);
    expect((await store.list()).map((a) => a.id)).toEqual(['leader']);
  });

  it('запись без id и чужие id не ломают миграцию', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    await store.save('pm', legacyPm());
    await store.save('publisher', {
      id: 'publisher',
      displayName: 'Publisher',
      capabilities: [],
      enabled: true,
      isOverridden: true,
    });
    // Запись без id (битая) — в том же сторе.
    await store.save('broken', { displayName: 'Без id' } as unknown as AgentDefinition);

    const migrated = await migrateLegacyStoredAgents(store);

    expect(migrated).toEqual(['pm→leader']);
    // Чужие записи на месте.
    expect((await store.load('publisher'))!.displayName).toBe('Publisher');
    expect(await store.exists('broken')).toBe(true);
  });

  it('алиасы прежнего набора полные и ведут на встроенных агентов', () => {
    expect(LEGACY_AGENT_ROLE_ALIASES).toEqual({
      pm: 'leader',
      developer: 'fixer',
      qa: 'tester',
      analyst: 'researcher',
      auditor: 'security-auditor',
    });
    const ids = new Set(loadSystemAgentDefinitions().map((a) => a.id));
    for (const [legacy, target] of Object.entries(LEGACY_AGENT_ROLE_ALIASES)) {
      expect(resolveAgentRoleAlias(legacy)).toBe(target);
      expect(ids.has(target), `${legacy} → ${target}`).toBe(true);
    }
    // Актуальные роли алиасами не являются.
    expect(resolveAgentRoleAlias('leader')).toBeUndefined();
    expect(resolveAgentRoleAlias(undefined)).toBeUndefined();
  });

  it('developer/qa/analyst/auditor мигрируют в свои актуальные роли', async () => {
    const store = new MemoryDocumentRepository<AgentDefinition>();
    for (const legacy of Object.keys(LEGACY_AGENT_ROLE_ALIASES)) {
      await store.save(legacy, {
        id: legacy,
        displayName: legacy,
        capabilities: [],
        enabled: true,
        isOverridden: true,
        model: `model-${legacy}`,
      });
    }

    const migrated = await migrateLegacyStoredAgents(store);

    expect(migrated.sort()).toEqual(
      Object.entries(LEGACY_AGENT_ROLE_ALIASES)
        .map(([legacy, target]) => `${legacy}→${target}`)
        .sort(),
    );
    for (const target of Object.values(LEGACY_AGENT_ROLE_ALIASES)) {
      expect((await store.load(target))!.isOverridden).toBe(true);
    }
    // Прежних id в сторе больше нет.
    for (const legacy of Object.keys(LEGACY_AGENT_ROLE_ALIASES)) {
      expect(await store.exists(legacy)).toBe(false);
    }
  });
});
