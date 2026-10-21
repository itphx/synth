import { describe, it, expect } from 'vitest';
import {
  PIPELINE_MODES,
  pipelineConditionSchema,
  pipelineExitSchema,
  pipelineRunEventSchema,
  pipelineRunSchema,
  pipelineSpecNodeSchema,
  pipelineSpecSchema,
  pipelineStepResultSchema,
  validatePipelineSpec,
  type PipelineSpec,
} from './pipeline-engine.js';

/**
 * Корректная спецификация — по примеру из [docs/PIPELINES.md] §2.2
 * (ADR-101), в терминах контракта Э1 (`nodes`/`exits`).
 */
const VALID_SPEC = {
  id: 'pr-pipeline',
  name: 'PR Pipeline',
  description: 'Реализация → проверка → подтверждение',
  version: 3,
  status: 'published',
  mode: 'act',
  projectId: 'proj_1',
  io: {
    input: {
      type: 'object',
      properties: { issue: { type: 'string' } },
      required: ['issue'],
    },
    output: { type: 'object' },
  },
  vars: { branch: 'trigger.payload.branch' },
  nodes: [
    {
      id: 'implement',
      kind: 'agent',
      agent: 'implementer',
      skill: 'code-review',
      prompt: 'Исправь задачу',
      input: ['prev.output.report', 'trigger.payload.issue'],
      timeoutSec: 900,
      retry: { max: 2, backoffSec: 5 },
      on: [
        { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'verify' },
        { when: { path: 'prev.output.status', op: 'eq', value: 'failed' }, then: 'fix' },
      ],
    },
    { id: 'verify', kind: 'tool', tool: 'git_status', toolArgs: { path: '.' } },
    { id: 'fix', kind: 'script', command: 'npm run fix', args: ['--fast'] },
    { id: 'approve', kind: 'human', prompt: 'Подтверди публикацию', timeoutSec: 86400 },
  ],
  exits: [{ kind: 'session', session: { agent: 'reporter' } }],
};

/** Разобранная корректная спецификация (после `pipelineSpecSchema`). */
function validSpec(): PipelineSpec {
  return pipelineSpecSchema.parse(VALID_SPEC);
}

