# Steering — вмешательство в ход (Spec)

> **Назначение:** «как устроено, точно и полно» — режимы отправки, контракт HTTP/WS, очередь инъекций,
> границы применения, события, формат сообщений, UI и ограничения (класс **Spec** по
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md); HTTP-контракт — [API_V2.md](./API_V2.md) §5.5.
>
> **Статус документа:** этапы 1–2 реализованы (2026-10-23) — режимы `queue`/`steer`/`interrupt`, очередь
> инъекций `steerInbox`, применение на границе шага, `interrupt` без завершения хода, селектор режима
> и маркеры в UI. Остаток — этап 3 (§9).

---

## 1. Режимы отправки

Поле `mode` необязательное; по умолчанию `queue` (прежнее поведение). Неизвестное значение
трактуется как `queue` — старые клиенты не ломаются.

| Режим | Что происходит с сообщением | Что происходит с генерацией | Что происходит с ходом |
|---|---|---|---|
| `queue` | сообщение ждёт окончания текущего хода (обычная очередь `pendingMessages`) | не трогается | не трогается |
| `steer` | попадает в контекст на ближайшей границе шага | не прерывается | продолжается |
| `interrupt` | попадает в контекст на ближайшей границе шага | обрывается (частичный ответ сохраняется) | **продолжается** (ход не завершается и не отменяется) |

Отличие от «Стоп» (`POST /api/v2/sessions/:id/abort`, [ADR-005](./arch_decisions/adr-005-json-storage.md)):

| Механизм | Эффект |
|---|---|
| `queue` | сообщение ждёт окончания хода |
| `steer` | сообщение дописывается в текущий ход, генерация не рвётся |
| `interrupt` | генерация обрывается, **ход продолжается** с новым сообщением |
| «Стоп» (`/abort`) | **завершает** ход: `stream.cancelled`, частичный ответ, остановка процессора очереди |

## 2. API

### 2.1 `POST /api/v2/sessions/:id/prompt`

Тело: `{content, messageId?, mode?, agent?, provider?, model?, metadata?}` — `mode` необязателен
(`queue` по умолчанию). Доступ — общий prefix-guard сессии, scope service-key — `sessions:prompt`.

- **Активного хода нет** (или `mode: queue`) — обычное поведение: сообщение в очередь, ответ —
  `200` + SSE-стрим хода.
- **Активный ход и `mode: steer|interrupt`** — ответ **`202`** без отдельного SSE-стрима (идёт стрим
  текущего хода):

  ```json
  { "status": "steered", "stream_id": "…", "pending_count": 1 }
  ```

  Для `interrupt` — `"status": "interrupted"`. `pending_count` — сколько сообщений сейчас в очереди
  инъекций.
- **Лимит превышен** — `429` с `{ "error": { "code": "STEER_LIMIT_EXCEEDED", "message": "…" } }`.

Активный ход определяется как «процессор очереди занят ИЛИ сессия помечена `blocked`»
(`isTurnActive` в `packages/core/src/server/routes/sessions.ts`): между фазами процессора флаг
`blocked` может быть ещё не выставлен, поэтому нужны оба признака.

### 2.2 WS `send_message`

То же поле `mode` принимает WS-сообщение `send_message` — standalone-core
(`packages/core/src/server/app/ws-events.ts`) и managed-backend
(`packages/backend/src/app/listen.ts`).

- `queue` — подтверждение `queued` приходит сразу.
- `steer`/`interrupt` — подтверждение `queued` приходит **после** приёма сообщения (иначе «queued»
  означало бы принятое, но отброшенное).
- Превышение лимита — сообщение `error` с `data.code = "STEER_LIMIT_EXCEEDED"`.

## 3. Очередь инъекций `steerInbox`

- `Session.steerInbox` — **отдельная** от `pendingMessages` очередь: `pendingMessages` — это сообщения,
  ждущие **следующего** хода, `steerInbox` — вмешательства в **текущий**.
- Порядок — FIFO; лимит — **5 инъекций на ход** (`MAX_STEER_INJECTIONS_PER_TURN`).
- Приём: `enqueueSteerMessage` (`packages/core/src/queue/processor.ts`) → `SessionManager.enqueueSteerMessage`
  (под локом сессии). Превышение лимита — не 500: публикуется `steer.dropped`, вызывающий отвечает
  `429 STEER_LIMIT_EXCEEDED`.
