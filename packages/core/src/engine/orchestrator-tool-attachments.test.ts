/**
 * ADR-115 §«Медиа из инструментов»: вложения результатов тулов в текущем ходе.
 *
 * Проверяем шов целиком — от `ToolResult.attachments` до запроса провайдеру:
 *  - сообщение-вложение попадает в историю (`author: 'Tool'`,
 *    `metadata.source: 'tool-attachment'`) и учитывается в `blob_refs`;
 *  - в `currentMessages` оно вставляется **после** tool-результатов итерации
 *    (assistant(tool_use) → tool → user(media)) — на этом же порядке держится
 *    Anthropic-буфер `tool_result`;
 *  - бюджет (4 вложения, `attachments.maxBytesPerMessage`), дедуп по
 *    `blobPath`, `isError` и невалидные ссылки отбрасываются;
 *  - text-only модель получает производный текст (`derive`), а не байты.
 *
 * Мок-провайдер фиксирует `messages` каждого вызова — по ним видно, что модель
 * получила вложение на следующем шаге, а не на следующем ходу.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { MemoryBlobStore } from '../storage/memory/content.js';
import { MemoryBlobRefRepository } from '../storage/memory/blob-refs.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { AttachmentService } from './attachments/service.js';
import {
  attachmentsConfigSchema,
  generateId,
  makeTextPart,
  MessageRole,
  nowISO,
  ToolCapability,
} from '@itphx/synth-shared';
import type {
  AttachmentsConfig,
  Message,
  ProviderConfig,
  Session,
  ToolAttachmentRef,
  ToolResult,
} from '@itphx/synth-shared';

const PROVIDER = 'mockmedia';
const AUX_PROVIDER = 'mockmediaaux';
const TOOL_NAME = 'fetch_media';

/** PNG-сигнатура: MIME определяется по содержимому, а не по заявленному типу. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(seed: string): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(`payload-${seed}`)]);
}

/** `messages` каждого вызова провайдера (снимок аргументов). */
let providerCalls: LLMMessage[][] = [];
/** Ответ тула на текущий тест (attachments меняются от теста к тесту). */
let nextToolResult: ToolResult = { content: 'downloaded' };

