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
//   - `ackedTurnKey` — локальная метка «просмотрено»: ключ **увиденного**
//     исхода последнего хода (`turnKey`, формат `"<outcome>|<at>"`). Ключ
//     совпал — человек этот исход уже видел, красить нечего.

import type { SessionData } from '@/lib/api/sessions'

/** Тон названия сессии в дереве. */
export type SessionLabelTone = 'neutral' | 'caution' | 'error' | 'success'

/**
 * Точка статуса справа от названия.
 *
 * - `null` — точки нет;
 * - `busy-live` — работа идёт и это **подтверждено** живым ходом (мигает);
 * - `busy` — сервер сообщает о работе (`activity: busy`/`retry`), но живого
 *   подтверждения нет: точка информационная и **не** мигает;
 * - `attention` — работа стоит и ждёт «Продолжить» (статичная, без мигания);
 * - `approval` — требуется действие человека (права/вопрос) — единственная
 *   мигающая точка «требуется действие»;
 * - `pending` — в очереди есть сообщения (статичная).
 *
 * Правило: мигание — **только** по живому подтверждению (ADR-118 §1).
 * `activity: busy` в DTO при мёртвом/зависшем ходе не имеет конца: события хода
 * не приходят, а серверный признак не меняется — мигание в этом случае
 * превращалось в «вечный» индикатор (репорт владельца).
 */
export type SessionDot = null | 'busy-live' | 'busy' | 'attention' | 'approval' | 'pending'

