/**
 * PROP-108 Ф1: тесты shadow-интеграции Authority-слоя.
 *
 * Проверяются:
 * - **паритет**: shadow-решение совпадает с решением permission-слоя на
 *   существующих тулах (`read_file`/`write_file`/`execute_shell`);
 * - **инвариант**: shadow **не меняет** решение прав (решение permission-слоя
 *   с шовом и без него — одинаково; ошибка shadow не ломает ход);
 * - **fail-closed**: новый тул без отображения на действие → `deny('unknown')`;
 * - **метрика**: `synth_authority_decisions_total` инкрементится с
 *   нормализованными лейблами (`action`/`effect`/`source`, без id).
 */
import { describe, expect, it } from 'vitest';

import type { PermissionConfig } from '@itphx/synth-shared';

import { MetricsRegistry } from '../../metrics/registry.js';
import { createAuthorityMetrics } from '../../metrics/collectors/authority.js';
import { MemoryAuthorityDecisionJournal } from '../../storage/memory/authority-decision-journal.js';
import { PermissionEvaluator } from '../permission/evaluator.js';
import { AuthorityShadowRecorder } from './shadow.js';

const CWD = '/workspace/project';

const ALLOW_ALL: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };

/** Сборка shadow-рекордера с журналом и (опционально) счётчиком метрик. */
function makeRecorder(registry?: MetricsRegistry) {
  const journal = new MemoryAuthorityDecisionJournal();
  const recorder = new AuthorityShadowRecorder({
    enabled: true,
    shadow: true,
    journal,
    policy: null,
    ...(registry ? { onDecision: createAuthorityMetrics(registry).onDecision } : {}),
  });
  return { journal, recorder };
}

