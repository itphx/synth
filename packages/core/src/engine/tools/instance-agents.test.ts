/**
 * Самообслуживание реестра агентов из чата: `synth_agent_*`.
 *
 * Покрытие — паритет с HTTP-роутами `createAgentRoutes`:
 * - CRUD-цикл на фейковом порту `DocumentRepository` (list/get/save/enable/delete,
 *   сброс override встроенного агента);
 * - запись ролевого промпта через порт `ContextFileRepository` с отчётом
 *   `role {file, written, replaced}`;
 * - plan-режим: write-имена блокирует permission-слой, чтения остаются;
 * - валидация (`agent.invalid_id`, `agent.invalid_effort`, `agent.invalid_role_file`);
 * - импорт opencode-подобного markdown (frontmatter → определение, `permissions` →
 *   capabilities, `action: subagent` + `effect: deny` → без `task`, `dry_run`);
 * - ADMIN-гейт: роль `ADMIN`, локальный владелец standalone, отказы LEAD/USER и
 *   отсутствие принципала;
 * - событие шины `agents.updated` (инстансный канал) на всех write-тулах —
 *   панель и селекты агента в UI перечитывают состав без перезагрузки страницы;
 *   без `eventBus` в `extra` тулы работают как раньше (событий нет, падений нет).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCapability, type AgentDefinition, type ToolContext } from '@itphx/synth-shared';
import {
  synthAgentListTool,
  synthAgentGetTool,
  synthAgentSaveTool,
  synthAgentDeleteTool,
  synthAgentEnableTool,
  synthAgentImportTool,
} from './instance-agents.js';
import { loadSystemAgentDefinitions } from '../agents/index.js';
import { computeToolAvailability } from '../permission/availability.js';
import type { DocumentRepository } from '../../storage/ports/document-repository.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { ToolPrincipal } from './project-resolve.js';
import { LOCAL_USER_ID } from '../../server/local-owner.js';
import { PermissionEvaluator, isPlanBlockedTool } from '../permission/evaluator.js';
import { AGENTS_READ_TOOLS, AGENTS_WRITE_TOOLS } from '../permission/groups.js';

interface FakeAgentStore {
  docs: Map<string, AgentDefinition>;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

/** Порт `DocumentRepository<AgentDefinition>` на `Map` (без ФС). */
function makeStore(initial: AgentDefinition[] = []): FakeAgentStore {
  const store: FakeAgentStore = {
    docs: new Map(initial.map((agent) => [agent.id, agent])),
    load: vi.fn(async (key: string) => store.docs.get(key) ?? null),
    save: vi.fn(async (key: string, value: AgentDefinition) => {
      store.docs.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.docs.delete(key);
    }),
    exists: vi.fn(async (key: string) => store.docs.has(key)),
    list: vi.fn(async () => [...store.docs.values()]),
  };
  return store;
}

interface FakeRoleFiles {
  files: Map<string, string>;
  getFile: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
}

/** Порт файлов контекста: ролевые промпты в памяти. */
function makeRoleFiles(initial: Record<string, string> = {}): FakeRoleFiles {
  const files = new Map(Object.entries(initial));
  return {
    files,
    getFile: vi.fn((filename: string, category: string) => (
      files.has(filename)
        ? {
          filename,
          content: files.get(filename)!,
          isSystem: false,
          isOverridden: true,
          category,
        }
        : null
    )),
    saveFile: vi.fn(async (filename: string, content: string) => {
      files.set(filename, content);
      return true;
    }),
  };
}

