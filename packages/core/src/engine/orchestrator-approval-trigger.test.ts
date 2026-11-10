/**
 * Структурная причина ask'а («виновник») — от решения permission-слоя до
 * payload'а события `permission.asked`.
 *
 * Человек должен видеть, ЧТО именно вызвало вопрос (путь/команда/код), а не
 * только английский текст для модели. Ядро отдаёт эту причину машиночитаемо —
 * в `trigger` запроса подтверждения; UI строит подсветку по нему.
 *
 * Сценарий: файл из `approvalPaths` политики защищённых путей → ask →
 * `permission.asked` несёт `trigger` с `messageId`/`params`/`matchedRule`/
 * `askKind`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

interface ScriptStep {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
}

class TriggerScriptProvider extends BaseProvider {
  static script: ScriptStep[] = [];
  static calls = 0;

  private _next(): ScriptStep {
    const step = TriggerScriptProvider.script[Math.min(TriggerScriptProvider.calls, TriggerScriptProvider.script.length - 1)]!;
    TriggerScriptProvider.calls++;
    return step;
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const step = this._next();
    return {
      content: step.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: step.toolCalls?.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._next();
    yield {
      content: step.content,
      isFinal: true,
      toolCalls: step.toolCalls?.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'trigger-script';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  sessionId: string;
  tmpDir: string;
  targetFile: string;
}

async function makeHarness(permissionConfig: PermissionConfig): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-approval-trigger-'));
  const dataDir = join(tmpDir, 'data');
  // Политика защищённых путей инстанса: файл требует подтверждения.
  await mkdir(join(dataDir, 'security'), { recursive: true });
  const targetFile = join(tmpDir, 'secret.txt');
  await writeFile(targetFile, 'секретный текст\n', 'utf-8');
  await writeFile(
    join(dataDir, 'security', 'protected-paths.json'),
    JSON.stringify({ version: 1, add: { approvalPaths: [targetFile] }, remove: {} }),
    'utf-8',
  );

  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Trigger', 'u1', { workspace: tmpDir });
  await projectStore.save(project);

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    projectStore,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'trigger-script', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry: createToolRegistry(),
    permissionConfig,
    defaultWorkingDir: tmpDir,
    dataDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });

  const session = await sessionManager.createSession({
    title: 'Trigger',
    projectId: project.id,
    userId: 'u1',
    settings: { provider: 'trigger-script', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('прочитай файл')],
    content: 'прочитай файл',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  });

  return { orchestrator, sessionManager, eventBus, sessionId: session.id, tmpDir, targetFile };
}

describe('структурная причина ask\'а (trigger) — основной ход', () => {
  beforeEach(() => {
    ProviderFactory.register('trigger-script', TriggerScriptProvider);
    TriggerScriptProvider.calls = 0;
    TriggerScriptProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('trigger-script');
  });

  it('permission.asked несёт trigger: messageId + params + matchedRule + askKind', async () => {
    const h = await makeHarness({ rules: {}, askTimeoutMs: 5000 } as unknown as PermissionConfig);

    TriggerScriptProvider.script = [
      {
        content: 'Шаг 1: чтение защищённого файла',
        toolCalls: [{ id: 'call_a', name: 'read_file', args: { file_path: h.targetFile } }],
      },
      { content: 'Готово' },
    ];

    const asked: Array<Record<string, unknown>> = [];
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.asked') {
        asked.push(event.data as Record<string, unknown>);
        h.eventBus.publish(h.sessionId, 'permission.replied', {
          approval_id: event.data.approval_id,
          session_id: h.sessionId,
          action: 'allow',
          once: true,
        });
      }
    });

    const processMessage = h.orchestrator.createProcessMessage();
    const fresh = (await h.sessionManager.getSession(h.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await processMessage(fresh, userMsg, new AbortController().signal, () => {});

    expect(asked).toHaveLength(1);
    const trigger = asked.at(-1)?.trigger as Record<string, unknown> | undefined;
    expect(trigger).toBeDefined();
    // id security-сообщения — UI по нему выбирает локализованный текст.
    expect(trigger?.messageId).toBe('ask-protected-path');
    // Структурный «виновник» — путь, ради которого спросили.
    expect((trigger?.params as Record<string, string>).path).toContain('secret.txt');
    expect(trigger?.matchedRule).toBe('protected-paths.ask');
    // Вид ask'а — тот же, что у shell-guard.
    expect(trigger?.askKind).toBe('protected');

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
