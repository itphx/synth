/**
 * Тесты `sessions/auto-title.ts`: план авто-заголовка, LLM-заголовок,
 * фоллбек из реплики с «сигналом задачи» и классификатор сигнала.
 *
 * Изолированно: фейковый провайдер (`chat`), реальный `SessionManager` в
 * tmp-каталоге; без сети.
 *
 * План (N — число диалоговых реплик пользователя):
 *  - N=1 и реплика-смолток → заголовок **откладывается** (LLM не зовётся);
 *  - N=1 и реплика с сигналом → режим «по первому сообщению»;
 *  - N=2..`maxAttempts` → режим «по диалогу» (исходный запрос + реплики);
 *  - N>`maxAttempts` → заголовок не ставится (только ручная регенерация).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeMediaPart, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { LLMResponse, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { autoTitleConfigSchema } from '@itphx/synth-shared/config';
import type { AutoTitleConfig } from '@itphx/synth-shared/config';
import type { BaseProvider, LLMMessage } from '../providers/base.js';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from './manager.js';
import { autoTitleSession, isLowSignalMessage, shouldAutoTitle } from './auto-title.js';

/** Дефолтный заголовок новой сессии (`session.default_title` ядра). */
const DEFAULT_TITLE = 'New session';
/** Реплика с сигналом задачи (длиннее `minSignalChars` по умолчанию). */
const SIGNAL_TEXT = 'Почини падающий тест авторизации';
/** Реплика-смолток (приветствие). */
const CHATTER_TEXT = 'привет';

let tmpDir: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-auto-title-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Конфиг секции `session.autoTitle` с дефолтами схемы. */
function cfg(overrides: Partial<AutoTitleConfig> = {}): AutoTitleConfig {
  return autoTitleConfigSchema.parse(overrides);
}

function userMessage(content: string, metadata?: Record<string, unknown>): Message {
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
    ...(metadata ? { metadata } : {}),
  };
}

function assistantMessage(content: string): Message {
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
  };
}

/**
 * Реплика с вложением (ADR-115): медиа-часть делает сообщение «сигналом
 * задачи» даже при коротком тексте.
 */
function userMessageWithImage(content: string): Message {
  const msg = userMessage(content);
  msg.parts = [
    makeTextPart(content),
    makeMediaPart('image', {
      blobPath: 'attachments/ab/abcdef0123456789',
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: 1024,
      name: 'screenshot.png',
    }),
  ];
  return msg;
}

function titleProvider(response: { content?: string; throws?: Error; usage?: TokenUsage }) {
  const chat = vi.fn(async (_messages: LLMMessage[]): Promise<LLMResponse> => {
    if (response.throws) throw response.throws;
    return {
      content: response.content ?? '',
      model: 'title-model',
      usage: response.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    } as LLMResponse;
  });
  return {
    provider: { chat, name: 'title-provider', model: 'title-model' } as unknown as BaseProvider,
    chat,
  };
}

/** Сессия с указанными сообщениями (сохранены в файловом сторе). */
async function sessionWith(messages: Message[], title?: string): Promise<Session> {
  const created = await sessionManager.createSession(title ? { title } : {});
  for (const message of messages) await sessionManager.addMessage(created.id, message);
  return (await sessionManager.getSession(created.id))!;
}

/**
 * Текущий заголовок сессии в сторе.
 *
 * Тип — `string | undefined`: заголовок у сессии необязательный (`Session.title`),
 * и подменять «нет сессии» на пустую строку здесь не нужно — ассерты проверяют
 * конкретные значения заголовка.
 */
async function storedTitle(sessionId: string): Promise<string | undefined> {
  return (await sessionManager.getSession(sessionId))?.title;
}

// --- Классификатор «сигнала задачи» ---

