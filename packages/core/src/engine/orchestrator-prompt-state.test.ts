/**
 * ADR-070 §2.4/§2.7 (Ф2-часть 2): оркестратор хранит promptStates per-agent,
 * предсказывает cache hit/miss и заполняет promptMeta фактическим usage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { wrapStateContent } from './context/state-messages.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content = 'Привет'): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Мок-провайдер: отдаёт финальный ответ и настраиваемый cacheRead. */
class CacheMetaProvider extends BaseProvider {
  static cacheRead = 0;

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return {
      content: 'ok',
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const usage: TokenUsage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: CacheMetaProvider.cacheRead,
    };
    yield { content: 'ok', isFinal: true, usage, model: this.model };
  }

  getProviderName(): string {
    return 'cachemeta';
  }
}

describe('ChatOrchestrator — promptStates/promptMeta (ADR-070 §2.4)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-pstate-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    CacheMetaProvider.cacheRead = 0;
    ProviderFactory.register('cachemeta', CacheMetaProvider);
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'cachemeta',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('cachemeta');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSession(extraSettings: Record<string, unknown> = {}): Promise<Session> {
    return sessionManager.createSession({
      title: 'PromptState',
      settings: {
        provider: 'cachemeta',
        model: 'm',
        agentRole: 'developer',
        ...extraSettings,
      },
    });
  }

  async function runTurn(sessionId: string, content = 'Привет'): Promise<Session> {
    const msg = makeUserMessage(content);
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(sessionId))!;
  }

  function lastAssistant(session: Session): Message {
    return [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
  }

  function makeAssistantMessage(content: string, agentRole = 'developer'): Message {
    return {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      agentRole,
    };
  }

  function makeStateMessage(type: string, content: string): Message {
    return {
      id: generateId(),
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { type, state: true },
    };
  }

  function makeInfoMessage(content: string): Message {
    return { ...makeUserMessage(content), role: MessageRole.INFO };
  }

  async function createSessionWithUser(userId = 'user'): Promise<Session> {
    return sessionManager.createSession({
      title: 'History',
      userId,
      settings: { provider: 'cachemeta', model: 'm', agentRole: 'developer' },
    });
  }

  it('первый ход: promptStates[agentKey] generation=1, reason=init, expected=miss', async () => {
    const session = await createSession();
    expect(session.promptStates).toBeUndefined();

    const after = await runTurn(session.id);

    const state = after.promptStates?.developer;
    expect(state).toBeDefined();
    expect(state!.generation).toBe(1);
    expect(state!.reason).toBe('init');
    expect(state!.staticPrefix).toBe('system prompt');

    const meta = lastAssistant(after).promptMeta;
    expect(meta).toBeDefined();
    expect(meta!.agentRole).toBe('developer');
    expect(meta!.generation).toBe(1);
    expect(meta!.expected).toBe('miss');
    expect(meta!.cachedTokens).toBe(0);
    expect(meta!.validated).toBe(true);
  });

  it('второй ход с тем же промптом: expected=hit, state не пересобирается', async () => {
    const session = await createSession();
    const first = await runTurn(session.id);
    const stateBefore = first.promptStates!.developer!;

    const second = await runTurn(session.id);
    const stateAfter = second.promptStates!.developer!;

    // Записи не было: generation и updatedAt сохранены.
    expect(stateAfter.generation).toBe(1);
    expect(stateAfter.updatedAt).toBe(stateBefore.updatedAt);
    expect(stateAfter.reason).toBe('init');

    const meta = lastAssistant(second).promptMeta;
    expect(meta!.expected).toBe('hit');
    expect(meta!.generation).toBe(1);
  });

  it('usage.cacheReadTokens заполняет cachedTokens и validated', async () => {
    const session = await createSession();
    await runTurn(session.id); // init, miss
    CacheMetaProvider.cacheRead = 128; // второй ход: hit и реальные cached-токены

    const after = await runTurn(session.id);

    const meta = lastAssistant(after).promptMeta;
    expect(meta!.expected).toBe('hit');
    expect(meta!.cachedTokens).toBe(128);
    expect(meta!.validated).toBe(true);
  });

  it('override systemPrompt: reason=override, staticPrefix пустой', async () => {
    const session = await createSession({ systemPrompt: 'мой оверрайд' });
    const after = await runTurn(session.id);

    const state = after.promptStates?.developer;
    expect(state!.reason).toBe('override');
    expect(state!.staticPrefix).toBe('');
    expect(state!.staticPrefixHash).toBe(
      // sha256 пустой строки
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('смена агента не смешивает состояния (per-agent)', async () => {
    const session = await createSession();
    await runTurn(session.id);

    // Тот же промпт, другой агент → свой init.
    const otherMsg = makeUserMessage('Привет');
    otherMsg.agentRole = 'researcher';
    await sessionManager.addMessage(session.id, otherMsg);
    const fresh = (await sessionManager.getSession(session.id))!;
    await orchestrator.createProcessMessage()(fresh, otherMsg, new AbortController().signal, () => {});

    const after = (await sessionManager.getSession(session.id))!;
    expect(after.promptStates!.developer!.generation).toBe(1);
    expect(after.promptStates!.researcher!.generation).toBe(1);
    expect(after.promptStates!.researcher!.reason).toBe('init');
  });

  it('getPromptInfo: манифест + promptState + lastPromptMeta активного агента (read-only)', async () => {
    const session = await createSession();
    const after = await runTurn(session.id);

    const info = await orchestrator.getPromptInfo(after);

    const role = info.manifest.entries.find((e) => e.key === 'role');
    expect(role?.status).toBe('loaded');
    expect(info.manifest.totalChars).toBeGreaterThan(0);
    expect(info.manifest.generation).toBe(1);
    expect(info.promptState).toEqual(after.promptStates!.developer);
    expect(info.lastPromptMeta).toEqual(lastAssistant(after).promptMeta);

    // Побочных эффектов нет: состояние в хранилище не перезаписано.
    const reloaded = (await sessionManager.getSession(session.id))!;
    expect(reloaded.promptStates!.developer!.updatedAt).toBe(after.promptStates!.developer!.updatedAt);
  });

  describe('_buildPromptHistoryInfo (ADR-070 §2.5, слой messages)', () => {
    it('считает отправляемые сообщения, а disabled/hidden/info — в excluded', async () => {
      const session = await createSessionWithUser();
      await sessionManager.addMessage(session.id, makeUserMessage('Привет'));
      await sessionManager.addMessage(session.id, makeAssistantMessage('ok'));

      const disabled = makeUserMessage('d');
      disabled.disabled = true;
      const hidden = makeUserMessage('h');
      hidden.hidden = true;
      await sessionManager.addMessage(session.id, disabled);
      await sessionManager.addMessage(session.id, hidden);
      await sessionManager.addMessage(session.id, makeInfoMessage('i'));
      await sessionManager.addMessage(session.id, makeStateMessage('mode_change', 'MODE'));

      const fresh = (await sessionManager.getSession(session.id))!;
      const { history } = await orchestrator.getPromptInfo(fresh);

      // user + assistant + state-сообщение (role system → user в LLM).
      expect(history.messages.count).toBe(3);
      expect(history.messages.chars).toBeGreaterThan(0);
      expect(history.messages.estTokens).toBe(Math.ceil(history.messages.chars / 4));
      expect(history.excluded).toEqual({ disabled: 1, hidden: 1, info: 1 });

      const wrapped = wrapStateContent('mode_change', 'MODE');
      expect(history.stateMessages).toEqual([
        {
          type: 'mode_change',
          count: 1,
          chars: wrapped.length,
          estTokens: Math.ceil(wrapped.length / 4),
        },
      ]);
    });

    it('группирует state-сообщения по type и сортирует по chars убыв.', async () => {
      const session = await createSessionWithUser();
      await sessionManager.addMessage(session.id, makeStateMessage('mode_change', 'AAA'));
      await sessionManager.addMessage(session.id, makeStateMessage('mode_change', 'BBB'));
      await sessionManager.addMessage(session.id, makeStateMessage('plan_updated', 'P'));

      const fresh = (await sessionManager.getSession(session.id))!;
      const { history } = await orchestrator.getPromptInfo(fresh);

      expect(history.stateMessages).toHaveLength(2);
      const byType = Object.fromEntries(history.stateMessages.map((s) => [s.type, s]));
      expect(byType.mode_change!.count).toBe(2);
      expect(byType.mode_change!.chars).toBe(
        wrapStateContent('mode_change', 'AAA').length + wrapStateContent('mode_change', 'BBB').length,
      );
      expect(byType.plan_updated!.count).toBe(1);
      // Сортировка: по chars убыв.
      expect(history.stateMessages[0]!.chars).toBeGreaterThanOrEqual(history.stateMessages[1]!.chars);
    });

    it('считает нетекстовые вложения отправляемых сообщений', async () => {
      const session = await createSessionWithUser();
      const withAttachment = makeUserMessage('see');
      withAttachment.parts = [
        { id: generateId(), type: 'tool_result', data: { content: 'abc' } },
        makeTextPart('see'),
      ];
      await sessionManager.addMessage(session.id, withAttachment);

      // Вложение в исключённом сообщении не учитывается.
      const excludedAttachment = makeUserMessage('x');
      excludedAttachment.hidden = true;
      excludedAttachment.parts = [{ id: generateId(), type: 'tool_result', data: { content: 'zzz' } }];
      await sessionManager.addMessage(session.id, excludedAttachment);

      const fresh = (await sessionManager.getSession(session.id))!;
      const { history } = await orchestrator.getPromptInfo(fresh);

      expect(history.attachments.count).toBe(1);
      expect(history.attachments.chars).toBe(JSON.stringify({ content: 'abc' }).length);
    });

    it('считает плейсхолдеры секретов ⟦SYNTH_SECRET_N⟧ в отправляемых сообщениях', async () => {
      const session = await createSessionWithUser();
      await sessionManager.addMessage(
        session.id,
        makeUserMessage('ключ ⟦SYNTH_SECRET_1⟧ и ⟦SYNTH_SECRET_2⟧'),
      );
      const hidden = makeUserMessage('⟦SYNTH_SECRET_3⟧');
      hidden.hidden = true;
      await sessionManager.addMessage(session.id, hidden);

      const fresh = (await sessionManager.getSession(session.id))!;
      const { history } = await orchestrator.getPromptInfo(fresh);

      expect(history.secretPlaceholders).toBe(2);
    });
  });
});
