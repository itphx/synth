import { describe, expect, it } from 'vitest';
import type {
  ProfileRepository,
  ProjectRepository,
  SessionMeta,
  SessionRepository,
  SettingsRepository,
} from '../ports/index.js';
import { MessageRole, ProjectRole, makeTextPart, nowISO } from '@itphx/synth-shared';
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

    it('маркер источника переноса сохраняется round-trip; его отсутствие читается как undefined', async () => {
      const { repo } = await make();

      await repo.save(makeSession({ id: 'transfer-source', sourceSessionId: 'sess-origin-42' }));
      const loaded = await repo.load('transfer-source');
      expect(loaded?.sourceSessionId).toBe('sess-origin-42');

      // Сессия без маркера — прежнее поведение (поля нет).
      await repo.save(makeSession({ id: 'transfer-no-source' }));
      const without = await repo.load('transfer-no-source');
      expect(without).not.toBeNull();
      expect(without!.sourceSessionId).toBeUndefined();
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

    it('mutateMeta: меняет метаданные, история и child-наборы не теряются', async () => {
      const { repo } = await make();
      const first = { ...makeMessage('first'), seq: 1 };
      const second = { ...makeMessage('second'), seq: 2 };
      await repo.save(makeSession({
        id: 'meta-target',
        title: 'до',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [first, second],
        checkpoints: [{ id: 'cp', sessionId: 'meta-target', messages: [makeMessage('cp-msg')], createdAt: '2024-01-01T00:00:00.000Z' }],
      }));

      const result = await repo.mutateMeta('meta-target', (meta) => {
        meta.title = 'после';
        meta.id = 'hacked-id';
        meta.settings = { ...meta.settings, model: 'test/model' };
        meta.status = { ...meta.status, blocked: 'proc-1' };
        meta.todos = [{ id: 't1', content: 'задача', status: 'pending', priority: 'low' }];
        return 'done';
      });
      expect(result.found).toBe(true);
      if (!result.found) throw new Error('ожидали found:true');
      expect(result.value).toBe('done');
      expect(result.session.title).toBe('после');
      expect(result.session.id).toBe('meta-target');

      const loaded = await repo.load('meta-target');
      expect(loaded!.id).toBe('meta-target');
      expect(loaded!.title).toBe('после');
      expect(loaded!.settings.model).toBe('test/model');
      expect(loaded!.status.blocked).toBe('proc-1');
      expect(loaded!.todos).toEqual([
        { id: 't1', content: 'задача', status: 'pending', priority: 'low' },
      ]);
      // История и чекпоинты целы (mutateMeta их не читает/не пишет).
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second']);
      expect(loaded!.checkpoints).toHaveLength(1);
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateMeta и appendMessage не затирают друг друга (в любом порядке)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'meta-append', messages: [] }));

      await repo.appendMessage('meta-append', makeMessage('first'));
      await repo.mutateMeta('meta-append', (meta) => {
        meta.title = 't1';
      });
      await repo.appendMessage('meta-append', makeMessage('second'));
      await repo.mutateMeta('meta-append', (meta) => {
        meta.title = 't2';
      });

      const loaded = await repo.load('meta-append');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second']);
      expect(loaded!.title).toBe('t2');
    });

    it('конкурентность: параллельные appendMessage и mutateMeta не теряют сообщения', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'meta-race', messages: [] }));

      const appends = Array.from({ length: 12 }, (_, index) =>
        repo.appendMessage('meta-race', makeMessage(`m${index}`)),
      );
      const metas = Array.from({ length: 12 }, (_, index) =>
        repo.mutateMeta('meta-race', (meta) => {
          meta.todos = [{ id: `t${index}`, content: `c${index}`, status: 'pending', priority: 'low' }];
        }),
      );
      await Promise.all([...appends, ...metas]);

      const loaded = await repo.load('meta-race');
      expect(loaded!.messages).toHaveLength(12);
      expect(loaded!.messages.map((m) => m.content).sort()).toEqual(
        Array.from({ length: 12 }, (_, index) => `m${index}`).sort(),
      );
    });

    it('mutateMeta: брошенный мутатор не пишет; неизвестная сессия → found:false', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'meta-throw',
        title: 'до',
        messages: [{ ...makeMessage('keep'), seq: 1 }],
      }));

      await expect(
        repo.mutateMeta('meta-throw', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const loaded = await repo.load('meta-throw');
      expect(loaded!.title).toBe('до');
      expect(loaded!.messages).toHaveLength(1);

      let called = false;
      const missing = await repo.mutateMeta('missing-session', () => {
        called = true;
        return 1;
      });
      expect(missing).toEqual({ found: false });
      expect(called).toBe(false);
    });

    it('mutateHistory({touchUpdatedAt:false}) пишет историю, но не двигает updatedAt; default — двигает', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'history-touch',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [{ ...makeMessage('first'), seq: 1, ord: 1 }],
      }));

      const kept = await repo.mutateHistory('history-touch', (session) => {
        session.messages[0]!.content = 'иное';
        session.messages[0]!.parts = [makeTextPart('иное')];
        return session.messages.length;
      }, { touchUpdatedAt: false });
      expect(kept).toEqual({ ok: true, value: 1 });

      let loaded = await repo.load('history-touch');
      // История заменена...
      expect(loaded!.messages.map((m) => m.content)).toEqual(['иное']);
      // ...а время сессии осталось прежним (служебный проход).
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');

      // По умолчанию (как и при `touchUpdatedAt:true`) — bump.
      await repo.mutateHistory('history-touch', (session) => {
        session.messages.push({ ...makeMessage('second'), seq: 0 });
        return session.messages.length;
      });
      loaded = await repo.load('history-touch');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['иное', 'second']);
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');

      // Явный `touchUpdatedAt:true` — тот же bump (фиксируем время, чтобы
      // сравнение не зависело от миллисекундного разрешения).
      await repo.mutateHistory('history-touch', (session) => {
        session.updatedAt = '2024-02-02T00:00:00.000Z';
      }, { touchUpdatedAt: false });
      await repo.mutateHistory('history-touch', (session) => {
        session.title = 't';
      }, { touchUpdatedAt: true });
      loaded = await repo.load('history-touch');
      expect(loaded!.title).toBe('t');
      expect(loaded!.updatedAt).not.toBe('2024-02-02T00:00:00.000Z');
    });

    it('mutateHistory: полная замена, seq 1..n, ord сохранён; expectMaxOrd→stale; shouldWrite:false→нет записи', async () => {
      const { repo } = await make();
      const m1 = { ...makeMessage('first'), seq: 5, ord: 10 };
      const m2 = { ...makeMessage('second'), seq: 7, ord: 11 };
      const m3 = { ...makeMessage('third'), seq: 9, ord: 12 };
      await repo.save(makeSession({ id: 'history-target', messages: [m1, m2, m3] }));

      const result = await repo.mutateHistory('history-target', (session) => {
        session.id = 'hacked-id';
        session.messages = [session.messages[0]!, session.messages[2]!];
        // `content` собирается из `parts` при чтении — правим обе формы.
        session.messages[0]!.content = 'first-updated';
        session.messages[0]!.parts = [makeTextPart('first-updated')];
        return session.messages.length;
      });
      expect(result).toEqual({ ok: true, value: 2 });

      let loaded = await repo.load('history-target');
      expect(loaded!.id).toBe('history-target');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first-updated', 'third']);
      expect(loaded!.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(loaded!.messages.map((m) => m.ord)).toEqual([10, 12]);

      // MAX(ord) = 12 > 11 → stale, мутатор не вызывается.
      let staleMutatorCalled = false;
      const stale = await repo.mutateHistory('history-target', () => {
        staleMutatorCalled = true;
        return 1;
      }, { expectMaxOrd: 11 });
      expect(stale).toEqual({ ok: false, reason: 'stale' });
      expect(staleMutatorCalled).toBe(false);

      // shouldWrite=false → мутатор выполнен, записи нет.
      const noWrite = await repo.mutateHistory('history-target', (session) => {
        session.title = 'не должно сохраниться';
        return 42;
      }, { shouldWrite: () => false });
      expect(noWrite).toEqual({ ok: true, value: 42 });
      loaded = await repo.load('history-target');
      expect(loaded!.title).toBeUndefined();
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first-updated', 'third']);

      // Неизвестная сессия.
      expect(await repo.mutateHistory('missing-session', () => 1)).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('mutateMessage: правка по id, id/seq/createdAt/ord иммутабельны; stale-черновик не воскрешает шаг', async () => {
      const { repo } = await make();
      const step = {
        ...makeMessage('финал'),
        id: 'step-id',
        seq: 1,
        ord: 7,
        role: MessageRole.ASSISTANT,
        status: 'completed' as const,
        createdAt: '2024-02-02T00:00:00.000Z',
        parts: [makeTextPart('финал')],
        metadata: { stream_id: 'stream-1' },
      };
      await repo.save(makeSession({
        id: 'message-target',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [step],
      }));

      const result = await repo.mutateMessage('message-target', 'step-id', (message) => {
        message.content = 'финал+';
        message.parts = [makeTextPart('финал+')];
        message.pinned = true;
        // Иммутабельные поля — попытка перебить (должна игнорироваться).
        message.id = 'hacked';
        message.seq = 99;
        message.createdAt = '2030-01-01T00:00:00.000Z';
        message.ord = 100;
        return 'ok';
      });
      expect(result.found).toBe(true);
      if (!result.found) throw new Error('ожидали found:true');
      expect(result.value).toBe('ok');
      expect(result.message).toMatchObject({
        id: 'step-id',
        seq: 1,
        createdAt: '2024-02-02T00:00:00.000Z',
        ord: 7,
        content: 'финал+',
        pinned: true,
        status: 'completed',
      });

      let loaded = await repo.load('message-target');
      expect(loaded!.messages[0]).toMatchObject({
        id: 'step-id',
        seq: 1,
        ord: 7,
        createdAt: '2024-02-02T00:00:00.000Z',
        content: 'финал+',
        pinned: true,
        status: 'completed',
      });
      const updatedAtAfterLegit = loaded!.updatedAt;
      expect(updatedAtAfterLegit).not.toBe('2024-01-01T00:00:00.000Z');

      // Поздняя запись черновика поверх завершённого шага — игнорируется.
      const stale = await repo.mutateMessage('message-target', 'step-id', (message) => {
        message.status = 'streaming';
        message.content = 'частичный';
        message.parts = [makeTextPart('частичный')];
        message.metadata = { stream_id: 'stream-1', streaming: true };
        return message.content;
      });
      expect(stale.found).toBe(true);
      if (stale.found) {
        expect(stale.message.status).toBe('completed');
        expect(stale.message.content).toBe('финал+');
      }
      loaded = await repo.load('message-target');
      expect(loaded!.messages[0]).toMatchObject({ status: 'completed', content: 'финал+' });
      expect(loaded!.updatedAt).toBe(updatedAtAfterLegit);

      // Неизвестное сообщение/сессия — мутатор не вызывается.
      let called = false;
      expect(await repo.mutateMessage('message-target', 'missing-message', () => {
        called = true;
        return 1;
      })).toEqual({ found: false });
      expect(await repo.mutateMessage('missing-session', 'step-id', () => {
        called = true;
        return 1;
      })).toEqual({ found: false });
      expect(called).toBe(false);
    });

    it('mutateMessage({touchUpdatedAt:false}) не двигает updatedAt, но применяет правку; свидетель цел', async () => {
      const { repo } = await make();
      const witness = { ...makeMessage('свидетель'), id: 'witness', seq: 1 };
      const marked = {
        ...makeMessage('реплика'),
        id: 'marked',
        seq: 2,
        role: MessageRole.USER,
        parts: [makeTextPart('реплика')],
      };
      await repo.save(makeSession({
        id: 'message-no-touch',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [witness, marked],
      }));

      // Служебная метка (turnId/last_error): сообщение меняется, время сессии — нет.
      const quiet = await repo.mutateMessage('message-no-touch', 'marked', (message) => {
        message.turnId = 'turn_1';
        message.metadata = { ...(message.metadata ?? {}), last_error: 'сбой' };
        return 'quiet';
      }, { touchUpdatedAt: false });
      expect(quiet.found).toBe(true);
      if (!quiet.found) throw new Error('ожидали found:true');
      expect(quiet.value).toBe('quiet');
      expect(quiet.message).toMatchObject({ id: 'marked', turnId: 'turn_1' });

      let loaded = await repo.load('message-no-touch');
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(loaded!.messages[1]).toMatchObject({
        id: 'marked',
        turnId: 'turn_1',
        metadata: { last_error: 'сбой' },
      });
      // Свидетель истории не тронут.
      expect(loaded!.messages[0]).toMatchObject({ id: 'witness', content: 'свидетель' });
      expect(loaded!.messages[0]!.turnId).toBeUndefined();

      // По умолчанию (без опции) `updatedAt` двигается — паритет обычной правки.
      const touched = await repo.mutateMessage('message-no-touch', 'marked', (message) => {
        message.pinned = true;
        return 'touched';
      });
      expect(touched.found).toBe(true);
      loaded = await repo.load('message-no-touch');
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
      expect(loaded!.messages[1]).toMatchObject({ id: 'marked', pinned: true, turnId: 'turn_1' });
      expect(loaded!.messages[0]).toMatchObject({ id: 'witness', content: 'свидетель' });
    });

    it('документирующий: save(устаревший снимок) затирает точечный append (почему save нельзя для метаданных)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'lost-update',
        messages: [{ ...makeMessage('base'), seq: 1 }],
      }));

      const snapshot = await repo.load('lost-update');
      expect(snapshot).not.toBeNull();
      await repo.appendMessage('lost-update', makeMessage('appended'));
      expect((await repo.load('lost-update'))!.messages).toHaveLength(2);

      // Полная запись снимка, прочитанного до append, возвращает историю назад —
      // ровно та гонка, ради которой введены mutateMeta/mutateHistory.
      await repo.save(snapshot!);
      expect((await repo.load('lost-update'))!.messages.map((m) => m.content)).toEqual(['base']);
    });

    it('конкурентность: 8×appendMessage + 8×mutateMeta (разные поля) — все сообщения и все изменения на месте', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'meta-fields',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [],
        pendingMessages: [{ ...makeMessage('pending-seed'), id: 'pending-seed', seq: 0 }],
      }));

      const now = nowISO();
      const mutators: Array<(meta: SessionMeta) => void> = [
        (meta) => { meta.status = { ...meta.status, blocked: 'proc-1' }; },
        (meta) => { meta.steerInbox = [{ ...makeMessage('steer'), id: 'steer-1', seq: 0 }]; },
        (meta) => { meta.todos = [{ id: 't1', content: 'задача', status: 'pending', priority: 'low' }]; },
        (meta) => { meta.settings = { ...meta.settings, model: 'test/model-1' }; },
        (meta) => {
          meta.currentStream = {
            streamId: 'stream-1',
            message: 'x',
            startedAt: now,
            cancelled: false,
            owner: 'proc-1',
          };
        },
        (meta) => { meta.retry = { streamId: 'stream-1', attempt: 1, maxRetries: 3, retryAt: now }; },
        (meta) => { meta.title = 'после гонки'; },
        (meta) => {
          meta.pendingMessages = [
            ...meta.pendingMessages,
            { ...makeMessage('pending-added'), id: 'pending-added', seq: 0 },
          ];
        },
      ];

      const appends = Array.from({ length: 8 }, (_, index) =>
        repo.appendMessage('meta-fields', makeMessage(`m${index}`)),
      );
      const metas = mutators.map((mutator) => repo.mutateMeta('meta-fields', mutator));
      await Promise.all([...appends, ...metas]);

      const loaded = await repo.load('meta-fields');
      // Все 8 append'ов на месте (ни один не затёрт мета-записью).
      expect(loaded!.messages).toHaveLength(8);
      expect(loaded!.messages.map((m) => m.content).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `m${index}`).sort(),
      );
      // Каждое мета-изменение применилось (разные поля не перетирают друг друга).
      expect(loaded!.status.blocked).toBe('proc-1');
      expect(loaded!.steerInbox).toHaveLength(1);
      expect(loaded!.steerInbox![0]!.id).toBe('steer-1');
      expect(loaded!.todos).toEqual([
        { id: 't1', content: 'задача', status: 'pending', priority: 'low' },
      ]);
      expect(loaded!.settings.model).toBe('test/model-1');
      expect(loaded!.currentStream).toMatchObject({ streamId: 'stream-1', owner: 'proc-1' });
      expect(loaded!.retry).toMatchObject({ streamId: 'stream-1', attempt: 1, maxRetries: 3 });
      expect(loaded!.title).toBe('после гонки');
      expect(loaded!.pendingMessages.map((m) => m.id).sort()).toEqual([
        'pending-added',
        'pending-seed',
      ]);
      expect(loaded!.updatedAt).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateMeta: очередь переживает правку, если её не трогать, и меняется, если мутатор её меняет', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'queues',
        pendingMessages: [
          { ...makeMessage('p1'), id: 'p1', seq: 0 },
          { ...makeMessage('p2'), id: 'p2', seq: 0 },
        ],
        steerInbox: [{ ...makeMessage('s1'), id: 's1', seq: 0 }],
      }));

      await repo.mutateMeta('queues', (meta) => {
        meta.title = 't';
      });
      let loaded = await repo.load('queues');
      expect(loaded!.pendingMessages.map((m) => m.id)).toEqual(['p1', 'p2']);
      expect(loaded!.steerInbox!.map((m) => m.id)).toEqual(['s1']);

      await repo.mutateMeta('queues', (meta) => {
        meta.pendingMessages = [meta.pendingMessages[1]!];
        meta.steerInbox = [{ ...makeMessage('s2'), id: 's2', seq: 0 }, ...(meta.steerInbox ?? [])];
      });
      loaded = await repo.load('queues');
      expect(loaded!.pendingMessages.map((m) => m.id)).toEqual(['p2']);
      expect(loaded!.steerInbox!.map((m) => m.id)).toEqual(['s2', 's1']);
    });

    it('mutateMeta({touchUpdatedAt:false}) не двигает updatedAt, но применяет правку', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'no-touch',
        title: 'до',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));

      const result = await repo.mutateMeta('no-touch', (meta) => {
        meta.title = 'после';
      }, { touchUpdatedAt: false });
      expect(result.found).toBe(true);

      const loaded = await repo.load('no-touch');
      expect(loaded!.title).toBe('после');
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateMeta не может править stickyNotes (их нет в SessionMeta)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'notes-meta',
        stickyNotes: [{
          id: 'n1',
          content: 'заметка',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          disabled: false,
        }],
      }));

      await repo.mutateMeta('notes-meta', (meta) => {
        // Обход типа: поля нет в `SessionMeta` — попытка записать его должна
        // игнорироваться (в PostgreSQL это child-таблица).
        (meta as unknown as { stickyNotes?: unknown }).stickyNotes = [];
        meta.title = 't';
      });

      const loaded = await repo.load('notes-meta');
      expect(loaded!.title).toBe('t');
      expect(loaded!.stickyNotes.map((note) => note.id)).toEqual(['n1']);
    });

    it('mutateMeta: shouldWrite=false — значение мутатора возвращается, записи нет', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'meta-noop',
        title: 'до',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [
          { ...makeMessage('first'), seq: 1, ord: 1 },
          { ...makeMessage('second'), seq: 2, ord: 2 },
        ],
      }));

      // `shouldWrite` получает значение мутатора: `false` — записи нет.
      const skipped = await repo.mutateMeta('meta-noop', (meta) => {
        meta.title = 'после';
        meta.status = { ...meta.status, blocked: 'x' };
        return false;
      }, { shouldWrite: (value) => value });
      expect(skipped.found).toBe(true);
      if (skipped.found) {
        expect(skipped.value).toBe(false);
        // `session` — снимок **до** мутатора (правки наружу не утекают).
        expect(skipped.session.title).toBe('до');
        expect(skipped.session.status.blocked).toBeUndefined();
        // И не алиасится с хранилищем.
        skipped.session.title = 'взлом';
      }

      const loaded = await repo.load('meta-noop');
      expect(loaded!.title).toBe('до');
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(loaded!.status.blocked).toBeUndefined();
      // История не тронута.
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second']);

      // Явная проверка `v === true` при `false` — тоже без записи.
      const skippedTrue = await repo.mutateMeta('meta-noop', (meta) => {
        meta.title = 'ещё раз';
        return false;
      }, { shouldWrite: (value) => value === true });
      expect(skippedTrue.found).toBe(true);
      if (skippedTrue.found) {
        expect(skippedTrue.value).toBe(false);
        expect(skippedTrue.session.title).toBe('до');
      }
      expect((await repo.load('meta-noop'))!.title).toBe('до');
      expect((await repo.load('meta-noop'))!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateMeta: возвращённый session санитизирован так же, как сохранённый (NUL в jsonb)', async () => {
      const { repo } = await make();
      await repo.save(makeSession({ id: 'nul-meta' }));

      const result = await repo.mutateMeta('nul-meta', (meta) => {
        meta.settings = { ...meta.settings, systemPrompt: 'до\u0000после' };
      });
      expect(result.found).toBe(true);
      // Паритет file/memory/PG: возврат — то же, что прочитается из хранилища.
      if (result.found) expect(result.session.settings.systemPrompt).toBe('допосле');

      const loaded = await repo.load('nul-meta');
      expect(loaded!.settings.systemPrompt).toBe('допосле');
    });

    it('mutateHistory: брошенный мутатор после частичной правки — в хранилище ничего не меняется', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'history-throw',
        title: 'до',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [
          { ...makeMessage('first'), seq: 1, ord: 1 },
          { ...makeMessage('second'), seq: 2, ord: 2 },
        ],
      }));

      await expect(repo.mutateHistory('history-throw', (session) => {
        session.title = 'грязно';
        session.messages[0]!.content = 'грязно';
        session.messages[0]!.parts = [makeTextPart('грязно')];
        session.messages.pop();
        throw new Error('boom-history');
      })).rejects.toThrow('boom-history');

      const loaded = await repo.load('history-throw');
      expect(loaded!.title).toBe('до');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second']);
      expect(loaded!.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateHistory({shouldWrite:false}) не пишет, не двигает updatedAt и не нормализует seq', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'history-nowrite',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messages: [
          { ...makeMessage('first'), seq: 5, ord: 10 },
          { ...makeMessage('second'), seq: 7, ord: 11 },
        ],
      }));

      const before = await repo.load('history-nowrite');
      const result = await repo.mutateHistory('history-nowrite', (session) => {
        session.messages[0]!.content = 'иное';
        session.messages[0]!.parts = [makeTextPart('иное')];
        return session.messages.length;
      }, { shouldWrite: () => false });
      expect(result).toEqual({ ok: true, value: 2 });

      const loaded = await repo.load('history-nowrite');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['first', 'second']);
      // `seq` не нормализован: значения те же, что были в хранилище до вызова
      // (абсолютные числа зависят от реализации записи, важна неизменность).
      expect(loaded!.messages.map((m) => m.seq)).toEqual(before!.messages.map((m) => m.seq));
      expect(loaded!.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('mutateHistory выдаёт ord новым сообщениям: порядок массива, от max(ord)+1', async () => {
      const { repo } = await make();
      const first = { ...makeMessage('first'), id: 'ord-first', seq: 1, ord: 10 };
      const second = { ...makeMessage('second'), id: 'ord-second', seq: 2, ord: 11 };
      await repo.save(makeSession({ id: 'history-ord', messages: [first, second] }));

      const addedA = { ...makeMessage('added-a'), id: 'added-a', seq: 0 };
      const addedB = { ...makeMessage('added-b'), id: 'added-b', seq: 0 };
      delete (addedA as { ord?: number }).ord;
      delete (addedB as { ord?: number }).ord;

      const result = await repo.mutateHistory('history-ord', (session) => {
        session.messages.push(addedA, addedB);
        return session.messages.length;
      });
      expect(result).toEqual({ ok: true, value: 4 });

      const loaded = await repo.load('history-ord');
      expect(loaded!.messages.map((m) => m.id)).toEqual([
        'ord-first',
        'ord-second',
        'added-a',
        'added-b',
      ]);
      // Ранее выданные `ord` не перенумерованы; новые — подряд после максимума.
      expect(loaded!.messages.map((m) => m.ord)).toEqual([10, 11, 12, 13]);
      expect(loaded!.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    });

    it('mutateHistory ∥ appendMessage (20 итераций): append не теряются, seq 1..n, ord уникальны, пары tool целы', async () => {
      const { repo } = await make();
      const assistant = {
        ...makeMessage('шаг'),
        id: 'assistant-step',
        role: MessageRole.ASSISTANT,
        seq: 1,
        ord: 1,
        toolCalls: [{ id: 'call-0' }],
      };
      await repo.save(makeSession({ id: 'history-race', messages: [assistant] }));

      for (let index = 0; index < 20; index++) {
        const snapshot = await repo.load('history-race');
        const expectedMaxOrd = snapshot!.messages.reduce(
          (acc, message) => (Number.isFinite(message.ord) ? Math.max(acc, message.ord as number) : acc),
          0,
        );
        const toolMessage = {
          ...makeMessage(`result-${index}`),
          id: `tool-${index}`,
          role: MessageRole.TOOL,
          toolCallId: `call-${index + 1}`,
          seq: 0,
        };

        const [appended, mutated] = await Promise.all([
          repo.appendMessage('history-race', toolMessage),
          repo.mutateHistory('history-race', (session) => {
            session.title = `итерация ${index}`;
            return session.messages.length;
          }, { expectMaxOrd: expectedMaxOrd }),
        ]);
        expect(appended).not.toBeNull();
        // Мутатор либо успел (ok), либо увидел append и отказался (stale):
        // «потерянного» исхода нет.
        expect(mutated.ok || mutated.reason === 'stale').toBe(true);
      }

      const loaded = await repo.load('history-race');
      // 1 шаг assistant + 20 tool-сообщений: ни один append не потерян.
      expect(loaded!.messages).toHaveLength(21);
      expect(loaded!.messages.map((m) => m.seq)).toEqual(
        Array.from({ length: 21 }, (_, index) => index + 1),
      );
      const ords = loaded!.messages.map((m) => m.ord as number);
      expect(ords.every((ord) => Number.isInteger(ord))).toBe(true);
      expect(new Set(ords).size).toBe(ords.length);
      // Пары assistant(tool_calls)/tool целы: у каждого вызова результат ниже.
      const assistantIndex = loaded!.messages.findIndex((m) => m.id === 'assistant-step');
      expect(assistantIndex).toBe(0);
      const callIds = new Set(loaded!.messages.slice(assistantIndex + 1).map((m) => m.toolCallId));
      expect([...callIds].sort()).toEqual(
        Array.from({ length: 20 }, (_, index) => `call-${index + 1}`).sort(),
      );
    });

    it('mutateMessage: брошенный мутатор — записи нет', async () => {
      const { repo } = await make();
      await repo.save(makeSession({
        id: 'message-throw',
        messages: [{ ...makeMessage('keep'), id: 'keep', seq: 1, ord: 1 }],
      }));

      await expect(repo.mutateMessage('message-throw', 'keep', (message) => {
        message.content = 'грязно';
        message.parts = [makeTextPart('грязно')];
        throw new Error('boom-message');
      })).rejects.toThrow('boom-message');

      const loaded = await repo.load('message-throw');
      expect(loaded!.messages[0]!.content).toBe('keep');
    });

    it('mutateMessage: при legacy-дублях id правится ровно первая запись по (seq, created_at, id)', async () => {
      const { repo } = await make();
      const first = {
        ...makeMessage('first'),
        id: 'dup',
        seq: 0,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      const second = {
        ...makeMessage('second'),
        id: 'dup',
        seq: 0,
        createdAt: '2024-01-02T00:00:00.000Z',
      };
      await repo.save(makeSession({ id: 'dup-message', messages: [first, second] }));

      const result = await repo.mutateMessage('dup-message', 'dup', (message) => {
        message.content = 'первая-правка';
        message.parts = [makeTextPart('первая-правка')];
      });
      expect(result.found).toBe(true);

      const loaded = await repo.load('dup-message');
      expect(loaded!.messages.map((m) => m.content)).toEqual(['первая-правка', 'second']);
    });

    it('mutateMeta/mutateMessage: возвращённые объекты не алиасятся с хранилищем', async () => {
      const { repo } = await make();
      // `settings` — полный тип сессии: частичное значение сливаем с дефолтом
      // хелпера (без `any`/каста).
      const session = makeSession({
        id: 'alias',
        title: 'до',
        messages: [{ ...makeMessage('msg'), id: 'alias-msg', seq: 1, ord: 1 }],
      });
      session.settings = { ...session.settings, model: 'a/b' };
      await repo.save(session);

      const metaResult = await repo.mutateMeta('alias', (meta) => {
        meta.title = 'после';
      });
      expect(metaResult.found).toBe(true);
      if (metaResult.found) {
        metaResult.session.title = 'взлом';
        metaResult.session.settings = { ...metaResult.session.settings, model: 'взлом/модель' };
      }

      const messageResult = await repo.mutateMessage('alias', 'alias-msg', (message) => {
        message.content = 'правка';
        message.parts = [makeTextPart('правка')];
      });
      expect(messageResult.found).toBe(true);
      if (messageResult.found) messageResult.message.content = 'взлом';

      const loaded = await repo.load('alias');
      expect(loaded!.title).toBe('после');
      expect(loaded!.settings.model).toBe('a/b');
      expect(loaded!.messages[0]!.content).toBe('правка');
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

      const mine = await repo.list({ userId: 'u1' });
      expect(mine.map((p) => p.id)).toEqual(['p-member', 'p-owner']);
      const all = await repo.list();
      expect(all.map((p) => p.id)).toEqual(['p-member', 'p-foreign', 'p-owner']);
    });

    it('list(viewer) учитывает состояние доступа: author/selected/all (PROP-133)', async () => {
      const { repo } = await make();
      // Состояние «только автор».
      await repo.save(makeProject('p-author', {
        ownerId: 'owner-1',
        members: { 'owner-1': ProjectRole.OWNER },
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));
      // Состояние «только выбранным» — пользовательский грант.
      await repo.save(makeProject('p-selected', {
        ownerId: 'owner-1',
        members: { 'owner-1': ProjectRole.OWNER, u1: ProjectRole.VIEWER },
        updatedAt: '2024-02-01T00:00:00.000Z',
      }));
      // Состояние «всем пользователям».
      await repo.save(makeProject('p-all', {
        ownerId: 'owner-1',
        members: { 'owner-1': ProjectRole.OWNER },
        everyoneRole: ProjectRole.VIEWER,
        updatedAt: '2024-03-01T00:00:00.000Z',
      }));

      const visible = await repo.list({ userId: 'u1' });
      expect(visible.map((p) => p.id)).toEqual(['p-all', 'p-selected']);
      // Без аргумента — все проекты (ADMIN/LEAD и внутренние задачи).
      expect((await repo.list()).map((p) => p.id)).toEqual(['p-all', 'p-selected', 'p-author']);
    });

    it('list(viewer) учитывает грант по группе (PROP-133)', async () => {
      const { repo } = await make();
      await repo.save(makeProject('p-group', {
        ownerId: 'owner-1',
        members: { 'owner-1': ProjectRole.OWNER },
        groupMembers: { team: ProjectRole.EDITOR },
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));

      expect((await repo.list({ userId: 'u1', groups: ['team'] })).map((p) => p.id)).toEqual(['p-group']);
      // Чужая группа — доступа нет.
      expect(await repo.list({ userId: 'u1', groups: ['other'] })).toEqual([]);
      expect(await repo.list({ userId: 'u1' })).toEqual([]);
    });

    it('create: состояние доступа по умолчанию — владелец, без групп и «всем» (PROP-133)', async () => {
      const { repo } = await make();
      const project = repo.create('Демо', 'u1');
      expect(project.members).toEqual({ u1: ProjectRole.OWNER });
      expect(project.groupMembers).toBeUndefined();
      expect(project.everyoneRole).toBeUndefined();
      await repo.save(project);
      const stored = await repo.load(project.id);
      expect(stored?.members).toEqual({ u1: ProjectRole.OWNER });
      expect(stored?.groupMembers).toBeUndefined();
      expect(stored?.everyoneRole).toBeUndefined();
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

    it('permission: set/get/clear правил по умолчанию; {} ≠ «не задано»', async () => {
      const { repo } = await make();
      // Секция не задана — `undefined` (действует `config.permission.rules`).
      expect(await repo.getPermissionRules()).toBeUndefined();

      await repo.setPermissionRules({ read_file: 'allow', write_file: { '*.env': 'deny' } });
      expect(await repo.getPermissionRules()).toEqual({
        read_file: 'allow',
        write_file: { '*.env': 'deny' },
      });

      // Пустая карта — валидное значение, отличимое от «не задано».
      await repo.setPermissionRules({});
      expect(await repo.getPermissionRules()).toEqual({});

      // Замена карты целиком: прежних правил не остаётся.
      await repo.setPermissionRules({ glob: 'ask' });
      expect(await repo.getPermissionRules()).toEqual({ glob: 'ask' });

      await repo.clearPermission();
      expect(await repo.getPermissionRules()).toBeUndefined();

      // Соседние секции не затронуты.
      await repo.setWorkspace('/tmp/ws');
      await repo.setPermissionRules({ glob: 'allow' });
      await repo.clearPermission();
      expect(await repo.getWorkspace()).toBe('/tmp/ws');
    });

    it('execution: set/get/clear runtime-каталога профилей (ADR-135)', async () => {
      const { repo } = await make();
      expect(await repo.getExecution()).toBeUndefined();

      await repo.setExecution({
        defaultProfile: 'p1',
        pooling: 'project',
        profiles: { p1: { image: 'img:1' } },
      });
      expect(await repo.getExecution()).toEqual({
        defaultProfile: 'p1',
        pooling: 'project',
        profiles: { p1: { image: 'img:1' } },
      });

      await repo.clearExecution();
      expect(await repo.getExecution()).toBeUndefined();
    });
  });
}
