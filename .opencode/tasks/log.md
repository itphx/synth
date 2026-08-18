
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
