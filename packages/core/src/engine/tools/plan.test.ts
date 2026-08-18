import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEnterTool, planExitTool, slugifyPlan } from './plan.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/shared';
import { generateId } from '@itphx/shared';

describe('slugifyPlan', () => {
  it('транслитерирует кириллицу в безопасные символы', () => {
    expect(slugifyPlan('Исправить баг в auth модуле')).toBe('ispravit-bag-v-auth-module');
  });

  it('использует первую строку как заголовок', () => {
    expect(slugifyPlan('# План: Добавить тесты\nШаги...')).toBe('plan-dobavit-testy');
  });

  it('обрезает до 50 символов', () => {
    const long = 'очень длинный заголовок который должен быть обрезан до безопасной длины символов'.repeat(3);
    expect(slugifyPlan(long).length).toBeLessThanOrEqual(50);
  });

  it('только небезопасные символы — fallback на "plan"', () => {
    expect(slugifyPlan('!!!')).toBe('plan');
  });

  it('удаляет дублирующиеся/краевые дефисы', () => {
    expect(slugifyPlan('--a  b--')).toBe('a-b');
  });
});

describe('plan_enter / plan_exit', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-tool-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'Plan test' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, eventBus, sessionId },
    };
  }

  it('plan_enter переводит сессию в mode=plan', async () => {
    const result = await planEnterTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.mode).toBe('plan');
  });

  it('plan_exit пишет файл .synth/plans/{ts}-{slug}.md и переводит в act', async () => {
    const planText = '# Исправить баг в auth\n\n1. Найти причину\n2. Починить\n3. Проверить тестами';
    const result = await planExitTool.execute({ plan: planText }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.plan_content).toBe(planText);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.mode).toBe('act');
    expect(session.planContent).toBe(planText);
    expect(session.planPath).toBeTruthy();

    const relPath = (result.metadata?.plan_file as string) ?? '';
    expect(relPath).toMatch(/^\.synth\/plans\/\d{4}-\d{2}-\d{2}-\d{6}-ispravit-bag-v-auth\.md$/);
    // план жёстко пишется в каталог сессии (ctx.workingDir), путь агент не указывает
    expect(session.planPath).toBe(join(tmpDir, relPath));
    const onDisk = await readFile(join(tmpDir, relPath), 'utf-8');
    expect(onDisk).toContain(planText);
  });

  it('plan_enter/plan_exit не принимают path/cwd-параметры от агента', () => {
    const enterShape = (planEnterTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(enterShape)).toEqual([]);

    const exitShape = (planExitTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(exitShape)).toEqual(['plan']);
  });

  it('plan_exit с пустым планом — ошибка', async () => {
    const result = await planExitTool.execute({ plan: '   ' }, makeCtx());
    expect(result.isError).toBe(true);
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.mode).toBeUndefined();
  });

  it('plan_exit без sessionManager — план всё равно пишется на диск', async () => {
    const ctx = makeCtx();
    delete ctx.extra;
    const result = await planExitTool.execute({ plan: 'план без сессии' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.plan_path).toBeTruthy();
  });

  it('plan_exit публикует событие plan.approved', async () => {
    let approved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'plan.approved') approved = e.data as Record<string, unknown>;
    });
    await planExitTool.execute({ plan: 'утверждаемый план' }, makeCtx());
    expect(approved).toBeTruthy();
    expect(approved?.session_id).toBe(sessionId);
  });
});
