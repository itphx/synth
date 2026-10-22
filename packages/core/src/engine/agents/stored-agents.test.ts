import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry, registerStoredAgents } from './index.js';
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
