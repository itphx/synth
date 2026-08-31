import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type {
  AuthKit,
} from '../auth/middleware.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import type {
  LLMGatewayConfig,
  ModelConfig,
  ProviderConfig as SharedProviderConfig,
  TokenUsage,
} from '@itphx/synth-shared';
import {
  AuditLogger,
  BaseProvider,
  ContextLengthExceededError,
  deobfuscateSecrets,
  GatewayProvider,
  ProviderError,
  ProviderFactory,
  RateLimitError,
  RateLimiter,
  SecretPatternStore,
} from '@itphx/synth-core';
import type {
  CancellationToken,
  LLMMessage,
} from '@itphx/synth-core';

/**
 * LLM Proxy endpoint (гибридный режим, Часть 5).
 * OpenAI-совместимый POST /api/v2/llm/chat/completions, через который локальный
 * core гоняет LLM-запросы централизованно — с применением LLM Gateway (AD-036):
 * обфускация/блокировка секретов, rate limit, аудит, полный payload-лог.
 */

/** Тело запроса chat/completions (подмножество OpenAI API). */
const chatCompletionsSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.string().min(1),
    content: z.string(),
  })).min(1),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  session_id: z.string().optional(),
});
type ChatCompletionsBody = z.infer<typeof chatCompletionsSchema>;

export interface LlmRoutesDeps {
  /** Резолв провайдера по имени (backend providerCache). */
  providerLoader: (name: string) => SharedProviderConfig | null;
  /** Резолв модели по id/имени (backend modelCache). */
  modelLoader: (model: string) => ModelConfig | null;
  /** Глобальный конфиг LLM Gateway (config.yaml, смёрженный с runtime). */
  gatewayConfig: LLMGatewayConfig;
  /** Общий AuditLogger (тот же JSONL, что и у оркестратора). */
  gatewayAuditLogger: AuditLogger;
  /** Общий RateLimiter Gateway (per-user + per-provider). */
  gatewayRateLimiter: RateLimiter;
  /** Путь к JSONL полного лога запросов/ответов LLM. */
  gatewayPayloadLogPath?: string;
  /** Хранилище кастомных regex-паттернов детекции секретов (null — дефолт детектора). */
  patternStore: SecretPatternStore | null;
  /** HTTP-мидлварь лимита запросов на ключ/пользователя (необязательно). */
  rateLimiter?: ReturnType<typeof createRateLimiter>;
}

interface ProviderErrorMapping {
  status: 400 | 429 | 502;
  code: string;
  message: string;
}

/** Маппинг ошибок провайдера на HTTP-статус + код (согласуется с llm-error.ts). */
function mapProviderError(err: unknown): ProviderErrorMapping {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ContextLengthExceededError) {
    return { status: 400, code: 'CONTEXT_LENGTH_EXCEEDED', message };
  }
  if (err instanceof RateLimitError) {
    return { status: 429, code: 'RATE_LIMITED', message };
  }
  if (err instanceof ProviderError) {
    return { status: 502, code: 'PROVIDER_ERROR', message };
  }
  // Fallback-классификация по тексту (для обычных Error, которые кидают провайдеры).
  const lower = message.toLowerCase();
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('429')) {
    return { status: 429, code: 'RATE_LIMITED', message };
  }
  if (lower.includes('context length') || lower.includes('too long')) {
    return { status: 400, code: 'CONTEXT_LENGTH_EXCEEDED', message };
  }
  return { status: 502, code: 'PROVIDER_ERROR', message };
}

/** OpenAI-формат usage из TokenUsage ядра. */
function toOpenAiUsage(usage: TokenUsage): Record<string, number> {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  };
}

/** Конвертация OpenAI-сообщений {role, content} в LLMMessage ядра. */
function toLlmMessages(raw: Array<{ role: string; content: string }>): LLMMessage[] {
  const ts = Date.now();
  return raw.map((m, i) => ({
    id: `llm-proxy-${ts}-${i}`,
    role: m.role,
    content: m.content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'llm-proxy',
  }));
}

