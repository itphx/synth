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
// Развёрнутый композер (`expanded`) показывает **только** поле ввода —
// остальные блоки композерной зоны скрыты (как в чате).

import type { ReactNode } from 'react'
import { DEFAULT_STEER_MODE } from '@itphx/synth-shared/types'
import type { AgentInfo } from '@/lib/api/synthApi'
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
}: SessionComposerProps) {
  const { pending, queue, sendBlocked } = controller
  // В развёрнутом виде композерной зоны видно только поле ввода.
  const zoneVisible = !expanded

  return (
    <>
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
      />
    </>
  )
}
