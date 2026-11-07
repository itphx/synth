// Лимиты Markdown-полей (PROP-054).
//
// Источник истины — shared: `MARKDOWN_LIMITS` из `@itphx/synth-shared/types`
// (subpath `/types` — value-импорт из корня `@itphx/synth-shared` в UI запрещён:
// корень тянет `node:fs` в бродерный бандл; `/types` browser-safe).
//
// Значения (в **байтах**):
//   invariants      — 64 КиБ (инварианты попадают в системный промпт на каждом ходе)
//   journalEntry    — 16 КиБ
//   planDescription — 16 Киб
//   todoContent     — 4 КиБ
//
// Сервер проверяет те же лимиты в HTTP-роутах и инструментах; здесь они нужны
// UI, чтобы показать счётчик и заблокировать сохранение до запроса.

export { MARKDOWN_LIMITS } from '@itphx/synth-shared/types'
export type { MarkdownLimitKey } from '@itphx/synth-shared/types'
