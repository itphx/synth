// sessionBadgeState: **единственный** источник цвета названия сессии и точки
// статуса в левом дереве (ADR-118 §1, PROP-143).
//
// Почему отдельная чистая функция, а не логика в `TreeNode`/`ProjectsTab`:
// цвет названия и точка статуса — одно состояние, которое читают сразу два
// места (строка дерева и заголовок таба). Две копии `if`-ов расходятся: так уже
// было с меткой «ждёт подтверждения» (живой стор vs DTO-счётчик). Здесь модель
// без сторов, React и API — вход только из DTO сессии + живые счётчики клиента,
// выход — тон, точка и ключ локализации для `aria-label`. Компоненты будут
// вызывать её и рендерить результат.
//
// Источники входа:
//   - `session` — сводка DTO (`GET /sessions`): `status.last_turn` (durable
//     исход последнего хода), `status.queue_stopped`, `pending_approvals`,
//     `activity`, `parent_id`, `todos`;
//   - `live`    — живые счётчики клиента (стрим хода, очередь, вопрос агента,
//     подтверждения прав из стора);
//   - `ackedAt` — локальная метка «просмотрено» (ms): до неё пользователь уже
//     видел исход, значит красить нечего.

import type { SessionData } from '@/lib/api/sessions'

/** Тон названия сессии в дереве. */
export type SessionLabelTone = 'neutral' | 'caution' | 'error' | 'success'

/**
 * Точка статуса справа от названия.
 *
 * `null` — точки нет; `streaming` — идёт ход; `stalled` — работа стоит и ждёт
 * «Продолжить»; `approval` — требуется действие человека (права/вопрос);
 * `pending` — в очереди есть сообщения.
 */
export type SessionDot = null | 'streaming' | 'stalled' | 'approval' | 'pending'

/** Вход модели: сводка DTO сессии + живые счётчики клиента. */
export interface SessionBadgeInput {
  session: Pick<
    SessionData,
    'id' | 'parent_id' | 'todos' | 'status' | 'pending_approvals' | 'activity'
  >
  /** Живое состояние клиента (сторы транспорта/очереди/подтверждений). */
  live: {
    /** Идёт ход (статус сообщения-хода `streaming`, ADR-118 §1). */
    streaming: boolean
    /** Сообщений в очереди сессии. */
    queuePending: number
    /** Обработка очереди стоит (stall) — ждём решения человека. */
    queueStalled: boolean
    /** Агент задал вопрос и ждёт ответа (`question`). */
    hasOpenQuestion: boolean
    /** Живых запросов подтверждения прав по сессии. */
    approvalRequests: number
  }
  /**
   * Локальная метка «просмотрено» (ms, `Date.now()`): исход последнего хода
   * старше неё — уже прочитан, цвет не нужен. `null`/`undefined`/`0` — не
   * просмотрено.
   */
  ackedAt?: number | null
}

/** Результат модели: что рисовать и как подписать для скринридера. */
export interface SessionBadgeState {
  /** Тон цвета названия сессии. */
  labelTone: SessionLabelTone
  /** Точка статуса (или её отсутствие). */
  dot: SessionDot
  /** Ключ локализации для `aria-label`/`title`; пустая строка — подписи нет. */
  ariaKey: string
}

/** Ключи локализации, которые отдаёт модель (`leftPanel.*`). */
const ARIA = {
  approvalNeeded: 'leftPanel.approvalNeeded',
  attentionNeeded: 'leftPanel.attentionNeeded',
  executionFailed: 'leftPanel.executionFailed',
  streaming: 'leftPanel.streaming',
  workCompleted: 'leftPanel.workCompleted',
  answerReady: 'leftPanel.answerReady',
} as const

/**
 * Есть ли незакрытые пункты todo.
 *
 * Todo считается **открытым** при статусе `pending`/`in_progress`; пустой или
 * отсутствующий список — «дел нет» (условие выполнено). `completed`/`cancelled`
 * закрыты.
 */
function hasOpenTodo(todos: SessionData['todos']): boolean {
  if (!todos || todos.length === 0) return false
  return todos.some((todo) => todo.status === 'pending' || todo.status === 'in_progress')
}

/**
 * Не просмотрен ли исход последнего хода.
 *
 * Нет метки «просмотрено» — не просмотрен. Битая/нечитаемая отметка времени
 * (`Date.parse` → `NaN`) считается просмотренной: красить по нечитаемому
 * времени хуже, чем не красить вовсе.
 */
function isUnacked(ackedAt: number | null | undefined, at: string): boolean {
  if (!ackedAt) return true
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return false
  return ackedAt < parsed
}

