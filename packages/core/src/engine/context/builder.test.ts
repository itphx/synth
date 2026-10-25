import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, StickyNote } from '@itphx/synth-shared';
import { ContextConfig } from './config.js';
import { ContextBuilder } from './builder.js';
import { joinPromptBlocks, sortPromptBlocks, type PromptBlock } from './prompt-blocks.js';
import { stubProfiles } from '../../test-helpers/storage-stubs.js';

/** ADR-070: обёртка удалена из класса — тесты собирают промпт через buildBaseBlocks. */
async function buildSystemPrompt(
  builder: ContextBuilder,
  params: Parameters<ContextBuilder['buildBaseBlocks']>[0],
): Promise<string> {
  return joinPromptBlocks(sortPromptBlocks(await builder.buildBaseBlocks(params)));
}

describe('ContextBuilder.buildSystemPrompt', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-ctx-'));
    await mkdir(join(userDataDir, 'user'), { recursive: true });
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('включает содержимое agentContextFile из user/ в системный промпт (custom-агент)', async () => {
    await writeFile(join(userDataDir, 'user', 'BANKASSIST.md'), 'БАНКОВСКИЙ КОНТЕКСТ: авто-кредит 15%', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await buildSystemPrompt(builder, {
      agentRole: '@bankassist',
      agentContextFile: 'BANKASSIST.md',
      language: 'ru',
    });

    expect(prompt).toContain('БАНКОВСКИЙ КОНТЕКСТ: авто-кредит 15%');
  });

  it('системные агенты продолжают получать ролевой промпт без agentContextFile', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      language: 'ru',
    });

    expect(prompt.length).toBeGreaterThan(50);
  });

  it('системные агенты получают ролевой промпт при передаче их contextFile (как из реестра)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      agentContextFile: 'ASSISTANT.md',
      language: 'ru',
    });

    expect(prompt.length).toBeGreaterThan(50);
  });

  it('user/ override файла роли приоритетнее системного prompts/roles/', async () => {
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      agentContextFile: 'ASSISTANT.md',
      language: 'ru',
    });

    expect(prompt).toContain('ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА');
  });

  it('пустой agentContextFile не ломает загрузку (fallback на дефолтный файл роли)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      agentContextFile: '',
      language: 'ru',
    });

    expect(prompt.length).toBeGreaterThan(50);
  });

  it('buildSystemPrompt: сохраняет содержимое блоков (role, additional, project)', async () => {
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'РОЛЬ-МАРКЕР', 'utf-8');
    await writeFile(join(userDataDir, 'user', 'SOUL.md'), 'SOUL-МАРКЕР', 'utf-8');

    const projectDataDir = join(userDataDir, 'projects');
    await mkdir(join(projectDataDir, 'demo'), { recursive: true });
    await writeFile(join(projectDataDir, 'demo', 'info.md'), 'PROJECT-МАРКЕР', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config, { projectDataDir });
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      agentContextFile: 'ASSISTANT.md',
      projectName: 'demo',
      language: 'ru',
    });

    expect(prompt).toContain('РОЛЬ-МАРКЕР');
    expect(prompt).toContain('[ADDITIONAL CONTEXT]');
    expect(prompt).toContain('SOUL-МАРКЕР');
    expect(prompt).toContain('[PROJECT: demo]');
    expect(prompt).toContain('PROJECT-МАРКЕР');
  });

  it('buildSystemPrompt: порядок тиров role → additional → project', async () => {
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'РОЛЬ-МАРКЕР', 'utf-8');
    await writeFile(join(userDataDir, 'user', 'SOUL.md'), 'SOUL-МАРКЕР', 'utf-8');

    const projectDataDir = join(userDataDir, 'projects');
    await mkdir(join(projectDataDir, 'demo'), { recursive: true });
    await writeFile(join(projectDataDir, 'demo', 'info.md'), 'PROJECT-МАРКЕР', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config, { projectDataDir });
    const prompt = await buildSystemPrompt(builder, {
      agentRole: 'assistant',
      agentContextFile: 'ASSISTANT.md',
      projectName: 'demo',
      language: 'ru',
    });

    const iRole = prompt.indexOf('РОЛЬ-МАРКЕР');
    const iAdditional = prompt.indexOf('[ADDITIONAL CONTEXT]');
    const iProject = prompt.indexOf('[PROJECT: demo]');

    expect(iRole).toBeGreaterThanOrEqual(0);
    expect(iAdditional).toBeGreaterThan(iRole);
    expect(iProject).toBeGreaterThan(iAdditional);
  });

  it('buildBaseBlocks: порядок и содержимое блоков согласованы', async () => {
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'РОЛЬ-МАРКЕР', 'utf-8');
    await writeFile(join(userDataDir, 'user', 'SOUL.md'), 'SOUL-МАРКЕР', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const params = { agentRole: 'assistant', agentContextFile: 'ASSISTANT.md', language: 'ru' };

    const blocks = await builder.buildBaseBlocks(params);
    const prompt = joinPromptBlocks(sortPromptBlocks(blocks));

    expect(prompt).toContain('РОЛЬ-МАРКЕР');
    expect(prompt).toContain('SOUL-МАРКЕР');
  });
});

