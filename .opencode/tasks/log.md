# Журнал задач оркестратора

> Архив: `log.1.md` (по 2026-08-31), `log.2.md` (2026-08-31 — 2026-09-16), `log.3.md` (2026-09-17 — 2026-10-07).

## 2026-10-07 — synth-media: заведена подсистема публикаций/медиа (каркас)
- **Задача:** «Автоматизировать публикацию новостей о релизах и новых AD; настроить MCP для Telegram; отдельный каталог + приватный репозиторий в gitea с README.md и AGENTS.md; позже Max/VK/блог». В ходе обсуждения рамка расширялась до отдельного продукта, затем откатана: **synth-media — внутренняя кухня Synth** (деплой в K3s через Fleet, как синт-docs/ландинг); движок генерации контента — внешний **opencode**.
- **Тип:** design / docs / infra-заготовка
- **Исполнитель:** @orchestrator → @general (README + AGENTS.md)
- **Результат:** PASS
- **Принятые решения:**
  - Компоненты: `apps/telegram-mcp` (MCP + бот), `apps/receiver` (ядро/приёмник: HTTP+MCP, реестр источников, черновики/ревью/публикация), `apps/ui` (SPA). Контент — git (`content/`), состояние — БД receiver, секреты — вне git.
  - **opencode вступает ровно в двух точках:** генерация черновика по skill и переписывание по правкам. Всё остальное — сервисы; LLM/Gateway в сервисы не тащим.
  - **Контекст — вариант A:** opencode собирает факты локально и присылает готовый черновик; receiver хранит refs и workflow, репозитории не клонит.
  - **Шедулер:** встроенного в opencode нет (`opencode run` — headless-точка автоматизации; Warming — не расписание). Расписание — внешний `systemd timer`/`cron` → `opencode run`, агент опрашивает `GET /tasks/pending`. K8s CronJob — позже.
  - Мультиканальность: канало-нейтральный контент + подключаемые коннекторы (Telegram → Max/VK/блог).
- **Что сделано:** создан приватный репозиторий `itphx/synth-media` (gitea), склонирован как соседний каталог `synth-media/`; написаны `README.md` и `AGENTS.md` (целевой дизайн-контракт: граница ответственности, компоненты и MCP-тулы, решения, потоки, доменная модель, хранилище, деплой, дорожная карта, безопасность).
- **Коммит:** `22b6957` (synth-media, docs, 2 files, +319). В `synth/` код не менялся (typecheck/lint/test не применимы).
- **Осталось:** Фаза 1 — receiver + MCP + skill (сквозная цепочка релиза в Telegram, approve в opencode); затем Telegram gateway, UI, мультиканал, автоматизация. В `synth/AGENTS.md` правило-триггер «при релизе/новом AD → skill `media-hub`» пока не добавлялось (ждёт реализации сервиса).

## 2026-10-07 — synth-media: Фаза 1 (receiver + telegram-mcp + skill)
- **Задача:** «Запускай» — реализовать Фазу 1 подсистемы synth-media: ядро (receiver + MCP), Telegram MCP-сервис, skill `media-hub`; skills хранить в synth-media, ссылка в `.opencode/skills`; креды бота — в `synth-media/secrets`.
- **Тип:** feature / infra-заготовка
- **Исполнитель:** @orchestrator → @general ×2 (порциями: каркас+receiver; telegram-mcp+skill+wiring)
- **Результат:** PASS
- **Коммит:** `5a06587` (synth-media, 76 files, +6930) — запушен в `git.itphx.loc:itphx/synth-media`.
- **Что сделано:**
  - **Каркас:** pnpm workspaces, TS ESM strict, Hono, `@modelcontextprotocol/sdk`, zod, Vitest; `.gitignore` (`data/`, `secrets/`, `dist/`, `*.tsbuildinfo`); `content/{sources.yaml,posts,inbox,templates}`.
  - **`apps/receiver`** (ядро): домен (Project/ContextSource/Task/Idea/Draft/Revision/Review/Publication), JSON-FileStore (tmp→rename), сервисы, HTTP API (`/api`, bearer-auth, `/health`, `/tasks/pending`, draft→render→submit→review→publish, ideas), MCP stdio с 17 тулами (`project_list … idea_list`), рендер под Telegram, адаптер канала (dry-run без токена).
  - **`apps/telegram-mcp`:** MCP stdio с 6 тулами (`tg_send_message/edit/delete/get_me/inbox_list/review_notify`), бот `--bot` (long-polling `getUpdates` → `POST /api/ideas`, дедуп), receiver-клиент на fetch+bearer; `packages/telegram` расширен `getUpdates` и `replyMarkup`.
  - **Skill `skills/media-hub`:** `SKILL.md` (сценарии release/ad/idea/repost/rewrite; «текст пишет агент», публикация только после approve) + `reference/tools.md` + `reference/agents-md-snippet.md`.
  - **Связка:** симлинк `synth/.opencode/skills/media-hub → ../../../synth-media/skills/media-hub`; проектный `/mnt/data/Agent/dev/Synth/.opencode/opencode.json` с двумя MCP (`synth-media-receiver`, `synth-media-telegram`), секреты через `{env:...}`.
- **Проверки (оркестратор):** `pnpm build`/`typecheck`/`lint` — 0 ошибок; `pnpm test` — 54 passed (telegram 9, telegram-mcp 23, receiver 22). MCP-серверы и skill подхватились харнессом.
- **Осталось (Фаза 2+):** inline-кнопки ревью и обработка callback; реальный `systemd timer`/`cron` → `opencode run` + `GET /tasks/pending`; UI (`apps/ui`); Docker/Helm/`fleet.yaml` + регистрация в `synth-deploy` (K3s) + Streamable-HTTP MCP с токеном; Max/VK/блог. Правило-триггер в `synth/AGENTS.md` — сниппет готов, ждёт согласования. Секреты бота — ждём от пользователя в `synth-media/secrets/`.
- **Не закоммичено в `synth/`:** симлинк `synth/.opencode/skills/media-hub` и этот журнал (ждут решения пользователя).

## 2026-10-08 — synth-media: проверка MCP + фикс пустых env
- **Задача:** «Проверь доступность новых MCP-серверов».
- **Тип:** bug fix / verification
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Найдено:** opencode подставляет `{env:VAR}` как **пустую строку**; в конфигах receiver/telegram-mcp env читался через `??`, поэтому пустая строка не откатывалась к дефолту → `tg_inbox_list` падал с `Failed to parse URL from /api/ideas` (baseUrl = '').
- **Фикс:** helper `envOr` (пустая/whitespace-строка → fallback, иначе `trim()`), применён ко всем env-чтениям в `apps/receiver/src/config.ts` и `apps/telegram-mcp/src/config.ts`; добавлены тесты на пустые/whitespace env.
- **Коммит:** `synth-media` — «fix: пустые env-значения трактуются как отсутствие…» (запушен).
- **Верификация:** build/typecheck/lint — 0 ошибок; tests — 63 passed (telegram 9, telegram-mcp 27, receiver 27). MCP-вызовы: `project_list` → `{items:[]}`; `tg_get_me` → dry-run ok; `tg_inbox_list` → `{items:[]}` (URL-ошибки нет).
- **Грабли:** MCP-серверы спавнятся при старте сервера; после пересборки `dist` их нужно перезапустить (смена кода «на лету» не подхватывается). Перезапуск сервера opencode поднял оба MCP-сервера с новым кодом.

## 2026-10-08 — synth-media: проверка доступности MCP + фикс пустых env
- **Задача:** «Проверь доступность новых MCP-серверов».
- **Тип:** verification / bug fix
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Что сделано:**
  - **Проверка:** `synth-media-receiver.project_list` → `{items:[]}`; `synth-media-telegram.tg_get_me` → dry-run `{ok:true,dryRun:true}`; `tg_inbox_list` сначала падал (`Failed to parse URL from /api/ideas`).
  - **Причина:** opencode подставляет `{env:SYNTH_MEDIA_URL}` как **пустую строку**; в `config.ts` использовался `??`, поэтому пустая строка не откатывалась к дефолту (`baseUrl=''`). Диагностировано через `/proc/<pid>/environ` (env=`SYNTH_MEDIA_URL=`).
  - **Фикс:** helper `envOr(env,key,fallback)` (пустая/whitespace → fallback), применён ко всем env-чтениям в `apps/receiver/src/config.ts` и `apps/telegram-mcp/src/config.ts`; добавлены тесты на пустые/whitespace env.
  - **Грабли:** MCP-серверы спавнятся при старте opencode-сервера; после правки/пересборки их нужно перезапустить (env в процессы передаётся при спавне). Перезапуск сервера поднял оба сервера с новым кодом.
- **Проверки (оркестратор):** `pnpm build/typecheck/lint` — OK; `pnpm test` — **63 passed** (telegram 9, telegram-mcp 27, receiver 27). После перезапуска все три MCP-вызова зелёные; `tg_inbox_list` → `{items:[]}`.
- **Коммит:** `ba75327` (synth-media, 4 files, +165/−15) — запушен.
- **Замечание:** на `127.0.0.1:7000` остался тестовый HTTP-receiver (pid 3043547, запущен при отладке) — нужен для `tg_inbox_list`/`publish`; можно остановить.

## 2026-10-08 09:45 — Проверка бага «скиллы выключены в проекте, но включены в новой сессии» — уже исправлено (правок не требуется)

- **Задача:** разобраться, почему при выключенных в «Проекте» скиллах новая сессия показывает их включёнными.
- **Тип:** investigation (проверка существующего фикса) · **Исполнитель:** @orchestrator · **Результат:** PASS (код менять не нужно).
- **Причина на момент сообщения:** в `server/routes/skill-scope.ts` формула эффективности обходила проектный скоуп для скиллов уровня `system` (`level === 'system'`), а каталог промпта проектный скоуп не учитывал вовсе.
- **Уже закрыто на master:** коммит `7a1420e` «единая модель включения скиллов и MCP (система/проект/сессия)» + `981b3ee` (курсор тумблеров и MCP config-гейт). Единая формула — `resolveSkillAvailability` (`engine/skills/scope.ts`): `systemOn && projectOn && !sessionOff && (seed || sessionOn)`, причина с приоритетом `system → project → session`; та же функция используется в каталоге промпта (`engine/skills/catalog.ts` → `projectGate`) и в оркестраторе (`orchestrator.ts:1570` передаёт `projectEnabled`).
- **Проверка на живом dev (master, admin/debug):**
  - проект «Тестовый проект»: `enabled: []`, `defaultOn: []` → `GET /projects/:id/skills` отдаёт `enabled: false`, `reason: project` для всех 4 скиллов (ранее `true`);
  - сессия этого проекта (`GET /sessions/:id/skills`): все скиллы `enabled: false`, `reason: project`;
  - UI: в «Сессии» тумблеры скиллов выключены и заблокированы (`disabled`), в кате — «отключён · не разрешён проектом» (`sessionSettings.skills.disabledReason.project`); в проекте «Synth — демо», где скиллы разрешены, тумблеры включены — гейт работает по данным проекта.
- **Тесты:** `@itphx/synth-core` — 2385 passed; `@itphx/synth-ui` — 998 passed (в т.ч. кейс `disabledReason: 'project'` в `SessionSettingsTab.skills.test.tsx:271`).
- **Остаточное (на решение):** подпись секции «Включение/отключение на уровне сессии. Переопределяет настройки проекта.» неточна для скиллов, заблокированных проектом — сессия их включить не может (тумблер заблокирован).
- **Не сделано:** коммит (правок нет). Замечено вне задачи: незакоммиченные `.opencode/tasks/log.md` и untracked `.opencode/skills/media-hub` — из другой задачи (synth-media), не трогал.

## 2026-10-08 — synth-media: прокси для Telegram API
- **Задача:** «Telegram напрямую недоступен, ходить через прокси `http://top.itphx.loc:3128` или `socks5://top.itphx.loc:9050`; реализуй поддержку».
- **Тип:** feature
- **Исполнитель:** @orchestrator → @fixer
- **Результат:** PASS
- **Разведка:** напрямую — timeout; HTTP `:3128` — timeout с этой машины; **SOCKS5 `:9050` — работает** (`302`). Node — v26.
- **Что сделано:** `packages/telegram/src/transport.ts` — `requestJson`/`createProxyAgent`: пусто → `fetch`, `socks*` → `SocksProxyAgent`, `http(s)://` → `HttpsProxyAgent` (CONNECT). `TelegramClient` получил `proxyUrl`; проброс в receiver (`channels/telegram.ts`) и telegram-mcp (флаг `--proxy`). Env-приоритет: `TELEGRAM_PROXY_URL` → `ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` → `secrets/telegram_proxy_url`. В проектный `.opencode/opencode.json` добавлен `TELEGRAM_PROXY_URL` в env MCP-серверов.
- **Зависимости:** `socks-proxy-agent@^10.1.0`, `https-proxy-agent@^9.1.0`.
- **Проверки:** build/typecheck/lint — 0 ошибок; tests — **80 passed** (telegram 18, telegram-mcp 31, receiver 31). Ручной smoke через SOCKS с невалидным токеном: `getMe` → `{"ok":false,"error_code":401,"description":"Unauthorized"}` (сквозной проход до api.telegram.org подтверждён); без прокси — `fetch failed` (ожидаемо).
- **Коммит:** `synth-media` — «feat: поддержка прокси для Telegram API (HTTP CONNECT и SOCKS5)» (запушен).
- **Грабли:** MCP-серверы читают env при спавне — после задания `TELEGRAM_PROXY_URL` нужен перезапуск opencode-сервера. HTTP-прокси `:3128` с этой машины недоступен, CONNECT-путь вживую не проверялся (юнит-тест выбора агента есть).

### Поправка (2026-10-08): порт HTTP-прокси
- HTTP-прокси — **`http://top.itphx.loc:3129`** (не `:3128`; `:3128` даёт timeout). Проверено `curl -x http://top.itphx.loc:3129 https://api.telegram.org/` → `302`.
- Оба пути проверены вживую через наш клиент с невалидным токеном: `http://top.itphx.loc:3129` и `socks5://top.itphx.loc:9050` → `{"ok":false,"error_code":401,"description":"Unauthorized"}`.
- Подготовлены `synth-media/secrets/`: `telegram_bot_token`, `telegram_channel_id`, `telegram_owner_chat_id` (пустые, 600), `telegram_proxy_url` = `socks5://top.itphx.loc:9050`.

### Настройка Telegram (2026-10-08)
- Бот: **@synth_itphx_bot** («Synth Admin», id 8853737717). Канал: **@synth_dev** (id `-1004298066060`, «Synth AI»).
- Владелец (owner chat id) = **450316139** (личка `ramazanov_dv`) — записан в `synth-media/secrets/telegram_owner_chat_id`.
- `synth-media/secrets/telegram_channel_id` = `@synth_dev`; `telegram_proxy_url` = `socks5://top.itphx.loc:9050`.
- Проверено: `getMe` ок; `getChat` канала ок; тестовое `sendMessage` владельцу → `ok:true, message_id=3`.
- Осталось: перезапустить opencode-сервер (MCP читает secrets при спавне), затем реальная публикация в канал (после approve).

### Тестовый пост в канал (2026-10-08)
- Опубликован тестовый пост в **@synth_dev** через `TelegramClient` (SOCKS5-прокси): `ok:true`, `message_id=20`, chat `-1004298066060` («Synth AI»). Ссылка: https://t.me/synth_dev/20.
- Подтверждено: токен, прокси, права бота в канале и публикация работают. Прямой `sendMessage` (не через цепочку receiver) — сквозной сценарий draft→approve→publish ещё не проверялся.

## 2026-10-08 — synth-media: Фаза 2 (кнопки ревью) + UI
- **Задача:** «Фаза 2 + UI».
- **Тип:** feature
- **Исполнитель:** @orchestrator → @fixer (Фаза 2, герметичные тесты) + @general (UI)
- **Результат:** PASS
- **Коммиты:** `a3966e8` (fix(test): герметичные config-тесты), `b212423` (feat: Фаза 2 — inline-кнопки), `6d9e3cb` (feat(ui): SPA) — запушены.
- **Фаза 2:** `tg_review_notify` шлёт владельцу черновик с клавиатурой `✅ Опубликовать / 🔁 Переписать / 🗑 Отклонить` (`callback_data = rv:<draftId>:<action>`, ≤64 байт; без `title/preview` подтягивает черновик из receiver). Бот `--bot` обрабатывает `callback_query`: approve → review+publish(telegram)+ссылка, reject → reject, rewrite → запрос комментария (состояние в памяти, TTL 1 ч) → следующее текстовое сообщение уходит в review(rewrite). Добавлены `answerCallbackQuery`, `editMessageReplyMarkup`; receiver-client получил `getDraft/reviewDraft/publishDraft`. Ручной smoke: уведомление с кнопками ушло владельцу (`message_id=4`).
- **UI:** новый `apps/ui` (Vite + React 19 + TS, без UI-китов, hash-роутинг): черновики (доска + детали/ревизии/превью по каналам + действия render/submit/approve/rewrite/reject/publish), проекты+источники, инбокс, публикации, настройки (API/token/health). Dev-прокси `/api` → `:7000`, порт 7010, токен в `localStorage`. Скрипт `pnpm dev:ui`.
- **Герметичность тестов:** `loadConfig` получил `secretsDir` (`overrides.secretsDir` > `SYNTH_MEDIA_SECRETS_DIR` > `<repo>/secrets`); тесты используют tmp-каталог, не зависят от реального `secrets/`.
- **Проверки (оркестратор):** build/typecheck/lint — 0 ошибок; tests — **116 passed** (telegram 23, ui 6, telegram-mcp 50, receiver 37).
- **Осталось:** живые нажатия кнопок владельцем; перезапуск opencode-сервера для свежих MCP-схем/секретов; деплой (Docker/Helm/Fleet); автоматизация (таймер); правило-триггер в `synth/AGENTS.md` и коммит симлинка/журнала в `synth/`.