/** Вход модели: сводка DTO сессии + живые счётчики клиента. */
export interface SessionBadgeInput {
  session: Pick<
    SessionData,
    'id' | 'parent_id' | 'todos' | 'status' | 'pending_approvals' | 'activity'
  >
  /** Живое состояние клиента (сторы транспорта/очереди/подтверждений). */
  live: {
    /**
     * Идёт ход — **подтверждённый**: статус сообщения-хода `streaming` **и**
     * отсутствие «тишины» больше порога (ADR-118 §1/§5). Свежесть проверяет
     * вызывающий (`ProjectsTab`: `sessionSilenceMs` ⩽ `STALE_TURN_SILENCE_MS`):
     * модель остаётся чистой функцией без часов и сторов.
     */
    streaming: boolean
    /** Сообщений в очереди сессии. */
    queuePending: number
    /**
     * Обработка очереди стоит (клиентский stall) — ждём решения человека.
     *
     * Учитывается **только вместе с непустой очередью**: флаг липкий (ставится
     * событиями и снимается отдельными событиями), без очереди он не значит
     * ничего и лишь красил бы точку вечно. Авторитетный источник — серверный
     * `status.queue_stopped`.
     */
    queueStalled: boolean
    /** Агент задал вопрос и ждёт ответа (`question`). */
    hasOpenQuestion: boolean
    /** Живых запросов подтверждения прав по сессии. */
    approvalRequests: number
  }
  /**
   * Локальная метка «просмотрено»: ключ увиденного исхода последнего хода
   * (`turnKey(last_turn)`). Совпал с текущим — исход уже прочитан, цвет не
   * нужен. `null`/`undefined` — не просмотрено.
   */
  ackedTurnKey?: string | null
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
 * Ключ исхода последнего хода — «идентичность записи» для метки «просмотрено».
 *
 * Строится только из серверных данных (`status.last_turn`):
 * `"<outcome>|<at>"`. Сравнение идёт **на равенство ключей**, а не по времени:
 * `Date.now()` клиента расходится с серверным `at` (часы, часовой пояс,
 * кэш ответа), и прежнее сравнение `ackedAt < at` давало ложные «просмотрено»
 * и «не просмотрено». Из-за этого метку нельзя было персистить: сохранённая
 * отметка времени «залипала» и могла навсегда скрыть новую ошибку.
 *
 * `outcome` входит в ключ намеренно: два разных исхода (например, `completed`
 * и `error`) с одинаковым `at` дают разные ключи.
 *
 * `null` — исхода нет (legacy-сессия, ход ни разу не завершался) либо он
 * нечитаем (нет `outcome`): отмечать нечего, красить нечего.
 */
export function turnKey(
  lastTurn: { outcome?: string | null; at?: string | null } | null | undefined,
): string | null {
  if (!lastTurn) return null
  if (typeof lastTurn.outcome !== 'string' || lastTurn.outcome === '') return null
  // `at` может отсутствовать (бэкенд старше поля) — тогда ключ уникален только
  // по исходу: следующий ход с тем же `outcome` без `at` ключ не сменит.
  const at = typeof lastTurn.at === 'string' ? lastTurn.at : ''
  return `${lastTurn.outcome}|${at}`
}

/**
 * Не просмотрен ли исход последнего хода.
 *
 * «Просмотрено» = сохранённый ключ **совпал** с ключом текущего исхода.
 * Нет метки/ключ другой (новый ход) — не просмотрено. Нечитаемый исход
 * (ключа нет) считаем просмотренным: красить по нечитаемым данным хуже, чем
 * не красить вовсе.
 */
function isUnacked(ackedTurnKey: string | null | undefined, currentTurnKey: string | null): boolean {
  if (currentTurnKey === null) return false
  return ackedTurnKey !== currentTurnKey
}

/**
 * Состояние бейджа сессии. Приоритет — сверху вниз, **первое совпадение**
 * выигрывает (порядок важен: действие человека важнее ошибки, ошибка важнее
 * «идёт работа», «идёт работа» важнее «завершено»).
 *
 * 1. Требуется действие — подтверждение прав → `caution` + точка `approval`.
 * 2. Требуется действие — вопрос агента → `caution` + точка `approval`.
 * 3. Работа стоит и ждёт «Продолжить» (серверный `queue_stopped`; клиентский
 *    stall — только вместе с непустой очередью) → `caution` + точка
 *    `attention` (статичная: это не «что-то происходит», а «нужен человек»).
 * 4. Критическая ошибка последнего хода, ещё не просмотренная и работа не идёт →
 *    `error`, без точки.
 * 5. Идёт работа → `neutral` + точка: `busy-live` (мигает), если ход подтверждён
 *    живым стримом клиента; иначе `busy` (статичная) — сервер сообщает о работе
 *    (`activity: busy`/`retry`), но подтверждения из событий нет.
 * 6. Завершено (см. ниже) → `success`, без точки.
 * 7. Очередь непуста → `neutral` + точка `pending`.
 * 8. Иначе → `neutral`, без точки, без подписи.
 *
 * Мигание — признак **живой** работы. Только живой стрим хода (`live.streaming`,
 * с проверкой свежести на стороне панели: тишина больше `STALE_TURN_SILENCE_MS`
 * — ход не подтверждён) даёт `busy-live`. Серверный `activity: busy` без
 * подтверждения может «залипнуть» (ход умер, а снимок не обновился): мигать по
 * нему — значит мигать бесконечно (репорт владельца).
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
  const { session, live, ackedTurnKey } = input
  // `status` у сессии из стора может отсутствовать, хотя тип DTO его требует:
  // `session.created` из пайплайна публикует частичный payload (`id`/`owner_id`/
  // `user_id`/`project_id`/`name`) и `transportStore` кладёт его в список как
  // есть — первого же рендера дерева на такой сессии хватило бы, чтобы упасть
  // (`Cannot read properties of undefined (reading 'last_turn')`). Частичная
  // сессия = «нет durable-статуса» = нейтраль; тот же приём уже применяется
  // рядом (`useNotification` читает `session.status?.queue_stopped`).
  const status = session.status ?? { blocked: null }
  const lastTurn = status.last_turn ?? null
  // Ключ текущего исхода: сравнивается с локальной меткой «просмотрено» на
  // равенство (см. `turnKey` — почему не сравнение по времени).
  const currentTurnKey = turnKey(lastTurn)

  // «Работа идёт»: живой стрим хода (**подтверждённая** работа) или серверный
  // статус активности (работа «по словам сервера»). В правиле 4 идущей работой
  // считается только `busy` (`retry` — ход уже оборван сбоем, процессор ждёт
  // backoff, поэтому красный тон честен); в правиле 5 `retry` входит в «идёт
  // работа» — процессор действительно работает.
  const liveStreaming = live.streaming
  const turnRunning = liveStreaming || session.activity?.type === 'busy'
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
  //    Источник — **серверный** `status.queue_stopped`: клиентский `queueStalled`
  //    липкий (ставится `queue.stalled`/`questionasked`, снимается отдельными
  //    событиями) и без непустой очереди давно ничего не значит — иначе он
  //    красит и моргает вечно при пустой очереди. Вместе с очередью он полезен:
  //    серверный флаг мог ещё не догнать событие.
  if (status.queue_stopped || (live.queueStalled && live.queuePending > 0)) {
    return { labelTone: 'caution', dot: 'attention', ariaKey: ARIA.attentionNeeded }
  }

  // 4. Критическая ошибка последнего хода: durable-запись есть, она ещё не
  //    просмотрена и работа не идёт. Точки нет — это не «что-то происходит», а
  //    «требуется вмешательство».
  if (lastTurn?.outcome === 'error' && isUnacked(ackedTurnKey, currentTurnKey) && !turnRunning) {
    return { labelTone: 'error', dot: null, ariaKey: ARIA.executionFailed }
  }

  // 5. Идёт работа — цвет нейтральный (точка показывает процесс, не тревогу).
  //    Мигает только подтверждённая живым ходом работа: серверный `busy` без
  //    подтверждения даёт статичную точку (см. описание приоритетов).
  if (working) {
    return liveStreaming
      ? { labelTone: 'neutral', dot: 'busy-live', ariaKey: ARIA.streaming }
      : { labelTone: 'neutral', dot: 'busy', ariaKey: ARIA.streaming }
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
    isUnacked(ackedTurnKey, currentTurnKey)
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