describe('ContextBuilder.buildBaseBlocks', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-ctx-'));
    await mkdir(join(userDataDir, 'user'), { recursive: true });
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('memory.guide: только при memoryAvailable, из prompts/system/MEMORY.{lang}.md', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);

    const withMemory = await builder.buildBaseBlocks({
      agentRole: 'assistant', language: 'ru', memoryAvailable: true,
    });
    const memoryBlock = withMemory.find((block) => block.key === 'memory.guide');
    expect(memoryBlock?.tier).toBe('context');
    expect(memoryBlock?.content).toContain('[ПАМЯТЬ]');
    expect(memoryBlock?.provenance).toBe('prompts/system/MEMORY');

    const withoutMemory = await builder.buildBaseBlocks({
      agentRole: 'assistant', language: 'ru', memoryAvailable: false,
    });
    expect(withoutMemory.find((block) => block.key === 'memory.guide')).toBeUndefined();

    const english = await builder.buildBaseBlocks({
      agentRole: 'assistant', language: 'en', memoryAvailable: true,
    });
    expect(english.find((block) => block.key === 'memory.guide')?.content).toContain('[MEMORY]');
  });

  it('возвращает блоки с ожидаемыми key/tier/order', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const blocks = await builder.buildBaseBlocks({ agentRole: 'assistant', language: 'ru' });

    expect(blocks.map((b) => b.key)).toEqual([
      'role',
      'additional',
      'profile',
      'project.info',
      'sticky',
      'participants',
      'summary',
      'interview',
    ]);

    const byKey = new Map(blocks.map((b) => [b.key, b]));
    expect(byKey.get('role')).toMatchObject({ tier: 'stable', order: 10 });
    expect(byKey.get('additional')).toMatchObject({ tier: 'stable', order: 20 });
    expect(byKey.get('profile')).toMatchObject({ tier: 'context', order: 10 });
    expect(byKey.get('project.info')).toMatchObject({ tier: 'context', order: 20 });
    expect(byKey.get('sticky')).toMatchObject({ tier: 'volatile', order: 10 });
    expect(byKey.get('participants')).toMatchObject({ tier: 'volatile', order: 20 });
    expect(byKey.get('summary')).toMatchObject({ tier: 'volatile', order: 30 });
    expect(byKey.get('interview')).toMatchObject({ tier: 'volatile', order: 90 });

    // role заполнен, необязательные блоки пусты ('' — не отправляются)
    expect(byKey.get('role')!.content.length).toBeGreaterThan(0);
    expect(byKey.get('additional')!.content).toBe('');
    expect(byKey.get('profile')!.content).toBe('');
    expect(byKey.get('project.info')!.content).toBe('');
  });

  it('profile: фолбэк на getProfileByUsername, если loadProfile(userId) вернул null', async () => {
    const config = new ContextConfig({ userDataDir });
    const profile = {
      id: 'uuid-1',
      username: 'admin',
      email: 'admin@example.com',
      roles: ['ADMIN'],
      teamRoles: [],
      isActive: true,
      preferences: {},
      notes: 'Зови меня Босс',
      interviewCompleted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const profilesStore = stubProfiles({
      loadProfile: async (id: string) => (id === 'uuid-1' ? profile : null),
      getProfileByUsername: async (username: string) => (username === 'admin' ? profile : null),
    });
    const builder = new ContextBuilder(config, { profilesStore });

    // userId = username ('admin') → loadProfile(null) → фолбэк по username.
    // Интервью показывается только при `interviewEligible` (первый ход сессии).
    const blocks = await builder.buildBaseBlocks({ language: 'ru', userId: 'admin', interviewEligible: true });
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    expect(byKey.get('profile')!.content).toContain('Зови меня Босс');
    expect(byKey.get('profile')!.content).toContain('admin');
    // Профиль, резолвнутый по username, при eligibility заполняет интервью.
    expect(byKey.get('interview')!.content.length).toBeGreaterThan(0);

    // Ни id, ни username не найдены → блоки пусты (поведение как раньше).
    const missing = await builder.buildBaseBlocks({ language: 'ru', userId: 'ghost', interviewEligible: true });
    const missingByKey = new Map(missing.map((b) => [b.key, b]));
    expect(missingByKey.get('profile')!.content).toBe('');
    expect(missingByKey.get('interview')!.content).toBe('');
  });

  it('interview: гейтится interviewEligible и interviewCompleted', async () => {
    const config = new ContextConfig({ userDataDir });
    const baseProfile = {
      id: 'uuid-2',
      username: 'admin',
      roles: ['ADMIN'],
      teamRoles: [],
      isActive: true,
      preferences: {},
      notes: '',
      interviewCompleted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const interviewContentFor = async (profileOverrides: Record<string, unknown>, eligible: boolean) => {
      const profile = { ...baseProfile, ...profileOverrides };
      const profilesStore = stubProfiles({
        loadProfile: async (id: string) => (id === 'uuid-2' ? profile : null),
        getProfileByUsername: async () => null,
      });
      const builder = new ContextBuilder(config, { profilesStore });
      const blocks = await builder.buildBaseBlocks({
        language: 'ru',
        userId: 'uuid-2',
        showInterview: true,
        interviewEligible: eligible,
      });
      return blocks.find((b) => b.key === 'interview')!.content;
    };

    // eligible + не пройдено → блок есть.
    expect((await interviewContentFor({ interviewCompleted: false }, true)).length).toBeGreaterThan(0);
    // eligible:false → блока нет.
    expect(await interviewContentFor({ interviewCompleted: false }, false)).toBe('');
    // пройдено → блока нет.
    expect(await interviewContentFor({ interviewCompleted: true }, true)).toBe('');
  });

  it('заполняет sticky/participants/summary при наличии данных (agentRole задан)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);

    const history = [
      { role: 'assistant', agentRole: 'a', disabled: false },
      { role: 'assistant', agentRole: 'b', disabled: false },
    ] as unknown as Message[];
    const notes: StickyNote[] = [
      { id: 'n1', content: 'ЗАМЕТКА', createdAt: '2026-01-01', updatedAt: '2026-01-01', disabled: false },
    ];

    const blocks = await builder.buildBaseBlocks({
      agentRole: 'assistant',
      language: 'ru',
      historyMessages: history,
      stickyNotes: notes,
      summaryContent: 'СЖАТЫЙ-ДИАЛОГ',
    });
    const byKey = new Map(blocks.map((b) => [b.key, b]));

    expect(byKey.get('sticky')!.content).toContain('ЗАМЕТКА');
    expect(byKey.get('participants')!.content.length).toBeGreaterThan(0);
    expect(byKey.get('summary')!.content).toContain('СЖАТЫЙ-ДИАЛОГ');
  });

  it('без agentRole sticky/participants пусты (сохранено текущее условие)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);

    const history = [
      { role: 'assistant', agentRole: 'a', disabled: false },
      { role: 'assistant', agentRole: 'b', disabled: false },
    ] as unknown as Message[];
    const notes: StickyNote[] = [
      { id: 'n1', content: 'ЗАМЕТКА', createdAt: '2026-01-01', updatedAt: '2026-01-01', disabled: false },
    ];

    const blocks = await builder.buildBaseBlocks({
      language: 'ru',
      historyMessages: history,
      stickyNotes: notes,
    });
    const byKey = new Map(blocks.map((b) => [b.key, b]));

    expect(byKey.get('sticky')!.content).toBe('');
    expect(byKey.get('participants')!.content).toBe('');
    expect(byKey.get('role')!.content.length).toBeGreaterThan(0);
  });
});