## 2026-10-08 — AD: нормализация нумерации + разворачивание черновиков + синтетический AD-089
- **Задача:** «Навести порядок с нумерацией, развернуть черновики в полноценные AD, создать синтетический AD; зафиксировать состояние».
- **Тип:** docs / design (ADR)
- **Исполнитель:** @orchestrator → @general ×6
- **Результат:** PASS
- **Коммит:** ветка `docs/ad-normalization-089-external-events` (в synth, без пуша).
- **Что сделано:**
  - Нормализация: D25 HTTP-прокси AD-083→**AD-088** (083 занят брендингом), D26 Gateway AD-084→**AD-087** (084 занят decision-моделями); D27→AD-085, D28→AD-086, новый синтетический→**AD-089**.
  - Созданы 26 AD-файлов: AD-047…AD-067 (из D2–D22), AD-085 (мультимодальность), AD-086 (расширяемость + внешние add-on сервисы + Telegram gateway), AD-087 (tombstone, поглощён AD-086), AD-088 (HTTP-прокси), **AD-089** (синтетический: Synth как платформа внешних событий — Event/Binding/Router, `bound|ephemeral|queue`, `session.requested`, переиспользование AD-034/035 + `classify_conversation`; synth-media — двусторонний демонстратор).
  - AD-030 дополнен как фундамент (события уровня интеграций, связи 051/052/086/087/089).
  - Индексы: `docs/arch_decisions/README.md`, `synth/AGENTS.md` (+26 строк, +11 триггеров, 74 AD), `AD-DRAFTS.md` (вне git) актуализирован (карта, статусы D1–D29, коллизии 083/084).
- **Проверки:** 74 AD, дублей номеров нет, порядок возрастает (005…089), битых ссылок 0.
- **Поправки по коду при развёртывании:** AD-054 (запись `project.plan` — в core), AD-061 (prompt-injection уже реализован), AD-050 (LLM-proxy на backend).
- **Открыто:** план реализации срезов (AD-030 → роутер → gateway → синхрон synth-media), судьба `telegram-mcp` в synth-media. Продолжение — в другой сессии.

## 2026-10-08 — AD-030 (min) + ядро AD-089: HookBus + Event/Binding/Router + единый funnel создания сессии
- **Задача:** реализовать AD-030 (min) и ядро AD-089 — hook-шину событий агента, сущности Event/Binding/Router, приём внешних событий и единый funnel создания сессии.
- **Тип:** feature
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Время:** оценочно (сессия агента, без точного замера).
- **Что сделано:**
  - **HookBus** (`engine/hooks/hook-bus.ts`) — шина хуков жизненного цикла (`session_requested`, `external_event`, …), async с таймаутом (`HOOK_ASYNC_TIMEOUT_MS`), `blocked`/`reason`; эмиты из оркестратора заведены (AD-030 min).
  - **EventRouter** (`engine/events/event-router.ts`) — решение по событию + журнал: `allowedSources` → dedup → `EventBinding` (`threadKey`/`chatKey`) → `RouteRuleProvider` → `drop no_route`; все дропы аудируемые, dedup-кэш ленивый из журнала.
  - **Хранилища** (`storage/event-binding-store.ts`, `storage/event-journal-store.ts`) — привязки и журнал решений (FileStore, AD-005).
  - **RequestSessionService** (`engine/events/request-session.ts`) — единый funnel: `request` (явное создание + `session_requested`) и `handleEvent` (`external_event` → `decide` → материализация `deliver` → `record`); переведён `POST /api/v2/sessions` (внешний контракт не изменился).
  - **EventIngress** (`engine/events/ingest.ts`) — нормализация входа в `SynthEvent` (id `evt_<uuid>`, дефолтный dedup-ключ).
  - **API** — `createEventRoutes`: `POST /api/v2/events` (ingest), `GET/POST /api/v2/events/bindings`, `DELETE /api/v2/events/bindings/:id`, `GET /api/v2/events/journal?limit=` (default 50, cap 500); SSE `GET /api/v2/events` сохранён; RBAC managed — ingest `requireAuth` + rate limit, мутации привязок `requireAdmin`, чтение `requireAuth`.
  - **Конфиг** — секция `events` (`enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`).
  - **UI** — панель/представление внешних событий (bindings, журнал).
  - **Документация** — `docs/API_V2.md` (§5.26), `docs/ARCHITECTURE.md` (слой «Внешние события и хуки»), `docs/CONFIGURATION.md` (`events.*`), `docs/arch_decisions/README.md` (AD-030/089 → «Частично реализованные»).
- **Проблемы/отклонения:**
  - Режим `queue` реализован как `addPendingMessage` (defer без старта процессора).
  - `agentTemplate` → `settings.agentRole` (задел; семантика шаблона будет уточнена).
  - `fork`/`import`/`transfer`/`chat` — materialization (создание сессий сведено к funnel постепенно).
  - Источники AD-051 (шедулер), AD-052 (публичный API), AD-086 (плагины) не реализованы.
- **Проверки:** typecheck / lint / test — зелёные (по отчёту исполнителя); тесты по подсистеме — `events.test.ts`, `ingest.test.ts`, `request-session.test.ts`, `orchestrator-hooks.test.ts`.
- **Коммит:** `ed1351b` (фактический хеш; запись была с `TBD`).

## 2026-10-08 — AD-051 (минимальный срез): cron-источник событий поверх ядра AD-089
- **Задача:** «Продолжим работу над AD-089 и пререквизитами» — первый реальный источник внешних событий: cron/interval-планировщик (выбран пользователем из предложенных срезов).
- **Тип:** feature
- **Исполнитель:** @orchestrator → @fixer ×3 (A: shared+core+API; B: backend-сшивка+docs; C: UI) → верификация @orchestrator (тесты, typecheck/lint, dev-smoke, Playwright)
- **Результат:** PASS
- **Что сделано:**
  - **Идея среза:** планировщик не создаёт сессии сам — срабатывание публикует `{source:'cron', type:'schedule_fired'}` через существующий `EventIngress`, а маршрутизацию в сессию выполняет `EventRouter` через новый `RouteRuleProvider` (использован заложенный seam). Без новых npm-зависимостей — свой мини-cron.
  - **shared:** типы `Schedule`/`ScheduleTarget` (`bound`/`ephemeral`/`queue`) + Zod (`scheduleTargetSchema`/`scheduleInputSchema`/`scheduleSchema`); конфиг-секция `scheduler: { enabled, tickSec }`.
  - **core / парсеры:** `engine/scheduler/{cron,duration,schedule-time}.ts` — `nextCronDate` (5 полей, UTC, `*`/`n`/`a-b`/`a,b`/`*/n`), `parseDurationMs` (`30s|15m|1h|24h`), `nextRunAt`.
  - **core / store:** `storage/schedule-store.ts` (`{dataDir}/schedules.json`, AsyncLock, atomicWrite, path-traversal guard; `create/update/remove/markRun/setNextRun`).
  - **core / сервис:** `SchedulerRuleProvider` (cron-event + `payload.scheduleId` → `bound`/`queue`/`ephemeral`, иначе `drop schedule_not_found/schedule_disabled`); `SchedulerService` (один `setInterval`-тикер, `unref`, guard от наложения, без catch-up, идемпотентный `dedupKey = cron:<id>:<минута>`, `runNow`, `refreshNextRun`, ошибки в `lastStatus/lastError`).
  - **core / API:** `createSchedulerRoutes` — `GET/POST /api/v2/schedules`, `PUT/DELETE /:id`, `POST /:id/run`; сшивка в standalone `core/src/server/app.ts` (store, регистрация провайдера, старт по `scheduler.enabled`, `stopScheduler` на shutdown) + `main.ts`.
  - **backend:** сшивка в `packages/backend/src/app.ts` (store+провайдер+сервис+монтирование), `writeGuard = requireAdmin`, `stopScheduler` в `src/main.ts`; backend-тесты (`routes/schedules.test.ts`, 6 кейсов).
  - **UI:** рабочая вкладка «Шедулер» (`components/panels/SchedulerTab.tsx`) вместо заглушки: список (имя/триггер/цель/`nextRunAt`/`lastRunAt`/статус), форма создания/правки, toggle, «Запустить сейчас», удаление; `synthApi`-методы, i18n ru/en.
  - **docs:** `API_V2.md` (§5.27), `CONFIGURATION.md` (`scheduler.*`), статус `ad-051`, `packages/backend/AGENTS.md` (таблица монтирования/импортов).
- **Проверки (оркестратор):**
  - `pnpm --filter @itphx/synth-shared build`, `pnpm --filter @itphx/synth-core build` — OK.
  - `pnpm typecheck` — 6/6, 0 ошибок; `pnpm lint` — 0 errors (175 предсуществующих warning).
  - `pnpm test` — shared 197, core 2543, ui 1019, backend 347 — все зелёные. Новые: core +59 (cron/duration/store/scheduler/route-provider/schedules-routes), backend +6, ui +12.
  - **dev-smoke (без LLM):** `POST /schedules` (target `queue`, `every:'1h'`) → `nextRunAt` посчитан; `POST /:id/run` → журнал `/events/journal` содержит событие `cron/schedule_fired` с решением `{kind:'queue', owner, reason:'schedule'}`, в сессии `pending_count=1`. Тестовое расписание удалено.
  - **UI (Playwright, :5002, admin):** вкладка «Шедулер» — список + форма (Имя/Включено/Cron|Интервал/Цель/Сессия/Промпт); консоль 0 errors / 0 warnings (скриншот `tmp/scheduler-tab.png`). Dev остановлен, порты освобождены.
- **Отклонения/замечания:**
  - `runNow` выключенного расписания публикует событие, но провайдер дропает (`schedule_disabled`) — семантика «принудительно и выключенное» не реализована.
  - Rate limit на `POST /:id/run` в backend не навешен (у core-фабрики общий `writeGuard`); вынесено в остаток AD-051.
  - Остаток AD-051: Job-история, catch-up, пайплайны, размещение планировщика в гибриде; остаток AD-089: источники AD-052/086, Plugin SDK (AD-030).
  - **Не сделано (ожидает согласования):** правка корневого `AGENTS.md` (AD-051/089, runtime-таблица `/api/v2/schedules`, раздел «Внешние события и хуки»), статус AD-051 в `docs/arch_decisions/README.md`; правка item 4 прошлой записи (TBD → `ed1351b`) внесена.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `6c5ef7e` (код+docs+журнал; в записи было «нет»).

## 2026-10-08 — AD-051: тех.долг мульти-инстанса + системный пользователь Scheduler
- **Задача:** (1) зафиксировать в AD как тех.долг вопрос синхронизации нескольких инстансов backend (чтобы не было повторов срабатываний); (2) сообщения шедулера должны генерироваться не от имени пользователя, а от понятного агентам системного пользователя `Scheduler` с описанием (планировщик запустил плановое задание с текстом), описание — в системном контекстном файле рядом с остальными.
- **Тип:** docs (AD) + feature
- **Исполнитель:** @orchestrator (investigate, AD, AGENTS) → @fixer ×2 (реализация + косметика)
- **Результат:** PASS
- **Диагностика:** сообщение `source:'cron'` создавалось в `eventToMessage` без `author`; в сессии с `userId` оркестратор (`withAttribution`) отдавал модели `[anonymous]: <текст>`.
- **Что сделано (код):**
  - Ассеты `packages/core/prompts/system/SCHEDULER.{ru,en}.md` (шаблон `[SCHEDULER]`, плейсхолдер `{name}`) — рядом с `PARTICIPANTS_NOTICE`/`ROLES_DESCRIPTION`.
  - `ContextConfig.getSchedulerNotice(language)` (override-aware); `buildSchedulerNotice` (`engine/scheduler/notice.ts`) — язык сессии, подстановка `{name}` (fallback `scheduleId`), `trimEnd`.
  - `eventToMessage(event, { schedulerNotice })`: для `source:'cron'` → `author:'Scheduler'`, `content = notice + '\n\n' + текст`, metadata `scheduler/schedule_id/schedule_name`; прочие источники без изменений.
  - Проброс notice в обоих `deliver` (core `server/app.ts`, backend `app.ts`).
  - Тесты: +11 (config ×2, request-session ×4, notice ×5).
- **Что сделано (доки):**
  - `ad-051`: разделы «Идентичность сообщений планировщика (Scheduler)» (✅ реализовано) и «Технический долг: мульти-инстанс, синхронизация и идемпотентность» (⏳: leader election через K8s Lease/отдельный Deployment/PG advisory lock; атомарный `DedupStore.tryClaim`; межпроцессная сериализация `ScheduleStore`); актуализирован статус/«что осталось».
  - `ad-089`: cross-ref (Scheduler-сообщения; мульти-инстанс — тех.долг).
  - Корневой `AGENTS.md`: строка про планировщик дополнена автором `Scheduler`, ассетом и пометкой тех.долга.
- **Проверки:** typecheck 6/6; lint 0 errors; тесты shared 197 · core **2555** · ui 1019 · backend 347 (одиночный флейк `task-resume` при первом параллельном прогоне — повторно зелёный). Dev-smoke (без LLM): сообщение в очереди — `author="Scheduler"`, контент `[SCHEDULER]\n\nСообщение от системного пользователя «Scheduler» … «Smoke Nightly» …\n\nсобери отчёт по инцидентам`, metadata `source=cron/scheduler=true/schedule_id/schedule_name`.
- **Замечания:** в чартах `backend.replicaCount: 1`, поэтому сейчас дублей нет — тех.долг проявится при масштабировании. В dev-инстансе остаётся пользовательское расписание «Тест» (`*/5`), не трогал.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `b2fd4e0` (AD/AGENTS) + `4d8272d` (код/тесты/журнал).

## 2026-10-08 — AD-051: сообщения планировщика — Notice-рендер + системный блок (вариант A)
- **Задача:** довести отображение сообщений планировщика: не от имени пользователя, а системного `Scheduler`; центрированное оформление как у суммаризатора; описание — статический системный блок; решения пользователя: подпись «Планировщик · <имя задания>», чистый текст, все кнопки как у user, блок в сессиях с включённым расписанием.
- **Тип:** feature (core+backend+prompt+UI)
- **Исполнитель:** @orchestrator (investigate/дизайн) → @fixer ×2 (core/промпт; UI) → верификация @orchestrator (тесты, dev-smoke, Playwright)
- **Результат:** PASS
- **Диагностика:** UI-ветка выбиралась по `role:'user'` и `MessageHeader.resolveAuthor()` всегда брал текущего залогиненного → «я»; `metadata.scheduler` не использовался.
- **Что сделано:**
  - **core/контент:** `eventToMessage` для cron — `author:'Scheduler'`, `content` = чистый текст задания, metadata `scheduler/schedule_id/schedule_name`; удалён per-message notice (`EventToMessageOptions`, `engine/scheduler/notice.ts`, вызовы в deliver core/backend).
  - **prompt:** `prompts/system/SCHEDULER.{ru,en}.md` — статическое описание Scheduler (без `{name}`); `ContextConfig.getSchedulerNotice`.
  - **Composer/оркестратор:** `ComposerContext.schedulerActive`; блок `scheduler` (context, order 16, provenance `prompts/system/SCHEDULER`) при `!override && schedulerActive`; `OrchestratorOptions.isSchedulerActive` + `_resolveSchedulerActive` (scheduler-сообщение в истории ИЛИ резолвер); `ScheduleStore.hasEnabledTargetFor(sessionId)`; сшивка в core/backend.
  - **UI:** вариант `Notice 'scheduler'` (иконка `calendar-schedule`); в `ChatMessage` ветка `metadata.scheduler` → центрированный Notice с подписью «Планировщик · <имя задания>», временем, телом = текст задания и полным набором действий как у user; i18n `chat.notice.scheduler`/`schedulerNamed` ru/en.
  - **docs:** AD-051 (раздел «Идентичность сообщений планировщика») приведён к финальному дизайну; строка в корневом AGENTS.md.