describe('Спецификация пайплайна (ADR-101 §2.2)', () => {
  it('принимает корректную спецификацию', () => {
    const parsed = pipelineSpecSchema.safeParse(VALID_SPEC);
    expect(parsed.success).toBe(true);
  });

  it('отвергает неизвестный вид узла', () => {
    expect(
      pipelineSpecSchema.safeParse({ ...VALID_SPEC, nodes: [{ id: 'n1', kind: 'workflow' }] })
        .success,
    ).toBe(false);
  });

  it('отвергает спецификацию без узлов', () => {
    const withoutNodes: Record<string, unknown> = { ...VALID_SPEC };
    delete withoutNodes.nodes;
    expect(pipelineSpecSchema.safeParse(withoutNodes).success).toBe(false);
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, nodes: [] }).success).toBe(false);
  });

  it('отвергает спецификацию без выходов', () => {
    const withoutExits: Record<string, unknown> = { ...VALID_SPEC };
    delete withoutExits.exits;
    expect(pipelineSpecSchema.safeParse(withoutExits).success).toBe(false);
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, exits: [] }).success).toBe(false);
  });

  it('отвергает версию < 1 и нецелую версию', () => {
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, version: 0 }).success).toBe(false);
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, version: 1.5 }).success).toBe(false);
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, version: 1 }).success).toBe(true);
  });

  it('отвергает неизвестные статус и режим', () => {
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, status: 'archived' }).success).toBe(false);
    expect(pipelineSpecSchema.safeParse({ ...VALID_SPEC, mode: 'auto' }).success).toBe(false);
  });

  it('перечисляет допустимые режимы пайплайна', () => {
    expect([...PIPELINE_MODES]).toEqual(['plan', 'act', 'yolo']);
  });

  it('принимает минимальную спецификацию', () => {
    const parsed = pipelineSpecSchema.safeParse({
      id: 'p1',
      name: 'Минимальный',
      version: 1,
      status: 'draft',
      mode: 'plan',
      nodes: [{ id: 'n1', kind: 'agent', agent: 'assistant' }],
      exits: [{ kind: 'none' }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('Условия переходов (ADR-101 §2.6)', () => {
  it('принимает путь, оператор и скалярное значение', () => {
    expect(
      pipelineConditionSchema.safeParse({ path: 'prev.output.status', op: 'eq', value: 'ok' })
        .success,
    ).toBe(true);
  });

  it('принимает массив скаляров (оператор in)', () => {
    expect(
      pipelineConditionSchema.safeParse({ path: 'trigger.payload.labels', op: 'in', value: ['a', 'b'] })
        .success,
    ).toBe(true);
  });

  it('отвергает неизвестный оператор', () => {
    expect(
      pipelineConditionSchema.safeParse({ path: 'prev.output.status', op: 'like', value: 'ok' })
        .success,
    ).toBe(false);
  });

  it('отвергает массив значений с вложенными объектами', () => {
    expect(
      pipelineConditionSchema.safeParse({
        path: 'prev.output.status',
        op: 'in',
        value: [{ nested: true }],
      }).success,
    ).toBe(false);
  });

  it('требует непустой путь', () => {
    expect(pipelineConditionSchema.safeParse({ path: '', op: 'exists' }).success).toBe(false);
  });
});

describe('Выход пайплайна (ADR-101 §2.10)', () => {
  it('принимает все виды выходов', () => {
    expect(pipelineExitSchema.safeParse({ kind: 'none' }).success).toBe(true);
    expect(
      pipelineExitSchema.safeParse({ kind: 'session', session: { agent: 'reporter' } }).success,
    ).toBe(true);
    expect(
      pipelineExitSchema.safeParse({ kind: 'file', file: { path: 'out/report.md' } }).success,
    ).toBe(true);
    expect(
      pipelineExitSchema.safeParse({ kind: 'gateway', gateway: { event: 'release_published' } })
        .success,
    ).toBe(true);
  });

  it('отвергает неизвестный вид выхода', () => {
    expect(pipelineExitSchema.safeParse({ kind: 'telegram' }).success).toBe(false);
  });
});

describe('Узел пайплайна', () => {
  it('отвергает узел без id', () => {
    expect(pipelineSpecNodeSchema.safeParse({ kind: 'agent', agent: 'a1' }).success).toBe(false);
  });

  it('отвергает неположительный таймаут', () => {
    expect(
      pipelineSpecNodeSchema.safeParse({ id: 'n1', kind: 'agent', agent: 'a1', timeoutSec: 0 })
        .success,
    ).toBe(false);
  });
});

describe('validatePipelineSpec — целостность графа (ADR-101)', () => {
  it('не сообщает проблем для корректной спецификации', () => {
    expect(validatePipelineSpec(validSpec())).toEqual({ ok: true });
  });

  it('сообщает о пустом списке узлов', () => {
    const result = validatePipelineSpec({ ...validSpec(), nodes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.startsWith('nodes:'))).toBe(true);
    }
  });

  it('сообщает о пустом списке выходов', () => {
    const result = validatePipelineSpec({ ...validSpec(), exits: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.startsWith('exits:'))).toBe(true);
    }
  });

  it('сообщает о дубликате id узла', () => {
    const spec = validSpec();
    const result = validatePipelineSpec({
      ...spec,
      nodes: [...spec.nodes, { id: 'verify', kind: 'tool', tool: 'git_status' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('дубликат id узла'))).toBe(true);
    }
  });

  it('сообщает о переходе на несуществующий узел', () => {
    const spec = validSpec();
    const [first, ...rest] = spec.nodes;
    const result = validatePipelineSpec({
      ...spec,
      nodes: [
        {
          ...first!,
          on: [{ when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'missing' }],
        },
        ...rest,
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('несуществующий узел'))).toBe(true);
    }
  });

  it('сообщает о узле вида «agent» без поля «agent»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      nodes: [{ id: 'implement', kind: 'agent' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('требует поле «agent»'))).toBe(true);
    }
  });

  it('сообщает о узле вида «tool» без поля «tool»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      nodes: [{ id: 'verify', kind: 'tool' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('требует поле «tool»'))).toBe(true);
    }
  });

  it('сообщает о узле вида «script» без поля «command»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      nodes: [{ id: 'fix', kind: 'script' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('требует поле «command»'))).toBe(true);
    }
  });

  it('сообщает о выходе вида «file» без поля «path»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      exits: [{ kind: 'file', file: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('требует «file.path»'))).toBe(true);
    }
  });

  it('сообщает о выходе вида «session» без «agent» и «sessionId»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      exits: [{ kind: 'session', session: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('«session.agent»'))).toBe(true);
    }
  });

  it('сообщает о выходе вида «gateway» без «event» и «webhookId»', () => {
    const result = validatePipelineSpec({
      ...validSpec(),
      exits: [{ kind: 'gateway', gateway: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.includes('«gateway.event»'))).toBe(true);
    }
  });

  it('сообщает о неизвестном режиме пайплайна', () => {
    const spec = { ...validSpec(), mode: 'auto' } as unknown as PipelineSpec;
    const result = validatePipelineSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((problem) => problem.startsWith('mode:'))).toBe(true);
    }
  });

  it('не требует agent/sessionId у выхода вида «none»', () => {
    const result = validatePipelineSpec({ ...validSpec(), exits: [{ kind: 'none' }] });
    expect(result).toEqual({ ok: true });
  });

  it('принимает переход вперёд (ссылка на узел, объявленный позже)', () => {
    const spec = validSpec();
    const result = validatePipelineSpec({
      ...spec,
      nodes: [
        {
          id: 'implement',
          kind: 'agent',
          agent: 'implementer',
          on: [{ when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'verify' }],
        },
        { id: 'verify', kind: 'tool', tool: 'git_status' },
      ],
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('Результат узла (ADR-101 §2.4)', () => {
  it('принимает результат с артефактами и таймингами', () => {
    const parsed = pipelineStepResultSchema.safeParse({
      status: 'ok',
      output: { status: 'ok', report: 'готово' },
      artifacts: [{ kind: 'report', id: 'a1', from: 'implement' }],
      startedAt: '2026-10-21T10:00:00.000Z',
      finishedAt: '2026-10-21T10:00:05.000Z',
      durationMs: 5000,
      attempt: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it('отвергает неизвестный статус результата', () => {
    expect(pipelineStepResultSchema.safeParse({ status: 'done', attempt: 1 }).success).toBe(false);
  });

  it('требует номер попытки', () => {
    expect(pipelineStepResultSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });

  it('принимает ошибку узла', () => {
    const parsed = pipelineStepResultSchema.safeParse({
      status: 'failed',
      error: { code: 'LLM_ERROR', message: 'модель недоступна' },
      attempt: 2,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('Прогон пайплайна (ADR-101 §2.9)', () => {
  it('принимает заголовок прогона', () => {
    const parsed = pipelineRunSchema.safeParse({
      id: 'run-1',
      pipelineId: 'pr-pipeline',
      version: 3,
      projectId: 'proj_1',
      status: 'awaiting_human',
      currentNode: 'approve',
      trigger: {
        kind: 'gateway',
        source: 'tg',
        type: 'release_published',
        payload: { issue: '42' },
        dedupKey: 'tg:42',
      },
      startedAt: '2026-10-21T10:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('перечисляет виды триггера прогона', () => {
    for (const kind of ['user', 'gateway', 'schedule', 'tool', 'webhook', 'manual']) {
      expect(pipelineRunSchema.safeParse({ id: 'r1', pipelineId: 'p1', version: 1, status: 'pending', trigger: { kind } }).success).toBe(true);
    }
  });

  it('отвергает неизвестный статус прогона', () => {
    expect(
      pipelineRunSchema.safeParse({ id: 'r1', pipelineId: 'p1', version: 1, status: 'paused' })
        .success,
    ).toBe(false);
  });

  it('требует pipelineId и версию ≥ 1', () => {
    expect(pipelineRunSchema.safeParse({ id: 'r1', version: 1, status: 'pending' }).success).toBe(
      false,
    );
    expect(
      pipelineRunSchema.safeParse({ id: 'r1', pipelineId: 'p1', version: 0, status: 'pending' })
        .success,
    ).toBe(false);
  });

  it('отвергает неизвестный вид триггера', () => {
    expect(
      pipelineRunSchema.safeParse({
        id: 'r1',
        pipelineId: 'p1',
        version: 1,
        status: 'pending',
        trigger: { kind: 'cron' },
      }).success,
    ).toBe(false);
  });
});

describe('События прогона (ADR-101 §2.9)', () => {
  it('принимает все типы событий журнала', () => {
    for (const type of [
      'run.started',
      'node.started',
      'node.finished',
      'edge.taken',
      'gate.awaiting',
      'run.finished',
      'run.failed',
    ]) {
      expect(
        pipelineRunEventSchema.safeParse({
          runId: 'run-1',
          ts: '2026-10-21T10:00:00.000Z',
          type,
        }).success,
      ).toBe(true);
    }
  });

  it('отвергает неизвестный тип события', () => {
    expect(
      pipelineRunEventSchema.safeParse({
        runId: 'run-1',
        ts: '2026-10-21T10:00:00.000Z',
        type: 'node.paused',
      }).success,
    ).toBe(false);
  });

  it('требует runId', () => {
    expect(
      pipelineRunEventSchema.safeParse({ ts: '2026-10-21T10:00:00.000Z', type: 'run.started' })
        .success,
    ).toBe(false);
  });
});
