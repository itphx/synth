import { describe, expect, it } from 'vitest';
import type { BlobOwnerKind, BlobRef, BlobRefRepository } from '../ports/index.js';

/**
 * Паспорт порта `BlobRefRepository` (ADR-115 §«Хранение», ADR-116 §3,
 * ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - `add` **идемпотентен** (первичный ключ — тройка
 *   `blobPath`/`ownerKind`/`ownerId`): повторная запись не создаёт дубля;
 * - `remove` снимает ровно одну ссылку; отсутствие ссылки — не ошибка;
 * - `removeByOwner` снимает все ссылки владельца и возвращает их число;
 *   чужие ссылки не трогает;
 * - `listByOwner` отдаёт пути объектов владельца (детерминированный порядок);
 * - `countRefs` считает ссылки на объект (0 — объект можно удалять).
 */
export function describeBlobRefRepository(
  name: string,
  make: () => Promise<{ repo: BlobRefRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: ссылок нет, список пуст', async () => {
      const { repo } = await make();
      expect(await repo.listByOwner('message', 'msg-1')).toEqual([]);
      expect(await repo.countRefs('attachments/ab/aa')).toBe(0);
    });

    it('add идемпотентен: повторная запись не создаёт дубля', async () => {
      const { repo } = await make();
      const ref = blobRef('attachments/ab/aa', 'message', 'msg-1');
      await repo.add(ref);
      await repo.add({ ...ref });

      expect(await repo.listByOwner('message', 'msg-1')).toEqual(['attachments/ab/aa']);
      expect(await repo.countRefs('attachments/ab/aa')).toBe(1);
    });

    it('разные владельцы дают разные ссылки на один объект', async () => {
      const { repo } = await make();
      await repo.add(blobRef('attachments/ab/aa', 'message', 'msg-1'));
      await repo.add(blobRef('attachments/ab/aa', 'process', 'proc-1'));

      expect(await repo.countRefs('attachments/ab/aa')).toBe(2);
      expect(await repo.listByOwner('message', 'msg-1')).toEqual(['attachments/ab/aa']);
      expect(await repo.listByOwner('process', 'proc-1')).toEqual(['attachments/ab/aa']);
    });

    it('remove снимает ровно одну ссылку; повтор — не ошибка', async () => {
      const { repo } = await make();
      const ref = blobRef('attachments/ab/aa', 'message', 'msg-1');
      await repo.add(ref);
      await repo.add(blobRef('attachments/ab/aa', 'process', 'proc-1'));

      await repo.remove(ref);
      expect(await repo.countRefs('attachments/ab/aa')).toBe(1);
      expect(await repo.listByOwner('message', 'msg-1')).toEqual([]);

      // Идемпотентность: снятие отсутствующей ссылки — не ошибка.
      await expect(repo.remove(ref)).resolves.toBeUndefined();
      expect(await repo.countRefs('attachments/ab/aa')).toBe(1);
    });

    it('removeByOwner снимает все ссылки владельца и считает их', async () => {
      const { repo } = await make();
      await repo.add(blobRef('attachments/ab/aa', 'message', 'msg-1'));
      await repo.add(blobRef('attachments/ac/bb', 'message', 'msg-1'));
      await repo.add(blobRef('attachments/ab/aa', 'process', 'proc-1'));

      expect(await repo.removeByOwner('message', 'msg-1')).toBe(2);
      expect(await repo.listByOwner('message', 'msg-1')).toEqual([]);
      // Чужой владелец не тронут.
      expect(await repo.listByOwner('process', 'proc-1')).toEqual(['attachments/ab/aa']);

      // Повторный вызов — 0 (ссылок владельца уже нет).
      expect(await repo.removeByOwner('message', 'msg-1')).toBe(0);
      expect(await repo.removeByOwner('message', 'msg-never')).toBe(0);
    });

    it('listByOwner отдаёт пути в детерминированном порядке', async () => {
      const { repo } = await make();
      await repo.add(blobRef('attachments/ac/bb', 'message', 'msg-1'));
      await repo.add(blobRef('attachments/ab/aa', 'message', 'msg-1'));

      expect(await repo.listByOwner('message', 'msg-1')).toEqual([
        'attachments/ab/aa',
        'attachments/ac/bb',
      ]);
    });

    it('countRefs считает ссылки всех владельцев объекта', async () => {
      const { repo } = await make();
      await repo.add(blobRef('attachments/ab/aa', 'message', 'msg-1'));
      await repo.add(blobRef('attachments/ab/aa', 'skill', 'skill-1'));
      await repo.add(blobRef('attachments/ab/aa', 'pipeline-run', 'run-1'));

      expect(await repo.countRefs('attachments/ab/aa')).toBe(3);
      expect(await repo.countRefs('attachments/zz/zz')).toBe(0);
    });
  });
}

/** Ссылка на объект blob-хранилища для контрактного прогона. */
function blobRef(blobPath: string, ownerKind: BlobOwnerKind, ownerId: string): BlobRef {
  return { blobPath, ownerKind, ownerId };
}
