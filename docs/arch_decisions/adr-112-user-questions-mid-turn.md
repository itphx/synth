# ADR-112: Вопрос пользователю посреди хода (question)

> **Статус:** ✅ Реализовано
> **Дата:** 2026-10-26
> **Связано:** [ADR-029](./adr-029-granular-permissions.md) (группы правил permission-слоя),
> [ADR-041](./adr-041-llm-error-taxonomy.md) (строки движка — через ключи `shared/i18n`),
> [ADR-096](./adr-096-storage-layer.md) (порты слоя хранения),
> [ADR-101](./adr-101-pipeline-engine.md) (HITL-гейт пайплайна — родственная пауза),
> [ADR-104](./adr-104-mid-turn-steering.md) (границы хода: что можно прервать),
> [ADR-106](./adr-106-authority-layer.md) (подтверждения как действие пользователя),
> [PROP-096](./prop-096-background-subagent-sessions.md) (фоновые прогоны — соседний блок этапа).

## Контекст

У агента не было способа **спросить пользователя и дождаться ответа**: `ask`-решения permission-слоя
блокируют ход до ответа администратора, но это про разрешение на действие, а не про уточнение
требований. На практике агент либо угадывал, либо обрывал ход фразой «нужен ваш ответ» — и
возвращался к тому же месту в следующем ходу. Отдельная потребность — HITL-пауза внутри хода: она уже
есть в движке пайплайнов (ADR-101), но в сессии её не было.

## Решение

1. **Тул `question`.** Capability `QUESTION`, группа правил `question` (`permission.rules.question`),
   саб-агентам — `deny` (вопрос задаёт человек, а не другой агент); в `plan`-режиме тул **разрешён**:
   вопрос — не мутация. Ответ модели — строка i18n-ключа `question.answered`
   («The user answered the questions: … Continue with the answers.») + сами ответы в `metadata`.
2. **`QuestionService` — запись персистентна, ожидание живёт в памяти.** Запись `QuestionRecord` лежит
   в порте `QuestionRepository` (ADR-096): файл `{dataDir}/questions.json`, в-памяти и PostgreSQL
   (таблица `questions`, миграция `021-background-runs`). Ожидание ответа — **внутри tool-loop**:
   ход стоит, пока пользователь не ответит, не отменит вопрос и не истечёт срок. **По умолчанию
   таймаута нет** (`questions.timeoutMs = 0` — вопрос ждёт ответа бесконечно); срок ожидания может
   задать сам тул `question` (`timeout`, ≥ 5 минут — не рекомендуется: ожидание обрывается).
   Отмена — по сигналу отмены хода («Стоп»: `orchestrator.cancel`
   снимает открытые вопросы сессии явно, а сигнал тула снимает тот вопрос, который он ждёт) и по ручной
   отмене пользователя. При старте `recoverOnStart` снимает все `pending`-вопросы с причиной
   `interrupted`: пережить рестарт нельзя, а запись в порте остаётся (журнал).
3. **HTTP-контур — внутри фабрики сессий.** `GET /api/v2/sessions/:id/questions` (список, фильтр
   `status`, `limit` до 200) и `POST /api/v2/sessions/:id/questions/:qid/answer|cancel` — под тем же
   prefix-guard'ом сессий (инвариант 16: проверок доступа в обработчиках нет). Вид доступа выводится
   из HTTP-метода: `GET` — чтение, `POST` — **write**: отвечает владелец сессии, `ADMIN`/`LEAD` и
   участник проекта с правом изменения содержимого (`VIEWER` не отвечает — инвариант 21). Вопрос
   чужой сессии — 404, а не 403 (факт существования не выдаётся).
4. **Ответ — свободный текст разрешён всегда** (аналог «Type your own answer» в opencode): любая
   непустая строка длиной ≤ 1000 символов валидна; значения из `options[].value` валидны тоже.
   Значение, не входящее в `options[].value`, ошибкой **не** считается. Для одиночного вопроса
   (`multiple: false`) допустимо ровно одно значение; ответ должен покрывать все заданные вопросы.
5. **События — `user_question.asked | answered | cancelled` в канале сессии.** Префикс `user_question.*`
   выбран намеренно: `question.asked` уже занят смыслом «очередь зависла». Новых транспортных каналов
   не заводим (ADR-024).
6. **Вопрос и ответ видны в истории и в журнале.** В истории сессии вопрос — обычный вызов инструмента
   (`tool_use` + `tool_result`), ответ — в содержимом `tool_result`; в записи порта — состав вопроса,
   ответы, кто ответил (`answeredBy`), время. UI: док вопроса **над композером** (`QuestionDock`) —
   варианты, «свой ответ», «Ответить»/«Отменить»; после перезагрузки док восстанавливается по
   `GET /sessions/:id/questions?status=pending`, live-обновление — по событиям `user_question.*`.

## Последствия и границы

- **Рестарт теряет ожидание.** Запись вопроса переживает рестарт, а ожидание ответа — нет: ход не
  возобновляется (как и прочие паузы tool-loop). Вопрос после рестарта помечен `interrupted`.
