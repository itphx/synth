/**
 * Тесты `task/prompt.ts` (ADR-095, шаг 5): резолвинг промпта роли саб-агента,
 * секция `[НЕДОСТУПНЫЕ ТУЛЫ]` и маппинг сообщений в LLM-формат.
 *
 * Изолированно: только файловая система tmp-каталога, без сети и LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, ToolCapability } from '@itphx/synth-shared';
import type { Message, ToolForLLM } from '@itphx/synth-shared';
import {
  buildSubagentUnavailableToolsSection,
  messageToLLMMessage,
  resolveSubagentPrompt,
} from './prompt.js';

function tool(name: string): ToolForLLM {
  return {
    type: 'function',
    function: { name, description: '', parameters: {} },
  };
}

describe('resolveSubagentPrompt', () => {
  let dir: string;
  let subagentsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-subagent-prompt-'));
    subagentsDir = join(dir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('приоритет локализованного файла: {type}.{lang}.md (ru по умолчанию)', async () => {
    await writeFile(join(subagentsDir, 'explore.ru.md'), 'RU PROMPT');
    await writeFile(join(subagentsDir, 'explore.md'), 'BASE PROMPT');

    expect(resolveSubagentPrompt({ subagentPrompt: 'legacy' }, 'explore', undefined, dir))
      .toBe('RU PROMPT');
  });

  it('language=en читает {type}.en.md', async () => {
    await writeFile(join(subagentsDir, 'explore.en.md'), 'EN PROMPT');
    await writeFile(join(subagentsDir, 'explore.ru.md'), 'RU PROMPT');

    expect(resolveSubagentPrompt({}, 'explore', 'en', dir)).toBe('EN PROMPT');
  });

  it('неизвестный язык трактуется как ru', async () => {
    await writeFile(join(subagentsDir, 'explore.ru.md'), 'RU PROMPT');

    expect(resolveSubagentPrompt({}, 'explore', 'de', dir)).toBe('RU PROMPT');
  });

  it('фоллбек на базовый {type}.md, если локализованного нет', async () => {
    await writeFile(join(subagentsDir, 'explore.md'), 'BASE PROMPT');

    expect(resolveSubagentPrompt({}, 'explore', 'en', dir)).toBe('BASE PROMPT');
  });

  it('нет файлов промпта → agentDef.subagentPrompt (легаси definitions)', async () => {
    expect(resolveSubagentPrompt({ subagentPrompt: 'legacy prompt' }, 'explore', 'ru', dir))
      .toBe('legacy prompt');
  });

  it('systemPromptsDir не задан → сразу agentDef.subagentPrompt', () => {
    expect(resolveSubagentPrompt({ subagentPrompt: 'legacy prompt' }, 'explore', 'ru', undefined))
      .toBe('legacy prompt');
  });

  it('нет ни файла, ни subagentPrompt → пустая строка', () => {
    expect(resolveSubagentPrompt({}, 'explore', 'ru', undefined)).toBe('');
  });
});

describe('buildSubagentUnavailableToolsSection (ADR-070 §2.9.1 / ADR-075)', () => {
  it('нет tools → пустая строка', () => {
    expect(buildSubagentUnavailableToolsSection(undefined, undefined, 'ru')).toBe('');
    expect(buildSubagentUnavailableToolsSection([], undefined, 'ru')).toBe('');
  });

  it('runtimeDeps undefined → fail-open, тулы не помечаются', () => {
    const tools = [tool('git_status'), tool('grep_files')];
    expect(buildSubagentUnavailableToolsSection(tools, undefined, 'ru')).toBe('');
  });

  it('недоступная программа (git=false) помечает только зависимые тулы', () => {
    const tools = [tool('git_status'), tool('read_file')];
    const section = buildSubagentUnavailableToolsSection(
      tools,
      { git: false, rg: true, sh: true },
      'ru',
    );
    expect(section).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(section).toContain('git_status');
    expect(section).toContain('«git»');
    expect(section).not.toContain('read_file');
  });

  it('en-локаль даёт англоязычный заголовок', () => {
    const section = buildSubagentUnavailableToolsSection(
      [tool('grep_files')],
      { git: true, rg: false, sh: true },
      'en',
    );
    expect(section).toContain('[UNAVAILABLE TOOLS]');
    expect(section).toContain('grep_files');
  });

  it('workspaceReady=false помечает file/shell/git-тулы (по capabilities), web — нет', () => {
    const tools = [tool('read_file'), tool('web_fetch')];
    const section = buildSubagentUnavailableToolsSection(
      tools,
      undefined,
      'ru',
      {
        workspaceReady: false,
        capabilitiesOf: (n) => (n === 'read_file' ? [ToolCapability.FILE_READ] : [ToolCapability.WEB]),
      },
    );
    // Все workspace-зависимые схлопнуты в одну строку.
    expect(section).toContain('file/shell/git-инструменты');
    expect(section).not.toContain('web_fetch');
    expect(section).not.toContain('- read_file');
  });

  it('workspaceReady=false без capabilitiesOf → file-тул не определяется как workspace-зависимый', () => {
    const section = buildSubagentUnavailableToolsSection(
      [tool('read_file')],
      undefined,
      'ru',
      { workspaceReady: false },
    );
    expect(section).toBe('');
  });

  it('dependency и workspace: тул не дублируется (dependency приоритетнее)', () => {
    const section = buildSubagentUnavailableToolsSection(
      [tool('git_status'), tool('read_file')],
      { git: false, rg: true, sh: true },
      'ru',
      {
        workspaceReady: false,
        capabilitiesOf: (n) => (n === 'read_file' ? [ToolCapability.FILE_READ] : [ToolCapability.GIT_READ]),
      },
    );
    // git_status — только dependency-строка (workspace-дубликата нет);
    // read_file схлопнут в общую workspace-строку.
    expect(section.split('git_status').length - 1).toBe(1);
    expect(section).not.toContain('- read_file');
    expect(section).toContain('file/shell/git-инструменты');
    expect(section).toContain('«git»');
  });
});

describe('messageToLLMMessage', () => {
  function msg(role: MessageRole, extra: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      role,
      seq: 0,
      origin: 'local',
      parts: [],
      content: 'content',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...extra,
    } as Message;
  }

  it.each([
    [MessageRole.USER, 'user'],
    [MessageRole.ASSISTANT, 'assistant'],
    [MessageRole.TOOL, 'tool'],
    [MessageRole.SYSTEM, 'system'],
    [MessageRole.SUMMARY, 'user'],
    [MessageRole.DEBUG, 'user'],
    [MessageRole.INFO, 'user'],
    [MessageRole.ERROR, 'user'],
  ])('role %s → %s', (role, expected) => {
    expect(messageToLLMMessage(msg(role)).role).toBe(expected);
  });

  it('переносит id/content/toolCallId/toolUse и zero-usage', () => {
    const toolCalls = [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }];
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, { id: 'abc', toolCallId: 'tc-9', toolCalls }));

    expect(llm.id).toBe('abc');
    expect(llm.content).toBe('content');
    expect(llm.toolCallId).toBe('tc-9');
    expect(llm.toolUse).toBe(toolCalls);
    expect(llm.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(llm.disabled).toBe(false);
    expect(llm.pinned).toBe(false);
    expect(llm.branchId).toBe('');
  });
});
