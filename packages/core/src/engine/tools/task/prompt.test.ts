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

    expect(resolveSubagentPrompt('explore', undefined, dir)).toBe('RU PROMPT');
  });

  it('language=en читает {type}.en.md', async () => {
    await writeFile(join(subagentsDir, 'explore.en.md'), 'EN PROMPT');
    await writeFile(join(subagentsDir, 'explore.ru.md'), 'RU PROMPT');

    expect(resolveSubagentPrompt('explore', 'en', dir)).toBe('EN PROMPT');
  });

  it('неизвестный язык трактуется как ru', async () => {
    await writeFile(join(subagentsDir, 'explore.ru.md'), 'RU PROMPT');

    expect(resolveSubagentPrompt('explore', 'de', dir)).toBe('RU PROMPT');
  });

  it('фоллбек на базовый {type}.md, если локализованного нет', async () => {
    await writeFile(join(subagentsDir, 'explore.md'), 'BASE PROMPT');

    expect(resolveSubagentPrompt('explore', 'en', dir)).toBe('BASE PROMPT');
  });

  it('фоллбек на ролевой промпт roles/<TYPE>.{lang}.md (общий текст с основной сессией)', async () => {
    const rolesDir = join(dir, 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(join(rolesDir, 'FIXER.ru.md'), 'ROLE RU PROMPT');

    // subagents/fixer.* нет → берётся ролевой промпт (ADR-069/ADR-046 не дублируют текст).
    expect(resolveSubagentPrompt('fixer', 'ru', dir)).toBe('ROLE RU PROMPT');
  });

  it('иерархия целиком: subagents/<type> → roles/<TYPE>', async () => {
    const rolesDir = join(dir, 'roles');
    await mkdir(rolesDir, { recursive: true });
    await writeFile(join(rolesDir, 'TESTER.ru.md'), 'ROLE RU');
    await writeFile(join(rolesDir, 'TESTER.en.md'), 'ROLE EN');
    await writeFile(join(subagentsDir, 'tester.ru.md'), 'SUBAGENT RU');

    // 1) файл в subagents/ важнее ролевого.
    expect(resolveSubagentPrompt('tester', 'ru', dir)).toBe('SUBAGENT RU');

    // 2) без subagents/ — ролевой промпт, локаль соблюдается.
    await rm(join(subagentsDir, 'tester.ru.md'));
    expect(resolveSubagentPrompt('tester', 'ru', dir)).toBe('ROLE RU');
    expect(resolveSubagentPrompt('tester', 'en', dir)).toBe('ROLE EN');
  });

  it('нет файлов промпта → пустая строка (fallback из дефинишена убран)', () => {
    expect(resolveSubagentPrompt('explore', 'ru', dir)).toBe('');
  });

  it('systemPromptsDir не задан → пустая строка', () => {
    expect(resolveSubagentPrompt('explore', 'ru', undefined)).toBe('');
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
      { git: false, rg: true, sh: true, bash: true },
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
      { git: true, rg: false, sh: true, bash: true },
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
      { git: false, rg: true, sh: true, bash: true },
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

  it('Anthropic: блоки reasoning восстанавливаются из частей (resume/наследование)', () => {
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, {
      parts: [
        { id: 'p1', type: 'text', data: 'ответ' },
        { id: 'p2', type: 'reasoning', data: 'блок A', metadata: { signature: 'sig-a' } },
        { id: 'p3', type: 'reasoning', data: 'блок B', metadata: { signature: 'sig-b' } },
        { id: 'p4', type: 'reasoning', data: '', metadata: { redacted: 'opaque-1' } },
      ],
    }));

    expect(llm.reasoningBlocks).toEqual([
      { text: 'блок A', signature: 'sig-a' },
      { text: 'блок B', signature: 'sig-b' },
      { text: '', redactedData: 'opaque-1' },
    ]);
  });

  it('Anthropic: legacy-поля сообщения — fallback, если reasoning-частей нет', () => {
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, {
      reasoning: 'старый блок',
      reasoningSignature: 'sig-old',
      reasoningRedacted: ['opaque-old'],
    }));

    expect(llm.reasoningBlocks).toEqual([
      { text: '', redactedData: 'opaque-old' },
      { text: 'старый блок', signature: 'sig-old' },
    ]);
  });

  it('без размышлений reasoningBlocks не задаётся', () => {
    expect(messageToLLMMessage(msg(MessageRole.ASSISTANT)).reasoningBlocks).toBeUndefined();
  });

  it('Anthropic: размышления своего агента прокидываются', () => {
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, {
      agentRole: 'fixer',
      parts: [{ id: 'p1', type: 'reasoning', data: 'свой блок', metadata: { signature: 'sig-own' } }],
    }), 'fixer');

    expect(llm.reasoningBlocks).toEqual([{ text: 'свой блок', signature: 'sig-own' }]);
  });

  it('Anthropic: размышления чужого агента не прокидываются (inherit/last_n)', () => {
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, {
      agentRole: 'leader',
      parts: [{ id: 'p1', type: 'reasoning', data: 'чужой блок', metadata: { signature: 'sig-foreign' } }],
      reasoning: 'чужой блок',
      reasoningSignature: 'sig-foreign',
    }), 'fixer');

    expect(llm.reasoningBlocks).toBeUndefined();
  });

  it('Anthropic: legacy-роль прежнего набора сравнивается по алиасу', () => {
    const llm = messageToLLMMessage(msg(MessageRole.ASSISTANT, {
      agentRole: 'leader',
      parts: [{ id: 'p1', type: 'reasoning', data: 'блок', metadata: { signature: 'sig-a' } }],
    }), 'pm');

    expect(llm.reasoningBlocks).toEqual([{ text: 'блок', signature: 'sig-a' }]);
  });
});