describe('Authority-shadow — паритет с permission-слоем', () => {
  it('read_file: действие read, цель path, эффект совпадает с решением', async () => {
    const { journal, recorder } = makeRecorder();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(decision.action).toBe('allow');
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('read');
    expect(entries[0]!.effect).toBe('allow');
    expect(entries[0]!.target).toBe('path:src/a.ts');
    expect(entries[0]!.mode).toBe('shadow');
    expect(entries[0]!.permissionEffect).toBe('allow');
    expect(entries[0]!.source).toBe('user');
  });

  it('write_file с запретом: действие write, эффект deny, совпадает с решением', async () => {
    const { journal, recorder } = makeRecorder();
    const config: PermissionConfig = {
      rules: { '*': 'allow', write_file: 'deny' },
      askTimeoutMs: 30_000,
    };
    const evaluator = new PermissionEvaluator(config, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(decision.action).toBe('deny');
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('write');
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.permissionEffect).toBe('deny');
  });

  it('execute_shell: действие execute, цель workspace', async () => {
    const { journal, recorder } = makeRecorder();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    evaluator.check({
      toolName: 'execute_shell',
      params: { command: 'ls -la' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('execute');
    expect(entries[0]!.target).toBe('workspace:.');
  });

  it('правило ask → shadow-эффект ask', async () => {
    const { journal, recorder } = makeRecorder();
    const config: PermissionConfig = {
      rules: { '*': 'allow', write_file: 'ask' },
      askTimeoutMs: 30_000,
    };
    const evaluator = new PermissionEvaluator(config, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(decision.action).toBe('ask');
    const entries = await journal.list();
    expect(entries[0]!.effect).toBe('ask');
    expect(entries[0]!.permissionEffect).toBe('ask');
  });

  it('read_file с файловым паттерном: deny по «*.env» совпадает с решением', async () => {
    const { journal, recorder } = makeRecorder();
    const config: PermissionConfig = {
      rules: { read: { '*.env': 'deny' } },
      askTimeoutMs: 30_000,
    };
    const evaluator = new PermissionEvaluator(config, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'read_file',
      params: { file_path: '.env' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(decision.action).toBe('deny');
    const entries = await journal.list();
    expect(entries[0]!.action).toBe('read');
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.target).toBe('path:.env');
    expect(entries[0]!.permissionEffect).toBe('deny');
  });
});

/**
 * Задокументированные расхождения Ф1.
 *
 * Критерий Ф1 PROP-108: «shadow-решения совпадают с текущими, **кроме
 * перечисленных расхождений**». Ниже — перечень известных расхождений
 * (миграции), а не дефекты резолвера: править под них политику нельзя
 * (PROP-108 §«Совместимость и миграция»).
 */
describe('Authority-shadow — задокументированные расхождения Ф1', () => {
  it('РАСХОЖДЕНИЕ: правило группы shell по команде не компилируется в гранты', async () => {
    const { journal, recorder } = makeRecorder();
    const config: PermissionConfig = {
      rules: { '*': 'allow', shell: { 'rm -rf *': 'deny' } },
      askTimeoutMs: 30_000,
    };
    const evaluator = new PermissionEvaluator(config, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'execute_shell',
      params: { command: 'rm -rf /tmp/important' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    // Permission-слой: правило группы `shell` объектом матчится по КОМАНДЕ.
    expect(decision.action).toBe('deny');

    // Shadow: грант — это «действие × цель», а цель `execute_shell` — это
    // `workspace:.`, а не текст команды; командные паттерны в Ф1 не
    // переносятся в гранты, поэтому shadow считает `allow`. Это известное
    // расхождение миграции, а не ошибка резолвера.
    const entries = await journal.list();
    expect(entries[0]!.action).toBe('execute');
    expect(entries[0]!.effect).toBe('allow');
    expect(entries[0]!.permissionEffect).toBe('deny');
  });

  it('РАСХОЖДЕНИЕ: путь вне workspace → shadow deny(unknown), permission ask', async () => {
    // Цель вне workspace относительным путём не выразить → shadow считает
    // цель неизвестной и даёт fail-closed `deny('unknown')`; permission-слой
    // по умолчанию спрашивает (`external_directory`). Расхождение зафиксировано
    // (shadow строже — направление Ф2).
    const { journal, recorder } = makeRecorder();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'read_file',
      params: { file_path: '/etc/passwd' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(decision.action).toBe('ask');
    const entries = await journal.list();
    expect(entries[0]!.action).toBe('read');
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.reason).toBe('unknown');
    expect(entries[0]!.permissionEffect).toBe('ask');
  });
});

describe('Authority-shadow — инварианты', () => {
  it('shadow НЕ меняет решение прав', async () => {
    const { recorder } = makeRecorder();
    const input = {
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act' as const,
    };

    const plain = new PermissionEvaluator(ALLOW_ALL).check(input);
    const withShadow = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record }).check(
      input,
    );
    await recorder.flush();

    expect(withShadow).toEqual(plain);
  });

  it('ошибка shadow не ломает ход (решение возвращается как есть)', () => {
    const evaluator = new PermissionEvaluator(ALLOW_ALL, {
      authorityShadow: () => {
        throw new Error('shadow-сбой');
      },
    });

    const decision = evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
    });

    expect(decision.action).toBe('allow');
  });

  it('новый тул без отображения на действие → deny(unknown) (fail-closed)', async () => {
    const { journal, recorder } = makeRecorder();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    const decision = evaluator.check({
      toolName: 'brand_new_tool',
      params: {},
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    // Решение permission-слоя не меняется (в Ф1 слой только наблюдает).
    expect(decision.action).toBe('allow');
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('unknown');
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.reason).toBe('unknown');
  });

  it('выключенный слой не пишет решений', async () => {
    const journal = new MemoryAuthorityDecisionJournal();
    const recorder = new AuthorityShadowRecorder({
      enabled: false,
      shadow: true,
      journal,
      policy: null,
    });
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    expect(await journal.list()).toHaveLength(0);
  });
});

describe('Authority-shadow — метрики', () => {
  it('synth_authority_decisions_total инкрементится с нормализованными лейблами', async () => {
    const registry = new MetricsRegistry();
    const { recorder } = makeRecorder(registry);
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    expect(snapshot).toBeDefined();
    expect(snapshot!.labelNames).toEqual(['action', 'effect', 'source']);
    expect(snapshot!.series).toHaveLength(1);
    expect(snapshot!.series[0]!.labels).toEqual({
      action: 'read',
      effect: 'allow',
      source: 'user',
    });
    expect(snapshot!.series[0]!.value).toBe(1);
  });

  it('неизвестное действие нормализуется к other', async () => {
    const registry = new MetricsRegistry();
    const { recorder } = makeRecorder(registry);
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    evaluator.check({
      toolName: 'brand_new_tool',
      params: {},
      workingDir: CWD,
      sessionMode: 'act',
    });
    await recorder.flush();

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    // Действие не отображено ни в один глагол ядра → `other` (кардинальность
    // ограничена конечным набором).
    expect(snapshot!.series[0]!.labels).toEqual({
      action: 'other',
      effect: 'deny',
      source: 'instance',
    });
  });

  it('в лейблах нет идентификаторов (user_id/session_id/путей)', async () => {
    const registry = new MetricsRegistry();
    const { recorder } = makeRecorder(registry);
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityShadow: recorder.record });

    evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/secret-file.ts' },
      workingDir: CWD,
      sessionMode: 'act',
      authorityContext: {
        sessionId: 'sess-42',
        principal: { kind: 'user', id: 'user:alice', roles: [] },
        turnId: 'turn-7',
      },
    });
    await recorder.flush();

    const rendered = registry.render().text;
    expect(rendered).toContain('synth_authority_decisions_total');
    expect(rendered).not.toContain('sess-42');
    expect(rendered).not.toContain('user:alice');
    expect(rendered).not.toContain('turn-7');
    expect(rendered).not.toContain('secret-file.ts');
  });
});