describe('isLowSignalMessage — классификатор «сигнала задачи»', () => {
  it('RU-приветствие — смолток (низкий сигнал)', () => {
    expect(isLowSignalMessage('привет', false, cfg())).toBe(true);
    expect(isLowSignalMessage('Привет!', false, cfg())).toBe(true);
    expect(isLowSignalMessage('здравствуйте', false, cfg())).toBe(true);
    expect(isLowSignalMessage('как дела', false, cfg())).toBe(true);
    expect(isLowSignalMessage('спасибо', false, cfg())).toBe(true);
  });

  it('EN-приветствие и смолток — низкий сигнал', () => {
    expect(isLowSignalMessage('hello', false, cfg())).toBe(true);
    expect(isLowSignalMessage('hi', false, cfg())).toBe(true);
    expect(isLowSignalMessage('thanks', false, cfg())).toBe(true);
    expect(isLowSignalMessage('ok', false, cfg())).toBe(true);
    expect(isLowSignalMessage('yes', false, cfg())).toBe(true);
  });

  it('приветствие вместе с задачей — сигнал задачи', () => {
    expect(isLowSignalMessage('привет, почини баг с авторизацией', false, cfg())).toBe(false);
  });

  it('длинный содержательный текст — сигнал задачи', () => {
    expect(
      isLowSignalMessage(
        'Разберись, почему падает интеграционный тест после обновления зависимостей',
        false,
        cfg(),
      ),
    ).toBe(false);
  });

  it('код, URL и путь — сигнал задачи', () => {
    expect(isLowSignalMessage('/etc/hosts', false, cfg())).toBe(false);
    expect(isLowSignalMessage('https://example.com/docs/page', false, cfg())).toBe(false);
    expect(isLowSignalMessage('```bash\nnpm run build\n```', false, cfg())).toBe(false);
  });

  it('пустая реплика — низкий сигнал', () => {
    expect(isLowSignalMessage('', false, cfg())).toBe(true);
    expect(isLowSignalMessage('   \n  ', false, cfg())).toBe(true);
  });

  it('вложение всегда считается сигналом задачи', () => {
    expect(isLowSignalMessage(CHATTER_TEXT, true, cfg())).toBe(false);
  });

  it('кастомный minSignalChars меняет порог сигнала', () => {
    // Реплика-приветствие: при пороге 30 — смолток, при пороге 7 (длина
    // реплики 7) — уже сигнал задачи.
    expect(isLowSignalMessage('thanks!', false, cfg({ minSignalChars: 30 }))).toBe(true);
    expect(isLowSignalMessage('thanks!', false, cfg({ minSignalChars: 7 }))).toBe(false);
  });
});

// --- План авто-заголовка ---

describe('shouldAutoTitle — план авто-заголовка', () => {
  it('одна реплика с сигналом → режим «по первому сообщению»', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)]);
    expect(shouldAutoTitle(session, cfg())).toEqual({ mode: 'message' });
  });

  it('одна реплика-смолток → заголовок откладывается', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT)]);
    expect(shouldAutoTitle(session, cfg())).toBeNull();
  });

  it('две реплики (первая — смолток) → режим «по диалогу»', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT), userMessage(SIGNAL_TEXT)]);
    expect(shouldAutoTitle(session, cfg())).toEqual({ mode: 'conversation' });
  });

  it('больше maxAttempts реплик → заголовок не ставится', async () => {
    const session = await sessionWith([
      userMessage('первая реплика'),
      userMessage('вторая реплика'),
      userMessage('третья реплика'),
    ]);
    expect(shouldAutoTitle(session, cfg({ maxAttempts: 2 }))).toBeNull();
  });

  it('дочерняя сессия не именуется', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)]);
    expect(shouldAutoTitle({ ...session, parentId: 'parent-1' }, cfg())).toBeNull();
  });

  it('выключенный авто-тайтл → плана нет', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)]);
    expect(shouldAutoTitle(session, cfg({ enabled: false }))).toBeNull();
  });

  it('slash-команда не именуется', async () => {
    const session = await sessionWith([userMessage('/help')]);
    expect(shouldAutoTitle(session, cfg())).toBeNull();
  });

  it('пользовательский заголовок не перетирается', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)], 'Мой заголовок');
    expect(shouldAutoTitle(session, cfg())).toBeNull();
  });

  it('force перетирает пользовательский заголовок (режим «по диалогу»)', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)], 'Мой заголовок');
    expect(shouldAutoTitle(session, cfg(), { force: true })).toEqual({ mode: 'conversation' });
  });
});

// --- LLM-заголовок ---

