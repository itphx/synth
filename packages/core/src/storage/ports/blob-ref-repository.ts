/**
 * Порт учёта ссылок на объекты blob-хранилища (ADR-115 §«Хранение»,
 * ADR-116 §3).
 *
 * Байты вложений/артефактов/скиллов/логов лежат на томе (blob-хранилище), а
 * **учёт ссылок** — в общем хранилище: по ссылкам определяется, когда объект
 * можно удалить (ссылок не осталось → GC), и работает дедуп по содержимому
 * (content-addressed путь).
 *
 * Ссылка — тройка `(blobPath, ownerKind, ownerId)`: путь объекта + владелец
 * (сообщение, прогон пайплайна, скилл, фоновый процесс). Первичный ключ —
 * вся тройка, поэтому `add` идемпотентен.
 */

/** Вид владельца объекта blob-хранилища. */
export type BlobOwnerKind = 'message' | 'pipeline-run' | 'skill' | 'process';

/** Ссылка на объект blob-хранилища. */
export interface BlobRef {
  /** Путь объекта в blob-хранилище (например `attachments/ab/<sha256>`). */
  blobPath: string;
  /** Вид владельца. */
  ownerKind: BlobOwnerKind;
  /** Id владельца (id сообщения, прогона, скилла, процесса). */
  ownerId: string;
}

export interface BlobRefRepository {
  /**
   * Добавить ссылку. **Идемпотентно**: повторная запись той же тройки не
   * создаёт дубля (первичный ключ).
   */
  add(ref: BlobRef): Promise<void>;
  /** Снять ссылку; отсутствие ссылки ошибкой не считается. */
  remove(ref: BlobRef): Promise<void>;
  /**
   * Снять все ссылки владельца; возвращает число снятых ссылок (0 — ссылок
   * не было).
   */
  removeByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<number>;
  /** Пути объектов, на которые ссылается владелец (детерминированный порядок). */
  listByOwner(ownerKind: BlobOwnerKind, ownerId: string): Promise<string[]>;
  /** Число ссылок на объект (0 — объект можно удалять). */
  countRefs(blobPath: string): Promise<number>;
}
