/**
 * Журнал решений по подтверждениям прав (`scope:'permission'`).
 *
 * Проверяется **шов целиком**, а не только сериализация: ожидание создаётся
 * настоящим `PermissionApprovalManager` с `onDecision` → `sink.decision(...)`,
 * поэтому тесты падают, если изменится любой из исходов (`user`/`timeout`/
 * `cascade`/`cancelled`) или фильтр режима (`decisions`/`all`).
 *
 * Порт журнала — фейк в памяти (`prune` в тестах не нужен).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SecurityAuditEntry } from '@itphx/synth-shared';

import { EventBus } from '../../events/bus.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { AuditPermissionMode } from '../../storage/runtime-settings.js';
import { checkPipelineToolPermission } from '../pipelines/permissions.js';
import { PermissionApprovalManager } from './approval.js';
import type { ApprovalRequest } from './approval.js';
import {
  createPermissionAuditSink,
  recordPermissionAudit,
  type PermissionAuditSink,
  type PermissionDecisionAuditSnapshot,
} from './permission-audit.js';

/** Фейковый порт журнала: записи в массиве, `failing` — имитация сбоя записи. */
class FakeAuditRepository implements SecurityAuditRepository {
  entries: SecurityAuditEntry[] = [];
  failing = false;

  async append(entry: SecurityAuditEntry): Promise<void> {
    if (this.failing) throw new Error('audit store is down');
    this.entries.push(structuredClone(entry));
  }

  async list(): Promise<SecurityAuditEntry[]> {
    return [...this.entries].reverse();
  }

  async clear(): Promise<number> {
    const removed = this.entries.length;
    this.entries = [];
    return removed;
  }
}

/** Снимок `after` записи журнала (форма `scope:'permission'`). */
function snapshots(repository: FakeAuditRepository): PermissionDecisionAuditSnapshot[] {
  return repository.entries.map((entry) => entry.after as PermissionDecisionAuditSnapshot);
}

/** Запрос подтверждения `execute_shell` с планом гранта «в сессии». */
const shellRequest: ApprovalRequest = {
  approvalId: 'approval_call-1',
  callId: 'call-1',
  toolName: 'execute_shell',
  arguments: { command: 'git status' },
  reason: 'правило execute_shell → ask',
  save: ['git status'],
  saveDirectories: ['/repo/work'],
  trigger: { matchedRule: 'execute_shell', askKind: 'dynamic' },
};

/** Запрос подтверждения с заданными id (несколько ожиданий одной сессии). */
function requestWith(id: string): ApprovalRequest {
  return { ...shellRequest, approvalId: `approval_${id}`, callId: id };
}