- Сообщение **обфусцируется до постановки в очередь** (ADR-036) — в историю попадёт плейсхолдер.
- Выборка: `SessionManager.takeSteerMessages` забирает FIFO до лимита; остаток — «лишнее» (событие
  `steer.dropped`), а не копящийся хвост.
- Персист: файловое хранилище — поле `steer_inbox` в JSON сессии; PostgreSQL — колонка `steer_inbox`
  (миграция `011_session_steer_inbox`); in-memory — пустая при клонировании.
- Применённая инъекция **персистится как обычная `user`-реплика** (автор, время, `metadata.steer`) и
  попадает в LLM-контекст штатным маппингом истории — то есть видна в ленте, в `GET /:id/messages` и
  в следующих ходах.

## 4. Границы применения

- Единственное место применения — **начало итерации цикла Tool Use** (там же, где проверяется
  отмена хода): результаты инструментов предыдущей итерации уже дописаны в контекст, поэтому пары
  `toolUse`/`toolResult` **не рвутся**.
- Внутрь шага инъекция не попадает: посреди выполнения инструмента, ожидания подтверждения прав
  (`ask`) или долгого shell-вызова сообщение просто ждёт следующей границы.
- `interrupt`, запрошенный **во время шага** (инструмент выполняется, генерации нет): обрывать нечего,
  поэтому публикуется `stream.interrupted` с `reason: "boundary"`, а сообщение вплетается как при
  `steer`.
- Выполняющийся инструмент **не прерывается**: необратимые операции (shell, commit) не бросаются
  на полпути.

## 5. События

| Событие | Когда | Данные |
|---|---|---|
| `message.injected` | инъекция применена на границе шага | `stream_id`, `message_index` (позиция в истории), `message_id`, `content`, `author`, `agent_role`, `metadata` |
| `steer.dropped` | сообщение отброшено по лимиту инъекций | `reason: "limit"`, `code: "STEER_LIMIT_EXCEEDED"`, `limit`, `pending_count`/`dropped_count`, `error`, `i18n` |
| `stream.interrupted` | генерация прервана (`interrupt`) | `stream_id`, `content` (частичный), `status: "interrupted"`, `reason: "generation"`\|`"boundary"`, `model`, `provider`, `iteration`, `usage`, `duration_ms` |

**Почему не `stream.cancelled`.** `stream.cancelled` — событие «Стоп» (ADR-005): ход отменён, процессор
остановлен, клиент должен закрыть стрим. `interrupt` ход **не** отменяет — тот же `stream_id`
продолжает жить, дальше приходят `stream.chunk`/`stream.done`. Публикация `stream.cancelled`
закрыла бы стрим в UI и выглядела бы как завершение хода. Поэтому у прерывания своё событие, а
обработчик в UI (`packages/ui/src/stores/transportStore.ts`) только сбрасывает аккумулятор
(`resetStreamAccumulator`) — `finishStream`/`cancelStream` не вызываются.

События идут через общий транспорт (ADR-024, `/ws/events` + SSE-фоллбек) — новых каналов нет.

## 6. Формат сообщений (`metadata`)

| Сообщение | Маркер | Смысл |
|---|---|---|
| user (инъекция) | `metadata.steer === true` | «вмешательство в ход» |
| user (инъекция в режиме `interrupt`) | `metadata.interrupt === true` (+ `steer`) | «прерывание хода» |
| user (инъекция) | `metadata.stream_id` | id стрима хода, в который вплетена |
| assistant (прерванная генерация) | `metadata.interrupted === true` и `metadata.status === "interrupted"` | частичный ответ прерванной генерации |

Статус assistant-сообщения выводится централизованно (`resolveAssistantStatus`,
`packages/core/src/engine/orchestrator/persistence.ts`): `interrupted` — не «остановлено» и не
«ошибка». Прерванная генерация сохраняется **отдельной** репликой, итоговый ответ хода — другой
(usage прерванного сообщения в итог хода не входит, иначе двойной счёт).

## 7. UI

- Селектор режима — `packages/ui/src/components/chat/SendModeSelector.tsx`: «в очередь» (`queue`),
  «вмешаться» (`steer`), «прервать» (`interrupt`). Виден **только при активном ходе**
  (`isStreaming`): вмешиваться некуда — сообщение уходит очередью.
- Режим уходит третьим аргументом `onSend(text, agentRole?, mode?)` → `transportStore.sendMessage` →
  `POST /sessions/:id/prompt` с полем `mode`. `queue` (и отсутствие режима) в тело запроса **не
  попадает** — его отбрасывает `packages/ui/src/lib/api/sessions.ts`.
