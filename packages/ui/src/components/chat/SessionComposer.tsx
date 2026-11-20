// Общий композер сессии (UI-1).
//
// Единый блок «панель очереди + поле ввода» для чата и будущего дока
// «Спросить агента» в терминале (UI-2). Логика — в контроллере
// (`useSessionComposer`), здесь только разметка и порядок блоков.
//
// Порядок блоков (сверху вниз) — как в чате сегодня:
//   1. плашка «отправка заблокирована» (`SendBlockedPanel`),
//   2. `banner` — баннер вызывающего (в чате: предупреждение о контексте),
//   3. панель очереди (`QueuePanel`),
//   4. `children` — блоки вызывающего между очередью и полем ввода
//      (в чате: полоса подтверждений прав и док вопросов),
//   5. поле ввода (`ChatInput`).
//
// **Вертикальный ритм задаёт контейнер, а не блоки.** Все позиции выше и
// поле ввода — элементы одного flex-столбца `gap-2` (`--spacing-2`, 8 px):
// у самих плашек вертикальных отступов (`mt-*`/`mb-*`/`my-*`) нет, только
// горизонтальные (`mx-auto w-4/5`). Поэтому любые две соседние плашки всегда
// разделены ровно одним `gap` — без удвоений и «слипаний», сколько бы блоков
// ни оказалось видно одновременно (подтверждение + вопрос, ошибка + очередь,
// «отправка заблокирована» + любой из них и т.д.).
// Верхний зазор (от ленты до первой плашки) — `pt-2` того же контейнера;
// нижний, под полем ввода, — `mb-2` у `ChatInput` (его переопределяет
// мобильная тема с учётом safe-area, `html.device-phone .chat-composer`).
// Пустых отступов ритм не рисует: невидимые позиции не рендерятся вовсе,
// а `gap` действует только между фактическими элементами.
//
// Развёрнутый композер (`expanded`) показывает **только** поле ввода —
// остальные блоки композерной зоны скрыты (как в чате).

import type { ReactNode } from 'react'
import { DEFAULT_STEER_MODE } from '@itphx/synth-shared/types'
import type { AgentInfo } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'
import { ChatInput } from './ChatInput'
import { QueuePanel } from './QueuePanel'
import { SendBlockedPanel } from './SendBlockedPanel'
import type { SessionComposerController } from './useSessionComposer'

export interface SessionComposerProps {
  /** Контроллер композера (логика отправки и очереди). */
  controller: SessionComposerController
  /** Агенты сессии — для упоминаний `@` и выбора агента. */
  agents: AgentInfo[]
  /** Идёт ли ход сессии: меняет подпись отправки и доступность «В разрыв». */
  isStreaming: boolean
  /** Развёрнут ли композер на всю высоту (тогда виден только ввод). */
  expanded?: boolean
  /** Переключить разворот композера. */
  onToggleExpand?: () => void
  /** Показывать панель очереди (в пустой сессии её нет). */
  showQueue?: boolean
  /** Баннер между плашкой «отправка заблокирована» и панелью очереди. */
  banner?: ReactNode
  /** Блоки между панелью очереди и полем ввода. */
  children?: ReactNode
  /**
   * Показывать кнопку прикрепления вложений (ADR-115).
   *
   * По умолчанию — `true` (обычный чат). Док «Спросить агента» в терминале
   * передаёт `false`: там прикрепляют не файлы, а вывод терминала (уходит
   * отдельным полем `context`).
   */
  showAttachments?: boolean
}

/** Композер сессии: очередь + ввод. */
export function SessionComposer({
  controller,
  agents,
  isStreaming,
  expanded = false,
  onToggleExpand,
  showQueue = true,
  banner,
  children,
  showAttachments = true,
}: SessionComposerProps) {
  const { pending, queue, sendBlocked } = controller
  // В развёрнутом виде композерной зоны видно только поле ввода.
  const zoneVisible = !expanded

  return (
    // Контейнер ритма композерной зоны: единственный источник вертикальных
    // расстояний между плашками и полем ввода (см. шапку файла).
    <div
      data-testid="session-composer"
      className={cn(
        'flex w-full flex-col gap-2 pt-2',
        // Развёрнутый композер занимает всю высоту области чата.
        expanded ? 'min-h-0 flex-1' : 'shrink-0',
      )}
    >
      {zoneVisible && sendBlocked && <SendBlockedPanel state={sendBlocked} />}

      {zoneVisible && banner}

      {zoneVisible && showQueue && (
        <QueuePanel
          pending={pending}
          isStalled={queue?.isStalled ?? false}
          pendingCount={queue?.pendingCount ?? 0}
          canSteer={isStreaming}
          // «Стоп» оставляет очередь в покое (автозапуска нет) — продолжить
          // обработку можно кнопкой в панели очереди.
          canResume={pending.length > 0 && !isStreaming}
          onResume={controller.handleResumeQueue}
          onClear={controller.handleClearQueue}
          onReturnAll={controller.handleReturnQueue}
          onReturnMsg={controller.handleReturnMsg}
          onSteerMsg={controller.handleSteerMsg}
          onRemoveMsg={controller.handleRemoveMsg}
          onReorder={controller.handleReorderQueue}
        />
      )}

      {zoneVisible && children}

      <ChatInput
        sessionId={controller.sessionId}
        agents={agents}
        isStreaming={isStreaming}
        onSend={controller.handleSend}
        sendMode={DEFAULT_STEER_MODE}
        onStop={controller.handleStop}
        onStopQueue={controller.handleStopAll}
        onCreateNote={controller.handleCreateNote}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        showAttachments={showAttachments}
      />
    </div>
  )
}