export function createLlmRoutes(kit: AuthKit, deps: LlmRoutesDeps): Hono {
  const app = new Hono();

  const middlewares = deps.rateLimiter ? [deps.rateLimiter] : [];

  // POST /api/v2/llm/chat/completions — OpenAI-совместимый LLM Proxy
  app.post('/chat/completions', kit.requireAuth, ...middlewares, async (c) => {
    const user = (await kit.getCurrentUser(c))!;

    const rawBody = await c.req.json().catch(() => null);
    if (!rawBody) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Невалидный JSON в теле запроса' } }, 400);
    }
    const parsed = chatCompletionsSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Некорректные данные: ' + parsed.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; '),
        },
      }, 400);
    }
    const body: ChatCompletionsBody = parsed.data;

    // 1. Резолв модели → провайдер.
    const modelConfig = deps.modelLoader(body.model);
    if (!modelConfig) {
      return c.json({ error: { code: 'MODEL_NOT_FOUND', message: `Модель не найдена: ${body.model}` } }, 404);
    }
    if (modelConfig.enabled === false) {
      return c.json({ error: { code: 'MODEL_DISABLED', message: `Модель отключена: ${body.model}` } }, 400);
    }

    const providerName = modelConfig.provider;
    const providerConfig = deps.providerLoader(providerName);
    if (!providerConfig || !providerConfig.baseUrl) {
      return c.json({ error: { code: 'PROVIDER_NOT_FOUND', message: `Провайдер не найден: ${providerName}` } }, 502);
    }
    if (providerConfig.enabled === false) {
      return c.json({ error: { code: 'PROVIDER_DISABLED', message: `Провайдер отключён: ${providerName}` } }, 400);
    }

    // 2. Создаём провайдер (модель из ModelConfig.name — реальное имя для LLM API).
    let inner: BaseProvider;
    try {
      inner = ProviderFactory.create(providerName, {
        type: providerConfig.type,
        name: providerConfig.name || providerName,
        url: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey || '',
        model: modelConfig.name,
        timeout: providerConfig.timeout ?? 120,
        maxTokens: body.max_tokens,
      }, body.temperature, body.top_p);
    } catch (e) {
      return c.json({
        error: {
          code: 'PROVIDER_CONFIG_ERROR',
          message: `Не удалось создать провайдера ${providerName}: ${e instanceof Error ? e.message : String(e)}`,
        },
      }, 502);
    }

    // 3. AD-036: оборачиваем провайдер в GatewayProvider.
    // У локального core нет карты обфускации, поэтому для прокси держим
    // transient-карту на время запроса: getMap/saveMap читают/пишут её, а после
    // ответа деобфусцируем контент по той же карте (иначе клиент увидел бы
    // плейсхолдеры ⟦SYNTH_SECRET_N⟧ без возможности их восстановить).
    const transientMap = new Map<string, Record<string, string>>();
    const sessionId = body.session_id ?? `llm-proxy:${user.id}`;
    // Сужение в замыкании: TS не сохраняет guard из тернарника внутри колбэка.
    const patternStore = deps.patternStore;
    const provider = new GatewayProvider(inner, deps.gatewayConfig, {
      getMap: async () => transientMap.get('proxy') ?? {},
      saveMap: async (map) => { transientMap.set('proxy', map); },
      getAudit: () => deps.gatewayAuditLogger,
      getRateLimiter: () => deps.gatewayRateLimiter,
      getPatterns: patternStore ? () => patternStore.getPatterns() : undefined,
      payloadLogPath: deps.gatewayPayloadLogPath,
      sessionId,
      userId: user.id,
    });

    const messages = toLlmMessages(body.messages);
    const tools = body.tools && body.tools.length > 0 ? body.tools : undefined;

    if (body.stream) {
      return streamCompletions(c, provider, messages, tools, body.model, transientMap);
    }

    // 4. Non-stream: полный ответ в OpenAI-формате.
    try {
      const response = await provider.chat(messages, undefined, tools, false);
      const map = transientMap.get('proxy') ?? {};
      const content = deobfuscateSecrets(response.content, map);
      return c.json({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: toOpenAiUsage(response.usage),
      });
    } catch (err) {
      const mapped = mapProviderError(err);
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    }
  });

  return app;
}

/**
 * SSE-стрим в OpenAI-формате (text/event-stream).
 * Каждая строка: data: {id, object: 'chat.completion.chunk', created, model,
 * choices: [{index: 0, delta: {content}, finish_reason: null}]}.
 * В конце — финальный чанк с finish_reason: 'stop' и data: [DONE].
 * Ошибки провайдера в середине стрима (статус уже 200) шлём объектом error
 * в потоке, затем [DONE] и закрываем.
 */
function streamCompletions(
  c: Context,
  provider: BaseProvider,
  messages: LLMMessage[],
  tools: Record<string, unknown>[] | undefined,
  model: string,
  transientMap: Map<string, Record<string, string>>,
): Response {
  const signal = c.req.raw.signal;
  const cancellationToken: CancellationToken = {
    cancelled: false,
    cancel() { this.cancelled = true; },
  };
  if (signal.aborted) {
    cancellationToken.cancel();
  } else {
    signal.addEventListener('abort', () => cancellationToken.cancel(), { once: true });
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        let finalUsage: TokenUsage | undefined;

        try {
          for await (const chunk of provider.chatAsync(messages, undefined, tools, undefined, cancellationToken)) {
            if (chunk.usage) finalUsage = chunk.usage;
            if (chunk.isFinal) continue;
            if (!chunk.content) continue;

            // Деобфускация по transient-карте запроса (gateway уже отработал до первого чанка).
            const content = deobfuscateSecrets(chunk.content, transientMap.get('proxy') ?? {});
            if (!content) continue;

            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            });
          }

          // Финальный чанк: finish_reason + usage (аналог OpenAI stream_options).
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ...(finalUsage ? { usage: toOpenAiUsage(finalUsage) } : {}),
          });
        } catch (err) {
          const mapped = mapProviderError(err);
          send({ error: { code: mapped.code, message: mapped.message } });
        } finally {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch { /* client disconnected */ }
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}