- **Проверки:** typecheck 6/6; lint 0 errors; тесты shared 197 · core **2559** · ui **1024** · backend 347. Dev-smoke (dev перезапущен): новое срабатывание расписания «Тест» → сообщение `author="Scheduler"`, `content="Сколько время?"` (чисто); `GET /sessions/:id/prompt` → блок `scheduler` (context/order 16/provenance) присутствует у нацеленной сессии и отсутствует у сессии без расписания. Playwright: центрированный `group "Планировщик · Тест"` с временем и кнопками Копировать/Ветка/Включить/Закрепить/Удалить/Повторить.
- **Замечания:** резолвер `isSchedulerActive` читает `ScheduleStore` на ход (файл `schedules.json`) — при масштабировании/оптимизации закэшировать; отклонение от исходного «включённым расписанием» учтено (история-сообщение ИЛИ enabled-target). Dev оставлен запущенным (пользовательское расписание «Тест» активно).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-09 — Онбординг-интервью: поле `interviewCompleted`, условия инжекта, тул `profile_update` + volatile-пояснение хода планировщика
- **Задача:** починить логику онбординг-интервью (сейчас мёртвая, блок `[INTERVIEW]` лился в каждую сессию) и убрать противоречие «сообщение от планировщика, а в промпте профиль пользователя». Решения пользователя: отдельное поле статуса + чекбокс в настройках профиля; `[INTERVIEW]` только в первое сообщение сессии, от пользователя, при незаполненном профиле; пояснение для хода планировщика — volatile и только на его ходу; записи интервью — тулом `profile_update` (поля профиля + завершение); ephemeral-сессии планировщика остаются безликими.
- **Тип:** feature (shared+core+backend+ui)
- **Исполнитель:** @orchestrator (investigate/дизайн) → @fixer ×3 (B1: поле/условия/UI; B2: тул/шаблон; chat.ts) → верификация @orchestrator
- **Результат:** PASS
- **Диагностика:** статус интервью хранился текстовой меткой `[ИНТЕРВЬЮ]` в `ProfileData.notes`; `InterviewManager.processAnswer/completeInterview/getNextQuestion/parseQuestions` никто не вызывал, парсер ждал `## qN` при шаблоне `[Q1]` (0 вопросов); `interviewCompleted` уже был на auth-`User`, но не персистился и не читался композером; volatile-пояснения для хода планировщика не было.
- **Что сделано:**
  - **shared/storage:** `ProfileData.interviewCompleted`/`interviewCompletedAt` (+`CreateProfileParams`); `FileProfileStore` — сериализация `interview_completed`/`interview_completed_at`, legacy-backfill из `[ИНТЕРВЬЮ]`, инициализация `false`.
  - **context/composer:** `[INTERVIEW]` — только при `showInterview && interviewEligible && userId && профиль && !interviewCompleted` (убран гейт по `notes`); `interviewEligible`/`schedulerCurrentTurn` в `ComposerContext`, хелперы `_interviewEligible`/`_schedulerCurrentTurn` в оркестраторе (оба call-site); новый volatile-блок `scheduler.turn` (`SCHEDULER_TURN.{ru,en}.md`, order 40) при ходе планировщика; удалён мёртвый `InterviewManager` (оставлен `isInterviewCompleted`).
  - **тул `profile_update`:** сохранение `display_name`/`email`/`phone`/`notes` профиля владельца сессии + завершение интервью; `capabilities:[RUNTIME]`; стор через `ctx.extra.profilesStore`; резолв `loadProfile(userId) ?? getProfileByUsername ?? getOrCreateProfile`. Проброс `profilesStore` в `OrchestratorOptions` + `extra` (включая саб-агентов) и в core/backend `app.ts` + `chat.ts`.
  - **backend/UI:** `/auth/profile` отдаёт `profile?.interviewCompleted ?? user.interviewCompleted` и персистит `interview_completed` (+`interviewCompletedAt`); `ProfileSettings` — `ToggleField` «Онбординг пройден» + i18n ru/en; шаблон `INTERVIEW.{ru,en}.md` инструктирует сохранять ответы тулом.
  - **docs:** корневой AGENTS.md (строка тула, раздел про онбординг, volatile `scheduler.turn`), `packages/core/AGENTS.md` (context/tools/storage), AD-051 (volatile-блок).
- **Проверки:** typecheck 6/6; lint 0 errors; тесты shared 197 · core **2600** · ui **1025** · backend 347 (новых ~27+14 кейсов). `synth chat` получил `profilesStore` (тул больше не падает).
- **Замечания:** standalone-core `GET/PUT /auth/profile` (`packages/core/src/server/routes/auth.ts`) остаётся минимальным — чекбокс там не персистится (долг; в dev/managed работает через backend). Резолвер `isSchedulerActive` читает `schedules.json` раз в ход — долг на будущее.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-09 — Bug: ollama терял system-промпт + понятное сообщение об ошибке Qwen3.8 tool-цепочки
- **Задача:** «Серьёзный баг. С провайдерами ollama не работают инструменты. Следующий вызов после инструмента падает: `Bad request: {"detail":"no user query found in messages"}`. Что-то подобное уже было с другими провайдерами. Разберись, обсудим.»
- **Тип:** bug fix (core + shared i18n + ui)
- **Исполнитель:** @orchestrator (investigate) → @fixer → верификация @orchestrator
- **Результат:** PASS
- **Диагностика:**
  - `no user query found in messages` — это guard рендерера **Qwen3.8** (Ollama 0.32.x, `model/renderers/qwen35.go`; тот же чек — в HF-шаблоне): поднимается, если после обрезки контекста в списке не остаётся «простого» `user`-сообщения (только `assistant(tool_calls)` + `tool`). Срабатывает на 2-м+ шаге tool-loop. Upstream: **ollama#17778**, фиксы **#17813/#17894** (ещё не влиты); затронуты 0.32.13–0.32.15; qwen3.5/3.6 не задеты.
  - **Воспроизведение (живые запросы):** на `omn` (`qwen3.8:27b`, Ollama 0.32.14) наш shape запроса (`user + assistant(tool_calls) + tool`, **51 инструмент**, дефолтный `num_ctx`) → **HTTP 500** `no user query found in messages`; тот же запрос с `num_ctx:8192` → **200**. На `ai.itphx.ru` тела падавших сессий → **HTTP 400** `{"detail":...}`; минимальный tool-loop с **1** инструментом → 200, с **51** → 400. Триггер — размер набора инструментов/контекста, а не буквальное отсутствие user.
  - **Попутно наш баг:** `OllamaProvider` слал системный промпт в top-level `body.system`, который `/api/chat` **игнорирует** (поле есть только у `/api/generate`) → у `type: ollama` промпт терялся целиком (роль, режим, правила tool-use). Проверено: top-level `system` → инструкция игнорируется; `messages[0]={role:'system'}` → исполняется.
- **Что сделано:**
  - `providers/ollama.ts` (`chat`/`chatAsync`): system-промпт идёт **первым** сообщением `{role:'system'}` (через `resolveSystemPromptText`); `body.system` убран.
  - `engine/llm-error.ts`: `classifyLlmError` распознаёт `no user query found in messages` (регистронезависимо, в обёртках `Bad request:`/`Ollama bad request:`) → тип `no_user_query`, добавлен в `UNRECOVERABLE_TYPES`.
  - i18n: ключ `router.no_user_query` (en — `engine/system-messages.ts`, ru — `ui/src/lib/i18n/messages/ru.ts`, контракт — `shared/src/i18n`); `orchestrator.ts` — `_errorTypeI18n` + `_resolveAssistantStatus`.
  - Тесты: `ollama.test.ts` (chat/chatAsync — system первым сообщением, `body.system===undefined`, без промпта — нет), `llm-error.test.ts` (классификация + unrecoverable по тексту и по типу), `orchestrator-error.test.ts` (assistant `status:'error'` + `metadata.i18n.key='router.no_user_query'`, `canRetry=false`).
- **Проверки (оркестратор):** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; тесты shared **197** · core **2607** · ui **1025**; diff просмотрен вручную.
- **Замечания (остаток):** варианты **num_ctx / сокращение набора инструментов** пользователь отложил — upstream-баг Ollama остаётся (при переполнении контекста возможен повтор, но теперь ошибка локализована и понятна). `StreamErrorPanel` (событие `stream.error`) по-прежнему показывает сырой текст — вне объёма. Ollama на test/preprod обновить, когда вльют #17813/#17894.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `994961f`

## 2026-10-09 — 15:05 — Онбординг: capability `user` для `profile_update` (только Ассистенту) + гейт интервью по доступности
- **Задача:** «инструмент для обновления профиля не доступен агенту и не найден в списке встроенных» → затем идея улучшения: отдельная capability для тулов работы с пользователем; выдать только Агенту `assistant`; не инжектить `[INTERVIEW]`, если тул `profile_update` недоступен.
- **Тип:** investigate (расхождение рантайма) + feature (shared+core+ui) + fix (ui)
- **Исполнитель:** @orchestrator (investigate/дизайн/верификация) → @fixer → независимая верификация @tester → @fixer (панель)
- **Результат:** PASS
- **Диагностика «пропажи» тула:** `profile_update` присутствовал и в исходниках, и в `dist`, и в `ALL_BUILTIN_TOOLS` (52). В рантайме не было: backend (PID 539927, старт 8 окт 23:37) и standalone-core (PID 541010, 23:38) запущены ДО пересборки core (9 окт 02:02, коммит `c15f86f` 09:05) → в памяти старый реестр (51 тул, без `profile_update`). Причина — stale dev-процессы, правки кода не требовалось (рестарт `dev.sh`). Побочно: в админ-разделе «Встроенные инструменты» тулы с capability `runtime` вынесены в отдельную always-on подсекцию — `profile_update` был там.
- **Решения пользователя:** имя capability `user`; отключаемая (не защищать как `runtime`); условие #3 — по реальной доступности `profile_update` (`computeToolAvailability` + admin-disabled), не по одной capability.
- **Что сделано (feature, `43ba6d9`):**
  - `shared`: `ToolCapability.USER='user'` + `TOOL_CAPABILITY_META`; Zod/конфиг подхватывают через `Object.values(ToolCapability)` (правок не потребовалось).
  - `core`: `profile-update.ts` → `capabilities:[USER]`; `assistant.json` +`user` (только Ассистент); `permission/groups.ts` — группа `user:['profile_update']`; `orchestrator.ts` — `_profileUpdateAvailable` (registry.get + `_isAdminDisabled` + `_availabilityPredicate`, fail-closed) и расширенный `_interviewEligible(session, message, toolAccess)`; обновлены оба call-site (`getPromptInfo`, `_processMessage`).
  - `ui`: `'user'` в `DISABLEABLE_GROUPS`, i18n `mcpAdmin.tools.group.user` (ru/en), иконка `profile_update`.
  - Тесты: `profile-update` (`['user']`), `orchestrator-interview` (новая сигнатура + 5 кейсов: с/без capability, admin-disable по capability и по имени, fail-closed), `settings` (принимает `user`). Доки: root `AGENTS.md`, `packages/core/AGENTS.md`.