describe('createPermissionAuditSink — решения по подтверждениям', () => {
  let repository: FakeAuditRepository;
  let sink: PermissionAuditSink;
  let bus: EventBus;
  let manager: PermissionApprovalManager;
  let warnings: string[];

  function build(mode: AuditPermissionMode = 'decisions'): void {
    repository = new FakeAuditRepository();
    warnings = [];
    sink = createPermissionAuditSink({
      repository,
      actorOf: (sessionId) => `owner:${sessionId}`,
      mode: () => mode,
      warn: (message) => warnings.push(message),
    });
    bus = new EventBus();
    // Пользовательский подписчик (UI-полоса подтверждения): без него ожидание
    // закрывается сразу как `noSubscribers` и решения по запросу нет.
    bus.subscribeAll(() => {}, { userFacing: true });
    manager = new PermissionApprovalManager(bus, {
      onDecision: (event) => sink.decision(event),
    });
  }

  beforeEach(() => {
    build();
  });

  it('allow «Разрешить в сессии» — одна запись allow с записанными правилами', async () => {
    const pending = manager.waitForDecision('s1', shellRequest, 5000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.publish('s1', 'permission.replied', {
      approval_id: shellRequest.approvalId,
      session_id: 's1',
      action: 'allow',
      once: false,
    });
    const decision = await pending;
    await sink.flush();

    expect(decision.approved).toBe(true);
    expect(repository.entries).toHaveLength(1);
    const [entry] = repository.entries;
    expect(entry?.scope).toBe('permission');
    expect(entry?.action).toBe('allow');
    expect(entry?.source).toBe('runtime');
    // Актор — владелец сессии (резолвится внутри записи).
    expect(entry?.actor).toBe('owner:s1');
    const after = snapshots(repository)[0]!;
    expect(after.sessionId).toBe('s1');
    expect(after.approvalId).toBe(shellRequest.approvalId);
    expect(after.callId).toBe('call-1');
    expect(after.toolName).toBe('execute_shell');
    expect(after.matchedRule).toBe('execute_shell');
    expect(after.askKind).toBe('dynamic');
    expect(after.command).toBe('git status');
    expect(after.once).toBe(false);
    expect(after.outcome).toBe('user');
    // Грант «в сессии» записал бы эти правила — они в снимке решения.
    expect(after.granted).toEqual({ patterns: ['git status'], directories: ['/repo/work'] });
    expect(entry?.before).toBeNull();
  });

  it('allow «только один раз» — once:true и пустой granted', async () => {
    const pending = manager.waitForDecision('s1', shellRequest, 5000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.publish('s1', 'permission.replied', {
      approval_id: shellRequest.approvalId,
      session_id: 's1',
      action: 'allow',
      once: true,
    });
    await pending;
    await sink.flush();

    expect(repository.entries).toHaveLength(1);
    const after = snapshots(repository)[0]!;
    expect(repository.entries[0]?.action).toBe('allow');
    expect(after.once).toBe(true);
    expect(after.outcome).toBe('user');
    expect(after.granted).toBeUndefined();
    expect(after).not.toHaveProperty('granted');
  });

  it('deny — запись deny с outcome user', async () => {
    const pending = manager.waitForDecision('s1', shellRequest, 5000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.publish('s1', 'permission.replied', {
      approval_id: shellRequest.approvalId,
      session_id: 's1',
      action: 'deny',
    });
    const decision = await pending;
    await sink.flush();

    expect(decision.approved).toBe(false);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.action).toBe('deny');
    expect(snapshots(repository)[0]?.outcome).toBe('user');
  });

  it('таймаут — outcome timeout, действие deny', async () => {
    // Таймаут короткий: ответа не публикуем вовсе.
    const decision = await manager.waitForDecision('s1', shellRequest, 5);
    await sink.flush();

    expect(decision.timeout).toBe(true);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.action).toBe('deny');
    const after = snapshots(repository)[0]!;
    expect(after.outcome).toBe('timeout');
    expect(after.granted).toBeUndefined();
  });

  it('каскад отказа — outcome cascade у соседнего ожидания', async () => {
    const first = requestWith('call-1');
    const second = requestWith('call-2');
    const waiters = manager.prepareWaiters('s1', [first, second], 5000);
    manager.publishWaiters(waiters);

    bus.publish('s1', 'permission.replied', {
      approval_id: first.approvalId,
      session_id: 's1',
      action: 'deny',
    });
    await Promise.all(waiters.map((waiter) => waiter.decision));
    await sink.flush();

    expect(repository.entries).toHaveLength(2);
    const byApproval = new Map(
      snapshots(repository).map((after) => [after.approvalId, after] as const),
    );
    expect(byApproval.get(first.approvalId)?.outcome).toBe('user');
    expect(byApproval.get(second.approvalId)?.outcome).toBe('cascade');
    expect(repository.entries.map((entry) => entry.action)).toEqual(['deny', 'deny']);
  });

  it('отмена хода («Стоп») — outcome cancelled', async () => {
    const controller = new AbortController();
    const pending = manager.waitForDecision('s1', shellRequest, 5000, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const decision = await pending;
    await sink.flush();

    expect(decision.cancelled).toBe(true);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.action).toBe('deny');
    expect(snapshots(repository)[0]?.outcome).toBe('cancelled');
  });

  it('репозиторий не задан — решений нет и ошибок нет', async () => {
    const bare: PermissionAuditSink = createPermissionAuditSink({
      actorOf: () => 'local',
      warn: (message) => warnings.push(message),
    });
    // Ничего не бросает и ничего не пишет: журнала на инстансе нет.
    bare.rule({ sessionId: 's1', toolName: 'read_file', action: 'allow' });
    bare.decision({
      sessionId: 's1',
      request: shellRequest,
      decision: { approved: true, action: 'allow', once: false },
    });
    await bare.flush();
    expect(warnings).toEqual([]);
  });

  it('ошибка порта не ломает ход (best-effort)', async () => {
    repository.failing = true;
    const pending = manager.waitForDecision('s1', shellRequest, 5000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.publish('s1', 'permission.replied', {
      approval_id: shellRequest.approvalId,
      session_id: 's1',
      action: 'allow',
      once: false,
    });
    // Решение доходит до вызывающего независимо от журнала.
    const decision = await pending;
    await sink.flush();

    expect(decision.approved).toBe(true);
    expect(repository.entries).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('аудит решения по правам не записан');
  });
});

describe('createPermissionAuditSink — режимы журналирования', () => {
  let repository: FakeAuditRepository;
  let warnings: string[];

  function sinkFor(mode: AuditPermissionMode): PermissionAuditSink {
    repository = new FakeAuditRepository();
    warnings = [];
    return createPermissionAuditSink({
      repository,
      actorOf: (sessionId) => `owner:${sessionId}`,
      mode: () => mode,
      warn: (message) => warnings.push(message),
    });
  }

  it('decisions — решения человека пишутся, автоматические по правилу нет', async () => {
    const sink = sinkFor('decisions');
    sink.rule({ sessionId: 's1', toolName: 'read_file', action: 'allow', matchedRule: 'read_file' });
    // Решение «по правилу», принятое из кода (переоценка соседей после гранта).
    sink.decision({
      sessionId: 's1',
      request: shellRequest,
      decision: { approved: true, action: 'allow' },
      auto: true,
    });
    // Решение человека — пишется всегда.
    sink.decision({
      sessionId: 's1',
      request: shellRequest,
      decision: { approved: false, action: 'deny' },
    });
    await sink.flush();

    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.action).toBe('deny');
    expect(snapshots(repository)[0]?.outcome).toBe('user');
    expect(warnings).toEqual([]);
  });

  it('all — пишутся и решения по правилам (outcome rule)', async () => {
    const sink = sinkFor('all');
    sink.rule({
      sessionId: 's1',
      toolName: 'read_file',
      action: 'allow',
      matchedRule: 'read_file',
      callId: 'call-9',
      turnId: 'stream-9',
    });
    sink.rule({ sessionId: 's1', toolName: 'write_file', action: 'deny', matchedRule: 'write_file' });
    sink.decision({
      sessionId: 's1',
      request: shellRequest,
      decision: { approved: true, action: 'allow' },
      auto: true,
    });
    await sink.flush();

    expect(repository.entries).toHaveLength(3);
    expect(repository.entries.map((entry) => entry.action)).toEqual(['allow', 'deny', 'allow']);
    const [ruleAllow, ruleDeny, autoDecision] = snapshots(repository);
    expect(ruleAllow?.outcome).toBe('rule');
    expect(ruleAllow?.matchedRule).toBe('read_file');
    expect(ruleAllow?.callId).toBe('call-9');
    expect(ruleAllow?.turnId).toBe('stream-9');
    expect(ruleDeny?.outcome).toBe('rule');
    // Решение, принятое из кода, тоже автоматическое — `outcome:'rule'`.
    expect(autoDecision?.outcome).toBe('rule');
  });

  it('режим читается на каждую запись (live-переключение)', async () => {
    let mode: AuditPermissionMode = 'decisions';
    repository = new FakeAuditRepository();
    const sink = createPermissionAuditSink({
      repository,
      actorOf: () => 'local',
      mode: () => mode,
    });

    sink.rule({ sessionId: 's1', toolName: 'read_file', action: 'allow' });
    await sink.flush();
    expect(repository.entries).toHaveLength(0);

    mode = 'all';
    sink.rule({ sessionId: 's1', toolName: 'read_file', action: 'allow' });
    await sink.flush();
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.actor).toBe('local');
  });
});

