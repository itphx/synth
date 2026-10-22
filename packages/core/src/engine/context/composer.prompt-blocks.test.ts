/**
 * PROP-090 §«Точка `promptBlocks`»: реестр провайдеров блоков системного
 * промпта и правила точки расширения.
 *
 * Проверяются правила из спецификации точки:
 * 1. блок провайдера попадает в `compose().blocks` и в `manifest()`
 *    (с `provenance`);
 * 2. тир `stable` отклоняется на регистрации (понятная причина, не тихое
 *    понижение до `context`);
 * 3. ошибка провайдера → warning в лог, блок пустой, **ход не падает**;
 * 4. пустой результат → `status: 'empty'`, в промпт не попадает;
 * 5. содержимое длиннее бюджета → обрезка + `status: 'truncated'`;
 * 6. override `session.settings.systemPrompt` → блок провайдера не добавляется;
 * 7. порядок блоков — по (тир, order), tie-break — порядок регистрации;
 * 8. контекст провайдера: sessionId/agentRole/language/mode/projectId и
 *    «вопрос хода» (`query`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptBlockContext, PromptBlockProvider, Session } from '@itphx/synth-shared';

import { ContextConfig } from './config.js';
import { ContextBuilder } from './builder.js';
import { SystemPromptComposer, type ComposerContext, type ComposerSessionLike } from './composer.js';
import { PromptBlockRegistrationError, PromptBlockRegistry } from './prompt-block-registry.js';
import { stubContextFiles } from '../../test-helpers/storage-stubs.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';

function makeSession(over: { systemPrompt?: string; projectId?: string } = {}): Session {
  return {
    id: 's1',
    projectId: over.projectId,
    mode: 'act',
    messages: [],
    settings: {
      language: 'ru',
      agentRole: 'assistant',
      showInterview: false,
      routingEnabled: false,
      ...(over.systemPrompt ? { systemPrompt: over.systemPrompt } : {}),
    },
  } as unknown as Session;
}

function makeContextConfig(): ContextFileRepository {
  return stubContextFiles({
    getGatewayInstructions: () => '[GATEWAY]',
    getPlanGuide: () => '[PLAN GUIDE]',
    getModePolicy: () => '[MODE POLICY]',
    getClassificationInstructions: () => '[CLASSIFICATION]',
    getSchedulerNotice: () => '[SCHEDULER]',
    getSchedulerTurnNotice: () => '[SCHEDULER TURN]',
  });
}

describe('SystemPromptComposer: точка promptBlocks', () => {
  let userDataDir: string;
  let builder: ContextBuilder;
  let registry: PromptBlockRegistry;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-composer-blocks-'));
    await mkdir(join(userDataDir, 'user'), { recursive: true });
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'ROLE-MARKER', 'utf-8');
    builder = new ContextBuilder(new ContextConfig({ userDataDir }));
    registry = new PromptBlockRegistry();
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  function makeComposer(): SystemPromptComposer {
    return new SystemPromptComposer({
      contextBuilder: builder,
      contextConfig: makeContextConfig(),
      projectStore: null,
      promptBlocks: registry,
    });
  }

  function makeCtx(
    session: ComposerSessionLike,
    extra: Partial<ComposerContext> = {},
  ): ComposerContext {
    return {
      session,
      workingDir: '/ws',
      language: 'ru',
      routingEnabled: false,
      gatewayEnabled: true,
      ...extra,
    };
  }

  it('блок провайдера попадает в compose().blocks и в manifest() с provenance', async () => {
    registry.register(
      {
        key: 'plugin.demo.memory',
        tier: 'context',
        order: 100,
        load: () => 'ПАМЯТЬ',
      },
      { provenance: 'plugin:demo' },
    );
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession()));
    const block = composed.blocks.find((b) => b.key === 'plugin.demo.memory');
    expect(block).toBeDefined();
    expect(block!.content).toBe('ПАМЯТЬ');
    expect(block!.tier).toBe('context');
    expect(block!.order).toBe(100);
    expect(block!.provenance).toBe('plugin:demo');
    expect(composed.system).toContain('ПАМЯТЬ');

    const manifest = await composer.manifest(makeCtx(makeSession()));
    const entry = manifest.entries.find((e) => e.key === 'plugin.demo.memory');
    expect(entry).toBeDefined();
    expect(entry!.provenance).toBe('plugin:demo');
    expect(entry!.source).toBe('system');
    expect(entry!.tier).toBe('context');
    // В манифесте не торчит сырой ключ.
    expect(entry!.label).not.toBe('plugin.demo.memory');
  });

  it('тир stable отклоняется на регистрации (понятная причина)', () => {
    const provider = {
      key: 'plugin.demo.stable',
      tier: 'stable',
      order: 10,
      load: () => 'текст',
    } as unknown as PromptBlockProvider;

    expect(() => registry.register(provider)).toThrow(PromptBlockRegistrationError);
    expect(() => registry.register(provider)).toThrow(/stable/);
    expect(registry.size).toBe(0);
  });

  it('дубликат ключа и пустой ключ отклоняются', () => {
    registry.register({ key: 'plugin.demo.a', tier: 'context', order: 1, load: () => 'x' });
    expect(() =>
      registry.register({ key: 'plugin.demo.a', tier: 'context', order: 1, load: () => 'y' }),
    ).toThrow(PromptBlockRegistrationError);
    expect(() =>
      registry.register({ key: '', tier: 'context', order: 1, load: () => 'y' }),
    ).toThrow(PromptBlockRegistrationError);
  });

  it('ошибка провайдера → warning в лог, блок пустой, ход не падает', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      registry.register({
        key: 'plugin.demo.broken',
        tier: 'context',
        order: 100,
        load: () => {
          throw new Error('сбой retrieval');
        },
      });
      const composer = makeComposer();

      const composed = await composer.compose(makeCtx(makeSession()));

      const block = composed.blocks.find((b) => b.key === 'plugin.demo.broken');
      expect(block).toBeDefined();
      expect(block!.content).toBe('');
      expect(block!.status).toBe('empty');
      expect(composed.system).not.toContain('сбой retrieval');
      // В лог ушло предупреждение, а не ошибка.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain('plugin.demo.broken');
    } finally {
      warn.mockRestore();
    }
  });

  it('пустой результат → status empty, в промпт не попадает', async () => {
    registry.register({ key: 'plugin.demo.empty', tier: 'volatile', order: 100, load: () => null });
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession()));

    const block = composed.blocks.find((b) => b.key === 'plugin.demo.empty');
    expect(block).toBeDefined();
    expect(block!.content).toBe('');
    expect(block!.status).toBe('empty');
    expect(composed.system).not.toContain('plugin.demo.empty');
  });

  it('бюджет символов: длинный блок обрезается, status truncated', async () => {
    const long = 'A'.repeat(500);
    registry.register({ key: 'plugin.demo.long', tier: 'context', order: 100, load: () => long });
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession(), { promptBlockMaxChars: 100 }));

    const block = composed.blocks.find((b) => b.key === 'plugin.demo.long');
    expect(block).toBeDefined();
    expect(block!.status).toBe('truncated');
    expect(block!.content.length).toBeLessThanOrEqual(100);
    expect(block!.content).toContain('TRUNCATED');
    // Полное содержимое провайдера в промпт не попало.
    expect(composed.system).not.toContain(long);
  });

  it('бюджет по умолчанию — 4000 символов', async () => {
    registry.register({
      key: 'plugin.demo.default',
      tier: 'context',
      order: 100,
      load: () => 'B'.repeat(5000),
    });
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession()));

    const block = composed.blocks.find((b) => b.key === 'plugin.demo.default');
    expect(block!.status).toBe('truncated');
    expect(block!.content.length).toBeLessThanOrEqual(4000);
  });

  it('override session.settings.systemPrompt → блок провайдера не добавляется', async () => {
    registry.register({
      key: 'plugin.demo.memory',
      tier: 'context',
      order: 100,
      load: () => 'ПАМЯТЬ',
    });
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession({ systemPrompt: 'OVERRIDE' })));

    expect(composed.system).toContain('OVERRIDE');
    expect(composed.system).not.toContain('ПАМЯТЬ');
    expect(composed.blocks.find((b) => b.key === 'plugin.demo.memory')).toBeUndefined();
  });

  it('порядок: тир → order, tie-break — порядок регистрации', async () => {
    registry.register({ key: 'plugin.demo.v1', tier: 'volatile', order: 100, load: () => 'V1' });
    registry.register({ key: 'plugin.demo.c1', tier: 'context', order: 100, load: () => 'C1' });
    registry.register({ key: 'plugin.demo.v2', tier: 'volatile', order: 100, load: () => 'V2' });
    registry.register({ key: 'plugin.demo.c2', tier: 'context', order: 50, load: () => 'C2' });
    const composer = makeComposer();

    const { system } = await composer.compose(makeCtx(makeSession()));

    const order = ['C2', 'C1', 'V1', 'V2'].map((marker) => system.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('контекст провайдера: сессия, роль, язык, режим, проект и вопрос хода', async () => {
    let seen: unknown;
    registry.register({
      key: 'plugin.demo.ctx',
      tier: 'volatile',
      order: 100,
      load: (ctx) => {
        seen = ctx;
        return 'ok';
      },
    });
    const composer = makeComposer();
    const session = { ...makeSession({ projectId: 'p1' }), mode: 'plan' as const };

    await composer.compose(makeCtx(session, { query: 'вопрос хода', turnId: 'stream-1' }));

    expect(seen).toMatchObject({
      sessionId: 's1',
      agentRole: 'assistant',
      language: 'ru',
      projectId: 'p1',
      mode: 'plan',
      query: 'вопрос хода',
      turnId: 'stream-1',
    });
  });

  it('без «вопроса хода» (шаг пайплайна) — query не заполняется, ход не падает', async () => {
    let seen: PromptBlockContext | undefined;
    registry.register({
      key: 'plugin.demo.noquery',
      tier: 'volatile',
      order: 100,
      load: (ctx) => {
        seen = ctx;
        // Провайдер сам решает: без `query` retrieval «по текущему вопросу»
        // невозможен — блок пуст (хост заглушку не подставляет и не требует `query`).
        return ctx.query ? 'ЕСТЬ ЗАПРОС' : null;
      },
    });
    const composer = makeComposer();

    const composed = await composer.compose(makeCtx(makeSession()));

    expect(seen).toBeDefined();
    expect(seen!.query).toBeUndefined();
    expect(seen!.turnId).toBeUndefined();
    const block = composed.blocks.find((b) => b.key === 'plugin.demo.noquery');
    expect(block).toBeDefined();
    expect(block!.content).toBe('');
    expect(block!.status).toBe('empty');
  });

  it('disposer снимает провайдера — блок исчезает из следующей сборки', async () => {
    const dispose = registry.register({
      key: 'plugin.demo.temp',
      tier: 'context',
      order: 100,
      load: () => 'ВРЕМЕННО',
    });
    const composer = makeComposer();

    const first = await composer.compose(makeCtx(makeSession()));
    expect(first.system).toContain('ВРЕМЕННО');

    dispose();

    const second = await composer.compose(makeCtx(makeSession()));
    expect(second.system).not.toContain('ВРЕМЕННО');
    expect(second.blocks.find((b) => b.key === 'plugin.demo.temp')).toBeUndefined();
  });
});
