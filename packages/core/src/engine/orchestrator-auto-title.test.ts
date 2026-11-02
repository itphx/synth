/**
 * Авто-заголовок в оркестраторе: заголовок сессии генерируется **до** ответа
 * ассистента — триггер `_maybeAutoTitle` срабатывает сразу после подготовки
 * запроса (провайдер уже выбран роутером), до `turn.started` и до вызова LLM
 * хода. Fire-and-forget: вызов заголовка не блокирует ход.
 *
 * Проверяется на реальном ходе с фейковым провайдером: порядок вызовов LLM
 * (заголовок → ход) и итоговый заголовок сессии.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, SystemPromptInput, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { LLMChunk, LLMResponse, Message, ProviderConfig } from '@itphx/synth-shared';

/** Реплика с сигналом задачи (длиннее `minSignalChars` по умолчанию). */
const SIGNAL_TEXT = 'Почини падающий тест авторизации в модуле сессий';
/** Заголовок, который «возвращает» фейковый провайдер. */
const TITLE_TEXT = 'Падающий тест авторизации';

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
    parts: [makeTextPart(SIGNAL_TEXT)],
    content: SIGNAL_TEXT,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('ChatOrchestrator — авто-заголовок до ответа ассистента', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  /** Порядок вызовов LLM: 'title' — заголовок, 'turn' — ход. */
  let calls: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-autotitle-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    calls = [];
    ProviderFactory.register('autotitle', makeProviderClass());
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('autotitle');
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProviderClass() {
    return class AutoTitleProvider extends BaseProvider {
      constructor() {
        super({ url: '', apiKey: '', model: 'm', name: 'autotitle' });
      }

      /** Заголовок: нестриминговый вызов LLM. */
      async chat(
        _messages: LLMMessage[],
        _systemPrompt?: SystemPromptInput,
      ): Promise<LLMResponse> {
        calls.push('title');
        return {
          content: TITLE_TEXT,
          model: this.model,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }

      /** Ход: стриминговый вызов LLM. */
      async *chatAsync(
        _messages: LLMMessage[],
        _systemPrompt?: SystemPromptInput,
        _tools?: Record<string, unknown>[],
        _debugCollector?: unknown,
        _cancellationToken?: CancellationToken,
      ): AsyncGenerator<LLMChunk> {
        calls.push('turn');
        yield {
          content: 'ответ ассистента',
          isFinal: true,
          model: this.model,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }

      getProviderName(): string {
        return 'autotitle';
      }
    };
  }

  it('вызов LLM заголовка идёт раньше вызова LLM хода, заголовок записывается', async () => {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'autotitle',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as ProviderConfig,
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      settings: { provider: 'autotitle', model: 'm', agentRole: 'fixer' },
    });
    const message = makeUserMessage();
    await sessionManager.addMessage(session.id, message);
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.title).toBe('New session');

    await orchestrator.createProcessMessage()(
      fresh,
      message,
      new AbortController().signal,
      () => {},
    );

    // Заголовок формируется до ответа ассистента.
    expect(calls[0]).toBe('title');
    expect(calls).toContain('turn');

    // Заголовок записан (fire-and-forget — ждём завершения).
    await vi.waitFor(async () => {
      expect((await sessionManager.getSession(session.id))!.title).toBe(TITLE_TEXT);
    });
  });
});
