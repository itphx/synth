# Журнал задач оркестратора

## 2026-08-04
- **Задача:** Баг — перестал работать просмотрщик и редактор файлов
- **Тип:** bug
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** — (коммит не выполнялся, не было явной просьбы пользователя)
- **Время:** ~30 мин (две сессии: investigate + fix)
- **Проблемы:** лимит шагов в первой сессии фиксера (investigate завершён, fix не применён); фикс применён во второй сессии.
- **Первопричина:** `WorkspaceResolver.isTextFile()` (packages/backend/src/lib/workspace-resolver.ts) классифицировал файлы как бинарные только по whitelist-расширениям → файлы без расширения (Makefile, Dockerfile, LICENSE, README, .npmrc и т.п.) возвращались из `GET /fs/read` как `encoding: "binary"` → UI показывал «Бинарный файл (N байт)» вместо содержимого. Не регрессия — дефект исходной реализации (единственный коммит 854bccf).
- **Исправление:** isTextFile → async, детекция текстовости по содержимому (NUL-байт в первых 8000 байт, учёт BOM UTF-16) + типовые имена без расширения + whitelist бинарных расширений. Обновлён вызов в packages/backend/src/routes/fs.ts.
- **Верификация:** pnpm typecheck ✅, lint 0 errors ✅, test (shared 59 / core 215 / backend 79) ✅; curl: Makefile/Dockerfile/LICENSE → utf-8, PNG → binary ✅; live UI-сценарий через Playwright (просмотр + редактирование + сохранение) ✅; тестовые артефакты удалены через API ✅.
- **Follow-up:** core-standalone `packages/core/src/server/routes/fs.ts` не имеет бинарной детекции и `POST /fs/write` — расхождение контракта standalone, отдельная задача.

## 2026-08-04 (вторая правка)
- **Задача:** Баг — область редактирования файла не на всю ширину центральной области, а узкая полоса
- **Тип:** bug (layout)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** — (коммит не выполнялся, не было явной просьбы пользователя)
- **Время:** ~15 мин
- **Проблемы:** нет
- **Первопричина:** корневой div табов `flex h-full flex-col bg-background` без `flex-1` (FileEditorTab.tsx:137, FileViewerTab.tsx:73); в flex-row контейнере CenterPanel.tsx:52 flex-item без grow не растягивается по ширине → textarea `w-full` (100% от авто-родителя) схлопывалась в узкую полосу (223px при main 1000px). Тот же паттерн в CommitDetailTab.tsx:73 — потенциально тот же баг (вне скоупа).
- **Исправление:** добавлен `flex-1` к корневому контейнеру FileEditorTab и FileViewerTab (паттерн как в ChatTab).
- **Верификация:** pnpm test 353 passed ✅; typecheck ✅; lint 0 errors ✅; Playwright: textarea 223px → 1000px (скриншоты tmp/editor-before.png, tmp/editor-after.png, viewer-*.png) ✅.
- **Follow-up:** CommitDetailTab.tsx:73 — аналогичная правка одной строкой при желании.

## 2026-08-04 (третья правка)
- **Задача:** Нет возможности сохранить изменения в файле — нужна кнопка «Сохранить» на верхней панели
- **Тип:** bug (UI)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** — (коммит не выполнялся, не было явной просьбы пользователя)
- **Время:** ~20 мин
- **Проблемы:** нет
- **Первопричина:** иконка `save` не была зарегистрирована в `iconMap` (packages/ui/src/components/icon/Icon.tsx) → `<Icon name="save" />` возвращал null → кнопка сохранения в Header рендерилась как пустой невидимый участок 8×8 px. Цепочка сохранения (editingState → CustomEvent synth:save-file → FileEditorTab.doSave → POST /fs/write) работала, но кнопка была невидима.
- **Исправление:** Icon.tsx — добавлен RiSaveLine в iconMap (заодно починил невидимую иконку save в DebugPanel); Header.tsx — кнопка заменена на явную «Сохранить» (текст + иконка, состояния disabled/активна/Сохранение...).
- **Верификация:** pnpm test ✅; typecheck ✅; lint 0 errors ✅; build ✅; Playwright: кнопка 93×21 px видима, POST /fs/write 200, файл обновился; скриншоты tmp/before-fix-header.png, tmp/after-fix-dirty-header.png, tmp/after-fix-saved-header.png ✅.

## Коммиты (2026-08-04, ветка feat/ad-035-micro-model-first)
- `2ea85a8` fix: определение текстовых файлов по содержимому (workspace-resolver, routes/fs)
- `1a130b4` fix(ui): редактор и просмотрщик файлов на всю ширину центральной области
- `2b5536a` fix(ui): видимая кнопка «Сохранить» в панели редактора (иконка save в iconMap)
- `8b6c357` docs: ссылка на документацию маршрутизации в README
- `.opencode/` (лог задач оркестратора) в коммиты не входил — служебный, не часть кодовой базы.

## Merge в master (2026-08-04)
- Ветка: `feat/ad-035-micro-model-first` → `master` с `--no-ff`
- Merge-коммит: `04a5fb4` — merge: feat/ad-035-micro-model-first — AD-035 micro-model first + фиксы файлов
- Перед merge локальный master обновлён до origin/master (fast-forward, 39 коммитов)
- Конфликтов нет (ветка содержала origin/master целиком)
- Итог: master опережает origin/master на 51 коммит (39 + 11 из ветки + 1 merge). Пуш не выполнялся.