interface FakeAgentRegistry {
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

function makeAgentRegistry(): FakeAgentRegistry {
  return { register: vi.fn(), unregister: vi.fn() };
}

const STANDALONE_META = { mode: 'standalone' } as unknown as InstanceRuntimeMeta;
const MANAGED_META = { mode: 'managed' } as unknown as InstanceRuntimeMeta;

/** Записанная публикация фейковой шины (канал всегда инстансный). */
interface PublishedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: только `publishInstance` (контракт `InstanceEventPublisherLike`). */
function makeEventBus(): { publishInstance: ReturnType<typeof vi.fn>; events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  const publishInstance = vi.fn((type: string, data: Record<string, unknown> = {}) => {
    events.push({ type, data });
  });
  return { publishInstance, events };
}

const ADMIN_PRINCIPAL: ToolPrincipal = { userId: 'u1', roles: ['ADMIN'] };

function makeCtx(opts: {
  store?: FakeAgentStore;
  roleFiles?: FakeRoleFiles;
  registry?: FakeAgentRegistry;
  /** `null` — принципала нет вовсе (fail-closed). */
  principal?: ToolPrincipal | null;
  instanceMeta?: InstanceRuntimeMeta;
  /** Шина событий: без неё — прежнее поведение (без публикаций). */
  eventBus?: { publishInstance: ReturnType<typeof vi.fn> };
} = {}): ToolContext {
  const principal = opts.principal === undefined ? ADMIN_PRINCIPAL : opts.principal;
  return {
    sessionId: 's1',
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: '/work',
    dataDir: '/data',
    extra: {
      agentStore: opts.store as unknown as DocumentRepository<AgentDefinition>,
      agentRegistry: opts.registry as unknown as AgentRegistry,
      contextConfig: opts.roleFiles as unknown as Pick<ContextFileRepository, 'getFile' | 'saveFile'>,
      instanceMeta: opts.instanceMeta,
      ...(opts.eventBus ? { eventBus: opts.eventBus } : {}),
      ...(principal ? { principal } : {}),
    },
  } as unknown as ToolContext;
}

/** Ключ i18n из результата тула (все сообщения — через `system-messages`). */
function i18nKey(result: { metadata?: Record<string, unknown> }): string | undefined {
  return (result.metadata?.i18n as { key?: string } | undefined)?.key;
}

describe('synth_agent_list / synth_agent_get', () => {
  it('список: встроенные определения + записи стора, сводка DTO роутов', async () => {
    const store = makeStore([
      { id: 'custom-agent', displayName: 'Custom', capabilities: [ToolCapability.FILE_READ] } as AgentDefinition,
    ]);
    const result = await synthAgentListTool.execute({}, makeCtx({ store }));

    expect(result.isError).toBeUndefined();
    const agents = result.metadata?.agents as Array<Record<string, unknown>>;
    expect(result.metadata?.count).toBe(agents.length);
    const byId = new Map(agents.map((agent) => [agent.id as string, agent]));
    expect(byId.get('admin')?.is_builtin).toBe(true);
    expect(byId.get('custom-agent')).toMatchObject({
      display_name: 'Custom',
      is_builtin: false,
      is_overridden: true,
      capabilities: [ToolCapability.FILE_READ],
    });
  });

  it('встроенный агент с override помечается is_overridden и берёт поля стора', async () => {
    const store = makeStore([
      { id: 'admin', displayName: 'Admin (override)', enabled: false } as AgentDefinition,
    ]);
    const result = await synthAgentListTool.execute({}, makeCtx({ store }));

    const agents = result.metadata?.agents as Array<Record<string, unknown>>;
    const admin = agents.find((agent) => agent.id === 'admin');
    expect(admin).toMatchObject({ display_name: 'Admin (override)', enabled: false, is_overridden: true, is_builtin: true });
  });

  it('get: определение + сведения о роли, содержимое роли — только по include_role', async () => {
    const roleFiles = makeRoleFiles({ 'ADMIN.md': 'Ты админ.' });
    const ctx = makeCtx({ store: makeStore(), roleFiles });

    const withoutBody = await synthAgentGetTool.execute({ id: 'admin' }, ctx);
    expect(withoutBody.isError).toBeUndefined();
    expect(withoutBody.metadata?.role).toMatchObject({ file: 'ADMIN.md', exists: true, source: 'override' });
    expect((withoutBody.metadata?.role as Record<string, unknown>).content).toBeUndefined();

    const withBody = await synthAgentGetTool.execute({ id: 'admin', include_role: true }, ctx);
    expect((withBody.metadata?.role as Record<string, unknown>).content).toBe('Ты админ.');
  });

  it('get: локализованная роль считается найденной (файл — фактически применённый)', async () => {
    // Роль грузится с учётом локали: встроенный `KEEPER.md` может отсутствовать,
    // а применяется `KEEPER.ru.md` — отчёт тула не должен врать про `exists: false`.
    const roleFiles = makeRoleFiles({ 'KEEPER.ru.md': 'Ты хранитель.' });
    const ctx = makeCtx({ store: makeStore(), roleFiles });

    const result = await synthAgentGetTool.execute({ id: 'keeper', include_role: true }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.role).toMatchObject({ file: 'KEEPER.ru.md', exists: true });
    expect((result.metadata?.role as Record<string, unknown>).content).toBe('Ты хранитель.');
  });

  it('get: неизвестный id → agent.not_found со списком доступных', async () => {
    const result = await synthAgentGetTool.execute({ id: 'nope' }, makeCtx({ store: makeStore() }));

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.not_found');
    expect(String(result.content)).toContain('admin');
  });

  it('без порта стора → agent.deps_unavailable', async () => {
    const list = await synthAgentListTool.execute({}, makeCtx());
    expect(list.isError).toBe(true);
    expect(i18nKey(list)).toBe('agent.deps_unavailable');
  });
});

describe('synth_agent_save / enable / delete (CRUD-цикл)', () => {
  let store: FakeAgentStore;
  let roleFiles: FakeRoleFiles;
  let registry: FakeAgentRegistry;

  beforeEach(() => {
    store = makeStore();
    roleFiles = makeRoleFiles();
    registry = makeAgentRegistry();
  });

  const ctx = () => makeCtx({ store, roleFiles, registry });

  it('создание кастомного агента: запись в стор, роль, регистрация в реестре', async () => {
    const created = await synthAgentSaveTool.execute({
      id: 'my-agent',
      display_name: 'My agent',
      capabilities: [ToolCapability.FILE_READ, ToolCapability.AGENTS],
      role_prompt: 'Ты мой агент.',
    }, ctx());

    expect(created.isError).toBeUndefined();
    expect(i18nKey(created)).toBe('agent.save.created');
    expect(created.metadata).toMatchObject({
      id: 'my-agent',
      created: true,
      display_name: 'My agent',
      is_builtin: false,
      role: { file: 'MY-AGENT.md', written: true, replaced: false },
    });
    expect(store.docs.get('my-agent')).toMatchObject({
      id: 'my-agent',
      displayName: 'My agent',
      capabilities: [ToolCapability.FILE_READ, ToolCapability.AGENTS],
    });
    expect(roleFiles.files.get('MY-AGENT.md')).toBe('Ты мой агент.');
    expect(registry.register).toHaveBeenCalledTimes(1);

    // Обновление: `created: false`, роль с тем же содержимым не «перезаписана».
    const updated = await synthAgentSaveTool.execute({
      id: 'my-agent',
      display_name: 'My agent v2',
      role_prompt: 'Ты мой агент.',
    }, ctx());
    expect(i18nKey(updated)).toBe('agent.save.updated');
    expect(updated.metadata).toMatchObject({
      created: false,
      display_name: 'My agent v2',
      role: { file: 'MY-AGENT.md', written: true, replaced: false },
    });
    // Сохранённые ранее capability не теряются (merge с существующей записью).
    expect(store.docs.get('my-agent')?.capabilities).toEqual([
      ToolCapability.FILE_READ,
      ToolCapability.AGENTS,
    ]);
  });

  it('запись роли поверх иного содержимого → replaced: true', async () => {
    roleFiles = makeRoleFiles({ 'MY-AGENT.md': 'Старая роль.' });
    const result = await synthAgentSaveTool.execute({
      id: 'my-agent',
      role_prompt: 'Новая роль.',
    }, ctx());

    expect(result.metadata?.role).toMatchObject({
      file: 'MY-AGENT.md',
      written: true,
      replaced: true,
    });
    expect(roleFiles.files.get('MY-AGENT.md')).toBe('Новая роль.');
  });

  it('override встроенного агента: стор получает запись, поля builtin — как база', async () => {
    const result = await synthAgentSaveTool.execute({
      id: 'admin',
      display_name: 'Админ инстанса',
    }, ctx());

    expect(result.metadata).toMatchObject({ id: 'admin', created: true, is_builtin: true });
    const stored = store.docs.get('admin');
    expect(stored?.displayName).toBe('Админ инстанса');
    // Наследование от builtin: contextFile остаётся, capability — не пустеет.
    expect(stored?.contextFile).toBe('ADMIN.md');
    expect((stored?.capabilities ?? []).length).toBeGreaterThan(0);
  });

  it('enable/disable: флаг в сторе и в реестре', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());

    const disabled = await synthAgentEnableTool.execute({ id: 'my-agent', enabled: false }, ctx());
    expect(disabled.isError).toBeUndefined();
    expect(disabled.metadata).toMatchObject({ id: 'my-agent', enabled: false, is_builtin: false });
    expect(store.docs.get('my-agent')?.enabled).toBe(false);

    const enabled = await synthAgentEnableTool.execute({ id: 'my-agent', enabled: true }, ctx());
    expect(enabled.metadata).toMatchObject({ enabled: true });
    expect(store.docs.get('my-agent')?.enabled).toBe(true);

    const unknown = await synthAgentEnableTool.execute({ id: 'nope', enabled: true }, ctx());
    expect(i18nKey(unknown)).toBe('agent.not_found');
  });