describe('messageToLLMMessage — thinking только своей пары provider+model (ADR-117)', () => {
  const ownPair = { provider: 'anthropic', model: 'claude-sonnet-4-5' };

  function msg(extra: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [
        { id: 'p1', type: 'text', data: 'ответ' },
        { id: 'p2', type: 'reasoning', data: 'блок A', metadata: { signature: 'sig-a' } },
      ],
      content: 'ответ',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...extra,
    } as Message;
  }

  it('совпадение пары — блоки прокидываются', () => {
    const llm = messageToLLMMessage(msg(ownPair), undefined, ownPair);

    expect(llm.reasoningBlocks).toEqual([{ text: 'блок A', signature: 'sig-a' }]);
  });

  it('смена модели — блоки не прокидываются, контент и toolUse не трогаются', () => {
    const toolCalls = [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }];
    const llm = messageToLLMMessage(
      msg({ ...ownPair, toolCalls }),
      undefined,
      { provider: 'deepseek', model: 'deepseek-flash' },
    );

    expect(llm.reasoningBlocks).toBeUndefined();
    expect(llm.content).toBe('ответ');
    expect(llm.toolUse).toBe(toolCalls);
  });

  it('legacy-сообщение без provider/model — блоки сохраняются', () => {
    const llm = messageToLLMMessage(msg(), undefined, {
      provider: 'deepseek',
      model: 'deepseek-flash',
    });

    expect(llm.reasoningBlocks).toEqual([{ text: 'блок A', signature: 'sig-a' }]);
  });

  it('пара не передана — прежнее поведение (блоки есть)', () => {
    const llm = messageToLLMMessage(msg(ownPair), 'fixer');

    expect(llm.reasoningBlocks).toEqual([{ text: 'блок A', signature: 'sig-a' }]);
  });

  it('чужой агент при совпадающей паре — блоки не прокидываются', () => {
    const llm = messageToLLMMessage(
      msg({ ...ownPair, agentRole: 'leader' }),
      'fixer',
      ownPair,
    );

    expect(llm.reasoningBlocks).toBeUndefined();
  });
});