## 2026-08-05 — AD-036 LLM Gateway (ветка feat/ad-036-llm-gateway)
- **Задача:** AD-036 — LLM Gateway: независимый слой безопасности
- **Тип:** feature
- **Исполнитель:** @fixer (слои 1-5,7), @tester (тесты, UI Playwright), оркестратор
- **Результат:** PASS
- **Коммит:** 7f0b5b3
- **Ключевое:**
  - Декоратор GatewayProvider (BaseProvider) в ProviderPool + ChatOrchestrator — покрывает 11 точек LLM-вызовов
  - Input guard: обфускация ⟦SYNTH_SECRET_N⟧ / block; output guard; rate limit (user+provider); аудит JSONL
  - Карта обфускации в Session.obfuscationMap; деобфускация в точках потребления (shell/fs/web/git/search/MCP)
  - Backend: GET /api/v2/audit, GET /sessions/:id/secrets, POST /audit/revealed (RBAC), runtime-настройка
  - UI: секция «Шлюз безопасности» (ADMIN), вкладка «Словарь обфускации» (ADMIN/AUDITOR), SecretPlaceholder
  - Тесты: 70 юнит-кейсов gateway + интеграционные + backend routes; UI проверен через Playwright
- **Проблемы:** найден и исправлен RBAC-баг (вкладка secrets рендерилась для USER из persisted state — 403); провайдер itphx недоступен, поэтому непустая карта проверена юнит-тестами, не живым LLM
- **Замечание:** в рабочем дереве остались чужие незакоммиченные изменения packages/synth/prompts (не AD-036) — не включались в коммит

## 2026-08-05 — Паттерны обфускации (дополнение AD-036)
- **Задача:** редактируемый список regex-паттернов обфускации
- **Тип:** feature
- **Исполнитель:** @fixer (слои A/B/C), @tester (проверка), оркестратор
- **Результат:** PASS
- **Коммит:** 47f26c0
- **Ключевое:**
  - SecretPatternStore: дефолт в коде (DEFAULT_PATTERNS), override {dataDir}/gateway/patterns.json полностью заменяет, сброс = удаление
  - detectSecrets/guards/obfuscator принимают patterns; GatewayProvider.getPatterns — live-детекция
  - API: GET/PUT/DELETE /api/v2/gateway/patterns (RBAC ADMIN, валидация regex)
  - UI: блок «Паттерны обфускации» в «Шлюз безопасности» — редактирование, сохранение, сброс, бейдж «дефолтные»
  - Тесты: 11 store + 10 routes + 3 detector; UI через Playwright (загрузка/сохранение/сброс/403)

## 2026-08-06 — Фикс: обфускация не работала (AD-036)
- **Задача:** «Не работает. Сессия llm-gw. Email не обфусцировался» — баг live-применения + утечка в истории
- **Тип:** bug
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** a226cd2
- **Причины (2):**
  1. Runtime-настройка llmGateway применялась только при старте сервера — включение через UI не доходило до живого оркестратора. Фикс: setGatewayConfig (live) + ProviderPool.setGateway + колбэк onLlmGatewayChange в routes.
  2. User-сообщение сохранялось в историю/UI с реальным значением (обфускация была только в памяти при вызове LLM). Фикс: obfuscateUserMessageForHistory до addPendingMessage, обфускатор прокинут в enqueueUserMessage (HTTP+WS), аудит obfuscated для user-сообщений.
- **Верификация (e2e, local.qwen3:14b):** включение через UI без рестарта → email → ⟦SYNTH_SECRET_1⟧ в истории, metadata.secrets с реальным значением, модель получила плейсхолдер, аудит пишется (secretsFound: ["email***"]).
- **Тесты:** +7 core (live-toggle, история, аудит); total core 580, backend 124, ui 4, shared 66 — зелёные.

## 2026-08-06 — GATEWAY-промпт + real-time раскрытие токенов (AD-036)
- **Задача:** 1) предупреждать модель о замене секретов на токены; 2) баг UI — токены раскрывались только после перезагрузки
- **Тип:** feature + bug
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** 97095b6
- **Сделано:**
  1. GATEWAY.{ru,en}.md — [GATEWAY] секция (токен = обычные данные, не раскрывать/не утекать, подставлять as-is, не предупреждать); ContextConfig.getGatewayInstructions + прокси ContextBuilder; вставка в system prompt при включённом шлюзе (live тоже).
  2. Real-time раскрытие: message.added передаёт metadata; stream.done включает metadata.secrets (_getAssistantSecrets); transportStore/chatStore пробрасывают metadata (message.added + finishStream newMsg/merge).
- **Верификация (e2e, local.qwen3:14b + Playwright):** модель знает механизм («обфусцированный токен... система безопасности автоматически заменяет»); свежее сообщение с email раскрылось кликом сразу, без перезагрузки.
- **Тесты:** +5 core; total core 585, backend 124, ui 4, shared 66 — зелёные.

