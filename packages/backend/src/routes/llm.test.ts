import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmRoutes } from './llm.js';
import type { LlmRoutesDeps } from './llm.js';
import {
  AuditLogger,
  BaseProvider,
  ContextLengthExceededError,
  ProviderFactory,
  RateLimitError,
  RateLimiter,
  SecretPatternStore,
} from '@itphx/synth-core';
import type { CancellationToken, LLMMessage } from '@itphx/synth-core';
import type {
  LLMChunk,
  LLMResponse,
  LLMGatewayConfig,
  ModelConfig,
  ProviderConfig as SharedProviderConfig,
  User,
} from '@itphx/synth-shared';

const userUser: User = {
  id: 'developer',
  username: 'developer',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

function createMockKit(user: User) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      c.set('user', user);
      await next();
    },
    getCurrentUser: () => user,
  };
}

function createUnauthorizedKit() {
  return {
    requireAuth: async (c: Context) => {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    },
    getCurrentUser: () => null,
  };
}

/** Минимальный fake-провайдер с фиксированным ответом (имитирует OpenAIProvider). */
class FakeProvider extends BaseProvider {
  throwError: Error | null = null;
  /** Если true — chat/chatAsync возвращают последнее user-сообщение (для теста обфускации). */
  echoUserContent = false;
  /** Если задан — chat/chatAsync возвращают tool_calls (OpenAI-формат). */
  toolCalls: Record<string, unknown>[] | null = null;
  /** Если задан — chat/chatAsync возвращают reasoning_content. */
  reasoning: string | undefined;
  lastMessages: LLMMessage[] = [];

  constructor(model = 'fake-model') {
    super({ url: 'http://fake.local/v1', apiKey: 'test-key', model, name: 'fake' });
  }

  getProviderName(): string {
    return 'fake';
  }