describe('autoTitleSession — LLM-заголовок', () => {
  it('N=1, реплика-смолток: LLM не зовётся, заголовок остаётся дефолтным', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT)]);
    const { provider, chat } = titleProvider({ content: 'Привет' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(await storedTitle(session.id)).toBe(DEFAULT_TITLE);
  });

  it('N=1, реплика с сигналом: LLM зовётся, в промпте только первое сообщение', async () => {
    const session = await sessionWith([
      userMessage(SIGNAL_TEXT),
      assistantMessage('Ответ ассистента: тест уже починен'),
    ]);
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Падающий тест авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0][0]!.content;
    expect(prompt).toContain(SIGNAL_TEXT);
    expect(prompt).not.toContain('Ответ ассистента');
    expect(await storedTitle(session.id)).toBe('Падающий тест авторизации');
  });

  it('N=2 после смолтка: режим «по диалогу» — в промпте обе реплики', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT), userMessage(SIGNAL_TEXT)]);
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Падающий тест авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0][0]!.content;
    expect(prompt).toContain('Original request');
    expect(prompt).toContain('Recent conversation');
    expect(prompt).toContain(CHATTER_TEXT);
    expect(prompt).toContain(SIGNAL_TEXT);
    expect(await storedTitle(session.id)).toBe('Падающий тест авторизации');
  });

  it('N>maxAttempts: LLM не зовётся, заголовок остаётся дефолтным', async () => {
    const session = await sessionWith([
      userMessage('первая реплика'),
      userMessage('вторая реплика'),
      userMessage('третья реплика'),
    ]);
    const { provider, chat } = titleProvider({ content: 'Лишний заголовок' });

    const title = await autoTitleSession(session, sessionManager, provider, {
      config: cfg({ maxAttempts: 2 }),
    });

    expect(title).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(await storedTitle(session.id)).toBe(DEFAULT_TITLE);
  });

  it('force перетирает пользовательский заголовок', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)], 'Мой заголовок');
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider, { force: true });

    expect(title).toBe('Падающий тест авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(await storedTitle(session.id)).toBe('Падающий тест авторизации');
  });

  it('без force пользовательский заголовок не перетирается (LLM не зовётся)', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)], 'Мой заголовок');
    const { provider, chat } = titleProvider({ content: 'Другой заголовок' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(await storedTitle(session.id)).toBe('Мой заголовок');
  });

  it('реплика с вложением — сигнал задачи (LLM зовётся)', async () => {
    const session = await sessionWith([userMessageWithImage(CHATTER_TEXT)]);
    const { provider, chat } = titleProvider({ content: 'Скриншот авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Скриншот авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(await storedTitle(session.id)).toBe('Скриншот авторизации');
  });

  it('служебные реплики (steer/scheduler/фон) не считаются репликами диалога', async () => {
    const session = await sessionWith([
      userMessage(SIGNAL_TEXT),
      userMessage('уточнение в ход', { steer: true }),
      userMessage('<process>ok</process>', { type: 'background_run_result', kind: 'process' }),
      userMessage('ночная задача', { scheduler: true, schedule_id: 'sch_1' }),
    ]);
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Падающий тест авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0][0]!.content;
    expect(prompt).toContain(SIGNAL_TEXT);
    expect(prompt).not.toContain('уточнение в ход');
    expect(prompt).not.toContain('ночная задача');
  });

  it('вложение тула не считается репликой пользователя', async () => {
    const session = await sessionWith([
      userMessage(SIGNAL_TEXT),
      userMessage('[image: shot.png]', {
        source: 'tool-attachment',
        tool: 'read_file',
        call_id: 'c1',
        agent_role: 'fixer',
      }),
    ]);
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Падающий тест авторизации');
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0][0]!.content;
    expect(prompt).toContain(SIGNAL_TEXT);
    expect(prompt).not.toContain('[image: shot.png]');
  });

  it('deferOnChatter: false — заголовок ставится даже для приветствия', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT)]);
    const { provider, chat } = titleProvider({ content: 'Привет' });

    const title = await autoTitleSession(session, sessionManager, provider, {
      config: cfg({ deferOnChatter: false }),
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(title).toBe('Привет');
    expect(await storedTitle(session.id)).toBe('Привет');
  });

  it('enabled: false — авто-заголовок не работает', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)]);
    const { provider, chat } = titleProvider({ content: 'Падающий тест авторизации' });

    const title = await autoTitleSession(session, sessionManager, provider, {
      config: cfg({ enabled: false }),
    });

    expect(title).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(await storedTitle(session.id)).toBe(DEFAULT_TITLE);
  });

  it('usage LLM-заголовка уходит в onUsage (aux-учёт)', async () => {
    const session = await sessionWith([userMessage(SIGNAL_TEXT)]);
    const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
    const { provider } = titleProvider({ content: 'Падающий тест авторизации', usage });
    const onUsage = vi.fn();

    await autoTitleSession(session, sessionManager, provider, { onUsage });

    expect(onUsage).toHaveBeenCalledWith(usage, { provider: 'title-provider', model: 'title-model' });
  });
});

// --- Фоллбек из текста реплики ---

describe('autoTitleSession — фоллбек из реплики с сигналом', () => {
  it('ошибка провайдера → фоллбек: markdown снят, взята первая строка', async () => {
    const session = await sessionWith([userMessage('\n# **Настройка**   агента\nвторая строка')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ throws: new Error('provider down') });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('Настройка агента');
    expect(await storedTitle(session.id)).toBe('Настройка агента');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('[AUTO-TITLE]');
  });

  it('фоллбек обрезает реплику до 60 символов', async () => {
    const session = await sessionWith([userMessage('а'.repeat(200))]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ throws: new Error('provider down') });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe('а'.repeat(60));
  });

  it('фоллбак берётся из первой реплики с сигналом, а не из смолтка', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT), userMessage(SIGNAL_TEXT)]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ throws: new Error('provider down') });

    const title = await autoTitleSession(session, sessionManager, provider);

    expect(title).toBe(SIGNAL_TEXT);
    expect(await storedTitle(session.id)).toBe(SIGNAL_TEXT);
  });

  it('реплика-смолток не становится заголовком даже при ошибке провайдера (force)', async () => {
    const session = await sessionWith([userMessage(CHATTER_TEXT)]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider, chat } = titleProvider({ throws: new Error('provider down') });

    const title = await autoTitleSession(session, sessionManager, provider, { force: true });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(title).toBeNull();
    expect(await storedTitle(session.id)).toBe(DEFAULT_TITLE);
  });
});