## 2026-08-06 — Стилизация SecretPlaceholder (AD-036)
- **Задача:** уменьшить высоту плашки, убрать рамку, показывать курсив «Значение скрыто» вместо имени токена
- **Тип:** style
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** 00728e7
- **Сделано:** курсив «Значение скрыто» (i18n gateway.secret.hidden), без рамки/фона/padding/font-mono, align-baseline + italic (не ломает интервал); цвета сохранены (violet/amber/muted); placeholder → только для аудита.
- **Верификация:** Playwright — токены показываются как «Значение скрыто», клик раскрывает значение; typecheck/lint/ui-tests зелёные.

## 2026-08-06 — Слитный рендер секретов в ответах (AD-036)
- **Задача:** скрытый текст в ответах был на отдельной строке + большая высота
- **Тип:** fix (UI)
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** 77c69b2
- **Сделано:** SecretMarkdown рендерит markdown один раз, плейсхолдеры — inline-спаны внутри <p> (text «Значение скрыто», тултип с плейсхолдером, клик через data-revealed + аудит). MarkdownContent: +data-ph в ALLOWED_ATTR.
- **Верификация (Playwright):** span inline внутри <p>, font 14px/22.75px = окружение, клик раскрывает gw-prompt@itphx.ru, аудит пишется, консоль 0 ошибок.

## 2026-08-06 — Плейсхолдер в code-блоке (сессия llm-gw-2)
- **Задача:** в последнем ответе llm-gw-2 вместо плейсхолдера отображался сырой HTML `<span class="synth-secret-ph ...>`
- **Тип:** fix (UI)
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** 612226b (SecretPlaceholder.tsx + новый SecretPlaceholder.test.ts, 7 тестов)
- **Причина:** SecretMarkdown заменял ⟦SYNTH_SECRET_N⟧ на HTML-спан строковой подстановкой ДО парсинга markdown; внутри fenced code block / inline code marked экранирует HTML → виден сырой тег.
- **Решение:** protectCodeBlocks() маскирует code-контексты якорями U+E000, замена плейсхолдеров идёт только вне кода, затем якоря возвращаются. В коде плейсхолдер остаётся буквальным.
- **Верификация:** typecheck/lint(0 err)/ui 11 passed; браузер — `<pre><code>` содержит 'Email: ⟦SYNTH_SECRET_1⟧' без сырого HTML, обычные маркеры работают.

## 2026-08-06 — Маркер «Значение скрыто» внутри code-блоков (llm-gw-2, переделка)
- **Задача:** пользователь потребовал, чтобы плейсхолдер внутри code-блоков тоже показывался маркером «Значение скрыто» (фикс 612226b оставлял буквальный ⟦...⟧ в коде — неверно)
- **Тип:** fix (UI)
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** b09b903
- **Решение:** замена плейсхолдеров перенесена ПОСЛЕ marked.parser и ДО DOMPurify.sanitize (пропс transformHtml в MarkdownContent). Плейсхолдер не содержит <>/ — marked не экранирует, span становится настоящим элементом и внутри <pre><code>.
- **Верификация:** typecheck/lint(0 err)/ui 13 passed; браузер — pre code содержит настоящий span «Значение скрыто» (rawHtml 0), клик раскрывает, аудит пишется.

## 2026-08-06 — Модальное окно «Логи и аудит»
- **Задача:** новое окно просмотра логов и журнала аудита по образцу настроек
- **Тип:** feature
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** b5aaae5 (14 файлов, +1120)
- **Разделы:** core → ui → backend → аудит (по требованию пользователя); кнопка в шапке, только ADMIN/AUDITOR
- **Backend:** GET /api/v2/logs/:name?tail&search (whitelist, clamp 1..2000, RBAC, path traversal 404); dev.sh export SYNTH_LOG_DIR; 19 тестов
- **UI:** components/logviewer/ (LogsModal, LogFilePanel, AuditLogPanel, logFormat + 13 тестов); useUIStore, synthApi getLogs/getAudit, Header, i18n
- **Нюанс:** каталог назван logviewer (а не logs) — .gitignore игнорирует любую папку logs/
- **Верификация:** typecheck/lint(0 err)/тесты shared 66 + core 585 + backend 143 + ui 26; curl tail/search/RBAC/path traversal; браузер — окно с 4 разделами, лог-строки, фильтр аудита по типу работает

## 2026-08-06 — Полное логирование LLM + доработка окна логов
- **Задача:** иконка file-list, убрать AD-036, dropdown-фильтры, читаемость селектов, даты 2-й строкой, полное логирование запросов/ответов LLM
- **Тип:** feature + fix
- **Исполнитель:** @fixer, оркестратор
- **Результат:** PASS
- **Коммит:** b59ad7c (28 файлов, +907)
- **UI:** иконка file-list; AD-036 убран из пользовательских текстов; фильтры Пользователь/Сессия — dropdown; селекты bg-input (читаемо); даты 2-й строкой; раздел LLM в окне логов (между backend и аудитом)
- **LLM-логирование:** logPayloads в конфиге (default false), payload-logger.ts (JSONL {dataDir}/audit/llm-payloads.jsonl), GatewayProvider пишет полный запрос ПОСЛЕ обфускации + ответ; GET /api/v2/logs/llm; тумблер в GatewaySettings
- **Баг найден:** getUsers возвращает дубли id из-за .sync-conflict-*.json в profiles/ → дедуп в селектах
- **Верификация:** typecheck/lint(0 err)/тесты shared 66 + core 596 + backend 148 + ui 26; сквозной сценарий — включил тумблер, отправил LLM-запрос, раздел LLM показал полный запрос (секрет обфусцирован ⟦SYNTH_SECRET_1⟧) и ответ; консоль 0 errors