- Маркеры в ленте (`components/chat/ChatMessage.tsx`): `metadata.steer` — «вмешательство в ход»,
  `metadata.interrupt` — «прерывание хода», `metadata.status === 'interrupted'` — бейдж «Прервано».
- `message.injected` добавляет сообщение в ленту без полной перезагрузки (позиция — из
  `message_index`).
- `stream.interrupted` **не закрывает стрим**: ход продолжается тем же `stream_id`.
- i18n: `chat.steer.mode.*`, `chat.steer.marker`, `chat.steer.interruptMarker`,
  `chat.messageStats.interrupted`, движковые `steer.*` (ru/en).

## 8. Гибрид

Режим применяет **та сторона, которой принадлежит ход**:

- HTTP-промпт удалённой сессии (`remote:<id>`) пробрасывается на удалённый backend как есть (в т.ч.
  с полем `mode`) — `packages/core/src/server/routes/sessions.ts`;
- WS-путь локального core отправляет remote-сессию **без** `mode` — сообщение уходит как обычная
  очередь (`queue`);
- локальный core в чужой (удалённый) ход не вмешивается никогда.

## 9. Ограничения и остаток (этап 3)

Реализовано: режимы, очередь и лимит, граница шага, `interrupt` с отдельным событием, селектор и
маркеры в UI.

Остаток этапа 3 (в объём ADR-104 не входит):

- **Приоритеты инъекций.** Сейчас порядок строго FIFO; приоритет/срочность не задаются.
- **Поведение при `ask` и в режиме `plan`.** Инъекция ждёт границы шага (после завершения
  инструмента/подтверждения); как она влияет на ожидание подтверждения прав и на режим `plan` —
  не решено.
- **Гибрид.** Единый контракт режима для обеих сторон (в т.ч. проброс `mode` в WS-пути) не сделан.
- **Фоновые саб-агенты** ([PROP-096](./arch_decisions/prop-096-background-subagent-sessions.md)):
  steering фонового ребёнка не реализован; очередь инъекций — на сессию.
- **Authority-слой** ([PROP-108](./arch_decisions/prop-108-authority-layer.md)): инъекция не меняет
  принципала и потолок хода; пересчёт потолка при steering — вопрос Authority-слоя, а не этого ADR.

## 10. Ключевые файлы кода

| Слой | Файл | Что делает |
|---|---|---|
| shared | `packages/shared/src/types/steering.ts` | контракт режимов: `STEER_MODES`, `DEFAULT_STEER_MODE`, `MAX_STEER_INJECTIONS_PER_TURN`, ключи `metadata`, код `STEER_LIMIT_EXCEEDED` |
| shared | `packages/shared/src/types/session.ts` | поле `Session.steerInbox` |
| shared | `packages/shared/src/types/bus-events.ts` | типы событий `message.injected` / `steer.dropped` / `stream.interrupted` |
| core | `packages/core/src/queue/processor.ts` | `enqueueSteerMessage` — приём, обфускация, маркеры, публикация `steer.dropped` |
| core | `packages/core/src/sessions/manager.ts` | `enqueueSteerMessage` / `takeSteerMessages` — очередь под локом, FIFO, лимит |
| core | `packages/core/src/engine/orchestrator.ts` | `_applySteerInjections` (граница шага), `_handleInterruptedGeneration`, `interrupt(streamId)` |
| core | `packages/core/src/engine/orchestrator/persistence.ts` | `resolveAssistantStatus` — статус `interrupted` |
| core | `packages/core/src/server/routes/sessions.ts` | `POST /:id/prompt` — режим, `202`, `429` |
| core | `packages/core/src/server/app/ws-events.ts` | WS `send_message` — режим, подтверждение, ошибка лимита |
| backend | `packages/backend/src/app/listen.ts` | WS `send_message` в managed-режиме |
| ui | `packages/ui/src/components/chat/SendModeSelector.tsx` | селектор режима отправки |
| ui | `packages/ui/src/components/chat/ChatMessage.tsx` | маркеры «вмешательство в ход» / «прерывание хода» / «Прервано» |
| ui | `packages/ui/src/stores/transportStore.ts` | обработка `message.injected` и `stream.interrupted` (стрим не закрывается) |
| ui | `packages/ui/src/lib/api/sessions.ts` | отправка `mode` в тело запроса (`queue` отбрасывается) |

## История

- 2026-10-23 — документ создан при переводе предложения PROP-098 в решение [ADR-104](./arch_decisions/adr-104-mid-turn-steering.md).