  it('delete: кастомный агент удаляется, встроенный — сбрасывается к builtin', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    const deleted = await synthAgentDeleteTool.execute({ id: 'my-agent' }, ctx());
    expect(deleted.metadata).toMatchObject({ id: 'my-agent', status: 'deleted', is_builtin: false });
    expect(store.docs.has('my-agent')).toBe(false);
    expect(registry.unregister).toHaveBeenCalledWith('my-agent');

    // Встроенный без override — сбрасывать нечего.
    const noOverride = await synthAgentDeleteTool.execute({ id: 'admin' }, ctx());
    expect(noOverride.isError).toBe(true);
    expect(i18nKey(noOverride)).toBe('agent.override_not_found');

    // Встроенный с override — запись снимается, builtin регистрируется обратно.
    await synthAgentSaveTool.execute({ id: 'admin', display_name: 'Админ инстанса' }, ctx());
    const reset = await synthAgentDeleteTool.execute({ id: 'admin' }, ctx());
    expect(reset.metadata).toMatchObject({ id: 'admin', status: 'reset', is_builtin: true });
    expect(store.docs.has('admin')).toBe(false);
    expect(registry.register).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'admin' }));
  });
});

describe('событие agents.updated из write-тулов', () => {
  let store: FakeAgentStore;
  let roleFiles: FakeRoleFiles;
  let registry: FakeAgentRegistry;
  let bus: ReturnType<typeof makeEventBus>;

  beforeEach(() => {
    store = makeStore();
    roleFiles = makeRoleFiles();
    registry = makeAgentRegistry();
    bus = makeEventBus();
  });

  const ctx = () => makeCtx({ store, roleFiles, registry, eventBus: bus });

  it('synth_agent_save (создание) публикует { id, action: save }', async () => {
    const result = await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());

    expect(result.isError).toBeUndefined();
    expect(bus.publishInstance).toHaveBeenCalledTimes(1);
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'save', id: 'my-agent' } },
    ]);
  });

  it('повторный synth_agent_save тем же содержимым событие не публикует', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    bus.events.length = 0;
    bus.publishInstance.mockClear();

    const again = await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    expect(again.isError).toBeUndefined();
    expect(again.metadata).toMatchObject({ created: false });
    expect(bus.publishInstance).not.toHaveBeenCalled();
  });

  it('изменение определения публикует событие повторно', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    bus.events.length = 0;

    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent v2' }, ctx());
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'save', id: 'my-agent' } },
    ]);
  });

  it('правка только роли (определение без изменений) — тоже событие', async () => {
    await synthAgentSaveTool.execute(
      { id: 'my-agent', display_name: 'My agent', role_prompt: 'Первая роль.' },
      ctx(),
    );
    bus.events.length = 0;

    await synthAgentSaveTool.execute(
      { id: 'my-agent', display_name: 'My agent', role_prompt: 'Вторая роль.' },
      ctx(),
    );
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'save', id: 'my-agent' } },
    ]);
  });

  it('synth_agent_delete: custom → delete, встроенный override → reset', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    await synthAgentSaveTool.execute({ id: 'admin', display_name: 'Админ инстанса' }, ctx());
    bus.events.length = 0;

    await synthAgentDeleteTool.execute({ id: 'my-agent' }, ctx());
    await synthAgentDeleteTool.execute({ id: 'admin' }, ctx());
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'delete', id: 'my-agent' } },
      { type: 'agents.updated', data: { action: 'reset', id: 'admin' } },
    ]);
  });

  it('synth_agent_enable публикует enable только при реальной смене', async () => {
    await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    bus.events.length = 0;

    // Тот же флаг (true) — ничего не изменилось.
    await synthAgentEnableTool.execute({ id: 'my-agent', enabled: true }, ctx());
    expect(bus.events).toEqual([]);

    await synthAgentEnableTool.execute({ id: 'my-agent', enabled: false }, ctx());
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'enable', id: 'my-agent' } },
    ]);
  });

  it('synth_agent_import публикует { id, action: import }', async () => {
    const result = await synthAgentImportTool.execute({
      content: [
        '---',
        'id: imported-agent',
        'description: Imported agent',
        '---',
        '',
        'Ты импортированный агент.',
      ].join('\n'),
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(bus.events).toEqual([
      { type: 'agents.updated', data: { action: 'import', id: 'imported-agent' } },
    ]);
  });

  it('ошибки валидации и not_found событие не публикуют', async () => {
    const invalid = await synthAgentSaveTool.execute({ id: 'Bad ID' }, ctx());
    expect(invalid.isError).toBe(true);

    const notFound = await synthAgentEnableTool.execute({ id: 'nope', enabled: false }, ctx());
    expect(notFound.isError).toBe(true);

    const noOverride = await synthAgentDeleteTool.execute({ id: 'admin' }, ctx());
    expect(noOverride.isError).toBe(true);

    expect(bus.publishInstance).not.toHaveBeenCalled();
  });
});