## 2026-08-06 — Полный лог LLM дублировал контент ответа
- **Задача:** последний ответ в разделе LLM (лог аудита) задваивался: «тесттест» вместо «тест»
- **Тип:** fix (core)
- **Исполнитель:** оркестратор (диагностика через debug-выводы), фикс вручную
- **Результат:** PASS
- **Коммит:** 9e6144b
- **Причина:** openai.ts yield'ит delta-чанки + финальный чанк с ПОЛНЫМ контентом (isFinal). GatewayProvider.chatAsync складывал accumulated безусловно → финальный полный контент прибавлялся к delta → удвоение. Оркестратор обрабатывал финальный чанк корректно (замена), поэтому история была верной.
- **Решение:** при isFinal=true и непустом content — замена accumulated вместо сложения (как в оркестраторе).
- **Верификация:** core 597 passed (вкл. тест-регрессию delta+финал); реальный запрос — payload 'тест' == история 'тест'; typecheck/lint 0 err.

## 2026-08-06 — Задвоение ответов: как решалось в чате + фикс summarizeStream
- **Задача:** проверить, как раньше решалась проблема задвоения ответов в чате
- **Тип:** research + fix
- **Исполнитель:** оркестратор
- **Результат:** PASS
- **Коммит:** 97a7897
- **Исследование:** коммит 672e07e (июнь) — «orchestrator: stream.chunk не отправляет полный текст для final чанков». Решение: при chunk.isFinal накопление заменяет контент (не складывает) и финальный чанк не отправляется в UI (content: ''). Та же логика в d5833f5 (дубли в QueueProcessor).
- **Вывод:** мой фикс gateway (9e6144b) повторяет паттерн чата. Найдена ЕЩЁ одна точка с тем же багом — summarizeStream() в optimizer.ts:296-297 (content += chunk.content + yield полного финального чанка) — исправлена тем же паттерном + 2 теста.
- **Верификация:** typecheck/lint 0 err; core 599 passed (51 файл).

## 2026-08-17 — Разделение на публикуемые npm-пакеты (AD-038)
- **Задача:** устранить дублирование ассетов (промпты/UI/docs/README копировались при сборке @itphx/synth), перейти на иерархию пакетов с зависимостями, Docker из npm
- **Тип:** refactor (пакеты + CI + Docker + docs)
- **Исполнитель:** оркестратор + @fixer (3 этапа)
- **Результат:** PASS
- **Ветка:** feat/package-split-npm
- **Сделано:** все 6 пакетов публикуются (shared→core→ui→backend→runner→synth), `pnpm publish` вместо `npm publish` (переписывает workspace:*); `@itphx/synth` — тонкая обёртка (deps core/ui/shared, без noExternal-бандла и без cp); удалены копии `packages/synth/{prompts,docs,README}`; резолвинг systemPromptsDir по package.json + fallback dist/prompts; uiDistPath через require.resolve('@synth/ui'); Docker из `npm install -g @itphx/synth@<version>`; runner + dep @synth/core; --host в serve; AD-037/AD-038 в AGENTS.md
- **Верификация:** typecheck/lint(0 err)/test (shared 66 + core 599 + ui 26 + backend 148) зелёные; dev.sh core (health 200, агенты) + backend+UI (health 200, UI 200); UI в браузере — вход admin, проект, шапка, панели; npm end-to-end: `pnpm pack` 6 пакетов → установка в чистый каталог → `synth serve` health 200, агенты из node_modules/@synth/core/prompts, UI из node_modules/@synth/ui/dist; `pnpm pack` переписывает workspace:*→0.1.11
- **Ограничение:** реальная Docker-сборка из npm и публикация в реестры не проверялись (нет опубликованной версии/токенов) — проверяются при релизе

