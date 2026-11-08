import { describe, expect, it } from 'vitest';
import type {
  ProfileRepository,
  ProjectRepository,
  SessionRepository,
  SettingsRepository,
} from '../ports/index.js';
import { MessageRole, ProjectRole, makeTextPart } from '@itphx/synth-shared';
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

    it('legacy-сообщения (seq=0 у всех и дубликаты id) сохраняются round-trip в исходном порядке и без потерь', async () => {
      const { repo } = await make();
      // Воспроизведение реальных legacy-данных: у всех сообщений `seq = 0`
      // (снятие коллизии `UNIQUE (session_id, seq)`) и один `id` повторяется.
      const first = { ...makeMessage('legacy-first'), id: 'dup-id', seq: 0 };
      const second = { ...makeMessage('legacy-second'), id: 'dup-id', seq: 0 };
      const third = { ...makeMessage('legacy-third'), id: 'unique-id', seq: 0 };

      await repo.save(makeSession({ id: 'legacy', messages: [first, second, third] }));

      const loaded = await repo.load('legacy');
      expect(loaded?.messages).toHaveLength(3);
      expect(loaded?.messages.map((m) => m.id)).toEqual(['dup-id', 'dup-id', 'unique-id']);
      expect(loaded?.messages.map((m) => m.content)).toEqual([
        'legacy-first',
        'legacy-second',
        'legacy-third',
      ]);
    });

    it('U+0000 в сообщении не сохраняется (NUL несовместим с PostgreSQL)', async () => {
      const { repo } = await make();
      const message = {
        ...makeMessage('before\u0000after'),
        metadata: { note: 'm\u0000', nested: ['n\u0000'] },
      };
      await repo.save(makeSession({ id: 'nul', messages: [message] }));

      const loaded = await repo.load('nul');
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0]?.content).toBe('beforeafter');
      expect(loaded?.messages[0]?.metadata).toEqual({ note: 'm', nested: ['n'] });
      // Ни реального NUL, ни JSON-escape `\u0000` в прочитанной сессии.
      expect(JSON.stringify(loaded)).not.toContain('\\u0000');
    });

    it('appendMessage: seq = max+1, сообщение видно в load, updatedAt обновился, соседние не тронуты', async () => {
      const { repo } = await make();
      const first = { ...makeMessage('first'), seq: 1 };
      const second = { ...makeMessage('second'), seq: 2 };
      await repo.save(makeSession({
        id: 'append-target',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [first, second],
      }));

      // id/seq намеренно пустые: порт обязан назначить их сам.
      const appended = await repo.appendMessage('append-target', {
        ...makeMessage('third'),
        id: '',
        seq: 0,
      });
      expect(appended).not.toBeNull();
      expect(appended!.id).toBeTruthy();
      expect(appended!.seq).toBe(3);
      expect(appended!.origin).toBe('local');
      expect(appended!.content).toBe('third');

      const loaded = await repo.load('append-target');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
      expect(loaded!.messages[0]).toMatchObject({ id: first.id, seq: 1, content: 'first' });
      expect(loaded!.messages[1]).toMatchObject({ id: second.id, seq: 2, content: 'second' });
      expect(loaded!.messages[2]!.id).toBe(appended!.id);
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('appendMessage в несуществующую сессию → null', async () => {
      const { repo } = await make();
      expect(await repo.appendMessage('missing-session', makeMessage('orphan'))).toBeNull();
    });

    it('ADR-114: привязка к worktree сохраняется round-trip; её отсутствие читается как undefined', async () => {
      const { repo } = await make();
      const worktree = {
        worktreeId: 'wkt_contract',
        projectId: 'proj-contract',
        repoPath: 'repo',
        directory: '/workspaces/.worktrees/proj-contract/feature-x',
        branch: 'feature/x',
      };

      await repo.save(makeSession({ id: 'worktree-bound', worktree }));
      const loaded = await repo.load('worktree-bound');
      expect(loaded?.worktree).toEqual(worktree);

      // Сессия без привязки — прежнее поведение (поля нет).
      await repo.save(makeSession({ id: 'worktree-absent' }));
      const without = await repo.load('worktree-absent');
      expect(without).not.toBeNull();
      expect(without!.worktree).toBeUndefined();
    });

    it('Anthropic: подпись thinking и opaque `redacted_thinking` переживают round-trip (save/append/update)', async () => {
      const { repo } = await make();
      const signed = {
        ...makeMessage('signed'),
        seq: 1,
        role: MessageRole.ASSISTANT,
        reasoning: 'размышление',
        reasoningSignature: 'sig-abc',
        reasoningRedacted: ['opaque-1', 'opaque-2'],
      };
      await repo.save(makeSession({ id: 'reasoning-signature', messages: [signed] }));

      const loaded = await repo.load('reasoning-signature');
      expect(loaded!.messages[0]).toMatchObject({
        reasoning: 'размышление',
        reasoningSignature: 'sig-abc',
        reasoningRedacted: ['opaque-1', 'opaque-2'],
      });

      // Пустая подпись — валидное значение (RouterAI/qwen), а не «нет подписи».
      const appended = await repo.appendMessage('reasoning-signature', {
        ...makeMessage('empty-signature'),
        role: MessageRole.ASSISTANT,
        reasoning: 'r2',
        reasoningSignature: '',
        reasoningRedacted: ['opaque-3'],
      });
      expect(appended!.reasoningSignature).toBe('');

      const updated = await repo.updateMessage('reasoning-signature', {
        ...makeMessage('signed'),
        seq: 1,
        role: MessageRole.ASSISTANT,
        reasoning: 'размышление',
        reasoningSignature: 'sig-updated',
        reasoningRedacted: ['opaque-4'],
      });
      expect(updated).not.toBeNull();

      const after = await repo.load('reasoning-signature');
      expect(after!.messages[0]).toMatchObject({
        reasoningSignature: 'sig-updated',
        reasoningRedacted: ['opaque-4'],
      });
      expect(after!.messages[1]).toMatchObject({
        reasoningSignature: '',
        reasoningRedacted: ['opaque-3'],
      });
    });

    it('Anthropic: legacy-сообщение без подписи читается как undefined (без дефолтов)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'reasoning-legacy',
        messages: [{ ...makeMessage('legacy'), seq: 1, reasoning: 'old reasoning' }],
      }));

      const loaded = await repo.load('reasoning-legacy');
      expect(loaded!.messages[0]!.reasoning).toBe('old reasoning');
      expect(loaded!.messages[0]!.reasoningSignature).toBeUndefined();
      expect(loaded!.messages[0]!.reasoningRedacted).toBeUndefined();
    });

    it('updateMessage по seq: меняется только цель, id/seq/createdAt сохраняются, updatedAt сессии обновился', async () => {
      const { repo } = await make();
      const first = { ...makeMessage('first'), seq: 1, metadata: { keep: true } };
      const second = {
        ...makeMessage('second'),
        seq: 2,
        createdAt: '2024-02-02T00:00:00.000Z',
      };
      await repo.save(makeSession({
        id: 'update-target',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [first, second],
      }));

      const updated = await repo.updateMessage('update-target', {
        ...makeMessage('second-updated'),
        // Чужой id и «будущий» createdAt не должны перебить исходную запись.
        id: 'not-the-target-id',
        seq: 2,
        createdAt: '2030-01-01T00:00:00.000Z',
        role: MessageRole.ASSISTANT,
        metadata: { changed: true },
      });
      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(second.id);
      expect(updated!.seq).toBe(2);
      expect(updated!.createdAt).toBe('2024-02-02T00:00:00.000Z');
      expect(updated!.role).toBe(MessageRole.ASSISTANT);
      expect(updated!.content).toBe('second-updated');

      const loaded = await repo.load('update-target');
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0]).toMatchObject({
        id: first.id,
        seq: 1,
        content: 'first',
        metadata: { keep: true },
      });
      expect(loaded!.messages[1]).toMatchObject({
        id: second.id,
        seq: 2,
        content: 'second-updated',
        metadata: { changed: true },
      });
      expect(loaded!.messages[1]!.createdAt).toBe('2024-02-02T00:00:00.000Z');
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('updateMessage несуществующего сообщения/сессии → null', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'update-missing', messages: [{ ...makeMessage('base'), seq: 1 }] }));

      expect(await repo.updateMessage('update-missing', {
        ...makeMessage('ghost'),
        id: 'ghost-id',
        seq: 99,
      })).toBeNull();
      expect(await repo.updateMessage('missing-session', makeMessage('ghost'))).toBeNull();
    });

    it('ADR-118 §5: поздняя запись черновика поверх терминального сообщения-шага игнорируется целиком', async () => {
      const { repo } = await make();
      const step = {
        ...makeMessage('финальный текст'),
        seq: 1,
        role: MessageRole.ASSISTANT,
        status: 'completed' as const,
        turnId: 'turn-1',
        stepIndex: 0,
        metadata: { stream_id: 'stream-1' },
        createdAt: '2024-02-02T00:00:00.000Z',
        parts: [makeTextPart('финальный текст')],
      };
      await repo.save(makeSession({
        id: 'stale-draft',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [step],
      }));

      // Поздняя троттлинг-запись черновика: откат в `streaming` + частичный текст.
      const returned = await repo.updateMessage('stale-draft', {
        ...step,
        status: 'streaming',
        content: 'частичный',
        parts: [makeTextPart('частичный')],
        metadata: { stream_id: 'stream-1', streaming: true },
      });
      expect(returned).not.toBeNull();
      expect(returned!.status).toBe('completed');
      expect(returned!.content).toBe('финальный текст');
      expect(returned!.parts?.map((part) => part.data)).toEqual(['финальный текст']);
      expect(returned!.metadata).toEqual({ stream_id: 'stream-1' });

      // Записи не произошло: терминальная запись и `updatedAt` сессии не тронуты.
      const loaded = await repo.load('stale-draft');
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.messages[0]).toMatchObject({
        status: 'completed',
        content: 'финальный текст',
        metadata: { stream_id: 'stream-1' },
      });
      expect(loaded!.messages[0]!.parts?.map((part) => part.data)).toEqual(['финальный текст']);
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');

      // Вариант без `status`, только с `metadata.streaming` — тоже черновик.
      const metadataOnly = await repo.updateMessage('stale-draft', {
        ...step,
        status: undefined,
        content: 'ещё один частичный',
        metadata: { stream_id: 'stream-1', streaming: true },
      });
      expect(metadataOnly!.status).toBe('completed');
      expect(metadataOnly!.content).toBe('финальный текст');

      // Норма не сломана: терминальную запись по-прежнему можно обновлять —
      // блокируется только запись черновика.
      const legit = await repo.updateMessage('stale-draft', {
        ...step,
        content: 'финальный текст (уточнён)',
        parts: [makeTextPart('финальный текст (уточнён)')],
        pinned: true,
      });
      expect(legit).not.toBeNull();
      expect(legit!.status).toBe('completed');
      expect(legit!.content).toBe('финальный текст (уточнён)');
      const afterLegit = await repo.load('stale-draft');
      expect(afterLegit!.messages[0]).toMatchObject({
        status: 'completed',
        content: 'финальный текст (уточнён)',
        pinned: true,
      });
      expect(afterLegit!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('ADR-118 §5: запись черновика в нетерминальное сообщение проходит как раньше', async () => {
      const { repo } = await make();
      const draft = {
        ...makeMessage('первый чанк'),
        seq: 1,
        role: MessageRole.ASSISTANT,
        status: 'streaming' as const,
        createdAt: '2024-02-02T00:00:00.000Z',
        parts: [makeTextPart('первый чанк')],
      };
      await repo.save(makeSession({
        id: 'live-draft',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [draft],
      }));

      const returned = await repo.updateMessage('live-draft', {
        ...draft,
        content: 'первый чанк + второй',
        parts: [makeTextPart('первый чанк + второй')],
        metadata: { streaming: true },
      });
      expect(returned).not.toBeNull();
      expect(returned!.status).toBe('streaming');
      expect(returned!.content).toBe('первый чанк + второй');

      const loaded = await repo.load('live-draft');
      expect(loaded!.messages[0]).toMatchObject({
        status: 'streaming',
        content: 'первый чанк + второй',
        metadata: { streaming: true },
      });
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('append/update: U+0000 в content/metadata не сохраняется', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'nul-write',
        messages: [{ ...makeMessage('base'), seq: 1 }],
      }));

      const appended = await repo.appendMessage('nul-write', {
        ...makeMessage('a\u0000b'),
        metadata: { note: 'm\u0000', nested: ['n\u0000'] },
      });
      expect(appended).not.toBeNull();

      const updated = await repo.updateMessage('nul-write', {
        ...makeMessage('c\u0000d'),
        seq: 1,
        metadata: { note: 'u\u0000' },
      });
      expect(updated).not.toBeNull();

      const loaded = await repo.load('nul-write');
      expect(loaded!.messages).toHaveLength(2);
      expect(loaded!.messages[0]!.content).toBe('cd');
      expect(loaded!.messages[0]!.metadata).toEqual({ note: 'u' });
      expect(loaded!.messages[1]!.content).toBe('ab');
      expect(loaded!.messages[1]!.metadata).toEqual({ note: 'm', nested: ['n'] });
      // Ни реального NUL, ни JSON-escape `\u0000` в прочитанной сессии.
      expect(JSON.stringify(loaded)).not.toContain('\\u0000');
    });

    it('loadLight: метаданные без истории; отсутствующая → null', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'light',
        title: 'meta',
        messages: [makeMessage('history')],
        pendingMessages: [makeMessage('pending')],
        checkpoints: [{ id: 'cp', sessionId: 'light', messages: [makeMessage('cp-msg')], createdAt: '2024-01-01T00:00:00.000Z' }],
      }));

      const light = await repo.loadLight('light');
      expect(light).not.toBeNull();
      expect(light!.title).toBe('meta');
      expect(light!.messages).toEqual([]);
      expect(light!.pendingMessages).toEqual([]);
      expect(light!.checkpoints).toEqual([]);
      expect(await repo.loadLight('missing')).toBeNull();
    });

    it('list не теряет записи и сортирует по updatedAt desc', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'a', updatedAt: '2024-01-01T00:00:00.000Z' }));
      await repo.save(makeSession({ id: 'b', updatedAt: '2024-03-01T00:00:00.000Z' }));
      await repo.save(makeSession({ id: 'c', updatedAt: '2024-02-01T00:00:00.000Z' }));

      const list = await repo.list();
      expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    });

    it('listLight: тот же набор id и порядок, что list; сообщения вырезаны, очередь сохранена', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'a',
        title: 'alpha',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [makeMessage('history-a')],
        pendingMessages: [makeMessage('pending-a')],
        steerInbox: [makeMessage('steer-a')],
        checkpoints: [{ id: 'cp-a', sessionId: 'a', messages: [makeMessage('cp-msg')], createdAt: '2024-01-01T00:00:00.000Z' }],
      }));
      await repo.save(makeSession({
        id: 'b',
        title: 'beta',
        updatedAt: '2024-03-01T00:00:00.000Z',
        messages: [makeMessage('history-b')],
      }));
      await repo.save(makeSession({ id: 'c', updatedAt: '2024-02-01T00:00:00.000Z' }));

      const full = await repo.list();
      const light = await repo.listLight();

      // Тот же набор id в том же порядке (updatedAt DESC), что у `list`.
      expect(light.map((s) => s.id)).toEqual(full.map((s) => s.id));
      expect(light.map((s) => s.id)).toEqual(['b', 'c', 'a']);
      // Метаданные сохранены, история вырезана…
      const lightA = light.find((s) => s.id === 'a')!;
      expect(lightA.title).toBe('alpha');
      expect(lightA.messages).toEqual([]);
      expect(lightA.checkpoints).toEqual([]);
      // …а очередь — нет: recovery/автозапуску нужны in-flight и steer.
      expect(lightA.pendingMessages.map((m) => m.content)).toEqual(['pending-a']);
      expect(lightA.steerInbox?.map((m) => m.content)).toEqual(['steer-a']);
      for (const session of light) {
        expect(session.messages).toEqual([]);
        expect(session.checkpoints).toEqual([]);
      }
      // `list` по-прежнему отдаёт полную историю.
      expect(full.find((s) => s.id === 'a')!.messages.map((m) => m.content)).toEqual(['history-a']);
      expect(full.find((s) => s.id === 'b')!.messages.map((m) => m.content)).toEqual(['history-b']);
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

    it('mutate: правка применяется и сохраняется, возвращается сохранённый проект', async () => {
      const { repo } = await make();
      await repo.save(makeProject('p1', { name: 'before', invariants: '' }));

      const updated = await repo.mutate('p1', (project) => {
        project.name = 'after';
        project.invariants = 'rule';
        project.updatedAt = '2024-05-01T00:00:00.000Z';
      });

      expect(updated?.name).toBe('after');
      expect(updated?.invariants).toBe('rule');
      const stored = await repo.load('p1');
      expect(stored?.name).toBe('after');
      expect(stored?.invariants).toBe('rule');
    });

    it('mutate неизвестного id → null, мутатор не вызывается', async () => {
      const { repo } = await make();
      let called = false;
      const result = await repo.mutate('missing', () => {
        called = true;
      });
      expect(result).toBeNull();
      expect(called).toBe(false);
    });

    it('mutate: брошенный мутатор не сохраняет правку и пробрасывает ошибку', async () => {
      const { repo } = await make();
      await repo.save(makeProject('p1', { name: 'before', log: [] }));

      await expect(
        repo.mutate('p1', (project) => {
          project.name = 'broken';
          project.log = [{ id: 'x', text: 'x', createdAt: 't', sessionId: 's', author: 'a' }];
          throw new Error('mutator failed');
        }),
      ).rejects.toThrow('mutator failed');

      const stored = await repo.load('p1');
      expect(stored?.name).toBe('before');
      expect(stored?.log).toEqual([]);
    });

    it('mutate конкурентно: две параллельные правки не теряют друг друга (lost update)', async () => {
      const { repo } = await make();
      await repo.save(makeProject('p1', { log: [] }));

      const entry = (id: string) => ({ id, text: id, createdAt: 't', sessionId: 's', author: 'a' });
      await Promise.all([
        repo.mutate('p1', (project) => {
          project.log = [...(project.log ?? []), entry('a')];
        }),
        repo.mutate('p1', (project) => {
          project.log = [...(project.log ?? []), entry('b')];
        }),
      ]);

      const stored = await repo.load('p1');
      expect((stored?.log ?? []).map((e) => e.id).sort()).toEqual(['a', 'b']);
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

    it('defaultModel: set/get/clear пары provider+model, независимо от других секций', async () => {
      const { repo } = await make();
      expect(await repo.getDefaultModel()).toBeUndefined();

      await repo.setWorkspace('/tmp/ws');
      await repo.setDefaultAgent('assistant');
      await repo.setDefaultModel({ provider: 'openai', model: 'gpt-4o' });
      expect(await repo.getDefaultModel()).toEqual({ provider: 'openai', model: 'gpt-4o' });
      // Соседние секции не затронуты.
      expect(await repo.getWorkspace()).toBe('/tmp/ws');
      expect(await repo.getDefaultAgent()).toBe('assistant');

      await repo.setDefaultModel({ provider: 'ollama', model: 'qwen3:8b' });
      expect(await repo.getDefaultModel()).toEqual({ provider: 'ollama', model: 'qwen3:8b' });

      await repo.clearDefaultModel();
      expect(await repo.getDefaultModel()).toBeUndefined();
      expect(await repo.getWorkspace()).toBe('/tmp/ws');
      expect(await repo.getDefaultAgent()).toBe('assistant');
    });

    it('proxy: set/get/clear runtime-override (без секретов)', async () => {
      const { repo } = await make();
      expect(await repo.getProxySettings()).toBeUndefined();
      await repo.setProxySettings({ enabled: true, url: 'http://proxy:3128', noProxy: ['localhost'] });
      expect(await repo.getProxySettings()).toEqual({
        enabled: true,
        url: 'http://proxy:3128',
        noProxy: ['localhost'],
      });
      await repo.clearProxySettings();
      expect(await repo.getProxySettings()).toBeUndefined();
    });
  });
}