  async chat(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
  ): Promise<LLMResponse> {
    if (this.throwError) throw this.throwError;
    this.lastMessages = messages;
    const content = this.echoUserContent
      ? (messages.find((m) => m.role === 'user')?.content ?? '')
      : 'Ответ fake-провайдера';
    return {
      content,
      model: this.model,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      ...(this.toolCalls ? { toolCalls: this.toolCalls } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    if (this.throwError) throw this.throwError;
    this.lastMessages = messages;
    const content = this.echoUserContent
      ? (messages.find((m) => m.role === 'user')?.content ?? '')
      : 'Привет';
    yield {
      content,
      isFinal: false,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...(this.toolCalls ? { toolCalls: this.toolCalls } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    };
    yield {
      content: '',
      isFinal: true,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      ...(this.toolCalls ? { toolCalls: this.toolCalls } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    };
  }
}

const modelConfig: ModelConfig = {
  id: 'fake/fake-model',
  name: 'fake-model',
  provider: 'fake',
  description: '',
  enabled: true,
  isDefault: true,
};

const providerConfig: SharedProviderConfig = {
  name: 'fake',
  type: 'openai',
  baseUrl: 'http://fake.local/v1',
  apiKey: 'test-key',
  defaultModel: 'fake-model',
  timeout: 30,
  enabled: true,
  icon: '',
};

const gatewayDisabledConfig: LLMGatewayConfig = {
  enabled: false,
  inputMode: 'obfuscate',
  logPayloads: false,
  payloadLogPath: '',
  rateLimit: { userPerMinute: 100, providerPerMinute: 100 },
  audit: { enabled: true, logPath: '' },
};

const gatewayEnabledConfig: LLMGatewayConfig = {
  ...gatewayDisabledConfig,
  enabled: true,
};

const BASE = '/api/v2/llm/chat/completions';

function postBody(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('LLM Proxy routes (гибридный режим, Часть 5)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-llm-proxy-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestContext(
    user: User,
    opts: {
      fakeProvider?: FakeProvider;
      gatewayConfig?: LLMGatewayConfig;
      modelLoader?: (model: string) => ModelConfig | null;
      providerLoader?: (name: string) => SharedProviderConfig | null;
      patternStore?: SecretPatternStore | null;
    } = {},
  ) {
    const fake = opts.fakeProvider ?? new FakeProvider();
    const auditPath = join(tmpDir, 'audit', 'llm-gateway.jsonl');
    const deps: LlmRoutesDeps = {
      providerLoader: opts.providerLoader ?? ((name) => (name === 'fake' ? providerConfig : null)),
      modelLoader: opts.modelLoader ?? ((model) => (model === 'fake-model' || model === 'fake/fake-model' ? modelConfig : null)),
      gatewayConfig: opts.gatewayConfig ?? gatewayDisabledConfig,
      gatewayAuditLogger: new AuditLogger(auditPath),
      gatewayRateLimiter: new RateLimiter(100, 100),
      gatewayPayloadLogPath: '',
      patternStore: opts.patternStore ?? null,
    };
    vi.spyOn(ProviderFactory, 'create').mockReturnValue(fake as never);

    const app = new Hono();
    const kit = createMockKit(user);
    app.route('/api/v2/llm', createLlmRoutes(kit as any, deps));
    return { app, fake, auditPath };
  }

  describe('валидация тела', () => {
    it('невалидный JSON → 400 BAD_REQUEST', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{не-json',
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('пустое тело / нет model → 400 BAD_REQUEST', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('пустой messages → 400 BAD_REQUEST', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({ model: 'fake-model', messages: [] }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('резолв модели/провайдера', () => {
    it('модель не найдена → 404 MODEL_NOT_FOUND', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({
        model: 'no-such-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('MODEL_NOT_FOUND');
      expect(body.error.message).toContain('no-such-model');
    });

    it('модель отключена → 400 MODEL_DISABLED', async () => {
      const { app } = createTestContext(userUser, {
        modelLoader: () => ({ ...modelConfig, enabled: false }),
      });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('MODEL_DISABLED');
    });

    it('провайдер не найден → 502 PROVIDER_NOT_FOUND', async () => {
      const { app } = createTestContext(userUser, {
        modelLoader: () => ({ ...modelConfig, provider: 'missing' }),
        providerLoader: () => null,
      });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(502);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROVIDER_NOT_FOUND');
    });

    it('провайдер отключён → 400 PROVIDER_DISABLED', async () => {
      const { app } = createTestContext(userUser, {
        providerLoader: () => ({ ...providerConfig, enabled: false }),
      });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROVIDER_DISABLED');
    });
  });

  describe('явный provider в теле (remote-зеркала)', () => {
    // Сервер знает двух провайдеров: fake (владелец fake-model) и itphx.
    const twoProviderLoader = (name: string) => {
      if (name === 'fake') return providerConfig;
      if (name === 'itphx') return { ...providerConfig, name: 'itphx', baseUrl: 'https://ai.itphx.ru/v1', defaultModel: 'local.qwen3:14b' };
      return null;
    };

    it('provider совпадает с провайдером модели → 200 (как раньше)', async () => {
      const { app } = createTestContext(userUser, { providerLoader: twoProviderLoader });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        provider: 'fake',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.choices[0].message.content).toBe('Ответ fake-провайдера');
    });

    it('provider существует, но не совпадает с провайдером модели → 400 MODEL_MISMATCH', async () => {
      const { app } = createTestContext(userUser, { providerLoader: twoProviderLoader });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        provider: 'itphx',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('MODEL_MISMATCH');
      expect(body.error.message).toContain('itphx');
      expect(body.error.message).toContain('fake-model');
    });

    it('provider не существует на сервере → 502 PROVIDER_NOT_FOUND', async () => {
      const { app } = createTestContext(userUser, { providerLoader: twoProviderLoader });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        provider: 'no-such-provider',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(502);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROVIDER_NOT_FOUND');
    });

    it('provider существует, но отключён → 400 PROVIDER_DISABLED', async () => {
      const { app } = createTestContext(userUser, {
        providerLoader: (name) => (name === 'itphx' ? { ...providerConfig, name: 'itphx', enabled: false } : providerConfig),
      });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        provider: 'itphx',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROVIDER_DISABLED');
    });

    it('без provider работает как раньше (резолв по модели)', async () => {
      const { app } = createTestContext(userUser, { providerLoader: twoProviderLoader });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(200);
    });
  });

  describe('non-stream успех', () => {
    it('возвращает OpenAI-формат и usage', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
        temperature: 0.3,
        max_tokens: 64,
      }));
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe('chat.completion');
      expect(typeof body.created).toBe('number');
      expect(body.model).toBe('fake-model');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0]).toMatchObject({
        index: 0,
        message: { role: 'assistant', content: 'Ответ fake-провайдера' },
        finish_reason: 'stop',
      });
      expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('прокидывает user-сообщения в провайдер (LLMMessage)', async () => {
      const fake = new FakeProvider();
      const { app } = createTestContext(userUser, { fakeProvider: fake });
      await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [
          { role: 'system', content: 'ты ассистент' },
          { role: 'user', content: 'привет' },
        ],
      }));
      expect(fake.lastMessages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(fake.lastMessages[1]?.content).toBe('привет');
    });

    it('tool-цикл: tool_calls/tool_call_id/reasoning_content доходят до провайдера', async () => {
      const fake = new FakeProvider();
      const { app } = createTestContext(userUser, { fakeProvider: fake });
      await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
            ],
            reasoning_content: 'подумал и решил прочитать файл',
          },
          { role: 'tool', content: 'содержимое файла', tool_call_id: 'call_1' },
          { role: 'user', content: 'продолжай' },
        ],
      }));

      const assistant = fake.lastMessages[0]!;
      expect(assistant.toolUse).toEqual([
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      ]);
      expect(assistant.reasoning).toBe('подумал и решил прочитать файл');
      const toolMsg = fake.lastMessages[1]!;
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.toolCallId).toBe('call_1');
      expect(toolMsg.content).toBe('содержимое файла');
    });

