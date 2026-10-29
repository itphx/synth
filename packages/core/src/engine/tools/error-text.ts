/**
 * Текст ошибки из произвольного брошенного значения — для tool-слоя.
 *
 * git-слой (ADR-076) бросает не только `Error`, но и plain-объекты
 * `{ error, code }` (`ensureRepo` → `NOT_FOUND`, `resolveRepoPath` →
 * `PATH_TRAVERSAL`, `cloneRepo`/`fetchRepo` → таймауты). `String(err)` от такого
 * объекта даёт бесполезный `[object Object]`, поэтому у plain-объекта берётся
 * string-поле `error`; код ошибки при этом остаётся у вызывающего (по нему
 * `repoOpError` различает таймауты).
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const message = (err as { error?: unknown }).error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(err);
}
