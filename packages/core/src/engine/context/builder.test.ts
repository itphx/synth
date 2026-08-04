import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextConfig } from './config.js';
import { ContextBuilder } from './builder.js';

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
    const prompt = await builder.buildSystemPrompt({
      agentRole: '@bankassist',
      agentContextFile: 'BANKASSIST.md',
      language: 'ru',
    });

    expect(prompt).toContain('БАНКОВСКИЙ КОНТЕКСТ: авто-кредит 15%');
  });

  it('системные агенты продолжают получать ролевой промпт без agentContextFile', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await builder.buildSystemPrompt({
      agentRole: 'assistant',
      language: 'ru',
    });

    expect(prompt.length).toBeGreaterThan(50);
  });

  it('системные агенты получают ролевой промпт при передаче их contextFile (как из реестра)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await builder.buildSystemPrompt({
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
    const prompt = await builder.buildSystemPrompt({
      agentRole: 'assistant',
      agentContextFile: 'ASSISTANT.md',
      language: 'ru',
    });

    expect(prompt).toContain('ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА');
  });

  it('пустой agentContextFile не ломает загрузку (fallback на дефолтный файл роли)', async () => {
    const config = new ContextConfig({ userDataDir });
    const builder = new ContextBuilder(config);
    const prompt = await builder.buildSystemPrompt({
      agentRole: 'assistant',
      agentContextFile: '',
      language: 'ru',
    });

    expect(prompt.length).toBeGreaterThan(50);
  });
});