    it('non-stream: tool_calls/reasoning_content пробрасываются в choices[0].message', async () => {
      const fake = new FakeProvider();
      fake.toolCalls = [
        { id: 'call_2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"b.ts"}' } },
      ];
      fake.reasoning = 'надо отредактировать';
      const { app } = createTestContext(userUser, { fakeProvider: fake });
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'исправь' }],
      }));
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.choices[0].message.tool_calls).toEqual(fake.toolCalls);
      expect(body.choices[0].message.reasoning_content).toBe('надо отредактировать');
      expect(body.choices[0].message.content).toBe('Ответ fake-провайдера');
    });
  });

  describe('stream успех', () => {
    it('возвращает SSE-чунки OpenAI-формата и [DONE]', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
        stream: true,
      }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      // data: [DONE] — не JSON, исключаем из парсинга
      const parsed = lines
        .filter((l) => !l.includes('[DONE]'))
        .map((l) => JSON.parse(l.slice(6)));
      // дельта-чанк с контентом
      expect(parsed[0]!.object).toBe('chat.completion.chunk');
      expect(parsed[0]!.choices[0].delta.content).toBe('Привет');
      expect(parsed[0]!.choices[0].finish_reason).toBeNull();
      // финальный чанк: finish_reason stop + usage
      const last = parsed[parsed.length - 1]!;
      expect(last.choices[0].finish_reason).toBe('stop');
      expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
      // завершение потока
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('AD-070: stream_options.include_usage принимается и usage есть в финальном чанке', async () => {
      const { app } = createTestContext(userUser);
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
        stream: true,
        stream_options: { include_usage: true },
      }));
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      const parsed = lines
        .filter((l) => !l.includes('[DONE]'))
        .map((l) => JSON.parse(l.slice(6)));
      const last = parsed[parsed.length - 1]!;
      expect(last.choices[0].finish_reason).toBe('stop');
      expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('ошибка провайдера в стриме шлёт error-объект и [DONE]', async () => {
      const fake = new FakeProvider();
      fake.throwError = new RateLimitError('too many requests');
      const { app } = createTestContext(userUser, { fakeProvider: fake });

      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
        stream: true,
      }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('RATE_LIMITED');
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('stream: tool_calls/reasoning_content пробрасываются в choices[0].delta', async () => {
      const fake = new FakeProvider();
      fake.toolCalls = [
        { index: 0, id: 'call_3', type: 'function', function: { name: 'grep_files', arguments: '{"pattern":"x"}' } },
      ];
      fake.reasoning = 'надо поискать';
      const { app } = createTestContext(userUser, { fakeProvider: fake });

      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'найди' }],
        stream: true,
      }));
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: '));
      const parsed = lines
        .filter((l) => !l.includes('[DONE]'))
        .map((l) => JSON.parse(l.slice(6)));

      // Контент-дельта как раньше.
      const contentChunk = parsed.find((c: any) => c.choices?.[0]?.delta?.content === 'Привет');
      expect(contentChunk).toBeDefined();
      // Отдельный дельта-чанк с накопленными tool_calls/reasoning (один раз).
      const toolChunk = parsed.find((c: any) => Array.isArray(c.choices?.[0]?.delta?.tool_calls));
      expect(toolChunk).toBeDefined();
      expect(toolChunk.choices[0].delta.tool_calls).toEqual(fake.toolCalls);
      expect(toolChunk.choices[0].delta.reasoning_content).toBe('надо поискать');
      // Финальный чанк — как раньше.
      const last = parsed[parsed.length - 1]!;
      expect(last.choices[0].finish_reason).toBe('stop');
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });
  });

  describe('маппинг ошибок провайдера', () => {
    it.each([
      [new RateLimitError('rate limit exceeded'), 429, 'RATE_LIMITED'],
      [new ContextLengthExceededError('context length exceeded'), 400, 'CONTEXT_LENGTH_EXCEEDED'],
      [new Error('OpenAI API error 500: upstream failed'), 502, 'PROVIDER_ERROR'],
    ])('%s → %i %s', async (err, status, code) => {
      const fake = new FakeProvider();
      fake.throwError = err;
      const { app } = createTestContext(userUser, { fakeProvider: fake });

      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(status);
      const body: any = await res.json();
      expect(body.error.code).toBe(code);
    });

    it('fallback-классификация по тексту: 429 для «429» в обычном Error', async () => {
      const fake = new FakeProvider();
      fake.throwError = new Error('HTTP 429 Too Many Requests');
      const { app } = createTestContext(userUser, { fakeProvider: fake });

      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(429);
      const body: any = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('без auth', () => {
    it('возвращает 401', async () => {
      const app = new Hono();
      const kit = createUnauthorizedKit();
      const deps: LlmRoutesDeps = {
        providerLoader: () => providerConfig,
        modelLoader: () => modelConfig,
        gatewayConfig: gatewayDisabledConfig,
        gatewayAuditLogger: new AuditLogger(join(tmpDir, 'audit', 'llm-gateway.jsonl')),
        gatewayRateLimiter: new RateLimiter(100, 100),
        patternStore: null,
      };
      app.route('/api/v2/llm', createLlmRoutes(kit as any, deps));

      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'привет' }],
      }));
      expect(res.status).toBe(401);
      const body: any = await res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('LLM Gateway (AD-036)', () => {
    it('обфусцирует секрет в запросе и восстанавливает его в ответе (non-stream)', async () => {
      const fake = new FakeProvider();
      fake.echoUserContent = true;
      const patternStore = new SecretPatternStore({ dataDir: tmpDir });
      const { app, auditPath } = createTestContext(userUser, {
        fakeProvider: fake,
        gatewayConfig: gatewayEnabledConfig,
        patternStore,
      });

      const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: `мой ключ ${secret} используй его` }],
      }));
      expect(res.status).toBe(200);
      const body: any = await res.json();

      // Провайдер получил обфусцированное сообщение, ответ деобфусцирован.
      expect(fake.lastMessages[0]!.content).toContain('⟦SYNTH_SECRET_1⟧');
      expect(fake.lastMessages[0]!.content).not.toContain(secret);
      expect(body.choices[0].message.content).toContain(secret);
      expect(body.choices[0].message.content).not.toContain('⟦SYNTH_SECRET_1⟧');

      // Аудит: событие obfuscated записано.
      const auditRaw = await readFile(auditPath, 'utf8');
      const entries = auditRaw.trim().split('\n').map((l) => JSON.parse(l));
      expect(entries.some((e: any) => e.type === 'obfuscated' && e.sessionId === `llm-proxy:${userUser.id}`)).toBe(true);
    });

    it('с выключенным gateway секрет не трогается', async () => {
      const fake = new FakeProvider();
      fake.echoUserContent = true;
      const { app } = createTestContext(userUser, {
        fakeProvider: fake,
        gatewayConfig: gatewayDisabledConfig,
      });

      const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const res = await app.request(BASE, postBody({
        model: 'fake-model',
        messages: [{ role: 'user', content: `мой ключ ${secret}` }],
      }));
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(fake.lastMessages[0]!.content).toContain(secret);
      expect(body.choices[0].message.content).toContain(secret);
    });
  });
});