class MediaToolProvider extends BaseProvider {
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
        content: 'Сейчас скачаю файл',
        isFinal: false,
        toolCalls: [{
          id: 'call_media',
          type: 'function',
          function: { name: TOOL_NAME, arguments: '{}' },
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

/** Aux-модель семейства: возвращает производный текст вместо байтов. */
class AuxProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return {
      content: 'A small test image',
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    // derive использует `chat`, поток не нужен
  }

  getProviderName(): string {
    return AUX_PROVIDER;
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

/** `providerLoader`: конфиг и основного мок-провайдера, и aux-модели. */
function providerLoader(name: string): ProviderConfig {
  const type = name === AUX_PROVIDER ? AUX_PROVIDER : PROVIDER;
  return {
    name,
    type,
    baseUrl: '',
    apiKey: '',
    defaultModel: 'm',
  } as unknown as ProviderConfig;
}

describe('ChatOrchestrator — вложения тулов в текущем ходе (ADR-115)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let blobs: MemoryBlobStore;
  let blobRefs: MemoryBlobRefRepository;
  let seeder: AttachmentService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-tool-attachments-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    blobs = new MemoryBlobStore();
    blobRefs = new MemoryBlobRefRepository();
    seeder = new AttachmentService({
      blobs,
      config: () => attachmentsConfigSchema.parse({}),
    });
    providerCalls = [];
    nextToolResult = { content: 'downloaded' };
    ProviderFactory.register(PROVIDER, MediaToolProvider);
    ProviderFactory.register(AUX_PROVIDER, AuxProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete(PROVIDER);
    ProviderFactory['_providers'].delete(AUX_PROVIDER);
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Загрузить объект вложения и получить валидную ссылку для `ToolResult`. */
  async function seedAttachment(seed: string, name: string): Promise<ToolAttachmentRef> {
    const meta = await seeder.upload({ bytes: pngBytes(seed), name });
    return {
      blobPath: meta.blobPath,
      sha256: meta.sha256,
      mime: meta.mime,
      size: meta.size,
      ...(meta.name ? { name: meta.name } : {}),
    };
  }

  async function runTurn(overrides: {
    attachmentsConfig?: () => AttachmentsConfig;
    resolveModelModalities?: (providerName: string, modelId: string) => ('text' | 'image' | 'pdf' | 'audio' | 'video')[] | undefined;
  } = {}): Promise<{ session: Session; messages: Message[]; events: Array<[string, Record<string, unknown>]> }> {
    const toolRegistry = createToolRegistry();
    toolRegistry.register({
      name: TOOL_NAME,
      description: 'fake media fetch',
      parameters: z.object({}),
      capabilities: [ToolCapability.WEB],
      async execute(): Promise<ToolResult> {
        return nextToolResult;
      },
    });

    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader,
      toolRegistry,
      blobs,
      blobRefs,
      // Каталог данных — временный: иначе ленивые фоллбэки оркестратора
      // (например словари) собирают `createFileStorage` с дефолтным
      // `/var/synth/data` и тот пытается создать `/var/synth/data/blobs` (EACCES).
      // Вложения идут через инъектированный `MemoryBlobStore` (`blobs`), а
      // `dataDir` закрывает остальные ленивые порты.
      dataDir: tmpDir,
      defaultWorkingDir: tmpDir,
      ...(overrides.attachmentsConfig ? { attachmentsConfig: overrides.attachmentsConfig } : {}),
      ...(overrides.resolveModelModalities
        ? { resolveModelModalities: overrides.resolveModelModalities }
        : {}),
    });

    const session = await sessionManager.createSession({
      title: 'ToolAttachments',
      settings: {
        provider: PROVIDER,
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'developer',
      },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Array<[string, Record<string, unknown>]> = [];
    const processMessage = orchestrator.createProcessMessage();
    await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      events.push([event, data]);
    });

    const updated = (await sessionManager.getSession(session.id))!;
    return { session: updated, messages: updated.messages, events };
  }

  /** Сообщения-вложения тулов из истории (без state-сообщений). */
  function toolAttachmentMessages(messages: Message[]): Message[] {
    return messages.filter((m) => m.metadata?.source === 'tool-attachment');
  }

  it('вложение тула: user-сообщение в истории, blob_refs, публикация событий', async () => {
    nextToolResult = { content: 'downloaded image', attachments: [await seedAttachment('one', 'shot.png')] };

    const { messages, events } = await runTurn();
    const injected = toolAttachmentMessages(messages);

    expect(injected).toHaveLength(1);
    const message = injected[0]!;
    expect(message.role).toBe(MessageRole.USER);
    expect(message.author).toBe('Tool');
    expect(message.metadata).toMatchObject({ source: 'tool-attachment', tool: TOOL_NAME, call_id: 'call_media' });
    const mediaPart = message.parts.find((p) => p.type === 'image');
    expect(mediaPart).toBeDefined();
    expect(message.content).toContain('[image: shot.png]');

    // blob_refs: объект не должен считаться сиротой (ownerKind/ownerId сообщения).
    const ref = nextToolResult.attachments![0]!;
    await expect(blobRefs.listByOwner('message', message.id)).resolves.toEqual([ref.blobPath]);

    // Живые события: без них чат не покажет вложение до перезагрузки.
    expect(events.some(([name]) => name === 'message.added')).toBe(true);
    expect(events.some(([name]) => name === 'session.updated')).toBe(true);
  });

  it('порядок assistant(tool_use) → tool → user(media): модель видит вложение на следующем шаге', async () => {
    nextToolResult = { content: 'downloaded image', attachments: [await seedAttachment('order', 'shot.png')] };

    await runTurn();

    // Второй вызов провайдера — уже с результатом тула и медиа-репликой.
    expect(providerCalls).toHaveLength(2);
    const second = providerCalls[1]!;
    const assistantIndex = second.findIndex((m) => m.role === 'assistant' && (m.toolUse?.length ?? 0) > 0);
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    const toolIndex = second.findIndex((m) => m.role === 'tool' && m.toolCallId === 'call_media');
    expect(toolIndex).toBeGreaterThan(assistantIndex);
    const mediaIndex = second.findIndex((m) => m.role === 'user' && (m.attachments?.length ?? 0) > 0);
    expect(mediaIndex).toBeGreaterThan(toolIndex);
    // Вложение гидратировано: провайдеру уходят байты, а не только плейсхолдер.
    expect(second[mediaIndex]!.attachments![0]!.mime).toBe('image/png');
    expect(second[mediaIndex]!.attachments![0]!.base64.length).toBeGreaterThan(0);
    expect(second[mediaIndex]!.content).toContain('[image: shot.png]');
  });

  it('несколько вложений одного результата: по реплике на вложение, порядок сохранён', async () => {
    const first = await seedAttachment('a', 'a.png');
    const second = await seedAttachment('b', 'b.png');
    nextToolResult = { content: 'two images', attachments: [first, second] };

    const { messages } = await runTurn();
    const injected = toolAttachmentMessages(messages);

    expect(injected).toHaveLength(2);
    expect(injected[0]!.content).toContain('[image: a.png]');
    expect(injected[1]!.content).toContain('[image: b.png]');
  });

  it('бюджет: пятое вложение отбрасывается, первые четыре остаются', async () => {
    const refs = [];
    for (let i = 0; i < 5; i += 1) refs.push(await seedAttachment(`limit-${i}`, `img-${i}.png`));
    nextToolResult = { content: 'five images', attachments: refs };

    const { messages } = await runTurn();

    expect(toolAttachmentMessages(messages)).toHaveLength(4);
  });

  it('бюджет по объёму (`attachments.maxBytesPerMessage`): слишком крупное пропускается', async () => {
    const big = await seedAttachment('big', 'big.png');
    const small = await seedAttachment('small', 'small.png');
    nextToolResult = { content: 'mixed', attachments: [big, small] };

    // Бюджет меньше первого вложения, но больше второго.
    const { messages } = await runTurn({
      attachmentsConfig: () => ({
        ...attachmentsConfigSchema.parse({}),
        maxBytesPerMessage: big.size,
      }),
    });

    const injected = toolAttachmentMessages(messages);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toContain('[image: big.png]');
  });

  it('isError результата: вложения не инжектятся', async () => {
    nextToolResult = {
      content: 'fetch failed',
      isError: true,
      attachments: [await seedAttachment('err', 'err.png')],
    };

    const { messages } = await runTurn();

    expect(toolAttachmentMessages(messages)).toHaveLength(0);
  });

  it('дубли по blobPath схлопываются в одно вложение', async () => {
    const ref = await seedAttachment('dup', 'dup.png');
    nextToolResult = { content: 'same object twice', attachments: [ref, { ...ref, name: 'other.png' }] };

    const { messages } = await runTurn();

    expect(toolAttachmentMessages(messages)).toHaveLength(1);
  });

  it('невалидная ссылка (blobPath вне attachments/) отбрасывается', async () => {
    const valid = await seedAttachment('valid', 'valid.png');
    nextToolResult = {
      content: 'one bad ref',
      attachments: [
        { ...valid, blobPath: 'processes/run.log' },
        valid,
      ],
    };

    const { messages } = await runTurn();
    const injected = toolAttachmentMessages(messages);

    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toContain('[image: valid.png]');
  });

  it('text-only модель: вложение обрабатывает aux-модель (derive), байты не отправляются', async () => {
    nextToolResult = { content: 'one image', attachments: [await seedAttachment('derive', 'shot.png')] };

    await runTurn({
      resolveModelModalities: () => ['text'],
      attachmentsConfig: () => ({
        ...attachmentsConfigSchema.parse({}),
        modalityModels: { image: { provider: AUX_PROVIDER, model: 'm' } },
      }),
    });

    const second = providerCalls[1]!;
    const mediaMessage = second.find((m) => m.role === 'user' && m.content.includes('[image: shot.png]'));
    expect(mediaMessage).toBeDefined();
    // Байты модели сессии не ушли — вместо них производный текст.
    expect(mediaMessage!.attachments).toBeUndefined();
    expect(mediaMessage!.content).toContain('A small test image');
  });

  it('Anthropic: media-реплика идёт после user(tool_result), пара tool_use/tool_result цела', async () => {
    nextToolResult = { content: 'result', attachments: [await seedAttachment('anthropic', 'shot.png')] };

    await runTurn();

    // Проверяем **фактические** сообщения второго LLM-вызова (они уже
    // гидрированы оркестратором): `_sessionMessagesToLlm` отдаёт только ссылки,
    // байты добавляет гидратация — форматировать «сухую» историю бессмысленно.
    const live = providerCalls[1]!;
    const provider = new AnthropicProvider({
      url: 'http://api.anthropic.test/v1/messages',
      apiKey: 'key',
      model: 'claude-test',
      timeout: 30,
    }) as unknown as { _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> };
    const formatted = provider._formatMessages(live);

    const hasPart = (m: Record<string, unknown>, type: string): boolean =>
      Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((p) => p.type === type);

    // assistant(tool_use) → user(tool_result) → user(media)
    const assistantIndex = formatted.findIndex((m) => m.role === 'assistant'
      && (m.content as Array<Record<string, unknown>>).some((p) => p.type === 'tool_use' && p.id === 'call_media'));
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    const toolIndex = formatted.findIndex((m) => hasPart(m, 'tool_result'));
    expect(toolIndex).toBe(assistantIndex + 1); // пары tool_use/tool_result не разорваны
    const mediaIndex = formatted.findIndex((m) => hasPart(m, 'image'));
    expect(mediaIndex).toBeGreaterThan(toolIndex); // медиа — строго после буфера tool_result

    const toolResultParts = formatted[toolIndex]!.content as Array<Record<string, unknown>>;
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_media' });

    const mediaParts = formatted[mediaIndex]!.content as Array<Record<string, unknown>>;
    const imagePart = mediaParts.find((p) => p.type === 'image') as
      | { source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    expect(imagePart?.source?.type).toBe('base64');
    expect(imagePart?.source?.media_type).toBe('image/png');
    expect(imagePart?.source?.data?.length ?? 0).toBeGreaterThan(0);

    // Плейсхолдер об авторстве тула остаётся в тексте — модель видит источник.
    expect(JSON.stringify(mediaParts)).toContain('[image: shot.png]');
  });
});
