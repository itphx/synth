/**
 * Общие заготовки тестов плагина памяти.
 *
 * Хранилище — **настоящее** in-memory (`createMemoryStorage()` из
 * `@itphx/synth-core`), а не мок: плагин ходит в порты памяти так же, как в
 * инстансе. Мокается только **фасад** (то, что выдаёт хост): блоки и тулы
 * тестируются через тот же контракт, что и в бою.
 */
import type {
  PluginFacade,
  PluginToolDefinition,
  StorageContext,
} from '@itphx/synth-core';
import { createMemoryStorage, createScopedMemory } from '@itphx/synth-core';
import type { PromptBlockProvider } from '@itphx/synth-shared';

/** Имя плагина в тестах (совпадает с именем манифеста `synth.pack`). */
export const TEST_PLUGIN_NAME = 'synth-plugin-memory';

/** Настоящее in-memory хранилище инстанса (порты фактов и индексов). */
export function createTestStorage(): StorageContext {
  return createMemoryStorage();
}

/** Фасад, собранный тестом: реестры вкладов + scoped-доступ к памяти. */
export interface TestFacade {
  /** Фасад в том же виде, что отдаёт хост плагину. */
  facade: PluginFacade;
  /** Зарегистрированные блоки промпта (в порядке регистрации). */
  promptBlocks: PromptBlockProvider[];
  /** Зарегистрированные тулы (в порядке регистрации). */
  tools: PluginToolDefinition[];
  /** Зарегистрированные disposer'ы. */
  disposers: Array<() => void>;
}

/** Опции сборки тестового фасада. */
export interface TestFacadeOptions {
  /** Хранилище инстанса (по умолчанию — новое in-memory). */
  storage?: StorageContext;
  /** Настройки плагина (`plugins[<имя>].settings`). */
  settings?: Record<string, unknown>;
  /** `false` — сервис памяти недоступен (`facade.memory === undefined`). */
  withMemory?: boolean;
}

/**
 * Тестовый фасад плагина.
 *
 * `facade.memory` — scoped-обёртка над портами storage'а (namespace
 * навязывает хост, ADR-107) — ровно то, что получает настоящий плагин.
 */
export function createTestFacade(options: TestFacadeOptions = {}): TestFacade {
  const storage = options.storage ?? createTestStorage();
  const promptBlocks: PromptBlockProvider[] = [];
  const tools: PluginToolDefinition[] = [];
  const disposers: Array<() => void> = [];

  const facade: PluginFacade = {
    registerDisposer: (disposer) => {
      disposers.push(disposer);
    },
    registerPromptBlock: (provider) => {
      promptBlocks.push(provider);
      return () => undefined;
    },
    registerLlmFilter: () => () => undefined,
    registerTool: (def) => {
      tools.push(def);
      return () => undefined;
    },
    ...(options.withMemory === false
      ? {}
      : {
          memory: createScopedMemory(TEST_PLUGIN_NAME, {
            facts: storage.memoryFacts,
            indexes: storage.memoryIndexes,
          }),
        }),
    embed: async () => {
      throw new Error('эмбеддинги в М1 не используются');
    },
    getSettings: <T extends Record<string, unknown> = Record<string, unknown>>(): Readonly<T> =>
      (options.settings ?? {}) as Readonly<T>,
  };

  return { facade, promptBlocks, tools, disposers };
}

/** Контекст хода для блоков промпта. */
export function blockCtx(over: {
  sessionId?: string;
  projectId?: string;
  query?: string;
  turnId?: string;
} = {}): {
  sessionId: string;
  agentRole: string;
  language: string;
  projectId?: string;
  mode: 'act';
  query?: string;
  turnId?: string;
} {
  return {
    sessionId: over.sessionId ?? 's1',
    agentRole: 'assistant',
    language: 'ru',
    ...(over.projectId ? { projectId: over.projectId } : {}),
    mode: 'act',
    ...(over.query ? { query: over.query } : {}),
    ...(over.turnId ? { turnId: over.turnId } : {}),
  };
}

/**
 * Контекст исполнения тула (суженный контекст плагинного тула, ADR-107).
 *
 * `projectId` — проект сессии (ADR-107: хост прокидывает его в суженный
 * контекст); нужен тулу `memory_search`, чтобы ограничить поиск данными
 * своего проекта.
 */
export function toolCtx(sessionId = 's1', projectId?: string): {
  sessionId: string;
  messageId: string;
  workingDir: string;
  projectId?: string;
} {
  return {
    sessionId,
    messageId: 'm1',
    workingDir: '/ws',
    ...(projectId ? { projectId } : {}),
  };
}
