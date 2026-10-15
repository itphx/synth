import { describe, expect, it } from 'vitest';
import type {
  ProfileRepository,
  ProjectRepository,
  SessionRepository,
  SettingsRepository,
} from '../ports/index.js';
import { ProjectRole } from '@itphx/synth-shared';
import { makeProfile, makeProject, makeSession, makeMessage } from './helpers.js';

/** Паспорт порта `SessionRepository`: round-trip, список, видимость, поиск, сортировка. */
export function describeSessionRepository(
  name: string,
  make: () => Promise<{ repo: SessionRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('save/load round-trip; list на пустом — []; delete отсутствующего — не ошибка', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.load('missing')).toBeNull();
      await expect(repo.delete('missing')).resolves.toBeUndefined();

      const session = makeSession({ id: 's1', title: 'first' });
      await repo.save(session);
      expect(await repo.exists('s1')).toBe(true);
      const loaded = await repo.load('s1');
      expect(loaded?.title).toBe('first');

      await repo.delete('s1');
      expect(await repo.exists('s1')).toBe(false);
      expect(await repo.load('s1')).toBeNull();
    });

    it('list не теряет записи и сортирует по updatedAt desc', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }));
      await repo.save(makeSession({ id: 'b', updatedAt: '2024-03-01T00:00:00.000Z' }));
      await repo.save(makeSession({ id: 'c', updatedAt: '2024-02-01T00:00:00.000Z' }));

      const list = await repo.list();
      expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    });

    it('search находит по содержимому сообщения', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'a', title: 'alpha', messages: [] }));
      await repo.save(makeSession({ id: 'b', title: 'beta', messages: [makeMessage('unique-needle')] }));

      const found = await repo.search('unique-needle');
      expect(found.map((s) => s.id)).toEqual(['b']);
    });

    it('listForUser возвращает только сессии пользователя (owner/user)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'mine', userId: 'u1' }));
      await repo.save(makeSession({ id: 'owned', ownerId: 'u1' }));
      await repo.save(makeSession({ id: 'other', userId: 'u2' }));

      const list = await repo.listForUser('u1');
      expect(list.map((s) => s.id).sort()).toEqual(['mine', 'owned']);
      expect((await repo.listForUser('u1', ['u3'])).map((s) => s.id).sort()).toEqual(['mine', 'owned']);
    });

    it('listForUserScope включает сессии проектов участия, но не чужие личные', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'mine', userId: 'u1' }));
      await repo.save(makeSession({ id: 'proj', userId: 'u2', projectId: 'p1' }));
      await repo.save(makeSession({ id: 'foreign', userId: 'u2', projectId: 'p2' }));

      const scoped = await repo.listForUserScope('u1', ['p1']);
      expect(scoped.map((s) => s.id).sort()).toEqual(['mine', 'proj']);
    });
  });
}

/** Паспорт порта `ProjectRepository`: create/save/load, фильтр owner/member, сортировка. */
export function describeProjectRepository(
  name: string,
  make: () => Promise<{ repo: ProjectRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/save/load round-trip; delete отсутствующего — не ошибка; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      const project = repo.create('Демо', 'u1');
      expect(project.id).toBeTruthy();
      expect(project.ownerId).toBe('u1');
      await repo.save(project);
      expect((await repo.load(project.id))?.name).toBe('Демо');

      await expect(repo.delete('missing')).resolves.toBeUndefined();
      await repo.delete(project.id);
      expect(await repo.load(project.id)).toBeNull();
    });

    it('list фильтрует по owner/member и сортирует по updatedAt desc', async () => {
      const { repo } = await make();
      await repo.save(makeProject('p-owner', { ownerId: 'u1', members: { u1: ProjectRole.OWNER }, updatedAt: '2024-01-01T00:00:00.000Z' }));
      await repo.save(makeProject('p-member', { ownerId: 'u9', members: { u9: ProjectRole.OWNER, u1: ProjectRole.EDITOR }, updatedAt: '2024-03-01T00:00:00.000Z' }));
      await repo.save(makeProject('p-foreign', { ownerId: 'u2', members: { u2: ProjectRole.OWNER }, updatedAt: '2024-02-01T00:00:00.000Z' }));

      const mine = await repo.list('u1');
      expect(mine.map((p) => p.id)).toEqual(['p-member', 'p-owner']);
      const all = await repo.list();
      expect(all.map((p) => p.id)).toEqual(['p-member', 'p-foreign', 'p-owner']);
    });
  });
}

/** Паспорт порта `ProfileRepository`: CRUD профиля и unique username. */
export function describeProfileRepository(
  name: string,
  make: () => Promise<{ repo: ProfileRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('save/load/list/delete; отсутствующий — null/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.listProfiles()).toEqual([]);
      expect(await repo.loadProfile('nope')).toBeNull();
      expect(await repo.deleteProfile('nope')).toBe(false);

      await repo.saveProfile(makeProfile('p1', { username: 'alice' }));
      const loaded = await repo.loadProfile('p1');
      expect(loaded?.username).toBe('alice');
      expect((await repo.listProfiles()).map((p) => p.id)).toEqual(['p1']);

      expect(await repo.deleteProfile('p1')).toBe(true);
      expect(await repo.loadProfile('p1')).toBeNull();
    });

    it('getOrCreateProfile идемпотентен по username', async () => {
      const { repo } = await make();
      const first = await repo.getOrCreateProfile({ username: 'bob' });
      const second = await repo.getOrCreateProfile({ username: 'bob' });
      expect(second.id).toBe(first.id);
      expect(await repo.getProfileByUsername('bob')).not.toBeNull();
    });
  });
}

/** Паспорт порта `SettingsRepository`: запись/чтение секции и сброс. */
export function describeSettingsRepository(
  name: string,
  make: () => Promise<{ repo: SettingsRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('set/get/clear workspace; load пустого — {}', async () => {
      const { repo } = await make();
      expect(await repo.load()).toEqual({});
      expect(await repo.getWorkspace()).toBeUndefined();

      await repo.setWorkspace('/tmp/ws');
      expect(await repo.getWorkspace()).toBe('/tmp/ws');
      await repo.clearWorkspace();
      expect(await repo.getWorkspace()).toBeUndefined();
    });

    it('маркеры и токен-ратио сохраняются независимо', async () => {
      const { repo } = await make();
      expect(await repo.getMigrationMarker('m1')).toBe(false);
      await repo.setMigrationMarker('m1');
      expect(await repo.getMigrationMarker('m1')).toBe(true);

      await repo.setTokenRatio('model-x', 3.5);
      expect(await repo.getTokenRatio('model-x')).toBe(3.5);
      expect(await repo.getTokenRatios()).toEqual({ 'model-x': 3.5 });
    });
  });
}
