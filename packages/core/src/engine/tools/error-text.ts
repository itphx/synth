/**
 * Текст ошибки из произвольного брошенного значения — для tool-слоя.
 *
 * git-слой (ADR-076) бросает не только `Error`, но и plain-объекты
 * `{ error, code }` (`ensureRepo` → `NOT_FOUND`, `resolveRepoPath` →
 * `PATH_TRAVERSAL`, `cloneRepo`/`fetchRepo` → таймауты, гонка клона →
 * `git.repo_exists`). `String(err)` от такого объекта даёт бесполезный
 * `[object Object]`, поэтому у plain-объекта берётся string-поле `error`.
 *
 * Второй фоллбек — `message`: так бросают некоторые библиотеки и обёртки
 * (`throw { message }` вместо `new Error`), и такой объект тоже не должен
 * превращаться в `[object Object]`. Порядок — `error` → `message` →
 * `String(err)`: `error` первичен, потому что его задаёт git-слой осмысленным
 * текстом, а `message` у обёртки может быть общим. Код ошибки при этом
 * остаётся у вызывающего (по нему `repoOpError` различает таймауты и
 * `git.repo_exists`).
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { error, message } = err as { error?: unknown; message?: unknown };
    if (typeof error === 'string' && error.length > 0) return error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(err);
}