- **Имя `ask_user` не вводится** — тул называется `question`: `ask_user` остался бы псевдонимом второго
  порядка (такое имя уже занято в других слоях), а «спросить пользователя» — это `question` с
  ожиданием ответа, а не permission-вопрос `ask`.
- Вопрос блокирует ход: пока ответа нет, агент не делает следующий шаг. Это осознанно (иначе «вопрос»
  превратился бы в запись в лог) и означает, что ручная отмена — обязательная, а не декоративная.
- **Таймаута по умолчанию нет.** Вопрос ждёт ответа бесконечно (`questions.timeoutMs = 0`): обрыв
  ожидания «по таймеру» обрывает ход на полуслове и теряет работу агента. Срок ожидания может задать
  **тул** (`timeout`, ≥ 5 минут, максимум 24 часа) — но это осознанный выбор агента под явное
  требование пользователя («спроси и не жди дольше N минут»), поэтому в описании тула он помечен как
  нерекомендуемый.
- Ответ пользователя — обычный ввод в ходе сессии, поэтому он проходит через те же права и правила
  видимости, что и остальные реплики.

## Статус в коде

| Что | Где |
|---|---|
| Контракт записи | `shared/types/question.ts` (`QuestionRecord`/`QuestionItem`/`QuestionOption`, Zod-схемы ответа и отмены) |
| Порт и реализации | `storage/ports/question-repository.ts`; `storage/file-question-store.ts` (`{dataDir}/questions.json`), `storage/memory/questions.ts`, `packages/storage-postgres/src/ports/questions.ts` (таблица `questions`, миграция `021-background-runs`) |
| Сервис | `engine/question/service.ts` (`ask`/`answer`/`cancel`/`get`/`list`/`recoverOnStart`, `MAX_FREE_ANSWER_LENGTH`), `engine/question/types.ts` (типизированные ошибки), `engine/question/prune.ts` |
| Тул | `engine/tools/question.ts` (схема 1–5 вопросов, до 8 вариантов; опция `timeout` — срок ожидания ответа, ≥ 5 мин; ответ — i18n-ключ `question.answered`) |
| Permission-слой | `engine/permission/groups.ts` (`QUESTION_TOOLS`, группа `question`), `engine/permission/derive.ts` (`rules.question = 'deny'` для саб-агентов); capability `QUESTION` — `shared/types/tools.ts` |
| HTTP | `server/routes/sessions.ts` — `GET /:id/questions`, `POST /:id/questions/:qid/answer`, `POST /:id/questions/:qid/cancel` (503 `QUESTION_UNAVAILABLE`, 400 `VALIDATION_ERROR`, 404 `NOT_FOUND`, 409 `CONFLICT`) |
| События | `user_question.asked/answered/cancelled` в канале сессии (`shared/types/bus-events.ts`) |
| Точки сборки | `server/app/deps.ts`, `backend/app/deps.ts` (`questionService`, `recoverOnStart` при старте) |
| Конфиг | `shared/config/{types,defaults}.ts` — секция `questions` (`timeoutMs` — `0`, без таймаута по умолчанию; `retentionDays` — 14) |
| UI | `packages/ui/src/components/chat/QuestionDock.tsx` (док над композером), `packages/ui/src/stores/questionStore.ts`, диспетчер — `packages/ui/src/stores/transportStore.ts` |
| Тесты | `engine/question/service.test.ts`, `engine/tools/question.test.ts`, `packages/ui/src/components/chat/QuestionDock.test.tsx`, `packages/ui/src/stores/transportStore.questions.test.ts` |

## Открытые вопросы

- Нужен ли вопрос без ожидания («просто уведомить, продолжить сам») — сейчас любой вопрос блокирует ход.
- Не введено: выбор ответа из истории сессии (переиспользование прошлых ответов) и несколько
  одновременных вопросов в разных сессиях пользователя (док показывает первый `pending`).

## Связи

- [ADR-029](./adr-029-granular-permissions.md), [ADR-041](./adr-041-llm-error-taxonomy.md),
  [ADR-096](./adr-096-storage-layer.md), [ADR-101](./adr-101-pipeline-engine.md),
  [ADR-104](./adr-104-mid-turn-steering.md), [ADR-106](./adr-106-authority-layer.md).

## История

- 2026-10-26 — решение принято и реализовано: тул `question` (capability `QUESTION`, группа правил
  `question`, саб-агентам deny, в plan-режиме разрешён), `QuestionService` с персистентной записью и
  ожиданием в памяти, HTTP-контур вопросов в фабрике сессий, свободный ответ до 1000 символов,
  события `user_question.*`, док вопроса над композером.
- 2026-10-26 — уточнение: по умолчанию **таймаута нет** (`questions.timeoutMs = 0`, вопрос ждёт
  ответа бесконечно); срок ожидания задаёт сам тул `question` (`timeout`, ≥ 5 минут — не
  рекомендуется, ожидание обрывается).