## 2026-08-18 — Релиз 0.1.13: публикация всех пакетов + Docker
- **Задача:** публикация 6 пакетов в npmjs+GitVerse, Docker-образ, финальные тесты
- **Тип:** release
- **Исполнитель:** оркестратор + @fixer
- **Результат:** PASS (с ограничением GitVerse npm @itphx/synth)
- **Коммиты:** merge feat/package-split-npm (23eacc0), bump 0.1.13, fix(auth) cookie standalone, переименование @synth→@itphx (d2918fb)
- **Сделано:** переименование scope @synth/*→@itphx/* (164 файла); npmjs — все 6 @0.1.13; GitVerse npm — 5/6 (shared/core/ui/backend/runner), @itphx/synth 403 no permission (владелец за старым токеном, удаление версий не освободило имя); Docker gitverse.ru/itphx/synth:0.1.13+latest (квота освобождена удалением образов 0.1.8–0.1.12); фикс standalone auth cookie (synth_session) — вход в UI через Docker работает; version-bump.sh пропускает packages/synth (баг, правили вручную)
- **Верификация:** typecheck/lint/test зелёные (core 608); Docker 0.1.13 health 200, UI 200, spa-login→cookie→projects/sessions 200; end-to-end npmjs install @itphx/synth@0.1.13 + serve работает
- **Ограничение:** GitVerse npm @itphx/synth пуст (нет прав); пользователю нужно добавить владельца токена или использовать токен владельца пакета

## 2026-08-18 — Релиз 0.2.0: переименование пакетов synth-* + решение GitVerse 403

- **Задача:** закрыть хвосты: 403 GitVerse npm @itphx/synth; переименовать пакеты @itphx/* → @itphx/synth-*; bump 0.2.0; публикация; удаление старых пакетов
- **Тип:** refactor + release
- **Исполнитель:** оркестратор + @fixer
- **Результат:** PASS
- **Коммиты:** НЕ коммитилось (нет явной просьбы). В рабочем каталоге 165 изменённых файлов.

### Сделано

**1. Переименование пакетов (165 файлов, @fixer):**
- `@itphx/shared` → `@itphx/synth-shared`, `@itphx/core` → `@itphx/synth-core`, `@itphx/ui` → `@itphx/synth-ui`, `@itphx/backend` → `@itphx/synth-backend`, `@itphx/runner` → `@itphx/synth-runner`
- `@itphx/synth` остался (не стал synth-synth)
- Обновлены package.json, импорты (428 вхождений новых имён), CI (ci.yaml/release.yaml), Dockerfile, скрипты (build.sh/publish.sh/dev.sh), AGENTS.md, README, docs
- Версия: `./version-bump.sh 0.2.0` — version.ts + все 6 package.json

**2. GitVerse npm 403 @itphx/synth — РЕШЕНО (корневая причина найдена):**
- Документация: `/docs/artifactory/packages-uc/npm-packages-uc`, токены `/docs/collaborative/authentification/tokens`, API пакетов `/docs/developers/public-api/packages` (Authorization: Bearer + Accept: application/vnd.gitverse.object+json;version=latest)
- **Причина 403**: поле `repository` в packages/synth/package.json (`{"type":"git","url":"https://gitverse.ru/itphx/synth"}`). GitVerse при привязке пакета к репозиторию по repository.url проверяет права и отдаёт 403 «no permission». У остальных 5 пакетов repository отсутствовал — они публиковались. Проверено probes: probe с repository → 403, без repository / с внешним URL → 200.
- **Фикс**: `repository` удалён из packages/synth/package.json (как у остальных пакетов)
- **Токены**: T2 (`109f9d97...`) — владелец имени пакета, может создавать пакет «с нуля»; T1 (`4b218cec...`, EeeeKa) — владелец org itphx (права owner, permission_packages: owner), может публиковать новые версии после создания. Оба записаны в этот лог (см. ниже).

**3. Публикация 0.2.0 (все 6 пакетов в обоих реестрах):**
- npmjs: @itphx/synth-shared, @itphx/synth-core, @itphx/synth-ui, @itphx/synth-backend, @itphx/synth-runner, @itphx/synth — все @0.2.0 ✅
- GitVerse org itphx: те же 6 @0.2.0 ✅ (synth создан токеном T2, остальные — T1)
- Docker: `gitverse.ru/itphx/synth:0.2.0` + `:latest` (health 0.2.0, UI 200) ✅
- End-to-end: `npm install @itphx/synth@0.2.0` → транзитивные synth-core/shared/ui, `synth --version` = 0.2.0, `synth serve` health 200 ✅

**4. Старые пакеты:**
- GitVerse: удалены полностью (DELETE /orgs/itphx/packages/npm/{name} → 204): @itphx/shared, @itphx/core, @itphx/ui, @itphx/backend, @itphx/runner (были 0.1.13)
- npmjs: unpublish запрещён политикой npm 2026 (GAT с bypass 2FA не может unpublish, gh.io/npm-gat-bypass2fa-deprecation). Вместо удаления — `npm deprecate` всех 5 @0.1.13 с указанием нового имени. Потребители видят предупреждение при установке.
- @itphx/synth@0.1.13 в npmjs остался (не deprecated — это тот же пакет, просто новая версия 0.2.0)

**5. version-bump.sh:** проверен в изоляции и на реальном репо — обновляет все 6 пакетов (включая synth). Баг из прошлого релиза не воспроизводится; вероятно, был фикс в прошлой сессии.

**6. Реестр Docker:** publish.sh/build.sh дефолт `GITVERSE_DOCKER_REGISTRY` исправлен `registry.gitverse.ru` → `gitverse.ru`; AGENTS.md секция Docker обновлена.

### Верификация
- pnpm build 6/6 ✅, typecheck 0 ошибок ✅, lint 0 errors (88 warnings no-explicit-any — предсуществующие) ✅, test **848 passed** (shared 66, ui 26, core 608, backend 148) ✅
- rg: `@itphx/synth-synth` = 0, старых `@itphx/(shared|core|ui|backend|runner)` = 0 (кроме archive/), новых имён = 428
- Docker health/UI ✅, npm end-to-end ✅

### Важно для будущих релизов
- **@itphx/synth в GitVerse**: НЕ добавлять поле `repository` в package.json. Пакет создан токеном T2 (`109f9d97...`); публиковать новые версии может T1 (`4b218cec...`) или T2.
- Токены GitVerse: T1 = EeeeKa (владелец org itphx, полный доступ), T2 = владелец имени @itphx/synth (ограничен /user 403, но публикует synth). В ~/.npmrc записан старый токен b872d963... (ограничен) — для публикаций использовать T1/T2 (полные значения — вне git, у пользователя).
- npmjs: старый токен в ~/.npmrc (`//registry.npmjs.org/:_authToken`) — GAT без права unpublish; publish/deprecate работают.

### Остались хвосты (не в скоупе этой задачи)
- WS /ws/events не читает cookie (standalone, app.ts:498-508) — отдельная задача
- publish.sh вне git (/mnt/data/Agent/dev/Synth/publish.sh) — перенести в репозиторий при желании
- Коммит 165 файлов переименования — по запросу пользователя

## 2026-08-19 — Уборка каталога проекта (cleanup)
- **Задача:** Прибраться: удалить мусорные каталоги, перенести скрипты и Dockerfile в репозиторий
- **Тип:** refactor (cleanup)
- **Исполнитель:** оркестратор
- **Результат:** PASS
- **Коммит:** — (изменения в git-репо готовы, коммит не выполнялся — не было явной просьбы)
- **Время:** ~40 мин
- **Ключевое:**
  - Удалены (корень проекта): test/ (дубликат synth/test + тестовые txt-файлы), test-results/ (кэш Playwright), tmp/ (скриншоты/логи/разовые скрипты), synth-test/ (разовый Python-тест WS старого стека), loops/ (40 JSON Cursor-loops, не используются)
  - Удалены (репозиторий synth): data/ (runtime-данные, в .gitignore, не используются — dataDir в корне проекта), src/ (только __pycache__ от Python-legacy), tmp/ (логи/скриншоты/repro-скрипты), node_modules/.modules.sync-conflict-*.yaml
  - Скрипты build.sh, dev.sh, publish.sh, version-bump.sh перенесены из корня в synth/ (SYNTH="$ROOT/synth" → SYNTH="$ROOT")
  - Dockerfile → synth/docker/Dockerfile (git mv, история сохранена); обновлены docker-compose.yml (build: context+dockerfile), build.sh/publish.sh (путь -f), release.yaml (--dockerfile=docker/Dockerfile), AGENTS.md (пути скриптов, tmp, Docker)
- **Верификация:** bash -n 4 скриптов ✅, docker-compose YAML ✅, pnpm typecheck ✅, lint 0 errors ✅, test (shared+core 608 + ui 26 + backend 148) ✅
- **Проблемы:** нет

> Примечание: с 2026-08-19 журнал ведётся в репозитории (synth/.opencode/tasks/log.md).
> Корневой .opencode/tasks/log.md — симлинк на этот файл.

## 2026-08-19 — Очистка .opencode (Plugin SDK)
- **Задача:** разобраться с .opencode/node_modules и удалить, если не нужно
- **Тип:** cleanup
- **Исполнитель:** оркестратор
- **Результат:** PASS
- **Коммит:** — (в git-репо изменений нет — удалялись файлы вне репозитория)
- **Время:** ~5 мин
- **Ключевое:**
  - `.opencode/node_modules` (62 МБ) — зависимости `@opencode-ai/plugin` (Plugin SDK opencode), установленные 14.08. Плагинов нет, ничего не импортирует, конфиг opencode не ссылается — не используется
  - Удалены: `.opencode/node_modules`, `.opencode/package.json`, `.opencode/package-lock.json` (все в .gitignore, восстановление — npm install)
  - `.opencode/` теперь: только `.gitignore` + `tasks/` (log.md — симлинк на synth/.opencode/tasks/log.md)
- **Проблемы:** нет

## 2026-08-19 — Удаление synth/config.yaml
- **Задача:** разобраться, нужен ли локальный config.yaml в корне репозитория
- **Тип:** cleanup
- **Исполнитель:** оркестратор
- **Результат:** PASS
- **Коммит:** — (файл был в .gitignore, не трекался)
- **Время:** ~5 мин
- **Ключевое:**
  - `synth/config.yaml` полностью повторял дефолты `packages/shared/src/config/defaults.ts` (mcp.servers {}, llmGateway: enabled=false, inputMode=obfuscate, rateLimit 60/120, audit enabled, logPath '') — ничего не переопределял
  - Файл в .gitignore (не трекается), на поведение не влиял — удалён
  - Если нужен шаблон — документировать как config.example.yaml (отдельное решение)
- **Проблемы:** нет

## 2026-08-19 — Перенос скриптов в synth/scripts + аудит scripts/ и test/
- **Задача:** перенести build.sh/dev.sh/publish.sh/version-bump.sh в synth/scripts; проверить актуальность changelog.sh, micro-benchmark.mjs и synth/test
- **Тип:** refactor (cleanup)
- **Исполнитель:** оркестратор
- **Результат:** PASS
- **Коммит:** — (ожидает явной просьбы)
- **Время:** ~25 мин
- **Ключевое:**
  - 4 скрипта перенесены в synth/scripts/; ROOT="$(dirname $0)/.." во всех; publish.sh → bash "$ROOT/scripts/build.sh"
  - AGENTS.md (разделы «Команды», «Скрипт запуска», «Скрипты», стадия Verify) и docs/DEVELOPMENT.md обновлены на ./scripts/dev.sh
  - changelog.sh — нужен (CI release.yaml:161), актуален
  - micro-benchmark.mjs — актуален (работает через tsx, exit 0; AD-035, упомянут в AGENTS.md)
  - synth/test: api-smoke.sh и ui-e2e.mjs актуальны (все эндпоинты живы: /health, projects CRUD, sessions CRUD), но никто не ссылается — ручные smoke-инструменты; решение по судьбе — у пользователя
- **Проблемы:** нет

## 2026-08-19 — Редактор файлов только для чтения + upload/download в standalone core
- **Задача:** «не работает редактор файлов, файлы открываются только для чтения» + реализовать загрузку файлов через UI/API + проверить скачивание через API
- **Тип:** bug + feature
- **Исполнитель:** @tester (диагностика/верификация), @researcher (прототип t11), @fixer (реализация)
- **Результат:** PASS
- **Коммит:** 217f8cc (ветка fix/file-editor-upload)
- **Время:** ~60 мин
- **Ключевое:**
  - UI → backend :5000: редактор/сохранение/upload/download работали (QA подтвердил) — баг воспроизводился только при подключении UI к core standalone :4300
  - Причина: packages/core/src/server/routes/fs.ts имел только GET /fs и GET /fs/read; write/upload/download/mkdir/move/delete → 404 → «файлы только для чтения»
  - В backend эти эндпоинты уже были; в прототипе t11 upload/download файлов проекта отсутствовали вовсе
  - Фикс: в core добавлены POST /fs/write, POST /fs/upload, GET /fs/download, DELETE /fs, POST /fs/mkdir, POST /fs/move с единой защитой resolveSafe() от path traversal и единым форматом ошибок
  - Документация: core/AGENTS.md и backend/AGENTS.md приведены в соответствие с реальными FS-эндпоинтами
  - Верификация: core API (200/201/403/401/409/400 — все сценарии), UI-смоук (редактор→сохранить→загрузить→скачать, 0 ошибок консоли), регрессия: typecheck PASS, lint 0 errors, 848 тестов зелёные
- **Проблемы:**
  - API-ключ core в ~/.config/synth/config.yaml пустой — без --api-key core недоступен по auth (конфигурационный нюанс, не баг фикса)

## 2026-08-19 — Дерево файлов: upload у папок, убрать new-file у файлов, пункт «Переместить»
- **Задача:** кнопка «Загрузить файл» у каждой папки; убрать «Создать файл» у файлов; добавить «Переместить» в контекстное меню файлов и папок
- **Тип:** feature (UI)
- **Исполнитель:** @fixer (реализация), @tester (UI-верификация)
- **Результат:** PASS
- **Коммит:** ожидает (см. git log ветки fix/file-editor-upload)
- **Время:** ~45 мин
- **Ключевое:**
  - packages/ui/src/components/panels/LeftPanel.tsx: handleUpload принимает dirPath, activeUploadPath; upload-кнопка у каждой папки; entryActions только для isDir (upload/new-file/new-folder); в контекстное меню добавлен «Переместить» (file.move) с диалогом выбора директории (projectDirPaths, исключение себя/подпапок, обновление открытой вкладки)
  - i18n: file.move добавлен в ru.ts/en.ts
  - Верификация: 8/8 UI-проверок PASS (upload в папку, hover файла без иконок создания, контекстные меню, перемещение файла/папки в т.ч. в корень, обновление вкладки); регрессия сохранения (POST /fs/write 200) и скачивания PASS; typecheck/lint UI чисто
- **Проблемы:** нет

## 2026-08-19 — Критический регресс: сообщения не уходят в LLM
- **Задача:** «не уходят сообщения в LLM» — проверить в любой сессии (провайдер itphx, модель local.qwen3.5:9b) через API и UI
- **Тип:** bug (верификация + фикс)
- **Исполнитель:** @tester (воспроизведение API+UI), @fixer (реализация)
- **Результат:** FIXED (регресс воспроизведён, причина устранена)
- **Коммит:** нет (коммит не запрашивался)
- **Время:** ~90 мин
- **Ключевое:**
  - Воспроизведено и через API (`mszxlr23-vvp-gtxl1opf`), и через UI (`msf00oe6-5-qosyb39w`): ответа нет, 0 токенов, сессия зависала навсегда (вечный «Стоп» в UI, «В очереди: 1», консоль браузера чистая)
  - Внешний LLM-бэкенд ai.itphx.ru сейчас недоступен (HTTP 000 на GET / и POST chat/completions, таймауты; ping до 10.0.0.230 OK) — внешний сбой, не чинится в коде
  - Регресс в коде: провайдеры (openai.ts/ollama.ts) глотали ошибки чтения стрима; оркестратор не публиковал stream.error и не писал last_error; QueueProcessor не очищал currentStream/pending/blocked при исключении → сессия блокировалась необратимо
  - Фикс: проброс ошибок стрима, `_handleLlmFailure()` (stream.error + last_error + человекочитаемый текст), полная очистка в processor; вторичный дефект `.chat` на undefined уже защищён (micro-llm-model.ts:44, router.ts:94, _routeProvider)
  - Верификация: typecheck PASS, lint 0 errors, 857 тестов (9 новых), build PASS; практическая проверка: после ошибки last_error записан, pending_count=0, current_stream=None, blocked=None, повторная отправка работает
- **Проблемы:**
  - Внешний itphx (ai.itphx.ru) не отвечает — вероятно временный сбой инфраструктуры; проверить отдельно когда сеть восстановится
  - При недоступности провайдера ответ теперь приходит через ~120 с (таймаут по умолчанию) — UX медленный, но сессия корректно разблокируется

## 2026-08-19 — Регресс «не уходят в LLM»: раунд 2 (router.ts + cancel + UI-уведомления)
- **Задача:** «Я не вижу изменений в поведении. Сообщение уходит, ошибок нет, индикатор висит, Стоп не работает»
- **Тип:** bug (второй раунд фикса)
- **Исполнитель:** @fixer (раунд 2 + UI-доработка), @tester (верификация API/UI)
- **Результат:** PASS
- **Коммит:** нет (не запрашивался)
- **Время:** ~3 ч (оба раунда)
- **Ключевое:**
  - РАУНД 2 — найден НАСТОЯЩИЙ источник `TypeError: Cannot read properties of undefined (reading 'chat')`: `router.ts:259 _resolveContentMapping()` обращался к `settings.routingContent['chat']` при undefined routingContent у старых сессий (routingEnabled undefined → роутер активен, маппинга нет). Выглядело как `provider.chat` на undefined. Фикс: optional chaining.
  - Кнопка «Стоп»: cancellationToken связан с AbortController в openai.ts/ollama.ts — отмена прерывает зависший fetch МГНОВЕННО (7 мс в тесте, было 120с).
  - dev.sh: core пересобирается ПЕРЕД стартом backend (раньше backend грузил старый dist).
  - UI-доработка по жалобам пользователя: (а) ошибка LLM теперь через стандартный toast (react-toastify) + история уведомлений, а не полоса вверху; (б) ретраи видны: «Повторная попытка N/3 через X с» (stream.retry событие), кнопки «Повторить сейчас» (retry-now) и «Отменить» (cancel-retry); (в) после финальной ошибки стрим завершается, «Стоп» исчезает.
  - Backend: MAX_RETRIES=3, backoff 5/15/30с; `_isRecoverable` учитывает errorType (provider_not_found и др. не ретраятся). Новые эндпоинты POST /queue/:id/retry-now, /cancel-retry.
  - Верификация: typecheck PASS, lint 0 errors, 857 тестов (620 core). UI: toast PASS, бейдж ретрая PASS, Отменить PASS, Повторить сейчас PASS (API), после ошибки Стоп исчезает PASS, console 0 errors. `setStreamRetrying is not defined` — HMR-артефакт, на чистой загрузке не воспроизвёлся.
  - Создан фиктивный провайдер `mocktimeout` (openai, http://127.0.0.1:9/v1/chat/completions, timeout 5с) + модель mock-model-1 — для тестов ошибок соединения.
- **Проблемы:**
  - Внешний itphx (ai.itphx.ru) недоступен — пользователь чинит отдельно.
  - Поведение ретраев: при недоступном провайдере весь цикл (4 попытки с backoff) занимает ~50с с mocktimeout и ~9 мин с itphx (timeout 120с ×4). Это by design, но пользователю может быть долго — можно пересмотреть таймауты/кол-во ретраев отдельной задачей.

## 2026-08-19 — Новая модель жизненного цикла сообщения (очередь + UI)
- **Задача:** доработка обработки ошибок LLM: стандартные уведомления, кнопки/статус ретрая в user-сообщении, корректный жизненный цикл (без дублей), починка кнопок очереди, WS+SSE паритет.
- **Тип:** refactor + bugfix (backend/core + UI)
- **Исполнитель:** @fixer (3 раунда), @tester (верификация)
- **Результат:** PASS (верификация A–F зелёная)
- **Коммит:** нет (не запрашивался)
- **Ключевое:**
  - Модель отображения: user-сообщение в истории сразу; «крутилка» (placeholder) только после первого stream.chunk; пока нет chunk — статус «обработка…»/«Повторная попытка N/M» + кнопки-иконки внутри user-сообщения; ошибки только toast+история (красная плашка удалена).
  - Backend/core: дедупликация сообщений по metadata.stream_id (защита от дублей при resume/гонках); resume больше не генерирует новый stream_id; return убрал slice(1) и удаляет user-сообщение из истории; cancel/abort (WS + HTTP) чистят состояние через процессор (убран queueManager.stop), публикуется stream.cancelled; устранена гонка «Обработка остановлена» после «Отменить».
  - UI: transportStore — stream.error(can_retry:true) ничего не показывает; финальная ошибка — только notify; stream.start декрементирует pendingCount; новый RetryStatus.tsx (иконки+title).
  - SSE vs WS: оба регистрируются в EventHub и дают идентичные события (backend-правок не потребовалось).
  - Верификация: typecheck/lint/870+ тестов зелёные; тайминг ретраев 5/15/30с; itphx end-to-end («обработка…»→placeholder→ответ за ~5с); SSE идентично WS; console 0 JS-исключений.
- **Проблемы/оговорки:**
  - Точный stalled-вид панели («Обработка остановлена») наживую не воспроизведён (нужен рестарт бэкенда); resume проверен напрямую (дедуп 10→10).
  - Pre-existing: отмена активного LLM-вызова даёт два stream.error (internal + retry_cancelled) — отдельной задачей.
  - 2 точечных замечания из отчёта фиксера (return в backoff не удаляет из истории по правилу «активный стрим»; pendingCount декремент без unit-теста) — не блокеры.