describe('write-тулы без eventBus в extra (прежнее поведение)', () => {
  it('save/delete/enable/import работают и не падают', async () => {
    const store = makeStore();
    const roleFiles = makeRoleFiles();
    const registry = makeAgentRegistry();
    const ctx = () => makeCtx({ store, roleFiles, registry });

    const saved = await synthAgentSaveTool.execute({ id: 'my-agent', display_name: 'My agent' }, ctx());
    expect(saved.isError).toBeUndefined();
    expect(store.docs.has('my-agent')).toBe(true);

    const disabled = await synthAgentEnableTool.execute({ id: 'my-agent', enabled: false }, ctx());
    expect(disabled.isError).toBeUndefined();

    const imported = await synthAgentImportTool.execute({
      content: '---\nid: no-bus-agent\n---\n\nРоль.\n',
    }, ctx());
    expect(imported.isError).toBeUndefined();

    const deleted = await synthAgentDeleteTool.execute({ id: 'my-agent' }, ctx());
    expect(deleted.isError).toBeUndefined();
    expect(store.docs.has('my-agent')).toBe(false);
  });
});

describe('валидация аргументов (agent.*)', () => {
  const ctx = () => makeCtx({ store: makeStore(), roleFiles: makeRoleFiles() });

  it('id вне [a-z0-9_-] → agent.invalid_id, стор не тронут', async () => {
    const store = makeStore();
    const result = await synthAgentSaveTool.execute(
      { id: 'Bad ID' },
      makeCtx({ store, roleFiles: makeRoleFiles() }),
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.invalid_id');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('невалидный effort → agent.invalid_effort', async () => {
    const result = await synthAgentSaveTool.execute({ id: 'my-agent', effort: 'super' }, ctx());

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.invalid_effort');
  });

  it('effort из допустимых значений сохраняется, null — сброс в auto', async () => {
    const store = makeStore();
    const saveCtx = () => makeCtx({ store, roleFiles: makeRoleFiles() });
    await synthAgentSaveTool.execute({ id: 'my-agent', effort: 'high' }, saveCtx());
    expect(store.docs.get('my-agent')?.effort).toBe('high');
    await synthAgentSaveTool.execute({ id: 'my-agent', effort: null }, saveCtx());
    expect(store.docs.get('my-agent')?.effort).toBeUndefined();
  });

  it('пустой role_prompt не пишет файл роли (роль — отдельное решение)', async () => {
    const store = makeStore();
    const roleFiles = makeRoleFiles();
    const result = await synthAgentSaveTool.execute(
      { id: 'no-role', role_prompt: '   ' },
      makeCtx({ store, roleFiles }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.role).toBeNull();
    expect(roleFiles.saveFile).not.toHaveBeenCalled();
    expect(store.docs.get('no-role')?.contextFile).toBeUndefined();
  });

  it('context_file с путём → agent.invalid_role_file', async () => {
    const result = await synthAgentSaveTool.execute(
      { id: 'my-agent', context_file: '../escape.md', role_prompt: 'роль' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.invalid_role_file');
  });
});

describe('synth_agent_import (opencode-подобный markdown)', () => {
  const MD = `---
id: imported-agent
description: Imported agent
mode: all
steps: 12
color: "#ff0000"
permissions:
  - tool: shell
  - tool: read
  - tool: edit
    effect: deny
  - tool: websearch
  - tool: skill
---

Ты импортированный агент.
`;

  it('frontmatter → определение, permissions → capabilities, тело → ролевой промпт', async () => {
    const store = makeStore();
    const roleFiles = makeRoleFiles();
    const result = await synthAgentImportTool.execute(
      { content: MD },
      makeCtx({ store, roleFiles }),
    );

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('agent.import.imported');
    const stored = store.docs.get('imported-agent');
    expect(stored?.maxSteps).toBe(12);
    expect(stored?.color).toBe('#ff0000');
    expect(stored?.description).toBe('Imported agent');
    // `mode: all` → обе роли; `edit: deny` снимает запись файлов.
    expect(stored?.agentMode).toEqual(['primary', 'subagent']);
    expect(stored?.capabilities).toEqual(
      expect.arrayContaining([ToolCapability.SHELL, ToolCapability.FILE_READ, ToolCapability.WEB]),
    );
    expect(stored?.capabilities).not.toContain(ToolCapability.FILE_WRITE);
    // Скиллы capability не имеют — импорт отдаёт предупреждение, а не теряет молча.
    expect(result.metadata?.warnings).toEqual([
      expect.stringContaining('skill'),
    ]);
    const role = roleFiles.files.get('IMPORTED-AGENT.md');
    expect(role).toContain('Ты импортированный агент.');
  });

  it('`permissions` картой (opencode-форма) сохраняет имена разрешений', async () => {
    const store = makeStore();
    const result = await synthAgentImportTool.execute({
      content: `---
id: object-form
permission:
  shell: allow
  edit: deny
  read: allow
---

Роль.
`,
    }, makeCtx({ store, roleFiles: makeRoleFiles() }));

    expect(result.isError).toBeUndefined();
    const stored = store.docs.get('object-form');
    expect(stored?.capabilities).toEqual(
      expect.arrayContaining([ToolCapability.SHELL, ToolCapability.FILE_READ]),
    );
    expect(stored?.capabilities).not.toContain(ToolCapability.FILE_WRITE);
    expect(result.metadata?.warnings).toEqual([]);
  });

  it('`action: subagent` даёт task, `effect: deny` — не даёт', async () => {
    const allowed = makeStore();
    await synthAgentImportTool.execute({
      content: `---
id: subagent-ok
permissions:
  - tool: task
    action: subagent
    effect: allow
---

Роль.
`,
    }, makeCtx({ store: allowed, roleFiles: makeRoleFiles() }));
    expect(allowed.docs.get('subagent-ok')?.capabilities).toContain(ToolCapability.TASK);

    const denied = makeStore();
    await synthAgentImportTool.execute({
      content: `---
id: subagent-denied
permissions:
  - tool: task
    action: subagent
    effect: deny
---

Роль.
`,
    }, makeCtx({ store: denied, roleFiles: makeRoleFiles() }));
    expect(denied.docs.get('subagent-denied')?.capabilities ?? []).not.toContain(ToolCapability.TASK);
  });

  it('dry_run: определение и предупреждения отдаются, но ничего не пишется', async () => {
    const store = makeStore();
    const roleFiles = makeRoleFiles();
    const result = await synthAgentImportTool.execute(
      { content: MD, dry_run: true },
      makeCtx({ store, roleFiles }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({
      dry_run: true,
      id: 'imported-agent',
      role: { file: 'IMPORTED-AGENT.md', written: false },
    });
    expect((result.metadata?.definition as Record<string, unknown>).max_steps).toBe(12);
    expect(store.save).not.toHaveBeenCalled();
    expect(roleFiles.saveFile).not.toHaveBeenCalled();
  });

  it('источник обязателен и однозначен; невалидный frontmatter — понятный код', async () => {
    const ctx = () => makeCtx({ store: makeStore(), roleFiles: makeRoleFiles() });

    const none = await synthAgentImportTool.execute({}, ctx());
    expect(i18nKey(none)).toBe('agent.import.source_required');

    const both = await synthAgentImportTool.execute({ path: 'a.md', content: 'x' }, ctx());
    expect(i18nKey(both)).toBe('agent.import.source_ambiguous');

    const broken = await synthAgentImportTool.execute({
      content: '---\npermissions: [unclosed\n---\n\nтело',
    }, ctx());
    expect(i18nKey(broken)).toBe('agent.import.invalid_frontmatter');
  });

  it('id вне [a-z0-9_-] из frontmatter → agent.invalid_id', async () => {
    const result = await synthAgentImportTool.execute({
      content: '---\nid: Bad ID\n---\n\nтело',
    }, makeCtx({ store: makeStore(), roleFiles: makeRoleFiles() }));

    expect(i18nKey(result)).toBe('agent.invalid_id');
  });
});

describe('ADMIN-гейт write-тулов (isInstanceAdmin)', () => {
  const run = (principal: ToolPrincipal | null, instanceMeta?: InstanceRuntimeMeta) => (
    synthAgentSaveTool.execute(
      { id: 'gate-agent', display_name: 'Gate' },
      makeCtx({ store: makeStore(), roleFiles: makeRoleFiles(), principal, instanceMeta }),
    )
  );

  it('роль ADMIN → операция разрешена', async () => {
    const result = await run(ADMIN_PRINCIPAL);
    expect(result.isError).toBeUndefined();
  });

  it('локальный владелец standalone (principal.userId === local) → разрешена', async () => {
    const result = await run({ userId: LOCAL_USER_ID, roles: [] }, STANDALONE_META);
    expect(result.isError).toBeUndefined();
  });

  it('локальный литерал вне standalone → отказ (роли приходят с сервера)', async () => {
    const result = await run({ userId: LOCAL_USER_ID, roles: [] }, MANAGED_META);
    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.forbidden');
  });

  it('LEAD и USER → отказ', async () => {
    for (const roles of [['LEAD'], ['USER']]) {
      const result = await run({ userId: 'u2', roles }, STANDALONE_META);
      expect(result.isError, roles.join()).toBe(true);
      expect(i18nKey(result), roles.join()).toBe('agent.forbidden');
    }
  });

  it('нет принципала → отказ (fail-closed)', async () => {
    const result = await run(null, STANDALONE_META);
    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.forbidden');
  });

  it('чтения ADMIN-гейта не требуют', async () => {
    const ctx = makeCtx({ store: makeStore(), principal: { userId: 'u2', roles: ['USER'] } });
    const list = await synthAgentListTool.execute({}, ctx);
    expect(list.isError).toBeUndefined();
    const get = await synthAgentGetTool.execute({ id: 'admin' }, ctx);
    expect(get.isError).toBeUndefined();
  });

  it('без порта стора write-тул отдаёт agent.deps_unavailable, а не падает', async () => {
    const result = await synthAgentSaveTool.execute(
      { id: 'gate-agent' },
      makeCtx({ principal: ADMIN_PRINCIPAL }),
    );
    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('agent.deps_unavailable');
  });
});

/**
 * Capability `agents` у встроенных агентов — без неё тулы скрыты от роли
 * (`unavailable(role)`), поэтому проверка идёт через реальный расчёт
 * доступности, а не только по списку capability в определении.
 */
describe('дефолтные агенты — capability agents', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const WITH_AGENTS = ['admin', 'assistant', 'leader', 'devops'];
  const TOOLS = [
    synthAgentListTool,
    synthAgentGetTool,
    synthAgentSaveTool,
    synthAgentDeleteTool,
    synthAgentEnableTool,
    synthAgentImportTool,
  ];

  it.each(WITH_AGENTS)('%s видит все тулы реестра', (id) => {
    const agent = byId.get(id)!;
    expect(agent.capabilities, id).toContain(ToolCapability.AGENTS);
    for (const tool of TOOLS) {
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        agentCapabilities: agent.capabilities,
        sessionMode: 'act',
      });
      expect(availability.available, `${id} → ${tool.name}`).toBe(true);
    }
  });

  it('без capability agents тулы роли не выдаются', () => {
    for (const tool of TOOLS) {
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        agentCapabilities: [ToolCapability.FILE_READ],
        sessionMode: 'act',
      });
      expect(availability.available, tool.name).toBe(false);
    }
  });
});

describe('plan-режим (ADR-025/ADR-029)', () => {
  it('write-имена блокируются, чтения — нет', () => {
    for (const name of AGENTS_WRITE_TOOLS) {
      expect(isPlanBlockedTool(name), name).toBe(true);
    }
    for (const name of AGENTS_READ_TOOLS) {
      expect(isPlanBlockedTool(name, [ToolCapability.AGENTS]), name).toBe(false);
    }
  });

  it('PermissionEvaluator: plan → deny на мутацию, allow на чтение', () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });

    const denied = evaluator.check({
      toolName: 'synth_agent_save',
      params: { id: 'x' },
      workingDir: '/work',
      capabilities: [ToolCapability.AGENTS],
      sessionMode: 'plan',
    });
    expect(denied.action).toBe('deny');
    expect(denied.unavailable?.reason).toBe('mode');

    const allowed = evaluator.check({
      toolName: 'synth_agent_list',
      params: {},
      workingDir: '/work',
      capabilities: [ToolCapability.AGENTS],
      sessionMode: 'plan',
    });
    expect(allowed.action).toBe('allow');
  });

  it('в act-режиме мутация режимом не блокируется', () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });
    const decision = evaluator.check({
      toolName: 'synth_agent_save',
      params: { id: 'x' },
      workingDir: '/work',
      capabilities: [ToolCapability.AGENTS],
      sessionMode: 'act',
    });
    expect(decision.action).toBe('allow');
  });
});