describe('шов пайплайна — решение по правилу', () => {
  /** Заглушка шва: собирает вызовы `rule()`. */
  function fakeSink(): { sink: PermissionAuditSink; rules: unknown[] } {
    const rules: unknown[] = [];
    return {
      rules,
      sink: {
        decision: () => {},
        rule: (event) => {
          rules.push(event);
        },
        flush: async () => {},
      },
    };
  }

  const check = {
    toolName: 'execute_shell',
    params: { command: 'ls -la' },
    workingDir: '/repo',
    mode: 'act' as const,
  };

  it('allow с sessionId — запись rule с сессией прогона и командой', () => {
    const { sink, rules } = fakeSink();
    const decision = checkPipelineToolPermission(
      { ...check, sessionId: 'pipeline:run-1' },
      { permissionConfig: { rules: {}, askTimeoutMs: 30_000 }, audit: sink },
    );

    expect(decision.action).toBe('allow');
    expect(rules).toEqual([
      { sessionId: 'pipeline:run-1', toolName: 'execute_shell', action: 'allow', command: 'ls -la' },
    ]);
  });

  it('ask и отсутствие sessionId — записи нет', () => {
    const { sink, rules } = fakeSink();
    const askConfig = {
      rules: { execute_shell: 'ask' as const },
      askTimeoutMs: 30_000,
    };
    // `ask` — не решение (исход — решение оператора в human-гейте).
    checkPipelineToolPermission(
      { ...check, sessionId: 'pipeline:run-2' },
      { permissionConfig: askConfig, audit: sink },
    );
    // Без `sessionId` журнал не пишется (поведение прежнее).
    checkPipelineToolPermission(check, { permissionConfig: askConfig, audit: sink });
    expect(rules).toEqual([]);
  });
});

