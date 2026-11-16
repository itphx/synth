/**
 * ADR-126 §5: тесты встроенных тулов реестра скриптов проекта
 * (`engine/tools/scripts.ts`).
 *
 * Проверяются тулы, а не сервис: `ScriptService` — фейковый (структурный
 * объект), права решает permission-слой, discovery/запуск — за сервисом.
 *
 * Что проверяется:
 * - `script_list` — список скриптов, скрытие deny-скриптов (фильтр в туле
 *   через тот же резолвер, что у permission-слоя), отсутствие сервиса;
 * - `script_run` — вызов сервиса с `origin: 'agent'` и контекстом сессии,
 *   ответ `script_started` (run_id/process_id/log_path), понятный отказ по
 *   коду доменной ошибки;
 * - permission-слой: `script_list` разрешён в plan-режиме, `script_run` —
 *   заблокирован; группа `script` отключаема админом.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CommandAuditEntry, ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import { scriptListTool, scriptRunTool } from './scripts.js';
import type { ScriptService } from '../scripts/service.js';
import { ScriptError } from '../scripts/types.js';
import type { CommandAuditLog } from '../security/command-audit.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';

/** Сводка скрипта в форме, которую отдаёт `ScriptService.list`. */
function summary(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `Скрипт ${name}`,
    origin: 'project',
    available: true,
    trusted: true,
    ...overrides,
  };
}

/** Фейковый сервис скриптов (структурный объект — каст). */
function makeService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    list: vi.fn(async () => ({
      scripts: [summary('dev'), summary('deploy')],
      diagnostics: [],
    })),
    get: vi.fn(async (name: string) =>
      name === 'dev'
        ? {
            name: 'dev',
            description: 'Поднять локальное окружение',
            origin: 'project',
            available: true,
            trusted: true,
            run: './scripts/dev.sh',
            shell: false,
            args: true,
            file: '.synth/scripts/dev.md',
            body: 'Локальная отладка.',
          }
        : null
    ),
    run: vi.fn(async () => ({
      run_id: 'bgr_run1',
      process_id: 'proc_1',
      log_path: 'processes/bgr_run1.log',
      status: 'running' as const,
    })),
    ...overrides,
  } as unknown as ScriptService;
}

function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
  return {
    sessionId: 'sess-1',
    messageId: generateId(),
    projectId: 'proj-1',
    abortSignal: new AbortController().signal,
    workingDir: '/work/project',
    allowedRoots: ['/work/project-root'],
    extra,
  };
}

/** Заглушка журнала исполнений (ADR-136): пишет записи в массив. */
function makeAuditLog() {
  const entries: CommandAuditEntry[] = [];
  const append = vi.fn(async (entry: CommandAuditEntry) => {
    entries.push(entry);
  });
  return { entries, append, log: { enabled: true, append } as unknown as CommandAuditLog };
}

describe('Встроенные тулы реестра скриптов проекта (scripts.ts)', () => {
  describe('script_list', () => {
    it('возвращает список скриптов реестра', async () => {
      const service = makeService();
      const result = await scriptListTool.execute({}, makeCtx({ scriptService: service }));

      expect(result.isError).toBeUndefined();
      expect(result.metadata?.count).toBe(2);
      const scripts = result.metadata?.scripts as Array<{ name: string }>;
      expect(scripts.map((s) => s.name)).toEqual(['dev', 'deploy']);
      expect(result.content).toContain('dev');
    });

    it('скрывает deny-скрипты (правило permission.rules.script)', async () => {
      const service = makeService();
      const result = await scriptListTool.execute(
        {},
        makeCtx({
          scriptService: service,
          permissionConfig: { rules: { script: { 'deploy*': 'deny' } }, askTimeoutMs: 1000 },
        }),
      );

      expect(result.metadata?.count).toBe(1);
      const scripts = result.metadata?.scripts as Array<{ name: string }>;
      expect(scripts.map((s) => s.name)).toEqual(['dev']);
    });

    it('без сервиса — отказ script.tool.deps_unavailable', async () => {
      const result = await scriptListTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.metadata?.i18n).toMatchObject({ key: 'script.tool.deps_unavailable' });
    });
  });

  describe('script_run', () => {
    it('вызывает сервис с origin=agent и контекстом сессии', async () => {
      const service = makeService();
      const ctx = makeCtx({ scriptService: service });

      await scriptRunTool.execute({ name: 'dev', arguments: '--fast' }, ctx);

      const run = (service.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(run).toMatchObject({
        name: 'dev',
        args: '--fast',
        origin: 'agent',
        sessionId: 'sess-1',
        projectId: 'proj-1',
        workingDir: '/work/project',
        allowedRoots: ['/work/project-root'],
      });
    });

    it('ответ — script_started с run_id/process_id/log_path', async () => {
      const service = makeService();
      const result = await scriptRunTool.execute(
        { name: 'dev' },
        makeCtx({ scriptService: service }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.metadata?.status).toBe('script_started');
      expect(result.metadata?.run_id).toBe('bgr_run1');
      expect(result.metadata?.process_id).toBe('proc_1');
      expect(result.metadata?.log_path).toBe('processes/bgr_run1.log');
      expect(result.content).toContain('process_logs');
    });

    it('доменная ошибка скрипта — понятный отказ', async () => {
      const service = makeService({
        run: vi.fn(async () => {
          throw new ScriptError('script_untrusted', 'каталог недоверенный');
        }),
      });
      const result = await scriptRunTool.execute(
        { name: 'dev' },
        makeCtx({ scriptService: service }),
      );

      expect(result.isError).toBe(true);
      expect(result.metadata?.i18n).toMatchObject({ key: 'script.untrusted' });
    });

    it('без сервиса — отказ script.tool.deps_unavailable', async () => {
      const result = await scriptRunTool.execute({ name: 'dev' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.metadata?.i18n).toMatchObject({ key: 'script.tool.deps_unavailable' });
    });

    /**
     * ADR-136: у пары `started`/`finished` — один `execution_id`. Запись
     * `started` несёт его в `id`, в запуск скрипта он уходит как `auditId`.
     */
    it('запись started получает id, тот же id уходит в сервис как auditId', async () => {
      const service = makeService();
      const audit = makeAuditLog();

      await scriptRunTool.execute(
        { name: 'dev' },
        makeCtx({ scriptService: service, commandAudit: audit.log }),
      );

      expect(audit.entries).toHaveLength(1);
      const entry = audit.entries[0]!;
      expect(entry.phase).toBe('started');
      expect(entry.tool).toBe('script.run');
      expect(entry.id).toBeTruthy();

      const run = (service.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(run).toMatchObject({ auditId: entry.id });
    });

    it('без журнала запуск идёт без auditId', async () => {
      const service = makeService();

      await scriptRunTool.execute({ name: 'dev' }, makeCtx({ scriptService: service }));

      const run = (service.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(run).not.toHaveProperty('auditId');
    });
  });

  describe('permissions', () => {
    it('script_list разрешён в plan-режиме', () => {
      expect(isPlanBlockedTool('script_list', scriptListTool.capabilities)).toBe(false);
    });

    it('script_run в plan-режиме заблокирован', () => {
      expect(isPlanBlockedTool('script_run', scriptRunTool.capabilities)).toBe(true);
    });

    it('группа script отключаема админом (оба тула в ней)', () => {
      expect(getToolGroups('script_list', scriptListTool.capabilities)).toContain('script');
      expect(getToolGroups('script_run', scriptRunTool.capabilities)).toContain('script');
    });
  });
});
