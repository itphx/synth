/**
 * ADR-118 §1: идентификаторы частей assistant-сообщения в персисте.
 *
 * Стрим публикует части с детерминированными `partId` (`msg:text:N`,
 * `msg:reasoning:N`, `callId`), а клиент мержит части по id. Если персист
 * выдаёт другие id (uuid), в представлении сообщения оказываются две
 * текстовые части одного ответа — текст дублируется.
 *
 * Проверяем на двухшаговом ходе (вызов инструмента → финальный текст):
 *  - id частей сохранённых сообщений == id опубликованных в стриме;
 *  - финализация черновика (`updateMessage`) не плодит части;
 *  - слияние dto-частей и live-частей (как в UI) даёт текст ОДИН раз.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, Message, Part } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни задачу')],
    content: 'выполни задачу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/**
 * Два шага: 1-й — текст + вызов инструмента (deny-команда, реально не
 * выполняется), 2-й — финальный текст без вызовов.
 */
class MockTwoStepProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'x', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: unknown,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockTwoStepProvider.calls++;
    if (n === 0) {
      // Текст шага идёт дельтами (как у живого провайдера), финальный чанк
      // текст не повторяет — иначе накопленный текст был бы заменён целиком.
      yield {
        content: 'Шаг 1: проверяю команду', isFinal: false,
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      yield {
        content: '', isFinal: true,
        toolCalls: [{ id: 'call_t0', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    yield {
      content: 'Готово', isFinal: false,
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    yield {
      content: '', isFinal: true,
      model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mocktwostep';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-part-ids-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('PartIds', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) =>
      ({ name, type: 'mocktwostep', baseUrl: '', apiKey: '', defaultModel: 'm' }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry: createToolRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    modelPriceLoader: () => null,
  });
  const session = await sessionManager.createSession({
    title: 'PartIds',
    projectId: project.id,
    settings: { provider: 'mocktwostep', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, tmpDir, sessionId: session.id };
}

/**
 * Слияние частей по id — как в UI (`buildPartsView`): dto-части кладутся в
 * карту, live-части перезаписывают одноимённые.
 */
function mergeParts(dto: Part[], live: Map<string, Part>): string[] {
  const merged = new Map<string, Part>();
  for (const part of dto) merged.set(part.id, part);
  for (const [id, part] of live) merged.set(id, { ...merged.get(id), ...part } as Part);
  return [...merged.values()]
    .filter((part) => part.type === 'text')
    .map((part) => String(part.data ?? ''));
}

describe('ADR-118 §1: детерминированные id частей в персисте', () => {
  beforeEach(() => {
    ProviderFactory.register('mocktwostep', MockTwoStepProvider);
    MockTwoStepProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mocktwostep');
  });

  it('id сохранённых частей == id частей из стрима (двухшаговый ход)', async () => {
    const h = await makeHarness();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const fresh = (await h.sessionManager.getSession(h.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await h.orchestrator.createProcessMessage()(
      fresh, userMsg, new AbortController().signal, (event, data) => events.push({ event, data }),
    );

    // Живые части стрима: `{messageId, partId}`.
    const liveText = new Map<string, string>();
    for (const e of events) {
      if (e.event !== 'part.delta') continue;
      const messageId = String(e.data.messageId);
      const partId = String(e.data.partId);
      liveText.set(`${messageId}|${partId}`, (liveText.get(`${messageId}|${partId}`) ?? '') + String(e.data.delta ?? ''));
    }
    // Текст шага идёт дельтами с `partId` `msg:text:0`.
    expect([...liveText.keys()].every((key) => key.endsWith('|msg:text:0'))).toBe(true);

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistants = session.messages.filter((m) => m.role === MessageRole.ASSISTANT);

    // Шаг 1 (вызов инструмента) — assistant с `toolCalls`; шаг 2 — финальный.
    // Маркер `tool_chain` у шага с текстом НЕ ставится (текст шага — реальный
    // ответ агента), поэтому шаг ищем по вызовам инструментов, а не по маркеру.
    const chain = assistants.find((m) => (m.toolCalls?.length ?? 0) > 0)!;
    const final = assistants.find((m) => (m.toolCalls?.length ?? 0) === 0)!;
    expect(chain).toBeDefined();
    expect(final).toBeDefined();
    expect(chain.metadata?.tool_chain).toBeUndefined();
    expect(final.metadata?.tool_chain).toBeUndefined();

    // Части стрима и части персиста — по одному messageId.
    const chainText = chain.parts.find((p) => p.type === 'text')!;
    const finalText = final.parts.find((p) => p.type === 'text')!;
    expect(chainText.id).toBe('msg:text:0');
    expect(finalText.id).toBe('msg:text:0');

    // Живой текст шага адресован тому же сообщению и той же части.
    expect(liveText.has(`${chain.id}|${chainText.id}`)).toBe(true);
    expect(liveText.has(`${final.id}|${finalText.id}`)).toBe(true);

    // Вызов инструмента в стриме — `partId` = `callId` провайдера.
    const toolParts = events
      .filter((e) => e.event === 'part.updated')
      .map((e) => e.data.partId)
      .filter((partId): partId is string => typeof partId === 'string' && partId.startsWith('call_'));
    expect(toolParts).toContain('call_t0');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('слияние dto- и live-частей даёт текст ответа ОДИН раз (без дубля)', async () => {
    const h = await makeHarness();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const fresh = (await h.sessionManager.getSession(h.sessionId))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    await h.orchestrator.createProcessMessage()(
      fresh, userMsg, new AbortController().signal, (event, data) => events.push({ event, data }),
    );

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    // Финальный шаг — assistant без вызовов инструментов (у шага с вызовами
    // маркера `tool_chain` нет — текст шага видим в транскрипте).
    const final = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) === 0,
    )!;

    // Live-части финального шага — из `part.delta` стрима.
    const live = new Map<string, Part>();
    for (const e of events) {
      if (e.event !== 'part.delta') continue;
      const messageId = String(e.data.messageId);
      if (messageId !== final.id) continue;
      const partId = String(e.data.partId);
      const prev = live.get(partId);
      live.set(partId, {
        id: partId,
        type: 'text',
        data: (prev ? String(prev.data ?? '') : '') + String(e.data.delta ?? ''),
      });
    }

    const texts = mergeParts(final.parts, live);
    // Одна текстовая часть — текст ответа без дубля.
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('Готово');

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