/**
 * Состояние бейджа сессии. Приоритет — сверху вниз, **первое совпадение**
 * выигрывает (порядок важен: действие человека важнее ошибки, ошибка важнее
 * «идёт работа», «идёт работа» важнее «завершено»).
 *
 * 1. Требуется действие — подтверждение прав → `caution` + точка `approval`.
 * 2. Требуется действие — вопрос агента → `caution` + точка `approval`.
 * 3. Работа стоит и ждёт «Продолжить» (`queue_stopped`/живой stall) →
 *    `caution` + точка `stalled`.
 * 4. Критическая ошибка последнего хода, ещё не просмотренная и работа не идёт →
 *    `error`, без точки.
 * 5. Идёт работа (`streaming`/`busy`/`retry`) → `neutral` + точка `streaming`.
 * 6. Завершено (см. ниже) → `success`, без точки.
 * 7. Очередь непуста → `neutral` + точка `pending`.
 * 8. Иначе → `neutral`, без точки, без подписи.
 *
 * Про `limit` (лимит шагов/контекста/вывода): это **не ошибка** — ход дошёл до
 * границы ограничителя, продолжить можно «Продолжить», данные не потеряны;
 * красный тон врал бы про сбой, зелёный — про завершение работы. Поэтому
 * `limit` нейтрален (как и «нет исхода»).
 *
 * Про `stopped`/`cancelled`: остановка человеком («Стоп») и отмена внешней
 * причиной (рестарт инстанса, отмена стрима) — **штатные** исходы. Красный
 * приучал бы игнорировать цвет («опять красный, ничего не сломалось»), зелёный
 * обещал бы результат, которого нет. Значит — нейтраль.
 *
 * Про дочерние сессии: `success` ставится только сессии **верхнего уровня**
 * (`parent_id` пуст). Саб-агент завершается успешно десятки раз за ход
 * родителя, и зелёный на каждой строке дерева превратил бы индикатор в шум;
 * итог работы ребёнка виден в отчёте родителя (его `last_turn`).
 */
export function sessionBadgeState(input: SessionBadgeInput): SessionBadgeState {
  const { session, live, ackedAt } = input
  // `status` у сессии из стора может отсутствовать, хотя тип DTO его требует:
  // `session.created` из пайплайна публикует частичный payload (`id`/`owner_id`/
  // `user_id`/`project_id`/`name`) и `transportStore` кладёт его в список как
  // есть — первого же рендера дерева на такой сессии хватило бы, чтобы упасть
  // (`Cannot read properties of undefined (reading 'last_turn')`). Частичная
  // сессия = «нет durable-статуса» = нейтраль; тот же приём уже применяется
  // рядом (`useNotification` читает `session.status?.queue_stopped`).
  const status = session.status ?? { blocked: null }
  const lastTurn = status.last_turn ?? null

  // «Работа идёт»: живой стрим хода или серверный статус активности. В правиле 4
  // идущей работой считается только `busy` (`retry` — ход уже оборван сбоем,
  // процессор ждёт backoff, поэтому красный тон честен); в правиле 5 `retry`
  // входит в «идёт работа» — процессор действительно работает.
  const turnRunning = live.streaming || session.activity?.type === 'busy'
  const working = turnRunning || session.activity?.type === 'retry'

  // 1. Подтверждение прав: ход человека заблокирован, нужен ответ. Два
  //    источника — живой стор и DTO-счётчик (после перезагрузки страницы живого
  //    стора нет).
  if (live.approvalRequests > 0 || (session.pending_approvals ?? 0) > 0) {
    return { labelTone: 'caution', dot: 'approval', ariaKey: ARIA.approvalNeeded }
  }

  // 2. Агент задал вопрос и ждёт ответа — то же «требуется действие».
  if (live.hasOpenQuestion) {
    return { labelTone: 'caution', dot: 'approval', ariaKey: ARIA.approvalNeeded }
  }

  // 3. Обработка очереди остановлена (Stop/stall) — ждём «Продолжить».
  if (status.queue_stopped || live.queueStalled) {
    return { labelTone: 'caution', dot: 'stalled', ariaKey: ARIA.attentionNeeded }
  }

  // 4. Критическая ошибка последнего хода: durable-запись есть, она ещё не
  //    просмотрена и работа не идёт. Точки нет — это не «что-то происходит», а
  //    «требуется вмешательство».
  if (lastTurn?.outcome === 'error' && isUnacked(ackedAt, lastTurn.at) && !turnRunning) {
    return { labelTone: 'error', dot: null, ariaKey: ARIA.executionFailed }
  }

  // 5. Идёт работа — цвет нейтральный (точка показывает процесс, не тревогу).
  if (working) {
    return { labelTone: 'neutral', dot: 'streaming', ariaKey: ARIA.streaming }
  }

  // 6. Работа завершена: ход успешен, сессия верхнего уровня, очередь и
  //    подтверждения пусты, открытых todo нет, исход ещё не просмотрен.
  //    Заголовок — «работы завершены», дело закрыто. Условия по очереди/
  //    подтверждениям/вопросу дублируют правила 1–2 и 7 — намеренно: зелёный
  //    ставится только при полной уверенности, что работы действительно нет.
  if (
    lastTurn?.outcome === 'completed' &&
    !session.parent_id &&
    !status.queue_stopped &&
    live.queuePending === 0 &&
    live.approvalRequests === 0 &&
    !live.hasOpenQuestion &&
    !hasOpenTodo(session.todos) &&
    isUnacked(ackedAt, lastTurn.at)
  ) {
    return { labelTone: 'success', dot: null, ariaKey: ARIA.workCompleted }
  }

  // 7. В очереди есть сообщения — точка «ответ ждёт обработки».
  if (live.queuePending > 0) {
    return { labelTone: 'neutral', dot: 'pending', ariaKey: ARIA.answerReady }
  }

  // 8. Обычная сессия без особенностей.
  return { labelTone: 'neutral', dot: null, ariaKey: '' }
}
