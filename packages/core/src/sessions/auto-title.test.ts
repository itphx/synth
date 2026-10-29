/**
 * Тесты `sessions/auto-title.ts`: LLM-заголовок и фоллбек из первого сообщения.
 *
 * Изолированно: фейковый провайдер (`chat`), реальный `SessionManager` в
 * tmp-каталоге; без сети.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, LLMResponse } from '@itphx/synth-shared';
import type { BaseProvider } from '../providers/base.js';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from './manager.js';
import { autoTitleSession } from './auto-title.js';

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

afterAll(() => {
  vi.restoreAllMocks();
});

function userMessage(content: string): Message {
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
  };
}

function titleProvider(response: { content?: string; throws?: Error }) {
  const chat = vi.fn(async (): Promise<LLMResponse> => {
    if (response.throws) throw response.throws;
    return { content: response.content ?? '' } as LLMResponse;
  });
  return { provider: { chat } as unknown as BaseProvider, chat };
}

describe('autoTitleSession — LLM-заголовок', () => {
  it('нормальный ответ модели сохраняется как заголовок', async () => {
    const session = await sessionManager.createSession();
    await sessionManager.addMessage(session.id, userMessage('Как настроить сборку проекта?'));
    const { provider, chat } = titleProvider({ content: 'Настройка сборки проекта' });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBe('Настройка сборки проекта');
    expect(chat).toHaveBeenCalledTimes(1);
    expect((await sessionManager.getSession(session.id))!.title).toBe('Настройка сборки проекта');
  });

  it('не перетирает пользовательский заголовок', async () => {
    const session = await sessionManager.createSession({ title: 'Мой заголовок' });
    await sessionManager.addMessage(session.id, userMessage('привет'));
    const { provider, chat } = titleProvider({ content: 'Другой заголовок' });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect((await sessionManager.getSession(session.id))!.title).toBe('Мой заголовок');
  });
});

describe('autoTitleSession — фоллбек из первого сообщения', () => {
  it('пустой ответ модели → фоллбек: markdown снят, первая непустая строка', async () => {
    const session = await sessionManager.createSession();
    await sessionManager.addMessage(
      session.id,
      userMessage('\n# **Настройка**   агента\nвторая строка'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ content: '   ' });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBe('Настройка агента');
    expect((await sessionManager.getSession(session.id))!.title).toBe('Настройка агента');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('[AUTO-TITLE]');
  });

  it('исключение провайдера → фоллбек + предупреждение (без содержимого сообщения)', async () => {
    const content = 'Почини сборку, пожалуйста';
    const session = await sessionManager.createSession();
    await sessionManager.addMessage(session.id, userMessage(content));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ throws: new Error('provider down') });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBe(content);
    expect((await sessionManager.getSession(session.id))!.title).toBe(content);
    const warned = String(warn.mock.calls[0]![0]);
    expect(warned).toContain('[AUTO-TITLE]');
    expect(warned).toContain('provider down');
    expect(warned).not.toContain(content);
  });

  it('слишком длинный ответ модели → фоллбек с обрезкой до 60 символов', async () => {
    const session = await sessionManager.createSession();
    await sessionManager.addMessage(session.id, userMessage('а'.repeat(200)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = titleProvider({ content: 'з'.repeat(150) });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBe('а'.repeat(60));
    expect(warn).toHaveBeenCalled();
  });

  it('пустое первое сообщение (только пробелы/разметка) → заголовок не меняется', async () => {
    const session = await sessionManager.createSession();
    await sessionManager.addMessage(session.id, userMessage('   \n#\n'));
    const { provider } = titleProvider({ content: '' });

    const title = await autoTitleSession(
      (await sessionManager.getSession(session.id))!,
      sessionManager,
      provider,
    );

    expect(title).toBeNull();
    expect((await sessionManager.getSession(session.id))!.title).toBe('New session');
  });
});
