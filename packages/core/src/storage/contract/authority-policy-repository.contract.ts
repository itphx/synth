import { appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthorityDecisionEntry, AuthorityPolicy } from '@itphx/synth-shared';
import type {
  AuthorityDecisionJournal,
  AuthorityPolicyRepository,
} from '../ports/index.js';

/** Запись журнала решений для контрактного прогона. */
function decision(id: string, over: Partial<AuthorityDecisionEntry> = {}): AuthorityDecisionEntry {
  return {
    id,
    ts: new Date().toISOString(),
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

/** Политика инстанса для контрактного прогона. */
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
    ...over,
  };
}

/**
 * Паспорт порта `AuthorityPolicyRepository` (ADR-106 Ф0, ADR-096): политика
 * инстанца — одна на инстанс; «документа нет» (`null`) и «документ пуст» —
 * **разные** состояния (ось отсутствует vs ось запрещает всё).
 */
export function describeAuthorityPolicyRepository(
  name: string,
  make: () => Promise<{
    repo: AuthorityPolicyRepository;
    dispose?: () => Promise<void>;
    /** Путь к JSON-файлу политики — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('без документа — getPolicy возвращает null (ось инстанца не применима)', async () => {
      const { repo } = await make();
      expect(await repo.getPolicy()).toBeNull();
    });

    it('savePolicy → getPolicy отдаёт сохранённую политику', async () => {
      const { repo } = await make();
      await repo.savePolicy(policy());

      const stored = await repo.getPolicy();
      expect(stored).not.toBeNull();
      expect(stored!.actions.map((a) => a.id)).toEqual(['read']);
      expect(stored!.roles.map((r) => r.id)).toEqual(['reader']);
      expect(stored!.roles[0]!.grants[0]!.targetPattern).toBe('path:**');
      expect(stored!.targets.map((t) => t.kind)).toEqual(['record']);
    });

    it('savePolicy заменяет политику целиком (не дописывает)', async () => {
      const { repo } = await make();
      await repo.savePolicy(policy());
      await repo.savePolicy(policy({ roles: [], actions: [] }));

      const stored = await repo.getPolicy();
      expect(stored!.roles).toEqual([]);
      expect(stored!.actions).toEqual([]);
    });

    it('пустой документ — политика задана (ось применима) и пуста', async () => {
      const { repo } = await make();
      await repo.savePolicy({
        actions: [],
        roles: [],
        targets: [],
        ceilings: [],
      });

      const stored = await repo.getPolicy();
      expect(stored).not.toBeNull();
      expect(stored!.roles).toEqual([]);
    });

    it('getPolicy отдаёт независимую копию (мутация не влияет на хранилище)', async () => {
      const { repo } = await make();
      await repo.savePolicy(policy());

      const first = await repo.getPolicy();
      first!.roles.push({
        id: 'intruder',
        domain: 'base',
        grants: [],
      });

      const second = await repo.getPolicy();
      expect(second!.roles.map((r) => r.id)).toEqual(['reader']);
    });

    it('файловая реализация: savePolicy создаёт каталог authority/', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.savePolicy(policy());
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
      expect((await stat(filePath)).isFile()).toBe(true);
    });

    it('файловая реализация: повреждённый документ читается как отсутствие политики', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.savePolicy(policy());
      await appendFile(filePath, 'не-json-мусор\n', 'utf-8');
      // Документ не разбирается — политика считается незаданной (fail-closed
      // на оси «user», а не «политика без грантов»).
      expect(await repo.getPolicy()).toBeNull();
    });
  });
}

/**
 * Паспорт порта `AuthorityDecisionJournal` (ADR-106 Ф1, ADR-096): append-only
 * журнал решений, выборка «свежие первыми», фильтры `action`/`effect`/`source`,
 * очистка с числом удалённых.
 *
 * Кейсы с `filePath` — файл-специфичные (повреждённая строка, создание
 * каталога); для in-memory реализации `filePath` не задаётся и они пропускаются.
 */
export function describeAuthorityDecisionJournal(
  name: string,
  make: () => Promise<{
    repo: AuthorityDecisionJournal;
    dispose?: () => Promise<void>;
    /** Путь к JSONL-файлу журнала — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(decision('ad_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('ad_1');
      expect(list[0]!.principal).toBe('user:local');
      expect(list[0]!.action).toBe('write');
      expect(list[0]!.target).toBe('path:src/a.ts');
      expect(list[0]!.effect).toBe('allow');
      expect(list[0]!.source).toBe('user');
    });

    it('порядок «свежие первыми»; фильтры action/effect/source и limit', async () => {
      const { repo } = await make();
      await repo.append(decision('ad_1', { action: 'read', effect: 'allow' }));
      await repo.append(decision('ad_2', { action: 'write', effect: 'deny' }));
      await repo.append(decision('ad_3', { action: 'write', effect: 'ask', source: 'instance' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['ad_3', 'ad_2', 'ad_1']);
      expect((await repo.list({ action: 'write' })).map((e) => e.id)).toEqual(['ad_3', 'ad_2']);
      expect((await repo.list({ effect: 'deny' })).map((e) => e.id)).toEqual(['ad_2']);
      expect((await repo.list({ source: 'instance' })).map((e) => e.id)).toEqual(['ad_3']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['ad_3', 'ad_2']);
      // `limit <= 0`/не число — без ограничения.
      expect((await repo.list({ limit: 0 })).map((e) => e.id)).toEqual(['ad_3', 'ad_2', 'ad_1']);
    });

    it('запись сохраняет причину и режим без потерь', async () => {
      const { repo } = await make();
      await repo.append(
        decision('ad_1', { effect: 'deny', reason: 'no_grant', mode: 'enforced' }),
      );
      const stored = (await repo.list())[0]!;
      expect(stored.reason).toBe('no_grant');
      expect(stored.mode).toBe('enforced');
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);

      await repo.append(decision('ad_1'));
      await repo.append(decision('ad_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
      expect(await repo.clear()).toBe(0);
    });

    it('list отдаёт независимые копии (мутация не влияет на журнал)', async () => {
      const { repo } = await make();
      await repo.append(decision('ad_1'));
      const listed = await repo.list();
      listed[0]!.effect = 'deny';
      expect((await repo.list())[0]!.effect).toBe('allow');
    });

    it('файловая реализация: повреждённая строка не ломает list', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.append(decision('ad_ok'));
      await appendFile(filePath, 'не-json-мусор\n', 'utf-8');
      expect((await repo.list()).map((e) => e.id)).toEqual(['ad_ok']);

      // Повреждённая строка не мешает дальнейшей дозаписи/чтению.
      await repo.append(decision('ad_next'));
      expect((await repo.list()).map((e) => e.id)).toEqual(['ad_next', 'ad_ok']);
    });

    it('файловая реализация: append создаёт каталог журнала', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      // До первой записи каталога `audit/` ещё нет.
      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.append(decision('ad_1'));
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
      expect((await repo.list()).map((e) => e.id)).toEqual(['ad_1']);
    });
  });
}
