/**
 * Unit-тесты портов Authority-слоя PostgreSQL-драйвера (ADR-106 Ф0/Ф1):
 * SQL-параметры, upsert политики, выборка журнала и маппинг строки в запись.
 *
 * Живая БД не нужна — подменяется исполнитель запросов (`PostgresExecutor`).
 * Контракт против настоящего PostgreSQL — в core
 * (`packages/core/src/storage/contract/postgres.test.ts`, гейт `SYNTH_TEST_POSTGRES_DSN`).
 */

import { describe, expect, it } from 'vitest';
import type { AuthorityDecisionEntry, AuthorityPolicy } from '@itphx/synth-shared';
import type { PostgresConnection } from '../pool.js';
import { buildAuthorityPorts } from './authority.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

/** Запрос, зафиксированный подменённым исполнителем. */
interface RecordedQuery {
  text: string;
  params: unknown[];
}

/** Подменённый исполнитель: возвращает заранее заданные строки и пишет запросы. */
function makeDeps(rows: Row[] = []): { deps: PortDeps; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const connection = {
    query: async (text: string, params: unknown[] = []): Promise<Row[]> => {
      queries.push({ text, params });
      return rows;
    },
  };
  const deps = { connection: connection as unknown as PostgresConnection } as unknown as PortDeps;
  return { deps, queries };
}

/** Политика инстанца для прогона. */
function policy(over: Partial<AuthorityPolicy> = {}): AuthorityPolicy {
  return {
    actions: [{ id: 'read', mutating: false, requires: [] }],
    roles: [
      {
        id: 'reader',
        domain: 'base',
        grants: [{ action: 'read', targetPattern: 'path:**', effect: 'allow' }],
      },
    ],
    targets: [{ kind: 'record' }],
    ceilings: [],
    agents: [],
    ...over,
  };
}

/** Запись журнала решений для прогона. */
function decision(over: Partial<AuthorityDecisionEntry> = {}): AuthorityDecisionEntry {
  return {
    id: 'ad_1',
    ts: '2026-01-01T00:00:00.000Z',
    principal: 'user:local',
    action: 'write',
    target: 'path:src/a.ts',
    effect: 'allow',
    source: 'user',
    reason: null,
    mode: 'shadow',
    ...over,
  };
}

describe('PostgresAuthorityPolicyRepository', () => {
  it('getPolicy без строки — null (политика не задана)', async () => {
    const { deps } = makeDeps([]);
    const { authorityPolicy } = buildAuthorityPorts(deps);

    expect(await authorityPolicy!.getPolicy()).toBeNull();
  });

  it('getPolicy возвращает разобранную политику инстанца', async () => {
    const { deps } = makeDeps([{ id: 'instance', document: policy() }]);
    const { authorityPolicy } = buildAuthorityPorts(deps);

    const stored = await authorityPolicy!.getPolicy();
    expect(stored!.roles.map((r) => r.id)).toEqual(['reader']);
    expect(stored!.actions.map((a) => a.id)).toEqual(['read']);
  });

  it('getPolicy: невалидный документ читается как отсутствие политики (fail-closed)', async () => {
    const { deps } = makeDeps([{ id: 'instance', document: { roles: 'не-массив' } }]);
    const { authorityPolicy } = buildAuthorityPorts(deps);

    expect(await authorityPolicy!.getPolicy()).toBeNull();
  });

  it('savePolicy — upsert единственной строки политики инстанца', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityPolicy } = buildAuthorityPorts(deps);

    await authorityPolicy!.savePolicy(policy());

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('INSERT INTO authority_policy');
    expect(queries[0]!.text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(queries[0]!.params[0]).toBe('instance');
    // Документ уходит JSONB-параметром (не конкатенацией в SQL).
    expect(queries[0]!.text).toContain('$2::jsonb');
    expect(JSON.parse(queries[0]!.params[1] as string).roles[0].id).toBe('reader');
  });

  it('savePolicy: невалидная политика отвергается (схема shared)', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityPolicy } = buildAuthorityPorts(deps);

    await expect(
      authorityPolicy!.savePolicy({ ...policy(), unknown: true } as unknown as AuthorityPolicy),
    ).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
});

describe('PostgresAuthorityDecisionJournal', () => {
  it('append — вставка записи в append-only журнал', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    await authorityDecisions!.append(decision());

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('INSERT INTO authority_decisions');
    expect(queries[0]!.params).toEqual([
      'ad_1',
      '2026-01-01T00:00:00.000Z',
      'user:local',
      'write',
      'path:src/a.ts',
      'allow',
      'user',
      null,
      'shadow',
      null,
    ]);
  });

  it('append: `permissionEffect` (shadow) сохраняется, режим enforced — без него', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    await authorityDecisions!.append(decision({ permissionEffect: 'deny' }));
    await authorityDecisions!.append(decision({ id: 'ad_2', mode: 'enforced' }));

    expect(queries[0]!.params[9]).toBe('deny');
    expect(queries[1]!.params[9]).toBeNull();
  });

  it('list — «свежие первыми» (ORDER BY seq DESC) без фильтров', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    await authorityDecisions!.list();

    expect(queries[0]!.text).toContain('ORDER BY seq DESC');
    expect(queries[0]!.params).toEqual([]);
  });

  it('list — фильтры action/effect/source и limit', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    await authorityDecisions!.list({ action: 'write', effect: 'deny', source: 'user', limit: 5 });

    expect(queries[0]!.text).toContain('action = $1');
    expect(queries[0]!.text).toContain('effect = $2');
    expect(queries[0]!.text).toContain('source = $3');
    expect(queries[0]!.text).toContain('LIMIT $4::int');
    expect(queries[0]!.params).toEqual(['write', 'deny', 'user', 5]);
  });

  it('list — `limit <= 0` не ограничивает выборку', async () => {
    const { deps, queries } = makeDeps([]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    await authorityDecisions!.list({ limit: 0 });

    expect(queries[0]!.text).not.toContain('LIMIT');
  });

  it('list — строка БД маппится в запись журнала (ts → ISO, permissionEffect опционален)', async () => {
    const { deps } = makeDeps([
      {
        id: 'ad_1',
        ts: new Date('2026-01-01T00:00:00.000Z'),
        principal: 'user:local',
        action: 'write',
        target: 'path:src/a.ts',
        effect: 'allow',
        source: 'user',
        reason: null,
        mode: 'shadow',
        permission_effect: null,
      },
    ]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    const list = await authorityDecisions!.list();

    expect(list).toHaveLength(1);
    expect(list[0]!.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(list[0]!.effect).toBe('allow');
    expect(list[0]!.reason).toBeNull();
    expect(list[0]!.mode).toBe('shadow');
    expect(list[0]!.permissionEffect).toBeUndefined();
  });

  it('clear — полная очистка журнала с числом удалённых записей', async () => {
    const { deps, queries } = makeDeps([{ n: 3 }]);
    const { authorityDecisions } = buildAuthorityPorts(deps);

    expect(await authorityDecisions!.clear()).toBe(3);
    expect(queries[0]!.text).toContain('DELETE FROM authority_decisions');
  });
});
