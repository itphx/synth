// PanelSection: общие примитивы секций панели «Процессы».
//
// Вкладка «Процессы» — три среза (терминалы, фоновые процессы, саб-агенты),
// и у каждого своя шапка (заголовок + счётчик) и пустой блок. Шапка терминалов
// рисуется в `TerminalsSection`, остальные — в `ProcessesTab`, поэтому формат
// задан здесь: иначе секции разъедутся по вёрстке.

import type { ReactNode } from 'react'

import { Icon, type IconName } from '@/components/icon/Icon'

export interface PanelSectionHeaderProps {
  /** Заголовок секции («Терминалы», «Фоновые процессы», «Саб-агенты»). */
  title: string
  /** Подпись со счётчиком (уже отформатированная: «2 терминала»). */
  count: string
  /** Идентификатор секции — основа `data-testid`. */
  testId: string
  /** Действия справа от заголовка (кнопка «+» и т.п.). */
  actions?: ReactNode
}

/** Шапка секции: заголовок, счётчик и действия справа. */
export function PanelSectionHeader({ title, count, testId, actions }: PanelSectionHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="truncate" data-testid={`${testId}-title`}>
          {title}
        </span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 normal-case" data-testid={`${testId}-count`}>
          {count}
        </span>
      </span>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  )
}

export interface PanelSectionEmptyProps {
  /** Иконка вида сущности (пустой блок — крупный, с подсказкой). */
  icon: IconName
  /** Заголовок пустого состояния. */
  title: string
  /** Подсказка под заголовком. */
  hint: string
  /** Идентификатор блока — основа `data-testid`. */
  testId: string
}

/** Пустое состояние секции: иконка, заголовок, подсказка. */
export function PanelSectionEmpty({ icon, title, hint, testId }: PanelSectionEmptyProps) {
  return (
    <div
      className="rounded-lg border border-border bg-surface-inset px-3 py-8 text-center text-muted-foreground"
      data-testid={testId}
    >
      <Icon name={icon} className="mx-auto mb-2 size-8 opacity-40" />
      <p className="text-sm">{title}</p>
      <p className="mt-1 text-xs opacity-80">{hint}</p>
    </div>
  )
}