describe('recordPermissionAudit', () => {
  it('пишет запись scope permission с актором и снимками', async () => {
    const repository = new FakeAuditRepository();
    await recordPermissionAudit(
      { repository },
      { action: 'revoke', actor: 'admin', before: { tool: 'read_file' }, after: null },
    );

    expect(repository.entries).toHaveLength(1);
    const [entry] = repository.entries;
    expect(entry?.scope).toBe('permission');
    expect(entry?.action).toBe('revoke');
    expect(entry?.actor).toBe('admin');
    expect(entry?.before).toEqual({ tool: 'read_file' });
    expect(entry?.after).toBeNull();
    expect(entry?.id.startsWith('sa_')).toBe(true);
  });

  it('пустой актор и отсутствие порта — не ошибки', async () => {
    const warnings: string[] = [];
    const repository = new FakeAuditRepository();
    await recordPermissionAudit(
      { repository, warn: (message) => warnings.push(message) },
      { action: 'update', actor: '', before: null, after: { mode: 'all' } },
    );
    expect(repository.entries[0]?.actor).toBe('local');

    await recordPermissionAudit({ warn: (message) => warnings.push(message) }, {
      action: 'update',
      actor: 'admin',
      before: null,
      after: null,
    });
    expect(repository.entries).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('ошибка порта гасится предупреждением, а не исключением', async () => {
    const repository = new FakeAuditRepository();
    repository.failing = true;
    const warnings: string[] = [];
    await expect(
      recordPermissionAudit(
        { repository, warn: (message) => warnings.push(message) },
        { action: 'allow', actor: 'local', before: null, after: {} },
      ),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('audit store is down');
  });
});
