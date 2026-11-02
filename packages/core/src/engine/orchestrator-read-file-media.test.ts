/**
 * ADR-115: `read_file` для изображения/PDF — сквозной путь до модели.
 *
 * Проверяем шов целиком: тул `read_file` читает PNG из рабочего каталога,
 * отдаёт ссылку (`ToolResult.attachments`), оркестратор вставляет медиа-часть
 * в **текущий** ход (`_injectToolAttachments`), и следующий вызов провайдера
 * уже несёт байты картинки — без второго тула (`attach_workspace_file`).
 *
 * Мок-провайдер фиксирует `messages` каждого вызова — по ним видно, что модель
 * получила изображение на следующем шаге, а не на следующем ходу.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { MemoryBlobStore } from '../storage/memory/content.js';
import { MemoryBlobRefRepository } from '../storage/memory/blob-refs.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import { createToolRegistry } from './tools/index.js';
import type { ContextBuilder } from './context/builder.js';
import {
  attachmentsConfigSchema,
  generateId,
  makeTextPart,
  MessageRole,
  nowISO,
} from '@itphx/synth-shared';
import type { Message, ProviderConfig, Session } from '@itphx/synth-shared';

const PROVIDER = 'mockreadmedia';

/** PNG-сигнатура: MIME определяется по содержимому, а не по расширению. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `messages` каждого вызова провайдера (снимок аргументов). */
let providerCalls: LLMMessage[][] = [];

class ReadFileProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancelToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    providerCalls.push(messages.map((m) => ({ ...m })));
    const hasToolResult = messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      yield {
        content: 'Читаю картинку',
        isFinal: false,
        toolCalls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'shot.png' }) },
        }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: this.model,
      };
      return;
    }
    yield {
      content: 'Готово',
      isFinal: false,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      model: this.model,
    };
  }

  getProviderName(): string {
    return PROVIDER;
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('Что на картинке?')],
    content: 'Что на картинке?',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function providerLoader(name: string): ProviderConfig {
  return {
    name,
    type: PROVIDER,
    baseUrl: '',
    apiKey: '',
    defaultModel: 'm',
  } as unknown as ProviderConfig;
}

describe('ChatOrchestrator — read_file отдаёт изображение модели (ADR-115)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let projectId: string;
  let blobs: MemoryBlobStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-read-media-'));
    await writeFile(join(tmpDir, 'shot.png'), Buffer.concat([PNG_HEADER, Buffer.from('payload')]));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    // ADR-075: file-тулы доступны только при заданном workspace проекта.
    const project = projectStore.create('ReadMedia', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    projectId = project.id;
    blobs = new MemoryBlobStore();
    providerCalls = [];
    ProviderFactory.register(PROVIDER, ReadFileProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete(PROVIDER);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(): Promise<Session> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader,
      toolRegistry: createToolRegistry(),
      projectStore,
      blobs,
      blobRefs: new MemoryBlobRefRepository(),
      dataDir: tmpDir,
      defaultWorkingDir: tmpDir,
      attachmentsConfig: () => attachmentsConfigSchema.parse({}),
    });

    const session = await sessionManager.createSession({
      title: 'ReadMedia',
      projectId,
      settings: { provider: PROVIDER, model: 'm', agentRole: 'fixer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(session.id))!;
  }

  it('модель получает картинку на следующем шаге того же хода', async () => {
    const session = await runTurn();

    // Второй вызов провайдера — уже с результатом тула и медиа-репликой.
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    const second = providerCalls[1]!;
    const mediaIndex = second.findIndex((m) => m.role === 'user' && (m.attachments?.length ?? 0) > 0);
    expect(mediaIndex).toBeGreaterThanOrEqual(0);
    expect(second[mediaIndex]!.attachments![0]!.mime).toBe('image/png');
    expect(second[mediaIndex]!.attachments![0]!.base64.length).toBeGreaterThan(0);

    // В истории — сообщение-вложение тула (`author: 'Tool'`).
    const injected = session.messages.filter((m) => m.metadata?.source === 'tool-attachment');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.author).toBe('Tool');
    // Роль агента — для служебной подписи блока вложения в UI.
    expect(injected[0]!.metadata?.agent_role).toBe('fixer');
    expect(injected[0]!.parts.some((p) => p.type === 'image')).toBe(true);
  });
});