describe('prompt-blocks', () => {
  it('sortPromptBlocks: stable → context → volatile, затем order', () => {
    const blocks: PromptBlock[] = [
      { key: 'summary', tier: 'volatile', order: 30, content: 's' },
      { key: 'profile', tier: 'context', order: 10, content: 'p' },
      { key: 'sticky', tier: 'volatile', order: 10, content: 'k' },
      { key: 'additional', tier: 'stable', order: 20, content: 'a' },
      { key: 'role', tier: 'stable', order: 10, content: 'r' },
      { key: 'project.info', tier: 'context', order: 20, content: 'j' },
      { key: 'interview', tier: 'volatile', order: 90, content: 'i' },
    ];

    const sorted = sortPromptBlocks(blocks);

    expect(sorted.map((b) => b.key)).toEqual([
      'role',
      'additional',
      'profile',
      'project.info',
      'sticky',
      'summary',
      'interview',
    ]);
    // исходный массив не мутируется
    expect(blocks[0]!.key).toBe('summary');
  });

  it('joinPromptBlocks: пропускает пустые блоки и использует разделитель', () => {
    const blocks: PromptBlock[] = [
      { key: 'a', tier: 'stable', order: 10, content: 'A' },
      { key: 'b', tier: 'context', order: 10, content: '' },
      { key: 'c', tier: 'volatile', order: 10, content: 'C' },
    ];

    expect(joinPromptBlocks(blocks)).toBe('A\n\nC');
    expect(joinPromptBlocks(blocks, '\n')).toBe('A\nC');
    expect(joinPromptBlocks([])).toBe('');
  });
});