- **Что сделано (fix ui, `0f82ef8`):** `AgentsPanel` — `CAP_KEYS` из `TOOL_CAPABILITY_META` вместо хардкода (было 9 из 11; не было `runtime`/`user`); добавлены i18n `admin.agents.cap.runtime`/`.user` (ru/en) — устранял сырой ключ на карточке агента.
- **Проверки:** `pnpm build` 6/6; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` ~4182 (shared 197 · core 2613 · ui 1025 · backend 347). Поведенчески (node по `dist` + юнит-тесты): `profile_update` доступен только `assistant` (у developer/qa/title — `role`); интервью только Ассистенту; admin-disable capability/тула убирает и тул, и интервью; без реестра — fail-closed.
- **Замечания (долг, не блокирует):** (1) НЕ функционально, но мертвый артефакт: `packages/backend/src/agents/definitions/*.json` — вторая копия дефиниций, кодом не читается (backend грузит системные дефиниции из `core/dist`, а `{dataDir}/agents` — только user-overrides); Dockerfile.backend копирует её впустую и она расходится с core (все 10 файлов). (2) `runtime`-capability теперь тоже видна в админ-панели агентов (следствие derive-from-meta) — это осознанно.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `43ba6d9` (feature), `0f82ef8` (ui-fix)

## 2026-10-09 — 15:30 — Cleanup: мёртвая копия дефиниций backend + различимые capability-чипы
- **Задача:** удалить мёртвую копию дефиниций агентов в backend и починить визуальное различие включённых/отключённых capability в админ-панели агентов («не отличаются друг от друга»).
- **Тип:** chore (backend) + fix (ui)
- **Исполнитель:** @orchestrator (investigate) → @fixer → верификация @orchestrator
- **Результат:** PASS
- **Диагностика:** backend-копия `src/agents/definitions/*.json` кодом не читалась (backend вызывает `createAgentRegistry(toolRegistry, {dataDir}/agents)` — системные дефиниции из core, второй аргумент — user-overrides), но попадала в `dist/agents/definitions` (build-script) и в Docker-образ (COPY). Чипы capability различались только `--secondary` (L≈0.29) vs `--muted` (L≈0.33) — в тёмной теме визуально сливались.
- **Что сделано:**
  - backend: удалён `packages/backend/src/agents/` (10 json); `package.json` build → `tsc -p tsconfig.build.json`; `docker/Dockerfile.backend` — убран COPY definitions и устаревший комментарий; `AGENTS.md` (корневой, backend) приведены в соответствие.
  - ui: `AgentsPanel` capability-чипы — вкл `bg-primary text-primary-foreground border-primary font-medium`, выкл `border-border bg-surface-inset text-muted-foreground`; добавлен `aria-pressed` и `focus-visible:ring-2 ring-ring` (паттерн `SkillsUserSettings`/`PlanActModeToggle`).
- **Проверки:** `pnpm build` 6/6; backend typecheck/test (347) зелёные, `dist/agents` не создаётся; ui typecheck/lint(0 errors)/test(1025)/build зелёные; ссылок на backend-дефиниции в коде не осталось.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `b3e697c` (cleanup), `0340686` (ui-fix)

## 2026-10-09 — AD-030 (доки) + AD-051 (Job-история, catch-up, force-run, мульти-инстанс)
- **Задача:** продолжить AD-030/AD-051. Пользователь выбрал: актуализация доки AD-030; AD-051 — Job-история + catch-up, UI истории Job'ов, rate limit `/run` + force-run выключенного, мульти-инстанс тех.долг. Plugin SDK (AD-030) — не в этом заходе. Доп. требование: на панели «Шедулер» — рекомендация включить оптимизацию контекста + кнопка перехода на вкладку «Контекст». Разрешение коммитить по мере готовности.
- **Тип:** docs + feature (shared/core/backend/ui) + refactor (мульти-инстанс)
- **Исполнитель:** @orchestrator (investigate/дизайн/верификация) → @fixer ×3
- **Результат:** PASS
- **Согласованные развилки:** catch-up — `Schedule.catchUp: skip|once` + конфиг-дефолт `skip`; Job — append-only JSONL + retention `scheduler.jobRetentionDays=30`; `POST /:id/run` — всегда force (в т.ч. выключенное); мульти-инстанс — семы + file-based, default OFF.
- **Что сделано:**
  - **AD-030 (docs, `90d7e1c`):** статус → ⚠️ Частично; раздел «Статус реализации в коде» переписан под факт (HookBus + эмиты жизненного цикла), зафиксирован остаток (Plugin SDK/загрузчик, неэмитируемые `plan_rejected`/`message_received`/`callback`/`schedule_fired`, политика `builtin`, неполные контексты).
  - **AD-051 ядро (`6970d57`):** shared — `ScheduleJob`/`ScheduleJobTrigger`, `Schedule.catchUp`, zod `scheduleJobSchema`, конфиг `scheduler.catchUp`/`jobRetentionDays`; core — `JobStore` (JSONL, prune), Job-запись на каждый запуск (trigger cron/manual/catchup, status, duration, decision/sessionId), catch-up на старте, in-flight guard, `runNow` force; `SchedulerRuleProvider` honor `payload.force`; `GET /:id/jobs`, `runGuard`/`runMiddleware` в core-фабрике.
  - **AD-051 backend/UI (`946a937`):** rate limit `run` (ADMIN + 10/60c); UI `synthApi.getScheduleJobs`, раскрываемая «История запусков» в «Шедулере», рекомендация оптимизации контекста + переход на «Контекст»; docs (AD-051, API_V2, CONFIGURATION, AGENTS root/core/backend).
  - **AD-051 мульти-инстанс (`90fa28b`, default OFF):** `DedupStore` (memory/file, атомарный claim `open wx` под `events/dedup`), `SchedulerLeader` (Always/File), `FileMutex` (межпроцессная сериализация `ScheduleStore`); конфиг `events.dedupStore`, `scheduler.leaderElection`, `scheduler.crossProcessLocks`; K8s Lease/PG advisory lock — будущее.
- **Верификация (оркестратор):** `pnpm typecheck` 6/6; `pnpm lint` 0 errors; `pnpm test` — shared 199, core 2631, ui 1030, backend 348; `pnpm build` OK. Единственный периодический фейл — `core/src/server/app.remote.test.ts` (WS/cookie, таймаут 5000 мс под параллельной нагрузкой; изолированно 20/20) — предсуществующий флейк, не связан с правками. **Dev-smoke API** (managed :5000): unauth 401; create (disabled, ephemeral) → `nextRunAt=null`; force-run выключенного → `ok`, decision `ephemeral`; `GET /:id/jobs` → Job `trigger=manual`, `status=ok`, `sessionId`; missing id → 404; delete 204. **UI (Playwright, :5002):** вкладка «Шедулер» — счётчик, рекомендация + кнопка «Открыть «Контекст»» (переключает на вкладку «Контекст»), карточки с раскрываемой «Историей запусков» (записи: статус/время/«Вручную · Nms»/sessionId); console без новых ошибок (502 в логе — из окна недоступности backend до `dev.sh`). Тестовые расписание/сессии удалены, dev остановлен.
- **Замечания:** мульти-инстанс file-based работает только при общем `dataDir` на одном хосте/FS (при разных dataDir/хостах — K8s Lease/PG); `FileMutex.withLock` fail-open при таймауте; `decide` теперь claim'ит dedup-ключ (не только `record`) — для памяти семантика штатного цикла та же. Прокси Vite в dev использует `localhost` (IPv6) — при ручном запуске UI отдельно от backend нужен `VITE_BACKEND_URL=http://127.0.0.1:5000`.
- **Ветка:** `docs/ad-normalization-089-external-events`. **Коммиты:** `90d7e1c`, `6970d57`, `946a937`, `90fa28b`, этот (журнал/README).

## 2026-10-09 — AD-089: правила маршрутизации событий + резолвинг agentTemplate (срезы A/B/C)
- **Задача:** «Что дальше нам нужно для AD-089?» → выбран срез «Правила маршрутизации + agentTemplate» (закрывает шаг 2 порядка AD-089: событие → сессия без явного биндинга). Решения пользователя: правила в FileStore + CRUD API; UI — в этом же срезе; неизвестный `agentTemplate` — настраиваемо, дефолт fail-safe (`drop`); фоллбек `events.defaultMode`: `ephemeral` → ephemeral, `bound` → `drop no_route`.
- **Тип:** feature (shared + core + backend + ui) + docs
- **Исполнитель:** @orchestrator (investigate/план/верификация) → @fixer ×3 (A: контракты/store/провайдер/резолвер; B: API + сшивка core/backend + defaultMode + доки; C: UI)
- **Результат:** PASS
- **Что сделано:**
  - **shared:** `EventRouteRule`/`EventRouteTarget`/`EventRouteMatch` + Zod (`eventRouteRuleSchema`/`eventRouteRuleInputSchema`/`eventRouteRuleUpsertSchema`); `RouteDecision.ephemeral` получил `project?`; конфиг `events.unknownAgentTemplate: 'drop' | 'default-agent'` (default `drop`).
  - **core:** `RouteRuleStore` (`{dataDir}/events/routes.json`, FileStore/atomicWrite/AsyncLock, `list/get/listEnabled/upsert/remove`); `decisionFromTarget` (`engine/events/target-decision.ts`) — общий маппинг target→RouteDecision, переиспользован `SchedulerRuleProvider`; `ProjectRuleProvider` (`name='project-rules'`, приоритет desc, AND-матчинг полей + keywords-подстроки без LLM); `RequestSessionService` — `resolveAgentTemplate` + `config.unknownAgentTemplate` (fail-safe `agent_not_found` в журнал), `project` из ephemeral → `createSession({projectId})`; `EventRouter` — фоллбек `defaultMode`.
  - **API:** `GET/POST /api/v2/events/routes`, `DELETE /events/routes/:id` (мутации ADMIN) в общей `createEventRoutes`; валидация `bound`/`queue` — существование сессии, `ephemeral.agentTemplate` — существование агента; сшивка в core `server/app.ts` и backend `app.ts` (провайдер после scheduler, `defaultMode`, резолвер через `AgentRegistry`).
  - **UI:** секция «Правила маршрутизации» в админ-разделе «События» (`EventRoutesSection.tsx`) — список/форма/удаление (`ConfirmDialog`), селект цели `bound|ephemeral|queue`, keywords строкой; `synthApi.getEventRoutes/createEventRoute/deleteEventRoute`; i18n ru/en (`events.routes.*`).
  - **docs:** `API_V2.md` (§5.26), `CONFIGURATION.md` (`events.unknownAgentTemplate`/`defaultMode`), AD-089 (статус + остаток; сняты устаревшие Job-история/catch-up/мульти-инстанс), `AGENTS.md` корень/shared/core/backend, UI-раздел (без правки ui AGENTS.md — см. замечания).
- **Верификация (оркестратор):** `pnpm --filter @itphx/synth-shared build` + `@itphx/synth-core build` OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors (175 предсуществующих warning). Тесты: shared **199**, core **2692**, ui **1038**, backend **352**. Единственный падающий — `core/src/server/app.remote.test.ts` (WS `connected`, таймаут 5000 мс под параллельной нагрузкой; изолированно 20/20 × 3) — предсуществующий флейк (проверено и на HEAD), не связан с правками. **Dev-smoke (срез B, изолированный backend :5057, отдельный dataDir):** `GET /events/routes` unauth 401 / admin 200; POST user 403 / admin `{source:'ci'→ephemeral}` 201; `POST /events` `source:'ci'` → 201, decision `ephemeral`, `sessionId` ≠ null; `GET /events/journal` — запись; DELETE 204, повтор 404. **UI:** unit `EventsAdminSettings.test.tsx` 17/17; Playwright-рендер секции правил (скриншот `synth/tmp/ad089-routes-section.png`) — но полный E2E не пройден: запущенный dev-backend (:5000, tsx без watch) не подхватил новый роут (404).
- **Замечания:** (1) «живой» dev-инстанс (:5000 backend / :5002 UI / :4300 core) запущен до правок и не перезапущен — для полного UI-E2E нужен рестарт `./scripts/dev.sh`; (2) LLM-классификация правил (micro AD-035/`classify_conversation`) НЕ реализована (только детерминированные правила); (3) UI-тумблер вкл/выкл правила — в форме (не инлайн); (4) пустой `match` в правиле = catch-all (разрешён схемой); (5) `packages/ui/AGENTS.md` (описание админ-раздела «События») не правился — требует согласования с пользователем.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-09 — AD-089: API-ключи привязок, перенос раздела в user-часть, селекты/тултипы, журнал в «Логи и аудит»
- **Задача:** доработать AD-089 по 7 требованиям пользователя: (1) селекты вместо свободного ввода (сессии/агенты по названию, ID как значение, ID под селектом); (2) выбор только сессий проекта + кнопка «+» с общим диалогом создания сессии; (3) read-only область с тестовым curl; (4) раздел в пользовательскую часть, создание — LEAD/ADMIN, просмотр — USER/AUDITOR; (5) API-ключи на привязку (несколько, создатель+описание обязательны), ключ заменяет креды для `POST /events`; (6) тултип у каждого поля; (7) журнал — оставить в разделе и дублировать в «Логи и аудит» + кнопка перехода. Плюс по итогам обсуждения — 5 улучшений: seam AD-052 (`expiresAt`/`revokedAt`, `EventKeyCredential`), `keyId` в журнале, общий `EventJournalPanel`, гейт чтения ключей LEAD/ADMIN, документирование binding-key vs service-key и инстанс-локальности.
- **Тип:** feature (shared + core + backend + ui) + docs + fix (фильтр сессий по проекту)
- **Исполнитель:** @orchestrator (investigate/план/верификация) → @fixer ×5 (T1 ключи ядро/backend; T1b seam+аудит; T2 UI; T3 docs; fix project_id)
- **Результат:** PASS
- **Что сделано:**
  - **shared:** `EventBindingApiKey`/`EventBindingApiKeyCreated` (+`expiresAt`/`revokedAt`), Zod `eventBindingApiKey*`, `eventKeyIngestSchema`; `EventKeyCredential` (core).
  - **core:** `EventApiKeyStore` (`events/api-keys.json`, sha256 at-rest, `synth_evt_<base64url>`, create/list/remove/removeByBinding/resolveBySecret/revoke/touch); `EventRouter.decide(event, forcedBinding?)`; `RequestSessionService.handleEvent(event,{binding,audit})`; `EventIngress.ingest(input,opts)`; `EventJournalEntry.keyId/principalId`; `EventRouter.record(...,meta)`; `createEventRoutes` — key-эндпоинты + приём по `Bearer <key>` + `ingestPreGuard`/`keyReadGuard`; каскад ключей при удалении привязки; forced-binding по ключу.
  - **backend:** `writeGuard=requirePermission('ADMIN','LEAD')`, `keyReadGuard=requirePermission('ADMIN','LEAD')`, `ingestPreGuard` (rate limit) + `ingestGuard=requireAuth` (fallback), i18n.
  - **ui:** раздел «События» в user-части (`SettingsModal`); `useCanManageEvents` (LEAD/ADMIN) — read-only для USER/AUDITOR; `entity-selects` (ProjectSelect/SessionSelect/AgentSelect, ID под селектом); `SessionCreateDialog` (общий с левой панелью); `EventBindingKeys` (создание/удаление, однократный показ секрета, read-only curl); `EventJournalPanel` (раздел + новая категория в «Логи и аудит» + кнопка перехода); `FieldTooltip` ⓘ + проп `tooltip` у контролов; селекты+тултипы в bindings/rules/schedules; i18n ru/en.
  - **fix:** core `GET /sessions` реально фильтрует по `project_id` (был игнор) + тесты.
  - **docs:** AD-089/AD-052/AD-081/AD-042, API_V2, ARCHITECTURE, README AD, корневой AGENTS, core/backend/shared/ui AGENTS.
- **Верификация (оркестратор):** `pnpm build` shared/core OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors (177 предсуществующих warning). Тесты: shared 199, core 2722, ui 1051, backend 356 (флейка `app.remote.test.ts` WS-таймаут — предсуществующая, изолированно 20/20). **Dev перезапущен.** API-E2E (managed :5000): создать привязку→ключ (secret один раз)→`POST /events` с `Bearer <key>` без source → 201, decision `bound`, `sessionId`; журнал содержит `keyId`; неверный ключ 401; USER список ключей 403; каскад при удалении привязки. **UI (Playwright, :5002):** раздел в user-части (до «Панель управления»), форма привязки с селектами (проект→сессии, агент), «+»→«Создать сессию», тултипы ⓘ, создание ключа (тост «API-ключ создан», секрет показан один раз, curl с реальным ключом), `developer` — без кнопок создания; консоль 0 errors. Тестовые данные прибраны.
- **Замечания:** HTTP-эндпоинта `revoke` нет (только стор-метод — задел AD-052); binding-key не масштабируется на мессенджеры (планируется service-key AD-052, задокументировано); клиент дополнительно фильтрует сессии по проекту (защита поверх серверного фильтра).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-10 — AD-089: retention журнала, per-key/глобальный rate limit, UX ключей, админ «Параметры событий»
- **Задача:** (1) retention журнала событий; (2) UI для `expiresAt`/revoke и per-key rate limit; (3) переработка интерфейса привязок по скиллу `better-ui` (ключи — секция внутри карточки; Метка обязательна/уникальна и выше Описания; Описание опционально; правка описания). Дополнительно по ответам пользователя: per-key **req/мин + глобальный дефолт** (админ-секция «Параметры событий»), метка уникальна **глобально по инстансу**, редактируются метка/описание/срок/лимит.
- **Тип:** feature (shared + core + backend + ui) + docs
- **Исполнитель:** @orchestrator → @fixer ×5 (backend ядро; backend тесты/верификация; UI код; UI тесты/Playwright/AGENTS; docs)
- **Результат:** PASS
- **Что сделано:**
  - **shared:** `EventBindingApiKey` — `label` (обязательна), `description?`, `rateLimitPerMinute?`, `expiresAt?`/`revokedAt?` (убран `name`); `eventBindingApiKeyCreate/UpdateSchema`; `events.keyRateLimitPerMinute` (default 0).
  - **core:** `EventApiKeyStore` — глобальная уникальность `label` (`EventApiKeyConflictError`), `create/update/get/revoke`, legacy-backfill `name`→`label`, `rateLimitPerMinute`; `KeyRateLimiter` (окно 60 c); `engine/events/journal-prune.ts` (`startEventJournalPruner`, startup + 6 ч, `unref`); runtime-настройки `RuntimeSettings.events` + `mergeEventsConfig`; `GET/PUT/DELETE /settings/events` (+`eventsWriteGuard`), `EventRouter.updateConfig`/`RequestSessionService.updateConfig` (live); роуты ключей `PATCH`/`revoke`, per-key 429, рубильник 503.
  - **backend:** `eventsWriteGuard=requirePermission('ADMIN')`, pruner в шине + graceful shutdown, i18n (`invalidEventKeyUpdate`/`eventKeyLabel`/`eventKey`/`eventsDisabled`).
  - **ui:** секция API-ключей — первоклассная и всегда видна внутри карточки привязки (без тумблера), создание нескольких, Метка (обязательна, уникальна, 409 под полем) выше Описания (опц.), поля срока/лимита, бейджи «Активен/Истёк/Отозван», инлайн-редактор, отзыв/удаление, однократный секрет + curl; новая админ-секция «Параметры событий» (`eventsConfig`, ADMIN); тултипы; i18n ru/en; **фикс** `resolveActiveSettingsPage` (смена роли без перезагрузки показывала содержимое недоступного admin-раздела).
  - **docs:** AD-089/AD-052, `API_V2`, `CONFIGURATION`, `ARCHITECTURE`, README AD, AGENTS (root/core/backend/shared/ui).
- **Верификация (оркестратор):** `pnpm build` shared/core OK; `pnpm typecheck` **6/6**; `pnpm lint` **0 errors**. Тесты: shared **199**, core **2754** (2 падения — предсуществующая флейка `app.remote.test.ts` WS-таймаут, изолированно 20/20), ui **1073**, backend **356**. Dev перезапущен; **dev-smoke**: `GET /settings/events` (дефолты), дубль метки **409**, `PATCH` (сброс лимита `null`), `revoke` (статус), каскад **204**. **UI (Playwright)**: секция ключей видна сразу, создание 2+ ключей, обязательная/уникальная метка, описание ниже и опц., редактор, отзыв + бейдж, однократный секрет + curl (201), админ «Параметры событий» save/Reset, `developer` — read-only и админ-раздел скрыт, регрессия смены ролей без перезагрузки. Live: per-key (ключ 2/мин → 3-й 429), глобальный дефолт → 429, `enabled=false` → 503. Тестовые данные прибраны; `settings/events` → `isOverridden:false`.
- **Замечания:** старые persisted-ключи с `name` бэкфиллятся в `label` при чтении; флейка `app.remote.test.ts` — предсуществующая; `dedupStore` в runtime-настройки не вынесен (инфра, рестарт); неожиданно найден и исправлен баг утечки содержимого admin-раздела при смене роли без перезагрузки.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-10 (продолжение) — Аудит и чистка AD вокруг AD-089 (контент + индексы)
- **Задача:** «Проанализируй AD — консистентно ли, нет ли противоречий/мусора; прибрать/почистить/актуализировать; затем решить куда дальше». Согласованный объём: пункты 1–9 (безопасная актуализация под код) + сжатие AD-089. Решения по «куда дальше» — вынести таблицей, ответ отложен.
- **Тип:** docs (аудит + чистка AD/индексов)
- **Исполнитель:** @orchestrator (аудит, план, верификация) → @researcher ×2 (аудит контента AD-089-семейства; аудит индексных поверхностей) → @fixer ×1 (правки)
- **Результат:** PASS
- **Что выяснено (аудит):** индекс AD полон и без битых ссылок (74 файла, 1402 ссылки, 0 битых; 0 фантомов/дублей/конфликтов номеров); реализация AD-089 подтверждена кодом (фантомов нет); AD-089/AD-052 согласованно описывают binding-key (первый срез) vs service-key (остаток). Проблемы — застарелые нарративные разделы и категоризация README.
- **Что сделано (5 файлов, +48/−58):**
  - **AD-089:** «Чего нет» → «Чего не было на момент решения» (исторический снимок, пометка на 2026-10-08); «Router реализуется поверх hook-шины» → «ядровый слой; hook-шина — точка расширения» (и в «Связях»); 4 закрытых «Открытых вопроса» убраны (хранение, ephemeral TTL, Router-плагин, cron-источник) + строка-отсылка к статусу; `RouteDecision.ephemeral` получил `project?`; «Порядок маршрутизации» дополнен шагами `allowedSources`/`dedup`; снято «(гибрид)» у дефолта; добавлено «Обновлено»; binding-key сведён к одному каноническому описанию (дубль убран из «Безопасность»/«Статус»/«Остаток»); удалена дублирующая секция «Переиспользуемые кирпичи»; service-key унифицирован как «остаток AD-052».
  - **AD-086:** исправлены утверждения «hook-кода нет» → «хуки/hook-шина реализованы (AD-030); Plugin SDK/загрузка (`SynthPlugin`) — нет» (2 места).
  - **AD-051:** снята пометка «открытый вопрос» у персистентности; убраны 3 закрытых вопроса (библиотека, catch-up, персистентность), оставлен гибрид-размещение.
  - **README AD:** AD-046 → «Частично реализованные» (описание синхронизировано с Фазой 3), AD-069 и AD-079 → «Актуальные»; секции упорядочены по номеру.
  - **Корневой AGENTS.md:** добавлен отсутствовавший `PUT /api/v2/schedules/:id` (таблица Runtime-настроек и API-бюллетень).
- **Проверки (оркестратор):** битые относительные ссылки — 0 (во всех 5 изменённых файлах); дубли строк AD в README — 0; соответствие файлов↔каталога — полное (AD-027 корректно в deprecated/`legacy`); AD-046 в «Частично», AD-069/079 в «Актуальные»; `PUT /api/v2/schedules/:id` — 2 вхождения. Код не менялся → typecheck/lint/test не требуются.
- **Осознанно отложено:** `docs/arch_decisions/README.md` ↔ корневой `AGENTS.md` — полное дублирование 74-строчной таблицы AD (структурный техдолг; требует решения пользователя); в AD-052 буквальная формулировка «остаток AD-052» не проставлялась (семантика уже совпадает — раздел «Осталось»).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** нет (ожидает явной просьбы пользователя).

## 2026-10-10 (продолжение) — AD-084/AD-089: decision-модели — исследование, план и Фаза 1 (DecisionProvider)
- **Задача:** «Проработать срез A». После исследования новой волны decision-моделей (System One: Jev/Decision-1/Clef·Clef-Flash/CLM) решения пользователя: объём — **полный AD-084 (Ф1–Ф5)**; транспорт — **оба, дефолт по политике** (managed → локально, standalone → RouterAI); decision-вызовы — **всегда через `GatewayProvider`**. Старт — с Ф1.
- **Тип:** research + design + feature (shared/core/gateway/ui/docs)
- **Исполнитель:** @orchestrator (исследование/план/верификация) → @explore ×2 (карта кода) → @fixer (Ф1)
- **Результат:** PASS (Ф1)
- **Артефакты плана (вне git, корень `/mnt/data/Agent/dev/Synth/`):** `AD-089-NEXT-STEPS.md` (таблица срезов + исследование decision-моделей), `AD-084-DECISION-MODELS-PLAN.md` (план Ф1–Ф5).
- **Исследование (кратко):** RouterAI — категория «Решения» (16 моделей) + эндпоинт `POST /api/v1/decisions` (SystemOne-совместим, TypeSafe SDK, выход бесплатный; `clef-flash` 4,19₽/1M, `microsoft-decision-1` 4,64₽, `jev-1.13` 4,64₽ и др.). Ollama — capability Decision (`clef-flash`/`clef`/`tev1`/`nimble`/`laya`), эндпоинт `POST /v1/systemone`; локально требуется Ollama **≥0.35.1** (сейчас 0.32.14) + pull ~11 ГБ. Связано с AD-084.
- **Фаза 1 (сделано):**
  - **shared:** `types/decision.ts` (типы+Zod: `DecisionQuestion`/`DecisionAnswer`/`DecisionRequest`/`DecisionResponse`); `config/types.ts` — секция `decision` (`enabled`/`mode` auto|local|remote/`provider`/`model`/`escalationModel`/`timeoutMs`/`confidenceThreshold`/`remoteEndpoint`); `defaults.ts`; env-резолверы `SYNTH_DECISION_*` (`resolve.ts`); `ProviderConfig.decisionApi?: 'decisions'|'systemone'`; тесты.
  - **core:** `providers/decision.ts` — `DecisionProvider extends BaseProvider` с `decide(state,questions,opts)`; транспорт `systemone`→`/v1/systemone`, иначе `/decisions`; маппинг ошибок (`RateLimitError`/`ContextLengthExceededError`/`ProviderError`); `chat/chatAsync` → отказ; регистрация `ProviderFactory.register('decision', …)`; `decisionApi` в core-конфиге/env-sync/роутах; help CLI.
  - **gateway:** `GatewayProvider.decide()` (rate limit + guard/обфускация `state` + аудит/payload-лог); `ProviderPool.getDecisionProvider()` — **всегда** оборачивает в gateway (fallback-конфиг при `gateway.enabled=false`); оркестратор прокидывает фабрику.
  - **ui/docs:** опция типа `decision` в `ProvidersPanel`; `docs/LLM_PROVIDERS.md`, `docs/CONFIGURATION.md`.
- **Верификация (оркестратор):** build shared/core OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; целевые тесты (decision/gateway decide/provider-pool) **37/37**; shared `decision`+`defaults` **205** PASS. Флейк `app.remote.test.ts` (WS-таймаут 5 c) — изолированно **PASS×2**, файл не менялся → pre-existing, не связан. JSON-провайдеры вручную не создавались (через API/UI).
- **Открытые моменты:** для decision-пути `sessionId`/`userId` в обвязке пула пустые (аудит без привязки к сессии — придёт в Ф2/Ф3); `_retryAfterSeconds` не реализован; политика `mode:auto` (сигнал «managed») — задел под AD-080/081.
- **Осталось:** Ф2 (`DecisionModel` в микро-каскаде), Ф3 (decision-классификатор роутера), Ф4 (decision-шаг в событиях AD-089 — срез A), Ф5 (runtime/UI/метрики/docs). Локальный Ollama — апгрейд ≥0.35.1 (отдельная задача @admin).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `16e4324` (чистка AD), `5e37351` (decision-слой Ф1).

## 2026-10-10 (продолжение 3) — AD-084 Ф2–Ф3: DecisionModel в микро-каскаде и классификатор роутинга
- **Задача:** продолжить полный AD-084 (Ф2→Ф5) по плану `AD-084-DECISION-MODELS-PLAN.md`. Разрешение коммитить — по мере готовности.
- **Тип:** feature (core/shared/backend)
- **Исполнитель:** @orchestrator (верификация/коммиты) → @fixer ×2 (Ф2, Ф3)
- **Результат:** PASS
- **Ф2 (`DecisionModel` в микро-каскаде AD-035):** `micro/models/decision-model.ts` (implements `MicroModel`, `kind='decision'`, `canHandle` classify/enum_decision); маппинг задач в `choice`-вопросы (`CLASSIFY_ANSWERS`/`VALID_LABELS`); встроен в каскад **после embedding, до `micro_llm`** (фоллбек сохранён); fail-safe (выключено/нет провайдера/низкая уверенность/ошибка → `UNSURE` с сигналами `decision_*`); гейты `config.decision.enabled` (мастер) и per-session `decisionFirst` (opt-out); runtime-геттер конфига + `ChatOrchestrator.setDecisionConfig`; `SessionSettings.decisionFirst`; проброс `decisionConfig` в standalone/backend/chat.
- **Ф3 (decision-классификатор маршрутизации AD-034):** `router/decision-content-classifier.ts` (`choice` coding|research|chat, ru/en-критерии, fail-safe `null`); встроен в `ModelRouter` между `settings.routingCategory` и keyword-фоллбеком (приоритеты не изменены); `route`/`_routeByContent`/`_routeByContentAndCost` → **async**; обновлены вызовы (`orchestrator._routeProvider`, `tools/task.ts`, тесты).
- **Верификация (оркестратор):** build shared/core OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; целевые тесты — decision-model 13, микро-каталог 70/70, decision-content-classifier+router 16/16. Флейк `app.remote.test.ts` — изолированно PASS (pre-existing).
- **Коммит:** `5e37351` (Ф1–Ф3 в одном feature-коммите; файлы фаз пересекаются в `orchestrator.ts`/`main.ts`).
- **Осталось:** Ф4 (decision-шаг в событиях AD-089 — **срез A**) и Ф5 (runtime-настройки `/settings/decision`, UI-секции, метрики, docs/AD/AGENTS). Локальный Ollama — апгрейд ≥0.35.1 (@admin).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** этот (журнал).

## 2026-10-10 (продолжение 4) — AD-084 Ф4–Ф5: срез A (события), runtime/API, UI, метрики, доки — ЗАВЕРШЕНО
- **Задача:** довести полный AD-084 (Ф4 срез A + Ф5 runtime/UI/метрики/docs). Разрешение коммитить — по мере готовности.
- **Тип:** feature (core/backend/ui/shared) + docs
- **Исполнитель:** @orchestrator (верификация/коммиты) → @fixer ×4 (Ф4, Ф5a, Ф5b, Ф5c+Ф5d)
- **Результат:** PASS
- **Ф4 — срез A (AD-089, decision-классификация событий, `1bcf7b3`):** `engine/events/decision-rule-provider.ts` (`DecisionRuleProvider`, `name='decision-rules'`) — при промахе `ProjectRuleProvider` decision-модель выбирает enabled-агента (`choice`), уверенный выбор → `decisionFromTarget({mode:'ephemeral', agentTemplate})`; порядок `Scheduler → ProjectRules → DecisionRules → фоллбек`; гейт `events.decisionRouting` (default false, live); fail-safe `null`; `ChatOrchestrator.getDecisionProvider`.
- **Ф5a — runtime/API (`15dbd96`):** `DecisionRuntimeSettings`+`mergeDecisionConfig`+get/set/clear; `GET/PUT/DELETE /api/v2/settings/decision` (валидация/дефолты/effective, `decisionWriteGuard` ADMIN); live-применение в трёх потребителях (микро/роутер через `setDecisionConfig`, события через мутабельный `effectiveDecisionSettings`). Docs: API_V2 §5.21, CONFIGURATION.
- **Ф5b — UI (`a4945ab`):** админ-секция `DecisionSettings.tsx` (Settings UI Kit; enabled/mode/provider/model/escalationModel/timeoutMs/confidenceThreshold/remoteEndpoint; Save/Cancel/Reset), per-session тумблер `decisionFirst` (opt-out, не затирает глобальный конфиг), events-тумблер `decisionRouting`; `synthApi`-методы/типы; i18n ru/en; тесты.
- **Ф5c — метрики + docs (`dab9e24`):** `RoutingDecision.category/confidence/signals`; микро-каскад сохраняет сигналы моделей в `fallbackSignals`; `DebugCollector` → `extra_context.decision`/`decision_routing` + `metadata.micro_first.decision` (через существующий `/messages/:id/:index/debug`); `docs/ROUTING.md` обновлён; AD-084 → «Частично».
- **Ф5d — AD/инструкции (`86c11cb`):** AD-084 ⚠️ Частично + «Статус реализации в коде» + этапы/риски; AD-089 — LLM-классификация правил закрыта decision-шагом; AGENTS (корень/core/shared/ui) — DecisionProvider/gateway.decide/DecisionModel/DecisionContentClassifier/DecisionRuleProvider/секция decision/`/settings/decision`/`decisionFirst`/`decisionRouting`/UI-секция.
- **Верификация (оркестратор):** по фазам — build shared/core OK, `pnpm typecheck` 6/6, `pnpm lint` 0 errors; целевые тесты зелёные (Ф4 15, Ф5a 131, Ф5b ui 1090, Ф5c 135); битых `.md`-ссылок нет. Единственный падающий в общих прогонах — pre-existing флейк `core/src/server/app.remote.test.ts` (WS-таймаут; изолированно PASS).
- **Остаток AD-084 (осознанно):** шаг 3 «Clef на эскалацию», мультимодальность (`images`/`videos`), `scopes`/политики гибрида для decision-трафика, `mode:auto`-сигнал managed (AD-080/081), агрегатные метрики `decision.calibration`. Локальный Ollama — апгрейд **≥0.35.1** (сейчас 0.32.14) + `ollama pull clef-flash` (@admin).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммиты:** `1bcf7b3`, `15dbd96`, `a4945ab`, `dab9e24`, `86c11cb`, этот (журнал).

## 2026-10-10 (продолжение 5) — рефакторинг decision: единый путь провайдеров/моделей
- **Задача (фидбек):** «Модели и провайдеры decision настраиваются своим путём; сделать единообразно с остальными провайдерами/моделями — просто отдельный тип API». Решения: два типа-протокола `decision`/`systemone`; выбор модели — пара provider/model через селекты; `/settings/decision` — тонкий.
- **Тип:** refactor (shared/core/ui) + docs
- **Исполнитель:** @orchestrator (анализ паттернов/решения/верификация) → @fixer ×2
- **Результат:** PASS
- **Часть 1 (core/shared, `a4d6cb2`):** удалён спец-атрибут `decisionApi`; введены типы провайдера-протокола `decision` (`POST {base}/decisions`) и `systemone` (`POST {base}/v1/systemone`), оба → `DecisionProvider` (endpoint по `this.type`, `_normalizeUrl` не достраивает путь); env-sync без `..._DECISION_API`; секция `decision` сокращена до `enabled`/`provider`/`model`/`confidenceThreshold` (удалены `mode`/`escalationModel`/`timeoutMs`/`remoteEndpoint`, env `SYNTH_DECISION_MODE`); обновлены runtime-merge/валидация/роуты; docs LLM_PROVIDERS/CONFIGURATION/API_V2.
- **Часть 2 (ui/docs/AD, `d11f3d0`):** `DecisionSettings` → `ModelPairSelect` (фильтр провайдеров по типу `decision`/`systemone`, модели по провайдеру) + `enabled`/`confidenceThreshold`; `ModelPairSelect` получил опц. testId/tooltip; тип `DecisionSettings` и i18n синхронизированы (ключи mode/escalation/endpoint удалены); ROUTING, AD-084, AGENTS (root/core/shared/ui) приведены к единому пути.
- **Верификация (оркестратор):** build shared/core OK; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; ui `1092` PASS, ui build OK; целевые core-тесты 125/125, shared config 21/21; grep — ссылок на удалённые поля нет (кроме легитимных `SYNTH_DECISION_MODEL`/`decision.model`).
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммиты:** `a4d6cb2`, `d11f3d0`, этот (журнал).

## 2026-10-10 (продолжение 6) — проверка decision на реальных моделях + фикс приёма событий
- **Задача:** протестировать с реальными моделями: локальный `systemone` (`clef-flash`/`tev1:4b` на `owu`) и RouterAI `decision`; настроить провайдер RouterAI.
- **Тип:** verification (real models) + bug fix (events auth) + infra-наблюдение
- **Исполнитель:** @orchestrator (разведка/вызовы/верификация) → @fixer ×2 (e2e-настройка; фикс 401)
- **Результат:** PASS (remote e2e и локальный e2e; найден и исправлен дефект 401)
- **RouterAI (type `decision`):** провайдер `routerai-decision` (`https://routerai.ru/api/v1`) + модель `cloudflare/clef-flash`; e2e через `POST /events` → `ephemeral` `decision-rules`, агент `admin`, latency ~0.7 с.
- **Локальный `systemone`:** на `owu` (Ollama 0.40.2) `clef-flash` падал 500 (`insufficient memory ~12.6 ГБ` / pooling) — зафиксирован fail-safe (событие принимается, роутер уходит в `defaultMode`). Затем загружена `tev1:4b` (4.2B) → e2e через приложение сработал: `ephemeral`, агент `bankassist`, latency ~0.7 с (первый прогрев ~12 с). Порог/фаил-сейф проверены.
- **Фикс `fix(events)` (`87e6c05`):** `POST /api/v2/events` с обычным `Bearer <user-key>` (не `synth_evt_…`) теперь падает на fallback `ingestGuard` (requireAuth), а не 401; невалидный binding-key по-прежнему 401. `event-api-key-store.ts` — `EVENT_API_KEY_SECRET_PREFIX`/`isEventApiKeySecret`. Проверено e2e: Bearer `admin-key-123` → 201, bogus `synth_evt_` → 401, без auth → 401. Тесты core 36, backend 8.
- **Финальное состояние (dev, оставлено):** провайдеры `routerai-decision`, `owu-systemone`; модели `cloudflare/clef-flash`, `clef-flash`, `tev1:4b`; `decision = {enabled:true, provider:"owu-systemone", model:"tev1:4b", confidenceThreshold:0.3}` (локально); `events.decisionRouting=false`.
- **Наблюдения (задел):** на успешном event-пути `DecisionRuleProvider` не логирует latency/agent/confidence (только warning при промахе) — событийная observability тоньше микро; confidence решения не попадает ни в HTTP-ответ, ни в журнал (append-only). Хост `owu` не тянет `clef-flash` (память) — при необходимости `@admin`/env `OLLAMA_CONTEXT_LENGTH`.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `87e6c05`, этот (журнал).

## 2026-10-10 (продолжение 7) — observability decision-маршрутизации событий
- **Задача:** «улучши observability event-decision (лог успеха + confidence в ответ/журнал)».
- **Тип:** feature (shared/core) + docs
- **Исполнитель:** @orchestrator (дизайн/верификация) → @fixer (правки + рестарт/e2e)
- **Результат:** PASS
- **Сделано (`cf76291`):**
  - shared: `RouteDecisionMeta {confidence?, signals?}` + `RouteDecision = RouteDecisionKind & Meta` (дискриминант `kind` сохранён) → confidence/signals попадают в ответ `POST /events` и в журнал автоматически (журнал хранит `decision` целиком).
  - `target-decision.ts`: `extra` расширен `confidence`/`signals`.
  - `DecisionRuleProvider`: замер latency; `info('DECISION', …)` на успехе (агент/confidence/порог/модель/latency/source/type); мета `{reason, confidence, signals:['decision-rules','agent:<id>','model:<p/m>','latency:<ms>ms']}`; latency добавлена в warning-ветки промаха. Fail-safe не изменён.
  - docs: API_V2 (POST /events — `decision.confidence/signals`), core AGENTS.
- **E2E (реальная модель `tev1:4b`@owu, рестарт dev):** `POST /events` → `decision = {kind:"ephemeral", agentTemplate:"bankassist", ttl:"24h", confidence:0.81, signals:[decision-rules, agent:bankassist, model:owu-systemone/tev1:4b, latency:681ms]}`; в журнале `decision.confidence/signals` есть; лог `[DECISION] decision-маршрутизация: агент=bankassist confidence=0.81 (порог 0.3) model=owu-systemone/tev1:4b latency=681ms source=test type=message`. Тестовая сессия удалена; `decisionRouting` → false.
- **Верификация (оркестратор):** build shared/core OK; typecheck 6/6; lint 0 errors; events-тесты 127/127.
- **Ветка:** `docs/ad-normalization-089-external-events`
- **Коммит:** `cf76291`, этот (журнал).

## 2026-10-10 (продолжение 8) — финальная сверка: AD, журнал, коммиты
- **Задача:** «Все AD актуализированы? Лог заполнен, наработки закоммичены?»
- **Тип:** docs (сверка/актуализация)
- **Исполнитель:** @orchestrator
- **Результат:** PASS
- **Проверено:** рабочее дерево чисто; все коммиты сессии на месте; журнал заполнен по всем эпизодам (продолжения 1–8); устаревших терминов (`decisionApi`/`escalationModel`/`remoteEndpoint`/`SYNTH_DECISION_MODE`) в docs/AGENTS нет; статусы AD-084 (⚠️), AD-089 (⚠️) согласованы между шапкой, README AD и корневым AGENTS; битых относительных ссылок нет.
- **Правки (`6dc98f2`):** AD-084 — §Метрики помечены «реализовано частично» (фактические `DebugCollector` context + event-log `confidence`/`signals`, задел на агрегаты `decision.*`/calibration); §Этапы п.7 → ✅ (ROUTING.md обновлён); §Связи — снята пометка «обновить при реализации». AD-089 — в bullet «Decision-маршрутизация» добавлено, что решение несёт `confidence`/`signals` (ответ `POST /events` + журнал) и логируется успех.
- **Ветка:** `docs/ad-normalization-089-external-events` (не запушена)
- **Коммит:** `6dc98f2`, этот (журнал).

## 2026-10-10 (продолжение 9) — AD-084 добит полностью (Ф6–Ф8), статус ✅
- **Задача:** «Давай добьём AD-084 полностью» — закрыть остаток (эскалация, мультимодальность, агрегатные метрики) и перевести AD в ✅.
- **Тип:** feature (shared/core/ui) + docs
- **Исполнитель:** @orchestrator (исследование/план/верификация) → @fixer (core/shared; UI/docs; рестарт+e2e)
- **Результат:** PASS
- **Объём (выбор пользователя):** эскалация + агрегатные метрики + мультимодальный контракт (источник медиа — AD-085); политика local/remote оставлена зависимостью AD-080/081.
- **Сделано (`6b154f3` core/shared, `0d86f69` UI/docs):**
  - **Эскалация:** вторая пара `escalationProvider`/`escalationModel` в конфиге `decision` (uniform provider/model), runtime/`mergeDecisionConfig`/`/settings/decision`; единый каскад `primary → escalation` — `engine/router/decision-cascade.ts` (`decideChoiceCascade`, fail-safe, `DecisionTier`, статусы `ok|low_confidence|invalid|no_answer|no_provider|error`), переиспользуется в `DecisionModel` (micro), `DecisionContentClassifier` (router) и `DecisionRuleProvider` (events); сигналы `decision_escalated`.
  - **Метрики:** `engine/router/decision-metrics.ts` (`calls/handled/fallback/escalated`, `attempts`, `rejected`, `by_model` с latency avg/max), process-wide синглтон; экспозиция `GET /api/v2/settings/decision/metrics` (`requireAuth`) и `DELETE …/metrics` (reset, `decisionWriteGuard`).
  - **Мультимодальный контракт:** `images`/`videos` в `DecisionRequest`/`decisionRequestSchema`/`DecisionProvider.decide`/`MicroInput` (plumbing; источник — AD-085).
  - **UI:** вторая пара `ModelPairSelect` (эскалация) + read-only секция «Статистика» (refresh/reset) в админ-разделе «Decision-модели»; `synthApi.getDecisionMetrics/resetDecisionMetrics`; i18n ru/en; тесты `DecisionSettings.test.tsx` 21/21.
  - **Docs:** AD-084 → **✅ Реализовано** (Ф6–Ф8, §Метрики/§Этапы/§Статус кода/§Риски), README AD (перенос в «Реализованные»), корневой AGENTS (индекс, `/settings/decision`+metrics, decision-конфиг), API_V2, CONFIGURATION, ROUTING, packages/{shared,core,ui}/AGENTS.
- **E2E (реальные модели, `clef-flash`@routerai vs `tev1:4b`@owu, порог 0.4):** `POST /events` → `decision = {kind:"ephemeral", agentTemplate:"bankassist", confidence:0.63, signals:[decision-rules, agent:bankassist, model:owu-systemone/tev1:4b, latency:1422ms, decision_escalated]}`; логи `низкая уверенность 0.26–0.30 < 0.4 (primary clef-flash)` → `переход на эскалацию tev1:4b` → `OK tier=escalation confidence=0.63–0.77`; `GET /settings/decision/metrics` → `calls:2, handled:2, escalated:2, attempts:{primary:2,escalation:2}, rejected.low_confidence:2, by_model:{clef-flash:…, tev1:4b:…}`. Тестовые сессии удалены; `decisionRouting=false`; decision возвращён в `owu-systemone/tev1:4b`, порог 0.3; метрики сброшены.
- **Верификация (оркестратор):** build shared/core; `pnpm typecheck` 6/6; `pnpm lint` 0 errors; целевые core-тесты (cascade/metrics/classifier/model/rule-provider/settings) 152/152; UI 21/21; ссылки AD целы; AD-084/README/AGENTS согласованы. Пре-существующий флейк `core/src/server/app.remote.test.ts` (WS) не трогали.
- **Отклонения e2e:** исходный текст события отсечён dedup (`memory`) как повторный — использован уникализированный; в метриках `calls=2` из-за параллельного события (оба — эскалация). На вывод не влияет.
- **Ветка:** `docs/ad-normalization-089-external-events` (не запушена)
- **Коммит:** `6b154f3`, `0d86f69`, этот (журнал).


## 2026-10-12 — AD-090 «Extension API v1»: вынос из AD-086, Plugin ≠ Add-on, плагины в managed/hybrid
- **Задача:** «Проработать AD-086: изучить `deepseek-harness` (как получается, что всё — плагин); чётко зафиксировать Plugin ≠ Add-on; снять запрет плагинов в managed/hybrid (managed — установка админом), продумать install/activate и hybrid allow-list».
- **Тип:** docs (AD) + исследование архитектуры
- **Исполнитель:** @orchestrator (исследование/дизайн/верификация) → @fixer (создание AD-090; правки AD-086 и реестров)
- **Результат:** PASS
- **Исследование (`deepseek-harness`, read-only):** Cordis «all-plugin» — композиция profile+bundle+patch поверх пустого корня, seam-тройка Service Definition/Provider/Consumer, «registrations are effects» (disposer), peer-gate версии, merge-extensible event maps. **Ключевой вывод:** in-process код у них **сознательно не изолирован** («treat a dynamic package like bash access»; sandbox покрывает только spawn-argv) → для Synth основной безопасный путь — **add-on** (внешний сервис), а in-process плагины — только через trust/скан/политику. Взяты идиомы, не фреймворк.
- **Создано:** `docs/arch_decisions/ad-090-extension-api.md` (497 строк) — Extension API v1: терминология Plugin/Add-on/Declarative; 11 точек расширения (все уже имеют seam в коде); манифест `synth.plugin`; SDK `@itphx/synth-plugin` + disposer-модель; **bundle-only ESM** (ноль runtime-резолва npm); install/activate (`<home>/plugin/`, `plugins.lock.json`, `plugins.json`, пайплайн `PluginHost`, semver-гейт + exact-исключения); матрица режимов; **managed** (deploy-time — дефолт; runtime-install — опция `deny`; ADMIN; `pluginsWriteGuard`; запрет снятия builtin/management); **hybrid allow-list** (3 уровня силы; Уровень 2 — **server-scoped токены на `plugin_id`**, проектируется сразу; честная таблица силы энфорса по образцу AD-081); политики/конфиг (`plugins.*`, `GET/PUT/DELETE /api/v2/settings/plugins`, `/api/v2/plugins*`); связь с AD-068 (trust/scan/policy/quarantine/lock/audit); фазы Ф0–Ф5.
- **Обновлено:** AD-086 (зонтик: столп 1 → указатель на AD-090; новый раздел «Плагины, add-on'ы и режимы»; снятие ограничения «только standalone»; 4 открытых вопроса закрыты), AD-030 (ссылки на AD-090), `docs/arch_decisions/README.md` (строка AD-090; AD-086/AD-030), корневой `AGENTS.md` (индекс AD-086/AD-090, триггеры, AD-030, service-key).
- **Решения пользователя:** 1) Extension API — отдельный **AD-090**; 2) managed runtime-install — **включаем как опцию** (default `deny`); 3) hybrid allow-list — **сразу Уровень 2** (scoped-токены); 4) **bundle-only**; 5) каталог **AD-068 закладываем сразу**.
- **Верификация (оркестратор):** все 27 относительных ссылок AD-090 разрешаются; структура/стиль соответствуют AD-068/AD-081/AD-086; ESM-консистентность (репо `"type":"module"` → бандл `.js`, упоминания CJS убраны); **код не тронут** (`git status -- packages/` пусто); реестры AD (README/AGENTS) согласованы.
- **Ветка:** `docs/ad-normalization-089-external-events` (не запушена)
- **Коммит:** этот коммит — «docs: AD-090 Extension API v1 — вынос из AD-086, Plugin ≠ Add-on, плагины в managed/hybrid» (запись журнала включена в него)

## 2026-10-12 (продолжение) — Первый add-on: Telegram-шлюз + auto-bind (AD-089) + вынос Telegram из synth-media
- **Задача:** «Реализация первого Add-on'а — отдельный сервис в экосистеме Synth для взаимодействия с Telegram» (AD-086 §4 «Первый частный случай», AD-087 tombstone).
- **Тип:** feature/infra (новый внешний сервис ×2, правка ядра, правка synth-media) + docs
- **Исполнитель:** @orchestrator (исследование/дизайн/решения/верификация) → @fixer ×5, @tester
- **Результат:** PASS
- **Решения пользователя (обсуждение):** новый репо `addons/synth-gateway-telegram` (не расширение synth-media); транспорт — long-polling; обратный путь — гибрид (слежение за сессией + MCP-тулы); МВП + inline-кнопки/уведомления; binding — все 3 способа (UI, `/bind`, Router); классификация — «оба» (команды в шлюзе + decision в Router); обратный ответ — по `stream.done`; Telegram выносится из synth-media целиком; шаблон add-on'а — отдельный репо; правки ядра — в текущей ветке.
- **Фаза 0/6 — ядро (AD-089 auto-bind), `synth/`:** конфиг `events.autoBind` (default false) + `events.autoBindAgentTemplate`; новое решение Router `{kind:'bind'}` и цель правила `{mode:'bind'}`; Router-фоллбек при наличии `identity.chatKey|threadKey` → `bind` + сигнал `auto-bind` (влияет **только** на фоллбек); `RequestSessionService._materialize` создаёт постоянную сессию (без `expiresAt`) + `EventBinding{mode:'bound'}` (повтор/гонка → переиспользование); проброс в runtime-настройки, `GET/PUT/DELETE /settings/events`, UI-раздел «Параметры событий»; тесты (Router 7, материализация 3, схемы, settings round-trip, UI). Документация: AD-089 (раздел «Auto-bind»), README AD, корневой AGENTS, CONFIGURATION, API_V2, пакетные AGENTS.
- **Фаза 1 — `addons/synth-addon-template`** (новый git-репо, 0 коммитов): скелет (pnpm-workspaces, strict TS, eslint/prettier), `docs/ADDON-CONTRACT.md` (что такое add-on, точки интеграции API v2/MCP/события AD-089, обязательные требования, совместимость `addon.json`, структура, чек-лист), пример `apps/example` (Hono + MCP stdio + FileStore + egress-задел), Docker/Helm/compose/Fleet, CI GitVerse, README/AGENTS. Проверено: install/build/typecheck/lint/test (22), helm lint/template, docker build, runtime HTTP+MCP.
- **Фазы 2–5, 8 — `addons/synth-gateway-telegram`** (новый git-репо, 0 коммитов; 84 файла): по шаблону; `packages/telegram` (копия клиента Bot API из synth-media, +`reply_to_message_id`/`message_thread_id`); `apps/gateway` — long-polling, дедуп по `update_id`, нормализация `Update`→`Event` (`source:'telegram'`, `identity{principalId,chatKey,threadKey,roles}`, `dedupKey:telegram:<bot>:<update_id>`, fail-closed allowlist), ингест `POST /api/v2/events` (Bearer, ретраи), команды `/help|/start|/status|/bind|/unbind|/new` (+`/synth`,`/idea`→событие с `payload.label`), управление bindings/сессиями через API, watcher SSE `/api/v2/events` → `stream.done`→ответ в чат (чанкинг 4096, plain/HTML, reply/thread, персистентный дедуп), `stream.error`→уведомление, `answerCallbackQuery`; `apps/mcp` — stdio MCP (7 тулов: send/edit/delete/notify/send_buttons/get_me/status, dry-run без токена); `skills/gateway-telegram/SKILL.md`. Тесты 143.
- **Фаза 7 — вынос Telegram из `synth-media`:** удалены `apps/telegram-mcp/`, `packages/telegram/`, коннектор `channels/telegram.ts`, рендер `render/telegram.ts`, `TELEGRAM_*` из конфига/deps; модель каналов сохранена, публикация без коннектора → `channel_not_implemented` (501); идеи (`/api/ideas`, `idea_add|idea_list`) оставлены как вход пайплайна AD-089; секреты бота перенесены в `addons/synth-gateway-telegram/secrets/` (вне git), обновлены AGENTS/README/скилл `media-hub`. Тесты 28.
- **Фаза 8 (MCP opencode):** в `.opencode/opencode.json` сервер `synth-media-telegram` заменён на `synth-gateway-telegram`; `synth-media-receiver` оставлен (из его env убран неиспользуемый `TELEGRAM_PROXY_URL`).
- **Фаза 9 — верификация (@tester, живой Synth на отдельном порту):** auto-bind e2e PASS — `autoBind=true` → `{kind:'bind', signals:['auto-bind']}` + сессия + `EventBinding{mode:'bound'}`; повтор того же `chatKey` → та же сессия (`kind:'bound'`); `autoBind=false` → `drop no_route`; журнал фиксирует решения; настройки/артефакты откачены. Сборки/тесты: шаблон 22, шлюз 143, монорепо typecheck+lint зелёные. Известный недетерминированный флейк `core/src/server/app.remote.test.ts` (WS-auth) — не связан, кандидат в отдельную задачу.
- **Осталось (не в этом заходе):** фаза 10 — деплой (Docker/Helm/Fleet K3s, реальные Secret/PVC, интеграционный прогон шлюза против живого Synth с ботом); визуальная проверка UI-тумблера auto-bind в браузере; при желании — `unknownAgentTemplate` для `autoBindAgentTemplate`.
- **Ветка:** `docs/ad-normalization-089-external-events` (не запушена). **Коммитов не делали** (правило: только по явной просьбе) — все изменения в рабочих деревьях `synth/`, `synth-media/`, `addons/*`.

## 2026-10-12 (продолжение) — Живой прогон Telegram-шлюза: три дефекта ядра/шлюза и полный e2e
- **Задача:** довести живой прогон первого add-on'а до ответа агента в Telegram; попутно закрыть прокси-вопрос.
- **Тип:** verification (live e2e) + bug fix (core ×2, gateway ×2) + config/docs
- **Исполнитель:** @orchestrator (диагностика/решения/верификация) → @fixer ×4, @devops ×3
- **Результат:** PASS (e2e), 4 фикса
- **Прокси (решение пользователя):** основной — `http://top.itphx.loc:3129` (CONNECT), записан в `secrets/telegram_proxy_url`; SOCKS5 `9050` — запасной. Зафиксировано в `docker-compose.yml` (env `TELEGRAM_PROXY_URL` с приоритетом над файлом), `values.yaml` (прокси только через `existingSecret`; перечислены ключи Secret), README/AGENTS/secrets NOTES. Доступность из K3s проверена: DNS `top.itphx.loc` → `10.0.0.250`, оба прокси OK, **прямой egress закрыт** (прокси обязателен), `CONNECT 3129 → api.telegram.org` подтверждён. Коммит `a2be3e7`.
- **Дефект 1 (ядро, доставка):** глобальный SSE-хаб `GET /api/v2/events` в standalone подписывался на сессии по `listSessions({userId:'local'}) **на момент подключения**` → события сессий, созданных позже (весь events-funnel), терялись (`0 subscribers — EVENT LOST`), и внешний подписчик (шлюз) не получал `stream.done`. Фикс: безусловный `eventBus.subscribeAll` (как в гибриде).
- **Дефект 2 (ядро, владелец):** сессии из funnel (`ephemeral`/`bind`) создавались без `userId`/`ownerId` → выпадали из `listSessions`/UI и не подпадали под подписку. Фикс: `resolveOwnerId` в `RequestSessionService` (standalone → `local`; backend — per-event: authenticated user / создатель binding-key; fallback `identity.principalId`).
- **Дефект 3 (ядро, модель):** funnel-сессии не получали `provider`/`model` из дефолтов инстанса (`llm.defaultProvider`/`llm.defaultModel`) → агент не мог ответить на сообщение из события. Фикс: `resolveLlmDefaults` в funnel, добирает недостающее поле по отдельности, явные настройки приоритетнее.
- **Дефект 4 (шлюз, зависание):** запросы Bot API без таймаута → long-poll `getUpdates` мог виснуть навсегда (наблюдалось дважды). Фикс: таймауты (обычные ~30 с, `getUpdates` = long-poll + 15 с) на обоих путях (fetch и прокси-агент), `AbortController` на цикл поллера, `stop()` прерывает висящий запрос, backoff; честная health-проба Synth; env `GATEWAY_POLL_TIMEOUT_SEC`/`GATEWAY_REQUEST_TIMEOUT_SEC`; тесты на timeout/abort/probe.
- **E2E (реальный бот, прокси CONNECT 3129, standalone core :5012):** сообщение → `POST /events` → `{kind:'bind', signals:['auto-bind']}` → сессия (owner `local`, provider `itphx`, model `omn.qwen3.8:27b-256k`) → `stream.done` при 2 подписчиках → шлюз `sendMessage` (state `sent.json`: `message:mv5b9zms:2`, `message:mv5b9zms:4`); второе сообщение → `{kind:'bound'}` в ту же сессию. Диалог: «Ты еще тут?» → «Да, я тут! Чем могу помочь?» → «Какое название у сессии и проекта?» → ответ агента. Таймауты long-poll подтверждены (циклы без зависаний), `409 Conflict` нет.
- **Верификация:** core 2888 тестов (последовательно) / events+storage+server 615, backend 356; шлюз 163 (telegram 31 / gateway 102 / mcp 26); typecheck 6/6; lint 0 errors. Известные флейки: `app.remote.test.ts` (WS-auth), `task-resume.test.ts` — не связаны.
- **Осталось:** применить дельту `synth-deploy` в test (K3s, за пользователем): образ → SealedSecret → `gateway.enabled=true`; визуальная проверка UI-тумблера auto-bind. Тех.долг: `SYNTH_API_KEY` шлюза = broad ADMIN до AD-052 (service-keys); проба `Schedule.ownerId` не проставляется.
- **Коммиты:** `a2be3e7` (прокси-конфиг шлюза); фиксы 1–4 — **не закоммичены** на момент записи.

## 2026-10-12 (продолжение 2) — Коммит наработок (ядро/шлюз/UI) + редактор identityMap в админке + dev-подъём шлюза
- **Задача:** «Закоммить наработки, добавь в админку редактор identityMap. И объясни как у сессии телеграм владелец автоматически встал admin?»
- **Тип:** feature (UI) + chore (коммиты) + объяснение
- **Исполнитель:** @orchestrator → @fixer (UI-редактор), @devops (dev-подъём шлюза через docker-compose)
- **Результат:** PASS

### Коммиты (только локально, push не делался)
- **Ядро `synth`** — `2deb88f` `feat(events): identityMap владельца сессий и доставка событий funnel-сессий (AD-089)`: приоритет владельца (`identityMap` → per-event → `identity.principalId` → `resolveOwnerId`), добор `provider/model` из `llm.default*`, `onSessionMaterialized` → `EventHub.subscribeToSession` до доставки, runtime-настройка `events.identityMap` (валидация/merge/live). Файлы: `packages/{shared,core,backend}` + AGENTS/CONFIGURATION/AD-089.
- **Шлюз `synth-gateway-telegram`** — `e6484f1` `feat(gateway): OIDC client-credentials, таймауты Bot API, health-проба Synth`: `auth.ts` (oidc > api-key > none, кэш/refresh/401), файловый fallback `secrets/synth_api_key`, таймауты Bot API + abort поллинга, health `auth`/`token`, CLI `--oidc-*`/`--api-key`, chart/compose/docs.
- **UI `synth`** — `793a804` `feat(ui): редактор events.identityMap в админке «Параметры событий»`: контрол `KeyValueField` в Settings UI Kit, поле в `EventsSettings` (+ санитайз пустых ключей), тип в `synthApi`, i18n ru/en, тесты (`KeyValueField.test.tsx` + 10, `EventsSettings.test.tsx` + 2), `packages/ui/AGENTS.md`.
- **Журнал** — восстановлена ротация: шапка + `log.3.md` (2026-09-17 — 2026-10-07).

### Dev-шлюз (docker-compose)
- Причина невидимости сессий ранее: живой прогон шёл на изолированном standalone `:5012` (`tmp/gw-live/data`), а UI смотрит на dev `:5000` (`data/`).
- Для dev нужен файловый fallback API-ключа (сделан, `secrets/synth_api_key`) — контейнер поднимается без env.
- `packages/backend/config.yaml` (gitignored): `llm.defaultProvider: routerai`, `llm.defaultModel: qwen/qwen3.7-flash`.
- Dev перезапущен с новым кодом (`dev.sh all`, detached), `events.autoBind=true`, шлюз — `docker compose up -d --build` (`restart: unless-stopped`), health `{synth:up, bot:ok, watcher:up, auth:api-key, token:ok}`.
- OIDC-файлы в dev вынесены в `secrets/oidc/` — чтобы шлюз не переключился на OIDC (в dev — статический API-ключ).

### Почему у Telegram-сессии владелец `admin` (dev)
Debug-аутентификация: Bearer `admin-key-123` → тестовый пользователь с `id = 'admin'` (`username` как id). Шлюз ходит тем же ключом ⇒ `POST /api/v2/events` даёт `ownerId = 'admin'` (per-event владелец), UI залогинен тем же `admin` ⇒ сессия видна в списке. `identityMap` при этом пуст и не участвует. В test (OIDC) шлюз = `service-account-synth-gateway`, поэтому там без `identityMap` сессии уйдут машинному аккаунту.

### Верификация
- `synth`: `pnpm typecheck` 6/6, `pnpm lint` 0 errors, core 2895 (events+server 615), backend 358; UI 128 файлов / 1111 тестов.
- Шлюз: typecheck 3/3, lint 0 errors, тесты 31 + 130 + 26.
- Обоснована безопасность: JS-regex без catastrophic backtracking (`trim().length > 0`), порядок `Object.fromEntries` стабилен.

### Осталось
- Test-деплой отложен пользователем. Для него нужен новый образ backend (в кластере `0.9.0` без events-роутов → 404) + образ шлюза, SealedSecret, `gateway.enabled=true`.
- `identityMap` в test задаётся через админку (после деплоя) — `chat:telegram:450316139` → `sub` пользователя Keycloak.
- Тех.долг: broad-ADMIN ключ шлюза в dev; UI-редактор `identityMap` есть (кроме парсинга «сложных» значений); `Schedule.ownerId` не проставляется.

## 2026-10-12/13 — AD-089: идентичность внешних событий (Э1–Э6) + AD про шлюзы
- **Задача:** «Погоди, давай это обсудим… Как настроен маппинг? Группа с несколькими пользователями? Как выглядят их сообщения в одной сессии? Имена/профиль вместо id? Неизвестные? Просить сопоставить id и учётку?» Плюс: «Закоммить наработки, добавь редактор identityMap»; «Коммить как посчитаешь нужным»; «Шлюз не универсальный? Отказоустойчивость? Мультитенантность. Пока ничего не делай, дополни AD про шлюзы».
- **Тип:** feature + design (AD) + chore (коммиты)
- **Исполнитель:** @orchestrator → @fixer ×8 (Э1, Э2×2, Э3×2, Э4×2, Э5×2, Э6×2, AD, NOTES)
- **Результат:** PASS

### Принятые решения (пользователь)
- Маппинг: **профиль `ProfileData.identities[]`** (self-service) + `events.identityMap` как override.
- Групповая сессия: **командная (проектная)**.
- Claim-flow: **сделать целиком**; код только в приватном чате (наше решение, гейт по `chatType`).
- Видимость: **сессии проекта — участникам; ADMIN и LEAD — сквозной обзор**.
- Шлюз: направление — **мультитенантность** (не реализуем пока), HA — **leader election** (решение, не реализовано).

### Ключевое (по факту кода)
- **Ключ владельца — человек** (`identity.principalId`), чат — только routing (`chatKey`). Приоритет: `resolveExternalIdentity` → `identityMap` (principalId→chatKey) → per-event → `resolveOwnerId`. `identity.principalId` больше **не** id сессии (был баг: `tg:<id>` в `userId`).
- **Attribution:** `eventToMessage` ставит `author` (`@username` → имя → `tg:<id>`) + `metadata.principal_id/chat_key/thread_key`; доходит до LLM тем же путём, что `Scheduler`. `displayName` профиля приоритетнее tg-имени для слинкованных.
- **Claim:** `IdentityClaimStore` (код `XXX-XXX`, алфавит без `0/O/1/I`, TTL 10 мин, одноразовый, атомарный consume) → `POST /me/identities/claim` (400/404/409; provider/externalId — из серверной записи) → код в `identityHint` ответа `POST /events` → шлюз показывает **только в ЛС**.
- **Права:** база — роли профиля; `identity.roles` (allowlist шлюза) только **сужают**; несопознанный → без прав (fail-closed). **Enforcement (role-aware) — остаток**: `PermissionEvaluator` роль-оси не имеет; роли доставляются в `metadata.effective_roles` (аудит/задел). Альтернатива — AD-052 service-key.
- **Видимость:** `isSessionVisible` (elevated → всё; владелец/без владельца → видно; проектные — owner+members); `listForUserScope`; `canRead` для проектов (manage/edit **не** расширены).

### Коммиты
- `synth` (ветка `docs/ad-normalization-089-external-events`): `793a804` (UI-редактор identityMap), `681e3b1` (идентичность+видимость, Э1/Э3/Э4/Э6 + AD-086/089 + редактор AD), `12ab4af` (Э5 права), `2583131` + этот (журнал).
- `addons/synth-gateway-telegram`: `e977071` (Э2+Э4 шлюза), `0dad06d` (доки allowlist).
- `synth-deploy`: `841ea15` (дельта gateway; **push не делался**).
- Push нигде не выполнялся (только локальные коммиты).

### Верификация
- core 2999, backend 365, UI 1122; аддон 31+160+26 = 217; typecheck 6/6; lint 0 errors.
- Подтверждённый **флейк** `app.remote.test.ts` (WS cookie v2, 5 с) — 2/3 в точечных прогонах, в полном наборе зелёный; к правкам не относится.
- **Dev e2e (шлюз, docker-compose):** 4 события → решения `bind`/`bound` → сессия `mv5g1k35-…` → ответы доставлены (`sent.json` message:…:2/4/12/21). Транзиентные сбои прокси (`socket hang up`, `invalid_json 503`, `aborted`) ретраятся с backoff, прокси жив (CONNECT 200, 763 мс), бэклога нет (`offset` продвигается).

### Осталось / тех.долг
1. **Role-aware enforcement** (Э5 остаток) или AD-052 service-key (убирает broad-ADMIN ключ шлюза).
2. **K3s test**: нужен новый образ backend (в кластере 0.9.0 без events-роутов → 404) + образ шлюза, SealedSecret, `gateway.enabled=true`, `events.autoBind=true`, `identityMap`/claim. Push `synth-deploy` — за пользователем.
3. **Шлюз-hardening**: прокси-агент создаётся на каждый запрос (CONNECT-туннели рвутся) — кэш агента/keep-alive + контекст в ошибках `aborted`.
4. `events.identityMap` в dev выставлен на `chat:telegram:450316139 → admin` (избыточно для debug — убрать по желанию).
5. Ключ `2deb88f` не входит в эту серию (коммит до неё); ROADMAP: UI-редактор identityMap есть, роль-ось enforcement — нет.

## 2026-10-13 — AD-052: план публичной API-платформы; AD-029 — чистка

- **Задача:** «Давай добьём AD-029 и 5 этап» → уточнение семантики ролей → «Сосредоточимся на AD-052 — нужны сервисные ключи» → «Всё AD-052 целиком» → «Зафиксируй решения и план в AD-052».
- **Тип:** design (AD) + docs
- **Исполнитель:** @orchestrator → @fixer (AD-029), @researcher (инвентаризация AD-052), @fixer (AD-052 + индексы)
- **Результат:** PASS

### Принятые решения
- **Роли = доступность эндпоинтов** (HTTP). Внутри сессии набор тулов/разрешений **одинаков для всех** (режим + capabilities агента + MCP/скиллы). Роль-ось в permission-слое (`PermissionEvaluator`, AD-029) **не нужна by design** (мой прежний «Э5 остаток» снят как некорректная постановка).
- **Tenants исключены из AD-052**: артефакт SaaS-шаблона; модель Synth — self-host (изоляция = инстанс), группировка = проект (AD-014). Заменено на `scopes` + проекцию `allowedProjects`. В AD-086 «тенант» = другой инстанс (не путать).
- **AD-052 = 4 блока:** ① service-key + scopes ② webhooks ③ public-OpenAPI (`@hono/zod-openapi`) + SDK ④ перевод шлюза на service-key.
- **OpenAPI — только public-спека** (интеграционное ядро: events/bindings/sessions/schedules/llm; ~42 хендлера). Полную internal-спеку не публикуем (заморозка контракта, fs/audit/admin в публичке = приглашение, scopes схлопнулись бы в ADMIN).
- **Scopes — именованные** (`events:ingest`, `sessions:create`, `llm:chat`, …), enforcement `requireScope` рядом с `requirePermission`; service-key — отдельный `ServiceApiKeyStore` (`synth_svc_`, `service-keys.json`), binding-key (AD-089) не трогаем.

### Что сделано
- **AD-029** — удалены вложенные устаревшие копии AD-030/031/032 (145 строк; 197 → 52). Покрытие 13/13 пунктов отдельными файлами — ничего не потеряно.
- **AD-052** — переработан: разделы «Почему без tenants», «Service-key», «Scopes», «Проектная проекция ключа», «OpenAPI — только public», «SDK», «Webhooks», «План реализации (этапы I–IV)»; обновлены статус, решение, открытые вопросы.
- **Индексы/AGENTS:** строка AD-052 в индексе + «Куда смотреть» (корень), `docs/arch_decisions/README.md`; в AD-089 убрано «тенанта», добавлены `scopes`/`allowedProjects`.
- **Согласование дизайна:** правки «остаток/role-aware enforcement» → «by design» в `AGENTS.md` (корень), `packages/core/AGENTS.md`, `packages/backend/AGENTS.md`, AD-089 (убрано чтение как недоделка).

### Коммит
- `synth` (ветка `docs/ad-normalization-089-external-events`): `4a4202c` — `docs(ad): AD-052 план публичной API-платформы; AD-029 — чистка вложенных AD` (только документация, код не менялся). Push не делался.

### Проверки
- Только `.md`; ссылки AD-052 валидны (10/10); `grep` — «тенант» только в разделе «Почему без tenants»; «role-aware enforcement не введён» нигде не осталось; ad-029 — единственный заголовок AD-029.

### Следующие шаги (этапы AD-052, с остановкой после каждого)
1. **Этап I** — service-key + scopes + spike `@hono/zod-openapi` (2–3 эндпоинта `events` + единый формат ошибок). Критерий: scoped service-key работает, spike подтвердил/опроверг подход.
2. **Этап II** — webhooks (модель подписки, store, доставка над `EventBus.subscribeAll`, HMAC-подпись, retry/backoff, дедуп, SSRF-политика, API/UI).
3. **Этап III** — public-OpenAPI (обёртка ~42 хендлеров) + пакет `@itphx/synth-sdk`.
4. **Этап IV** — перевод `synth-gateway-telegram` на scoped service-key.

### Тех.долг (актуальное)
- **Role-aware enforcement — снят** (не требуется by design; см. выше).
- **K3s test** — нужен новый образ backend (в кластере 0.9.0 без events-роутов → 404) + образ шлюза, SealedSecret, `gateway.enabled=true`, `events.autoBind=true`. Push `synth-deploy` — за пользователем.
- **Шлюз-hardening** — прокси-агент создаётся на каждый запрос (CONNECT-труннели рвутся) → кэш агента/keep-alive + контекст в ошибках `aborted`.
- `events.identityMap` в dev = `chat:telegram:450316139 → admin` (избыточно для debug).

## 2026-10-13 — AD-052 «Публичная API-платформа»: этапы I–IV реализованы (полностью)

- **Задача:** «Добиваем AD-052. Изучи, если нужно что-то уточнить, давай обсудим» → «Все этапы подряд, коммить как посчитаешь нужным, уточнять по ходу». Плюс отдельная просьба: параллельно починить флейк `app.remote.test.ts`.
- **Тип:** feature (shared/core/backend/ui) + spike (OpenAPI) + feature (webhooks) + новый пакет (SDK) + feature (addon-шлюз) + docs + test-fix.
- **Исполнитель:** @orchestrator → @explore ×1 (инвентаризация), @fixer ×10 (ядро service-key; backend; UI; docs; флейк; spike; webhooks-ядро; webhooks backend; webhooks UI; docs; public-OpenAPI; SDK; шлюз), верификация — оркестратор.
- **Результат:** PASS (все 4 этапа закрыты; e2e публичного контура подтверждён).

### Решения пользователя (развилки)
- Все этапы подряд, коммит по усмотрению оркестратора.
- Разрешена новая зависимость `@hono/zod-openapi`.
- Scopes: **именованные + wildcard семейства** (`events:*`, `sessions:*`, …), глобального `*` нет.
- Service-key несёт **`roles[]` + `scopes[]` + `allowedProjects[]`** (роли → совместимость с `requirePermission`; scopes → точечный гейт).
- UI управления service-ключами — сразу в этапе I.

### Этап I — service-key + scopes + spike OpenAPI (+UI)
- **shared:** `types/service-keys.ts` (`ServiceApiKey`/`…Created`/`Create…`/`Update…`; `SERVICE_SCOPES` 14 + `SERVICE_SCOPE_FAMILIES` 6, `hasServiceScope` exact/`family:*`, `isKnownScope`), Zod-схемы, `GlobalRole` (не `Role`).
- **core:** `storage/service-api-key-store.ts` (`{dataDir}/service-keys.json`, `synth_svc_<base64url>` → sha256 at-rest, глобальная уникальность `label`, `resolveBySecret`/`touch`/`revoke`, `ServiceApiKeyConflictError`); `server/service-scope.ts` (`requireScope` — no-op для не-service кред, иначе 403 `SCOPE_REQUIRED`; `isProjectAllowed`/`checkProjectAccess` → 403 `PROJECT_FORBIDDEN`; `getServiceCredential`); `server/routes/service-keys.ts` (`createServiceKeyRoutes`); auth-ветка `synth_svc_` в `auth/local.ts` (+`LocalAuthConfig.resolveServiceKey`); scope/project-гейты в `events`/`sessions`/`schedules`; монтирование в `server/app.ts`; экспорты.
- **backend:** ветка service-key в `auth/middleware.ts` (`AuthMiddlewareConfig.resolveServiceKey`), синтетический пользователь `service:<keyId>` с `roles`; `routes/service-keys` (RBAC ADMIN); `scopeGuard`/`projectGuard` для events/schedules/sessions; `llm:chat` на LLM Proxy; глобальный per-key rate limit (`KeyRateLimiter`); i18n.
- **UI:** админ-раздел «Сервисные ключи» (`ServiceKeysSettings.tsx`, Settings UI Kit; `MultiSelectField` для ролей/scopes/проектов; однократный секрет + curl; revoke/delete; ADMIN-гейт).
- **Spike OpenAPI:** зависимость `@hono/zod-openapi@^0.19.10` (1.x требует zod v4 → только 0.19.x совместимо с нашим zod 3.25); `server/openapi/public-openapi.ts`: `OpenAPIHono` + `createRoute`, `publicErrorSchema` (`{error:{code,message}}`), `GET /api/v2/openapi.json` (core+backend, за `requireAuth`).

### Этап II — исходящие webhooks
- **shared:** `types/webhooks.ts` (`WebhookSubscription`/`…Created`/`WebhookDelivery`, `whsec_`-секрет, `DEFAULT_WEBHOOK_EVENT_PATTERNS`, `matchWebhookEvent`), Zod-схемы, конфиг `webhooks` (`enabled` default **false**, `maxAttempts` 5, `timeoutMs` 10000, `allowPrivateTargets` false, `deliveryRetentionDays` 30).
- **core:** `storage/webhook-store.ts` (**signing-секрет шифруется AES-256-GCM** мастер-ключом — HMAC требует исходный секрет) + `webhook-delivery-store.ts` (JSONL); `engine/webhooks/{signature,network,service,prune}.ts` — доставка над `eventBus.subscribeAll`, HMAC-SHA256 (`X-Synth-Signature: t=…,v1=…`), retry/backoff, дедуп, SSRF-политика (переиспользует `engine/mcp/network-policy.ts`); API `createWebhookRoutes`; монтирование в core.
- **backend/UI:** монтирование (RBAC ADMIN; сервис подписан на общий `eventBus`), админ-раздел «Webhooks» (`WebhooksSettings.tsx`; однократный секрет + пример проверки подписи; тумблер/regenerate/test/журнал доставок; ADMIN-гейт).

### Этап III — public-OpenAPI (полная) + SDK
- **core:** `public-openapi.ts` расширен до **28 операций** интеграционного ядра (events 13, sessions 8, schedules 6, llm 1), **именованные** `components.schemas` (через `.openapi('Name')` — shared-схемы не мутируются), единый формат ошибок на всех операциях, `servers:[/api/v2]`, `security: bearerAuth`.
- **Новый пакет `packages/sdk` (`@itphx/synth-sdk`, 7-й):** `createSynthClient({baseUrl, serviceKey|apiKey|token, fetch?})`, namespaces `events`/`sessions`/`schedules`/`llm`, `SynthApiError`, типы из browser-safe subpath'ов shared, ESM, зависимость только от shared.
- **Инфра:** `scripts/{publish-packages,publish,version-bump,wait-npm-version,build}.sh`, `docs/PUBLISHING.md`, `.gitverse/workflows/{ci,release}.yaml`, корневой `AGENTS.md` (6→7 пакетов), скилл `synth-build-publish`.

### Этап IV — перевод Telegram-шлюза на service-key (репо `addons/synth-gateway-telegram`)
- Новый режим `AuthMode = 'service-key' | 'oidc' | 'api-key' | 'none'`; приоритет **service-key → oidc → api-key → none**; `SYNTH_SERVICE_KEY`/`--service-key`/`secrets/synth_service_key`; health отражает режим; деплой-манифесты (compose/Helm/Secret/NOTES/.env.example) и доки обновлены; зафиксированы требуемые scopes (`events:ingest`, `events:watch`, `bindings:read|write`, `sessions:create|read`) и роль `LEAD` (мутации bindings). Пробелов в `synth/` не найдено.

### Флейк `app.remote.test.ts` (отдельная просьба)
- Причина — **гонка в тесте**: подписка на WS-`message` после события `open`; кадр `connected` приходит в том же TCP-чанке и теряется. Фикс: хелпер `connectCollecting` (подписка до `open`); 10/10 изолированно, core 5/5 серий, полный монорепо зелёный.

### Верификация (оркестратор)
- `pnpm build` (7 пакетов) — OK; `pnpm typecheck` **7/7**; `pnpm lint` **0 errors**; `pnpm test` — shared 222 · **sdk 24** · core 3067 · ui 1160 · backend 380, 0 failed.
- Шлюз (репо addon): `build`/`typecheck`/`lint`/`test` **228 passed**, `helm lint`/`template` OK.
- **E2E публичного контура** (изолированный standalone-core `:5099`/`:5098`, отдельный dataDir): создание service-key (секрет один раз), `sessions`(scope)→200/403 `SCOPE_REQUIRED`, без auth→401, обычный ключ→200, `events` ingest→201, `bindings` write→201, `events/journal`→200, `openapi.json`→200, `webhooks` при `enabled:false`→503, пустые scopes→400, битый ключ→401. Тестовые данные удалены.

### Коммиты
- **`synth`:** `383c6b8` (ядро service-key), `e384b67` (backend+UI), `ea84dec` (docs I), `c39794d` (флейк), `8d99086` (spike OpenAPI), `1211108` (webhooks ядро), `a88fb86` (webhooks backend+UI+docs), `1751d94` (public-OpenAPI 28 операций), `a5c848c` (пакет SDK), `80a5851` (docs III), этот (журнал).
- **`addons/synth-gateway-telegram`:** `f8f2113` (service-key в шлюзе).
- Push не выполнялся.

### Замечания / остаток
- **Per-key rate limit** service-key реально энфорсится **только в managed** (глобальный middleware backend); в core поле хранится, но не применяется — задокументировано.
- **zod остаётся v3** → OpenAPI только `@hono/zod-openapi@0.19.x`; апгрейд до 1.x = отдельная миграция на zod v4 по монорепо (вне AD-052).
- Правки **AGENTS.md** (корневой + core/backend/shared/ui + новый sdk) внесены по инварианту 15 — **на согласование пользователя**; при несогласии легко откатить.
- **Осталось (вне кода AD-052):** K3s test (новый образ backend + шлюза, SealedSecret, `gateway.enabled=true`, `autoBind=true`; push `synth-deploy`); реальный e2e шлюза с ботом под service-key в test; версионирование public-спеки (открытый вопрос AD-052); обновление `openapi-typescript`-генерации типов для SDK (сейчас SDK берёт типы из shared).
- `events.identityMap` в dev = `chat:telegram:450316139 → admin` (избыточно для debug).

## 2026-10-13 (продолжение) — AD-052 этап IV применён: шлюз на service-key + фикс доставки; docs-UI отклонён

- **Задача:** «перенастроить шлюз в телеграм на сервисный ключ dev — создай ключ, поправь настройки, задеплой, протестируем»; затем «покажи как посмотреть openapi»; затем «Swagger добавь, можно ли только админам?» → «откуда оно грузит? закрытый контур — не подходит» → «не будем делать UI, оставь пометку в AD».
- **Тип:** infra/deploy + bug fix + design-decision + docs
- **Исполнитель:** @orchestrator → @devops (деплой шлюза), @fixer (фикс доставки); AD/индексы — @orchestrator.
- **Результат:** PASS.

### Этап IV применён (dev)
- Создан service-key `telegram-gateway-dev` (роль `LEAD`; scopes `events:ingest|watch`, `bindings:read|write`, `sessions:create|read`), секрет — `addons/synth-gateway-telegram/secrets/synth_service_key` (0600, gitignored). Шлюз пересобран и перезапущен: health `auth: "service-key"`.
- Проверено тем же ключом: `GET /events/bindings` → 200, `GET /sessions` → 200; `GET /schedules`/`GET /events/routes` (нет scope) → 403 `SCOPE_REQUIRED`.

### Баг, вскрытый живым тестом (и фикс)
- Симптом: сообщение в Telegram → сессия и ответ агента в Synth создаются, но **ответ не уходит** в Telegram.
- Причина (лог dev-backend `[EventHub] Register client: user=telegram-gateway-dev … sessions=0`): `EventHub.registerClient` подписывал SSE-клиента только на **свои** сессии (`listSessions({userId})`); у service-key синтетический пользователь `service:<keyId>` сессиями не владеет → подписок 0 → `stream.done` не доходил. С broad-`admin`-ключом это скрывалось (сессия принадлежала `admin`).
- Фикс (`synth`): `EventHub` — режим `allSessions` (глобальная подписка `eventBus.subscribeAll`, паритет со standalone-core); SSE/WS включают его для service-key и elevated (ADMIN/LEAD). Тесты backend 387 (интеграционный: SSE с service-key получает `stream.done` **чужой** сессии; без scope → 403). **Коммит `0ffe404`**; dev перезапущен (backend без hot-reload) — в логе `Register client (all sessions)`; повторный тест пользователя: **работает**.

### Swagger/docs-UI — решено НЕ делать
- Реализация UI-просмотра спеки отменена по требованию пользователя (не из-за сложности, а из-за egress).
- **Причина:** `@scalar/hono-api-reference` (MIT) отдаёт HTML, подгружающий JS-бандл Scalar с CDN (`jsdelivr`/`unpkg`) + возможные внешние шрифты → неконтролируемый egress и неработоспособность в закрытом контуре/air-gap (проверено по исходникам пакета).
- **Зафиксировано в AD-052** (§«Заделы и возможные улучшения»): требование к возможному docs-UI — полностью self-hosted без внешних запросов; кандидаты на будущее — `swagger-ui-dist` (Apache-2.0, ассеты локально) или `redoc` standalone (глушение шрифтов). AD-052 переведён в **✅ Реализовано (этапы I–IV закрыты)**; обновлены AD-052-тело, README AD (строка перенесена в «Актуальные»), корневой `AGENTS.md` (AD-052/AD-089).

### Замечания
- Правки AGENTS.md (backend — watch-all; корневой — индекс AD) — по инварианту 15, на согласование.
- Остаётся: test/preprod деплой (образы + SealedSecret `synth-service-key`, `gateway.enabled=true`); `events:watch`-семантика watch-all осознанно широка для инстанс-локальных service-key — задокументировано.

## 2026-10-13 (продолжение 2) — AD-089: актуализация NEXT-STEPS + срез M «доводка + синхронизация» (M1–M5)

- **Задача:** «Продолжим путь к реализации AD-089. Что у нас дальше? Проанализируй, актуализируй `AD-089-NEXT-STEPS.md`, обсудим».
- **Тип:** анализ/дизайн (roadmap) + docs-sync + fix (core) + fix (add-on) + infra-prep (K3s test).
- **Исполнитель:** @orchestrator (анализ/план/верификация) → @fixer ×3 (M3 — core; M1 — docs; M2 — add-on), @devops (M5), верификация — оркестратор.
- **Результат:** PASS (M1–M3, M5); M4 отменён по факту (см. ниже).

### Анализ NEXT-STEPS
- Старая таблица A–G (ревизия 2026-10-10) почти исчерпана: **A** (decision/LLM-классификация) — ✅ AD-084; **C** (service-key) / **D** (webhooks) / **E** (идентичность отправителя→профиль/RBAC) — ✅; **B** (Telegram-шлюз) — рабочий MVP (`addons/synth-gateway-telegram`), AD-086 как AD не закрыт; остались **F** (Plugin SDK, AD-090) и **G** (пайплайны, AD-059). Сверх плана закрыт **AD-052 целиком** (этапы I–IV).
- `AD-089-NEXT-STEPS.md` переписан под состояние 2026-10-13: таблица закрытых срезов с коммитами, реальный остаток AD-089, открытые вопросы, тех.долг, новый список кандидатов (H — AD-090; I — AD-059; J — AD-086 остаток/второй канал; K — стриминг наружу; L — гранулярность bound/мультитенантность; M — доводка+синхронизация). Приложение A (исследование decision-моделей) помечено как реализованное (AD-084).
- **Решение пользователя:** срез **M целиком** (M1–M5); большой трек (H/I/J+K) — пока не выбираем.

### M3 — core: per-key rate limit service-key (паритет core ↔ backend)
- Было: лимит энфорсился только в managed backend (`packages/backend/src/app.ts`), в core `rateLimitPerMinute` хранился, но игнорировался.
- Стало (`packages/core/src/server/app.ts`): глобальный middleware после `requireAuth` — один `KeyRateLimiter(60_000)` на приложение; `credential?.rateLimitPerMinute ?? 0`, `0`/не задан → без лимита; превышение → 429 `RATE_LIMITED`; интерактивные креды — no-op. Тест `packages/core/src/server/service-key-rate-limit.test.ts` (5: N+1→429, `0`/отсутствие→без лимита, независимость окон по `keyId`, api-key no-op) + строка в `packages/core/AGENTS.md`.

### M2 — add-on `synth-gateway-telegram`: `strategy` + hardening транспорта
- **Helm:** `charts/.../values.yaml` + `templates/deployment.yaml` — добавлен `strategy.type: Recreate` (singleton-поллер, `getUpdates` → `409 Conflict` при rolling). Закрыт пробел AD-086.
- **Транспорт:** `packages/telegram/src/transport.ts` создавал `createProxyAgent(proxyUrl)` на каждый запрос и уничтожал на таймауте/abort → агент переиспользуется (ленивое создание на клиент, `close()` — teardown, шов `createProxyAgentImpl`); ошибки (вкл. `aborted`/обрыв CONNECT) обогащены контекстом `[<method> <url без токена> proxy=…]`. `packages/telegram/src/{client,types}.ts`, `apps/{gateway,mcp}/src/index.ts` (закрытие клиента). Тесты +5.
- Замечено (не менялось): в `addons/synth-addon-template` чарт тоже без `strategy` — кандидат на отдельную правку.

### M1 — docs-sync статусов (AD-089/AD-086)
- Синхронизированы: `docs/arch_decisions/ad-089-external-events-automation.md` (шапка «Статус»/«Обновлено», §«Не реализовано» → остаток + блок «Закрыто реализацией», §«Связи»), `docs/arch_decisions/README.md` (AD-089/AD-086), корневой `AGENTS.md` (индексы AD-089 ⚠️ и AD-086 → ⚠️ «первый add-on реализован»), `docs/ARCHITECTURE.md` (остаток AD-052 снят, ссылка Plugin SDK AD-086→AD-090). Пакетные AGENTS/`API_V2.md`/`CONFIGURATION.md` — уже корректны. Ссылки 0 битых; grep устаревших формулировок чист.
- Правки `AGENTS.md` — по инварианту 15, **на согласование пользователя**.

### M4 — удаление dev `events.identityMap` — ОТМЕНЕНО (неверная посылка)
- Проверка: у admin `ProfileData.identities: []` (профильной привязки нет), а `_resolveSessionOwner` (`engine/events/request-session.ts`) ставит `deps.identityMap` (по `chatKey`) **раньше** per-event-владельца; для service-key per-event владелец = `service:<keyId>` (не admin).
- Вывод: `chat:telegram:450316139 → admin` — **единственная** привязка Telegram-чата к админу; удаление увело бы сессии шлюза из `listSessions({userId: admin})`/UI. Оставлено как есть; «правильная» замена — claim-flow (`POST /me/identities/claim`), за пользователем.

### M5 — K3s test: подготовка выката (без применения/пуша)
- Репо `synth-deploy` (Fleet GitOps; add-on-чарт шлюза в test **не подключён** — деплой через чарт-в-корне `synth-deploy`): `values.yaml` (backend `0.9.0→0.10.0`, `backend.config.events.autoBind=true`, gateway pullPolicy/comments), `templates/backend-config.yaml` (new, ConfigMap `synth-config` → `/etc/synth/config.yaml`), `templates/backend-deployment.yaml` (mount), `templates/gateway-sealedsecret.yaml` (per-`encryptedData`), `scripts/seal-gateway-secrets.sh` (new, kubeseal `--scope strict`), `README.md` (runbook + откат).
- Dry-run: `helm lint`/`template` OK; `kubectl apply --dry-run=server` (обе фазы) — валидно; скрипт пломбирования прогнан на копии. Проверено: живой 0.9.0 → `/api/v2/events` 404 (роутов нет).
- Открытые вопросы: тега `synth-backend:0.10.0` в реестре ещё нет (собрать/запушить); UI в test остаётся 0.9.0; service-key создать можно только после фазы 1; `addons/.../fleet.yaml` не подключён (риск двойного деплоя при подключении); `events.autoBind` через config.yaml перекрывается runtime `settings.json`.

### Верификация (оркестратор)
- `pnpm typecheck` — 7/7 Done; `pnpm lint` — 0 errors (184 pre-existing warnings в backend); core-тест M3 — 5/5 (изолированно); add-on M2 — build/typecheck/lint/test + `helm lint/template` (36/171/26, +5); M5 — dry-run server-side без apply.

### Коммиты
- **Не делались** (инвариант 13): изменения в `synth/` (M1/M3), `addons/synth-gateway-telegram` (M2), `synth-deploy` (M5) — незакоммичены; пуш/apply — за пользователем.

### Следующие шаги
- За пользователем: коммиты/пуш (synth, add-on, synth-deploy), выкат K3s test (runbook M5), решение по M4 (оставить/claim-flow), выбор большого трека (H AD-090 / I AD-059 / J+K шлюз).
- Отложено: миграция zod v3→v4 (OpenAPI 1.x); `strategy` в `synth-addon-template`.
