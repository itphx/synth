/**
 * PROP-143: перепись причин остановки хода — UI ↔ ядро.
 *
 * ## Зачем
 *
 * Таблица `lib/stopReason.ts` решает за ленту и за плашку «Продолжить»: тон
 * блока, подпись, наличие кнопки и допустимость тела конверта. Набор причин
 * задан ядром (`packages/core/src/engine/stop-reason.ts`, union `StopReason`),
 * и раньше он был скопирован **дважды** локальными `Set`-ами в `ChatMessage` и
 * `SubagentResumeBar` — новый код причины в ядре молча деградировал бы на
 * «внутренняя ошибка» в одном месте и не деградировал в другом.
 *
 * ## Что проверяем
 *
 * 1. **Перепись набора.** Ключи таблицы совпадают с union `StopReason` ядра —
 *    статическая сверка по исходнику (как `events/publish-census.test.ts` в
 *    core). Новая причина в ядре без строки таблицы (и наоборот) роняет тест.
 * 2. **Решения владельца по каждому полю.** `resumable` — только сбои прогона;
 *    `showProviderBody` — только `provider_error`; тон — по классу причины.
 * 3. **Нормализация.** Неизвестная причина — `internal` (иначе в подписи был бы
 *    сырой i18n-ключ).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STOP_REASON_TABLE, normalizeStopReason, stopReasonInfo, type StopReason } from './stopReason'

/** Корень репозитория (`<repo>/synth`): тест лежит в `packages/ui/src/lib`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
/** Исходник ядра с union'ом причин. */
const CORE_STOP_REASON = resolve(REPO_ROOT, 'packages/core/src/engine/stop-reason.ts')

/** Члены union `StopReason` из исходника ядра. */
function coreStopReasons(): string[] {
  const source = readFileSync(CORE_STOP_REASON, 'utf8')
  const start = source.indexOf('export type StopReason =')
  expect(start, 'в ядре нет объявления `export type StopReason`').toBeGreaterThan(-1)
  const end = source.indexOf(';', start)
  expect(end, 'объявление `StopReason` не завершено `;`').toBeGreaterThan(start)
  const body = source.slice(start, end)
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort()
}

describe('PROP-143: таблица причин остановки — перепись с ядром', () => {
  it('ключи таблицы совпадают с union StopReason ядра', () => {
    const ui = Object.keys(STOP_REASON_TABLE).sort()
    const core = coreStopReasons()
    expect(core.length, 'union ядра пуст — сломан парсер переписи').toBeGreaterThan(0)
    expect(ui).toEqual(core)
  })

  it('у каждой причины есть ключ локализации и допустимый тон', () => {
    for (const [reason, info] of Object.entries(STOP_REASON_TABLE)) {
      expect(info.labelKey, reason).toBe(`chat.notice.stopReason.${reason}`)
      expect(['neutral', 'warning', 'error'], reason).toContain(info.severity)
    }
  })

  it('тон по классу причины: сбой / ограничитель / решение человека', () => {
    const bySeverity = (severity: string) =>
      Object.entries(STOP_REASON_TABLE)
        .filter(([, info]) => info.severity === severity)
        .map(([reason]) => reason)
        .sort()

    expect(bySeverity('error')).toEqual(
      ['denied', 'empty', 'internal', 'orphaned', 'provider_error'].sort(),
    )
    expect(bySeverity('warning')).toEqual(
      ['context_budget', 'output_limit', 'restart', 'steps_limit'].sort(),
    )
    expect(bySeverity('neutral')).toEqual(['stopped_by_user'])
  })

  it('«Продолжить» доступно только сбоям прогона (решение владельца)', () => {
    const resumable = Object.entries(STOP_REASON_TABLE)
      .filter(([, info]) => info.resumable)
      .map(([reason]) => reason)
      .sort()
    expect(resumable).toEqual(['empty', 'internal', 'provider_error'])
  })

  it('тело конверта показывается только у provider_error', () => {
    const withBody = Object.entries(STOP_REASON_TABLE)
      .filter(([, info]) => info.showProviderBody)
      .map(([reason]) => reason)
    expect(withBody).toEqual(['provider_error'])
  })
})

describe('PROP-143: нормализация причины', () => {
  it('известная причина возвращается как есть', () => {
    for (const reason of Object.keys(STOP_REASON_TABLE) as StopReason[]) {
      expect(normalizeStopReason(reason)).toBe(reason)
    }
  })

  it('неизвестная/пустая причина деградирует на internal', () => {
    expect(normalizeStopReason('что-то новое')).toBe('internal')
    expect(normalizeStopReason('')).toBe('internal')
    expect(normalizeStopReason(undefined)).toBe('internal')
    expect(normalizeStopReason(null)).toBe('internal')
  })

  it('stopReasonInfo отдаёт строку таблицы по причине', () => {
    expect(stopReasonInfo('steps_limit').severity).toBe('warning')
    expect(stopReasonInfo('steps_limit').resumable).toBe(false)
    expect(stopReasonInfo('нет такой').labelKey).toBe('chat.notice.stopReason.internal')
  })
})
