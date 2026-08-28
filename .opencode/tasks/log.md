# Журнал задач оркестратора

## 2026-08-25 (продолжение) — fix: провайдер itphx / deepseek-v4-flash, вторая волна
- **Задача:** «Та же ошибка. Вероятно проблема в конкретной сессии. Изучи Сессию Разговор о разном. Протестируй, разберись.»
- **Тип:** bug
- **Исполнитель:** @fixer (диагностика/сквозной тест — оркестратор)
- **Результат:** PASS (build/typecheck/lint/test + реальный ретрай сессии через API ✅)
- **Коммит:** — (не выполнялся, нет явной просьбы; в дереве чужие незакоммиченные правки)
- **Первопричина (воспроизведена):** после первого фикса (object-arguments) всплыла следующая ошибка: `Invalid schema for function 'plan_write': schema must be a JSON Schema of 'type: object', got 'type: string'`. `zodToJsonSchema` (`packages/core/src/engine/tools/json-schema.ts`) не обрабатывал `z.discriminatedUnion` — схема `planWriteSchema` (plan.ts:250) проваливалась в fallback `{type:'string'}`. DeepSeek строго валидирует tool-схемы и требует верхнеуровневый `type:'object'` (проверено реальными запросами: `{type:'string'}` → ошибка; верхнеуровневый `{anyOf:[...]}` → тоже «got type: null»; `{type:'object', properties, required:['action']}` → принимается). Вложенные `z.union` в todo.ts DeepSeek принимает (nested anyOf — ок), их не трогали.
- **Исправление:**
  - `packages/core/src/engine/tools/json-schema.ts`: ветка `instanceof z.ZodDiscriminatedUnion` перед fallback — слияние properties всех вариантов, `properties[discriminator] = {type:'string', enum:[все значения]}`, `required:[discriminator]` (поля вариантов опциональны, иначе create_item.title стал бы обязательным для delete_item). Runtime-валидация не меняется (`safeParse` строгий discriminated union).
  - Новый тест `packages/core/src/engine/tools/json-schema.test.ts` (4 кейса).
  - Предыдущий фикс (openai.ts arguments→string + reasoning_content, orchestrator.ts reasoning-проброс) — в рабочем дереве, работает.
- **Проверка:** `pnpm build`/`typecheck` ✅; `pnpm lint` 0 errors ✅; `pnpm test` 1138 (core 872) ✅; сквозной тест: перезапуск backend+core с новым кодом, ретрай сообщения [144] сессии «Разговор о разном» через API → `stream.done`, модель deepseek.deepseek-v4-flash выполнила задачу (запустила subagent explore для чтения ~/.ssh/config), 1208 чанков, без ошибок; контрольный запрос → «Всё работает.». Сообщения [145-148] сохранены без `last_error`.
- **Замечание про «This model does not support image»:** так DeepSeek отвечает на `image_url`-части контента (воспроизведено тестовым запросом); в коде synth генерации image_url нет (grep). Вероятно, была одной из 400-ошибок в цепочке неработоспособности (пользователь видел разные ошибки) либо приходила от запроса с изображением извне. После фиксов не воспроизводится. Если повторится — отдельная диагностика (проверить, не попадает ли data:image URI в контент).

## 2026-08-25 — fix: провайдер itphx / deepseek.deepseek-v4-flash
- **Задача:** «Перестал работать провайдер itphx, в частности модель deepseek.deepseek-v4-flash». Лог провайдера: `publish_model_provider_request_failed ... url=https://api.deepseek.com model=deepseek-v4-flash ... "This model does not support image"`; лог бэкенда: `messages[20]: invalid type: map, expected a string`.
- **Тип:** bug
- **Исполнитель:** @fixer (диагностика и сквозная проверка — оркестратор)
- **Результат:** PASS (typecheck ✅, lint 0 errors ✅, test 1134 ✅, сквозная проверка через реальный open-webui → DeepSeek ✅)
- **Коммит:** — (не выполнялся, нет явной просьбы; в рабочем дереве чужие незакоммиченные правки feat fix/subagent-display — task.ts, StreamingPlaceholder.tsx, callId в orchestrator.ts — их не трогали)
- **Первопричина (воспроизведена):**
  - Коммит `74df4ba` (21.08) добавил в Ollama-провайдер нормализацию `function.arguments` **строка → объект** при разборе ответов (`_parseResponse`, `chatAsync`). Объекты сохраняются в `toolCalls` сессии (`_persistToolChain`).
  - При переигровке истории на OpenAI-совместимый провайдер (itphx → open-webui → api.deepseek.com) `openai.ts _formatMessages` передавал `tool_calls[].function.arguments` **объектом**, а API DeepSeek требует **JSON-строку** → HTTP 400 `messages[N]: invalid type: map, expected a string`. Точное тело synth → open-webui воспроизводило ошибку 1-в-1.
  - Дополнительно: DeepSeek reasoning-модели (deepseek-v4-flash) требуют возврата `reasoning_content` в повторных assistant-сообщениях → иначе 400 `The reasoning_content in the thinking mode must be passed back to the API`. Воспроизведено: добавление `reasoning_content` устраняет ошибку.
- **Исправление:**
  - `packages/core/src/providers/openai.ts _formatMessages`: `tool_calls` маппятся, объектные `function.arguments` сериализуются в JSON-строку (try/catch, циклические ссылки не роняют); строка/null/undefined/число — как есть. Для `role=assistant` с `msg.reasoning` добавляется `reasoning_content`.
  - `packages/core/src/engine/orchestrator.ts _sessionMessagesToLlm`: проброс `reasoning: msg.reasoning` для own-сообщений ассистента.
  - Новый тест `packages/core/src/providers/openai.test.ts` (4 кейса, стиль ollama.test.ts).
  - `ollama.ts` НЕ менялся (его поведение нужно для Ollama; с фиксом openai.ts хранение объектов безвредно).
- **Проверка:** `pnpm typecheck` ✅; `pnpm lint` 0 errors ✅; `pnpm test` (shared 66 / core 868 / ui 30 / backend 170) ✅; сквозной прогон реального тела сессии через исправленный `_formatMessages` → 0 объектных arguments / 8 строк / 24 reasoning_content → POST в open-webui → DeepSeek ответил 200 с reasoning_content ✅ (до фикса — `messages[20]: invalid type: map`).
- **Замечание про «This model does not support image»:** так DeepSeek отвечает на `image_url`-части контента (воспроизведено тестовым запросом). В коде synth генерации image_url нет (grep) — вероятно, изображение/data:image URI попадало в контент иным путём (внешний источник). Отдельная задача, если воспроизведётся.

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

## 2026-08-19 — Чат и область ввода: ширина, кнопки, иконка План, уровень размышлений
- **Задача:** 5 пунктов: зона чата 50%, адаптивность ввода при узкой чат-зоне, кнопки ввода (развернуть/убрать авто-одобрение), иконка План→todo, переключатель уровня размышлений в выборе модели.
- **Тип:** feature + bugfix (UI + shared + core + backend)
- **Исполнитель:** @fixer (UI-блок A–D, блок E reasoning, фикс валидации PATCH, фикс переполнения футера), @tester (QA 4 раунда)
- **Результат:** PASS (874 теста зелёные; QA VERDICT: PASS)
- **Коммит:** нет (не запрашивался)
- **Ключевое:**
  - Зона сообщений ограничена 50% центральной колонки, по центру (MessageList: `mx-auto w-full max-w-[50%]`).
  - Футер композера адаптивен: flex-wrap + container query `@container`, подписи режимов скрываются `@max-[212px]:hidden`; ни при какой ширине элементы не выходят за рамку.
  - Кнопки ввода: «Прикрепить» — заглушка, «Авто-одобрение» удалена, «Развернуть» реализована (композер на всю высоту чат-зоны, иконка fullscreen↔fullscreen-exit, i18n).
  - Иконка режима «План» — RiTodoLine (вместо shield).
  - Уровень размышлений (полная цепочка): shared `reasoningLevel` в SessionSettings + zod schema; core: BaseProvider/ProviderPool/orchestrator/роутер AD-034 прокидывают уровень; openai → `reasoning_effort`, anthropic → `thinking:{enabled,budget_tokens:8192}`, ollama → `think:true`; UI: сегмент-контрол в ModelSelector, наборы уровней по типу провайдера (openai/generic 4, anthropic Нет+Высокий, ollama Нет+Низкий), стиль PlanActModeToggle.
  - Баг #1 (найдено QA): PATCH /api/v2/sessions/:id не валидировал settings — применён `sessionUpdateSchema.safeParse` (+ `.passthrough()` чтобы не терять поля вне схемы), в backend и standalone core; тесты добавлены (невалидный reasoningLevel → 400).
  - Баг #2 (найдено QA): при ~300px правый блок футера переполнял рамку на 331px — исправлено (flex-wrap + min-w-0 + ml-auto + shrink-0 + container queries); проверено на 200/240/270/300/700px, overflowCount=0.
- **Проблемы/оговорки:**
  - При смене провайдера сохранённый уровень (например high после openai→ollama) не сбрасывается — ни одна кнопка не подсвечена; авто-сброс уровня при смене провайдера — отдельной задачей.
  - Предсуществующее: AgentModeSelector шлёт `agent_role` (snake_case) вместо `agentRole` (camelCase) — поле не доходит до настроек; вне скоупа.
  - Микро-слой AD-035 и суммаризация (ContextOptimizer) создают провайдеров без уровня (системные вызовы) — вне скоупа.

## 2026-08-19 — Переключатель уровня размышлений: тексты + отключение размышлений qwen3.5:9b
- **Задача:** 3 пункта: (1) текст «По умолчанию» без дефиса; (2) «Нет» → «Отключено»; (3) проверить через API можно ли отключить размышления у itphx/qwen3.5:9b и почему не работает «Отключено» из UI.
- **Тип:** bugfix (текст UI) + исследование (API)
- **Исполнитель:** @fixer (текст), оркестратор (прямое API-исследование)
- **Результат:** PASS (текст; typecheck/lint/874 теста зелёные) + отчёт по API (правок кода по п.3 не делали — по решению пользователя «только отчёт»)
- **Коммит:** нет (не запрашивался)
- **Ключевое:**
  - ru.ts: `'chat.reasoning.none': 'Нет'` → `'Отключено'`. `'chat.reasoning.default': 'По умолчанию'` — уже корректно (без дефиса), «По-умолчанию» в UI-строках нигде нет (проверено grep'ом по packages/ui включая dist).
  - Исследование отключения размышлений (curl напрямую, модель `local.qwen3.5:9b`/`omn.qwen3.5:9b` через прокси `ai.itphx.ru`):
    - Прокси OpenAI-совместимый (тип провайдера itphx = openai → Synth шлёт `reasoning_effort`); все параметры отключения thinking игнорируются для локальных Ollama-моделей: `reasoning_effort:none`, `think:false`, `chat_template_kwargs:{enable_thinking:false}`, `options:{think:false}`, `reasoning:{enabled:false}` — размышления остаются.
    - Отключение РАБОТАЕТ: нативный Ollama `/api/chat` + `think:false` (owu:11434, eval_count 2 вместо 3112); внешняя модель `routerai.qwen/qwen3.5-9b` + `reasoning:{enabled:false}`.
    - Вывод: «Отключено» из UI не работает для локальных qwen3.5:9b из-за ограничения прокси ai.itphx.ru (не умеет глушить thinking для local.*/omn.*), а не из-за бага цепочки Synth (UI → settings.reasoningLevel=none → reasoning_effort доходит корректно).
  - Решение пользователя: правок кода по п.3 не делать, только зафиксировать отчёт (best-effort параметры в OpenAIProvider и маршрутизация в нативный Ollama — не делаем).
- **Проблемы/оговорки:**
  - Для гарантированного отключения размышлений qwen3.5:9b использовать провайдер `ollama` (нативный, think:false работает) или внешнюю `routerai.qwen/qwen3.5-9b`.

## 2026-08-20/21 — Ветка refactor/remove-tsm: AD-039/AD-040 (замена TSM) + фикс tool-chain
- **Задача:** заменить TSM-механизм: план — в проекте (`project.plan`), todo — в сессии, состояние через инструменты; сессии без проекта; лог проекта и инварианты; фикс персистентности tool-chain
- **Тип:** refactor + feature + bugfix (core + shared + UI)
- **Исполнитель:** @fixer (реализация), оркестратор (ветка, merge)
- **Результат:** PASS (запись добавлена ретроспективно при подготовке merge; коммиты ветки содержат работу и тесты)
- **Коммиты (7, от 2026-08-20 15:15 → 2026-08-21 11:04):**
  - `382e0d1` docs: AD-039/AD-040 (план в проекте, todo в сессии, замена TSM)
  - `355cbd5` refactor: удалён TSM-слой (TsmState/TsmStatus/updateTsmState)
  - `a81f36f` feat: ядро состояний — todo_* CRUD, контекстный блок сессии, permission-группа RUNTIME (AD-039/040)
  - `c405048` feat: план в проекте — kanban-структура project.plan, инструменты plan_read/list/write (AD-039/040)
  - `8034215` feat: сессии без проекта — project_create/project_attach, перенос с валидацией + событие session.moved, UI-действия (AD-040)
  - `be5a264` feat: лог проекта (project_log_write/read) + инварианты в system prompt и инструменты (AD-040)
  - `ceb156f` fix: правильная персистентность tool-chain, атомарность скользящего окна, обработка ошибок и отмены
- **Ключевое:**
  - TSM удалён: `planContent`/`planPath` из сессии убраны, план живёт в `project.plan` (kanban), todo — в `session.todos`
  - Инструменты: `plan_read`/`plan_list`/`plan_write`, `todo_*` CRUD, `project_create`/`project_attach`, `project_log_write/read`, инварианты в system prompt
  - Контекстный блок сессии: наличие/отсутствие проекта, рабочий каталог; `get_project_info` честно сообщает «проект отсутствует»
  - Перенос сессии между проектами (`PATCH /sessions/:id` `project_id`): todo остаётся, план берётся от нового проекта, событие `session.moved`
  - UI: вкладка «Проект» для сессий без проекта (создать/привязать), метка «без проекта»
  - Фикс tool-chain: пары assistant(toolCalls)→tool→final assistant персистятся в `session.messages` (metadata.tool_chain), скользящее окно атомарно по «ходу», отмена сохраняет tool-вызовы, stream.error публикуется один раз
- **Верификация:** по коммитам — тесты (tool-chain персистентность, атомарность окна, отмена с тулами, plan/todo/project-manage — новые suite); AGENTS.md обновлён (AD-039/040)
- **Проблемы:** лог не велся в процессе — записи добавлены ретроспективно; перед merge запланирована проверка typecheck/lint/test

## Merge в master (2026-08-21)
- Ветка: `refactor/remove-tsm` → `master` с `--no-ff`
- Merge-коммит: `9b297b3` — merge: refactor/remove-tsm — AD-039/040 (план в проекте, todo в сессии, замена TSM) + фикс tool-chain
- Конфликтов нет (ветка содержала master целиком; локальный master впереди origin/master на 61 коммит, push не выполнялся)
- Итог: в master вошли 7 коммитов ветки (docs AD-039/040, refactor TSM, todo CRUD, project.plan, project_create/attach, project_log, tool-chain fix). Файлов: 65, +3518/−618

## 2026-08-19 — Индикатор обработки вместо слова «Обработка» в user-сообщении
- **Задача:** после отправки сообщения вместо текстового статуса «Обработка…» рисовать индикатор обработки (три прыгающие точки) в шапке user-сообщения на месте времени — как в ответах ассистента.
- **Тип:** feature/bugfix (UI)
- **Исполнитель:** @fixer
- **Результат:** PASS (typecheck/lint/874 теста, build UI; DOM-проверка в браузере: 3 точки `.animate-bounce` в шапке, время скрыто, текст «Обработка» отсутствует)
- **Коммит:** нет (не запрашивался)
- **Ключевое:**
  - MessageHeader.tsx: добавлен проп `processing?: boolean`; при `processing` вместо времени справа (ml-auto) рендерятся три прыгающие точки (разметка как в StreamingPlaceholder: `size-1.5 rounded-full bg-primary/60 animate-bounce`, animationDelay 0/150/300ms); внешнее условие блока расширено на `processing`.
  - ChatMessage.tsx: user-`<MessageHeader>` получает `processing={pending?.status === 'processing'}`; блок `ProcessingStatus` («Обработка…» + loader-2) удалён; для retrying остаётся `RetryStatus` (счётчик + кнопки) без изменений.
  - RetryStatus.tsx: удалён неиспользуемый экспорт `ProcessingStatus`.
  - i18n: удалены неиспользуемые ключи `chat.stream.processing` из ru.ts и en.ts.
- **Проблемы/оговорки:**
  - Окно processing у провайдера mocktimeout очень короткое (~0–200 мс), затем уходит в retry — на сетевых провайдерах точки видны дольше; это поведение провайдера, не правки.
  - В QA-сессию `qa-mocktimeout-fresh` добавлены тестовые сообщения для проверки состояния processing (сессия предназначена для таких проверок).

## 2026-08-21
- **Задача:** Автоименование сессий + классы агентов (primary/subagent/system) + флоу новой сессии
- **Тип:** feature (UI + core + API)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммиты:** 91077ad, df3b5c9, dec9717, 7287cc4 (ветка feat/agent-classes-session-flow)
- **Время:** ~1.5 ч
- **Проблемы:** dev-серверы :5000/:4300 не перезапущены (работают со старым кодом); UI в браузере не проверен визуально (нужен пересборка backend + перезапуск); forkSession из контекстного меню LeftPanel (~стр. 242) тоже вызывает setRenamingId — вне скоупа (только createSession).
- **Суть:**
  - Классы агентов: `AgentMode = 'primary' | 'subagent' | 'system'`, `agentMode` — строка или массив (мультиклассы). `'all'` удалён из модели (при чтении старых данных нормализуется в ['primary','subagent']). `hidden` удалён из типов и определений. title.json → `agentMode: ["system"]`.
  - `GET /agents` отдаёт только основных (primary); новый `GET /agents/all` — все (для админки). `normalizeAgentModes()` — новый модуль core, экспортируется из пакета.
  - Убрано принудительное переименование после создания сессии (4 места LeftPanel) → автооткрытие вкладки; ProjectsTabToolbar — тоже openTab.
  - Пустая сессия: область ввода по центру (ChatTab), без MessageList/QueuePanel/PermissionBar.
  - Админка: мультиселект классов чекбоксами, фильтры all/agents/subagents/system, бейджи «системный» (класс) и «встроенный» (builtin).
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: shared 66 / core 685 / backend 170 / ui 29 ✅; smoke API на standalone core :4311: GET /agents → только primary, GET /agents/all → все (title = ['system']).
- **Follow-up:** пересобрать backend (`pnpm --filter @itphx/synth-backend build`) и перезапустить dev (./scripts/dev.sh all); визуальная проверка админки «Агенты» и создания сессии; решить судьбу setRenamingId в forkSession.

## 2026-08-21 (вторая правка)
- **Задача:** Автопереименование не обновляет имя в дереве сразу; форк сессии из контекстного меню делал переименование вместо открытия вкладки
- **Тип:** bug (core + UI)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммиты:** 69660c3, fff1165 (ветка feat/agent-classes-session-flow)
- **Время:** ~25 мин
- **Проблемы:** нет
- **Первопричина:** `autoTitleSession` переименовывал сессию через `manager.renameSession()` (просто сохраняет title, без событий) — в отличие от ручного PATCH, который публикует `session.updated` с полным объектом. UI не получал события → дерево держало старое имя до перезагрузки списка.
- **Исправление:** `autoTitleSession` возвращает `string | null`; в orchestrator после успешного переименования публикуется `session.updated { session_id, name }` (fire-and-forget, stream.done не задерживается). UI менять не потребовалось (обработчик session.updated уже патчит `name`). LeftPanel: пункт «Форк» теперь открывает вкладку `chat-{id}` вместо `setRenamingId` (паттерн как в createSession/ChatTab).
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 685 / backend 170 / ui 29 / shared 66 ✅.
- **Follow-up:** `.opencode/tasks/log.md` остаётся незакоммиченным (служебный); dev-окружение :5000/:4300 всё ещё работает со старым кодом — нужен перезапуск ./scripts/dev.sh all + визуальная проверка.

## 2026-08-21 (третья правка)
- **Задача:** Переключатель размышлений (reasoning) у агентов; генератор заголовков без размышлений
- **Тип:** feature (core + UI + API)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммиты:** 4fe9dc7, 51dcc14 (ветка feat/agent-classes-session-flow)
- **Время:** ~40 мин
- **Проблемы:** `loadSystemAgentDefinitions()` терял поля temperature/topP/topK/reasoningLevel при ручном маппинге — исправлено (+reasoningLevel переносится). Авто-тайтл использовал провайдер основной сессии → reasoningLevel title-агента не применялся — исправлено: перед autoTitleSession создаётся провайдер с reasoningLevel из title.json через _getProvider.
- **Суть:**
  - `AgentDefinition.reasoningLevel?: ReasoningLevel`; API отдаёт `reasoning_level` (core+backend GET/POST); UI AgentInfo + форма агента.
  - title.json → `"reasoningLevel": "none"`.
  - Оркестратор: `effectiveReasoningLevel = agentDef?.reasoningLevel ?? session.settings.reasoningLevel` — применяется в _getProvider/_routeProvider/fallback-эскалации; сабагенты наследуют reasoningLevel агента через childRoutingOverrides (task.ts).
  - Форма агента: селект «Размышления» — провайдер не выбран → [Не задано, Отключено]; выбран → + уровни по типу провайдера (openai/generic: low/medium/high, anthropic: high, ollama: low; без default).
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 685 / backend 170 / ui 29 / shared 66 ✅; API curl: title.reasoning_level = "none", POST reasoning_level сохраняется ✅.
- **Follow-up:** dev-окружение :5000/:4300 всё ещё старый код — нужен перезапуск ./scripts/dev.sh all и визуальная проверка (админка «Агенты», создание сессии, центрированный ввод, автоименование).

## 2026-08-21 (четвёртая правка)
- **Задача:** Имя сессии не обновляется на открытой вкладке при переименовании (авто/событийном)
- **Тип:** bug (UI)
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** 5834bc4 (ветка feat/agent-classes-session-flow)
- **Время:** ~10 мин
- **Проблемы:** нет
- **Первопричина:** обработчик `session.updated` (transportStore) патчил сессию в сторе (дерево), но не обновлял `centerTabs[].title`; ручное переименование делало это отдельно (LeftPanel.onRenameCommit → updateTabTitle), событийный путь — нет.
- **Исправление:** в case 'session.updated' при непустом строковом `name` в payload — `useUIStore.getState().updateTabTitle('chat-'+sid, name)`. Закрывает и автопереименование, и любое переименование через API. Вкладка не открыта / name нет — безопасно.
- **Верификация:** typecheck ✅; lint 0 errors ✅; test: ui 29 / core 685 / backend 170 ✅.

## 2026-08-21 (пятая правка) — Режимы Plan/Act/YOLO + capabilities + безопасность execute_shell
- **Задача:** «Переключатели режимов Plan/Act/YOLO не работают. Модель не видит изменений в доступности, как и описания текущего режима. Пересмотреть capabilities. Прикрутить к shell фильтрацию и безопасность (по opencode/hermes).»
- **Тип:** bug + feature + refactor
- **Исполнитель:** @fixer (5 итераций), @tester (2 верификации, нашёл дыры B1–B5), оркестратор
- **Результат:** PASS
- **Ветка:** fix/mode-tools-shell-security (из master, 44bb8b5)
- **Коммит:** 9bb89ae (fix: режимы Plan/Act/YOLO — фильтрация тулов и описания режимов в system prompt, ревью capabilities, безопасность execute_shell)
- **Ключевое:**
  1. **Режимы Plan/Act/YOLO** (orchestrator.ts): список тулов LLM фильтруется по режиму (`_filterToolsByMode`: plan → убирает edit/git_write + MCP с availability.plan=false) и пересобирается после plan_enter/plan_exit в tool-цикле (раньше — только system prompt).
  2. **contextConfig не передавался в ChatOrchestrator** (core app.ts, chat.ts, backend main.ts) → `_contextConfig = null` → `getModePrompt` недоступен → описания режимов НЕ попадали в системный промпт (в реальной сессии «Разговор о разном»: system=3581 символов без [MODE: YOLO], debug через api_request.body.system). Фикс: `contextConfig` передан во все 3 точки.
  3. **Файлы режимов**: `prompts/modes/{plan,act,yolo}.md` → `prompts/system/MODE_{PLAN,ACT,YOLO}.{ru,en}.md` (стиль RULES/GATEWAY); базовые файлы без языка удалены (MODE_*.md, RULES.md, ROUTING.md — дубликаты/устаревшие); встроенный fallback [MODE: PLAN] удалён (блок режима грузится только из getModePrompt).
  4. **Capabilities**: `read_session_reference`/`get_project_info`/`list_repos` → RUNTIME (были file_read/git_read, рассинхрон с permission-группами); `isModeApplicable` — web больше не «мутирующий» (только SHELL||FILE_WRITE); по решению пользователя: analyst+git_read, assistant−shell, auditor+web, developer+web+task, devops+task, explore+git_read, general−runtime, pm+file_write+git_write+task, qa+web+task.
  5. **Безопасность execute_shell**: `security/shell-guard.ts` — shlex-токенизатор, `splitShellSegments` (; / && / & / | вне кавычек), извлечение путей (~, $HOME, $PWD, динамика → unknown), `isMutatingCommand` (в т.ч. рекурсивный разбор `sh -c`/`eval`/`sudo`, `find -delete/-exec`), `checkShellCommand`; файл-политика `definitions/shell-policy.json` (deniedPaths/deniedPrefixes/approvalPaths/deniedCommandPrefixes, полный hermes-набор) + override `{dataDir}/context/shell-policy.json`; интеграция через PermissionEvaluator (plan-режим блокирует мутирующие, префиксные правила `permission.rules.shell`, денлист поверх конфига); shellPolicy проброшен саб-агентам (task.ts), тулы саб-агента фильтруются по режиму.
- **Дыры QA (закрыты фиксером):** B1 обход plan через `;`/`&&`; B2 deniedCommandPrefixes только с начала строки; B3 shellPolicy не у саб-агентов; B4 sudo/find -delete/sh -c/eval; B5 тулы саб-агента без фильтра режима.
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 788 / backend 170 / ui 29 / shared 66 ✅; адверсальный QA 34+ кейсов (обходы, денлист, обёртки, саб-агенты) PASS; сборка core → dist/prompts/system/MODE_*.{ru,en}.md ✅.
- **Проблемы/оговорки:** `$(...)`-динамика не резолвится (осознанное ограничение дизайна) — возможно блокировать в plan отдельной задачей; для применения изменений нужна пересборка core + перезапуск dev-серверов.

## 2026-08-22 (шестая правка) — PLAN MODE в контекстные файлы + PLAN_GUIDE/TODO
- **Задача:** «Текст заметок про PLAN MODE захардкожен? Если да — надо переделать: брать из системных контекстных файлов, с поддержкой языков. Проверить источник APPROVED PLAN. В заметках про план и todo — инструкция об обновлении при выполнении задач. Модель ничего не знает о todo и отличии от плана — дополнить инструкции.»
- **Тип:** feature (core — промпты + оркестратор + тулы)
- **Исполнитель:** @fixer (2 итерации), оркестратор
- **Результат:** PASS
- **Ветка:** fix/mode-tools-shell-security (продолжение)
- **Суть:**
  1. **PLAN MODE убран из хардкода**: `[PLAN MODE: AUTO]`/`[PLAN MODE: STRICT]` (2 варианта) жили строкой в orchestrator.ts, только русский. Теперь — контекстные файлы `prompts/system/PLAN_MODE_AUTO.{ru,en}.md`, `PLAN_MODE_STRICT_APPROVED.{ru,en}.md`, `PLAN_MODE_STRICT_NOT_APPROVED.{ru,en}.md`; метод `ContextConfig.getPlanModePrompt(planMode, planApproved, language)` (off → null; override user/system → встроенный).
  2. **APPROVED PLAN — источник подтверждён**: `project.plan` (AD-039, план в проекте) → `_renderProjectPlan` → `renderPlanMarkdown`. Менять не потребовалось.
  3. **Блок [TODO]** в system prompt: `session.todos` рендерится через `renderTodosMarkdown` (todo.ts) → `[TODO]` (раньше модель видела todo только через `todo_list`).
  4. **PLAN_GUIDE.{ru,en}.md** — справочник «План и Todo»: план = стратегия проекта (kanban, project.plan), todo = оперативные шаги сессии (session.todos), отличие, правила ведения (декомпозиция → статусы → синхронизация через planItemId). Вставляется ВСЕГДА (по решению пользователя), не только при наличии плана/todo.
  5. **MODE_PLAN/ACT/YOLO.{ru,en}.md** — DIRECT INSTRUCTION дополнены: план + декомпозиция в todo; планирование доступно в любом режиме (пользователь уточнил: «в act/yolo модель тоже может планировать»).
  6. **Описания тулов todo_*** — добавлен контекст «оперативный список задач сессии, в отличие от плана проекта; planItemId связывает с пунктом плана».
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 805 / backend 170 / ui 29 / shared 66 ✅; build core → dist/prompts/system/PLAN_GUIDE/PLAN_MODE/MODE_* обновлены ✅.
- **Follow-up:** для применения в рантайме нужна пересборка core + перезапуск dev-серверов; наработки двух подзадач (PLAN MODE в файлы + PLAN_GUIDE/TODO) будут слиты в master --no-ff.

## 2026-08-22 (седьмая правка) — deny-цикл при заблокированной shell-команде + полный частичный ответ при стопе
- **Задача:** «Защита от опасных команд работает, но не так как ожидается: если модель пытается выполнить запрещённую команду через shell — блокируется, возвращается ошибка как при обрыве соединения, идут повторные попытки (3), потом пустой результат, модель не понимает, пробует снова — по кругу. При стопе сохраняется только обрывок вместо полного частичного ответа с неудачными попытками.»
- **Тип:** bug (core)
- **Исполнитель:** @fixer (2 итерации), оркестратор
- **Результат:** PASS
- **Ветка:** fix/deny-feedback-abort-partial (из master)
- **Коммит:** dbf9702
- **Время:** ~35 мин
- **Первопричина:**
  1. **Doom loop срабатывал раньше permission check** (orchestrator.ts): на 3-м одинаковом deny-вызове тул блокировался безликим «Ошибка: инструмент вызван 3 раз(а)... Цикл прерван» без tool_call.started/result и без объяснения политики → модель не понимала причину, продолжала, финальный ответ часто пустой. В UI deny выглядел как «обрыв соединения + повторные отправки».
  2. **При abort** `_saveAssistantMessage` получал только `accumulatedContent` (текст ТЕКУЩЕЙ LLM-итерации, сбрасывается каждую итерацию), тексты завершённых итераций лежали в `allIntermediateTexts` и терялись из content → в истории оставался обрывок на случайном месте.
- **Исправление:**
  1. Permission check перенесён выше doom loop; doom-счётчик инкрементируется и «Цикл прерван» применяется только для НЕ-deny повторяющихся вызовов. Deny-повторы получают полноценный tool_call.started+result.
  2. Deny toolResult дополнен инструкцией модели: «Permission denied: {reason}. Действие запрещено политикой безопасности. Не повторяйте вызов, выберите другой способ или объясните пользователю.» + флаг hadDeny.
  3. Защита от пустого финального ответа: `finalContent` подставляется («Не удалось выполнить: действие заблокировано политикой безопасности» / «Не удалось выполнить запрос: ответ модели пуст»).
  4. При abort в `_saveAssistantMessage` и `stream.cancelled` передаётся `_joinAccumulatedTexts(allIntermediateTexts, accumulatedContent)` — полный текст всех итераций; intermediate_text_blocks в metadata при отмене НЕ дублируются (они уже в content).
- **Тесты:** orchestrator-deny-abort.test.ts (4 теста: deny 3+ раза без «Цикл прерван» и с fallback; abort с полным текстом + deny в tool_results; doom loop для не-deny сохранён; пустой ответ без deny).
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 809 / backend 170 / ui 29 / shared 66 ✅; repro tmp/repro-deny.ts (3 deny + объяснение, без doom loop) и tmp/repro-stop.ts (полный текст в content, без дублей) ✅.
- **Риски:** deny-повторы больше не ограничиваются doom loop (при maxIterations=Infinity упрямая модель может повторять много раз, но каждая попытка получает понятный feedback; maxSteps агента ограничивает); пустой ответ теперь проходит в QA-эскалацию (роутер) — при необходимости исключить fallback-тексты.
- **Follow-up:** пересборка core + перезапуск dev-серверов; при необходимости слить ветку в master --no-ff.

## 2026-08-22 (восьмая правка) — агент всегда определяется в сессии (нет fallback на assistant) + default_agent
- **Задача:** «Сессия "Доступность bash-инструмента" — модель не видит shell, хотя он включён у агента. В другой сессии модель пыталась вызвать shell с вариациями имён, возвращалась ошибка и повторные попытки.»
- **Тип:** bug (core + backend + UI)
- **Исполнитель:** @fixer (2 итерации), оркестратор
- **Результат:** PASS (core/API/UI), живой LLM-ответ не подтверждён (провайдер itphx недоступен из среды)
- **Ветка:** fix/agent-role-fallback (из master)
- **Коммит:** 82bfdbe
- **Время:** ~50 мин
- **Первопричина (2 уровня):**
  1. `orchestrator.ts:613` — молчаливый fallback `|| 'assistant'`. При `agentRole` undefined (гонка loadAgents в UI, запрос не из UI) агент становился `assistant`, у которого НЕТ `shell` capability → модель не видела `execute_shell` → либо честно «нет bash», либо гадала по именам (`bash`/`shell`/`execute_command`) → «Инструмент не найден» → серия красных вызовов. Добавлен коммитом `0c26e79`.
  2. `backend/src/routes/agents.ts` — ветка «сессия без проекта → только assistant, default_agent='assistant'» навязывала assistant и игнорировала per-message выбор агента.
- **Исправление:**
  1. Убран `|| 'assistant'`: `effectiveAgentRole = message.agentRole || session.settings.agentRole`. При undefined/не-найденном агенте — НОЛЬ тулов (модель только текст, без «все non-MCP»). Ветка «без проекта → assistant» удалена.
  2. `DEFAULT_AGENT_ID = 'developer'` (export из `@itphx/synth-core`); `default_agent` в `/agents` (core+backend) → `DEFAULT_AGENT_ID`.
  3. `POST /api/v2/sessions` (core+backend) — `settings.agentRole = body.settings?.agentRole ?? DEFAULT_AGENT_ID` (новая сессия всегда с агентом по умолчанию).
  4. UI: `agentsStore.defaultAgentId` из `default_agent`; `ChatTab.handleSend` → `agentRole || activeAgentId || defaultAgentId` (закрыта гонка).
- **Тесты:** `orchestrator.test.ts` — блок «agentRole определяет набор инструментов (нет fallback на assistant)»: assistant → без execute_shell, undefined/not-found → 0 тулов, developer → execute_shell.
- **Верификация:** typecheck ✅ (6 пакетов); lint 0 errors ✅; test: core 809 / backend 170 / ui 29 / shared 66 ✅; API: default_agent=developer ✅, новая сессия settings.agentRole=developer ✅, current_stream.agent_role=developer ✅; UI: активный агент «Разработчик» по умолчанию ✅.
- **Ограничение:** живой ответ модели («видит ли shell») не подтверждён — провайдер itphx (ai.itphx.ru) недоступен из этой среды (прямой вызов пуст). Проверить в среде с рабочим LLM: спросить модель «есть ли bash» в сессии с agent=developer — должна ответить про execute_shell.
- **Follow-up:** backend `AgentModeSelector.tsx:25` захардкожен `defaultAgent = agents.find(a => a.id === 'assistant')` (визуальный дефолт сброса агента) — при желании заменить на defaultAgentId; рассинхрон projectId/project_id в хранении сессий (отдельный баг). Merge обеих веток (deny-feedback-abort-partial + agent-role-fallback) в master --no-ff.

## 2026-08-22 (девятая правка) — диагностика: почему модель не видит execute_shell на провайдере itphx
- **Задача:** «Посмотри последний ответ в сессии "Разговор о разном". Изучи дебаг. Почему модель не увидела инструмент shell?»
- **Тип:** research/диагностика (провайдер itphx)
- **Исполнитель:** оркестратор
- **Результат:** диагноз получен (ограничение провайдера, НЕ баг фикса)
- **Ветка:** fix/agent-role-fallback
- **Время:** ~40 мин
- **Наблюдение (сессия «Разговор о разном», msg 40/42):**
  - `api_request.body.tools` → 43 тула, ВКЛЮЧАЯ `execute_shell`; role в system prompt = DEVELOPER. Инструменты формируются и передаются корректно (фикс работает).
  - `api_response.tool_calls` → None; `raw_model_response` → «нет shell-инструмента», модель не упоминает НИ ОДНОГО из 43 тулов (ни read_file, ни web_fetch).
- **Причина:** провайдер `itphx` (https://ai.itphx.ru/api) НЕ поддерживает tool-calling в стриминговом режиме. Проверено прямыми запросами:
  - `stream:false` + tools → модель видит и называет `execute_shell`;
  - `stream:true` + tools → **0 tool_calls**, пустой контент (проверено на `omn.qwen3.8:27b`, `deepseek-v4-flash`, `omn.nemotron-3-nano`, `omn.qwen3:14b`).
  - Orchestrator вызывает LLM через `chatAsync` → всегда `stream:true`, поэтому tools (хоть и передаются в body) не обрабатываются моделью.
- **Вывод:** это ограничение провайдера/моделей itphx (function-calling не работает в SSE-стриме), касается всех тулов, не только shell. НЕ баг фикса agent-role-fallback.
- **Направления:** 1) прокси itphx должен поддерживать tool_calls в stream:true; 2) использовать провайдера с рабочим function-calling в стриме (напр. локальный ollama — проверить); 3) временный обход — не-стриминговый вызов при наличии tools (ломает UX печати).
- **Примечание:** обе ветки наработок закоммичены отдельно: fix/deny-feedback-abort-partial (dbf9702) и fix/agent-role-fallback (82bfdbe). Журнал (.opencode/tasks/log.md) — служебный.

## 2026-08-22 (десятая правка) — fix: отключён base64-детектор секретов (ложное срабатывание на путях ФС)
- **Задача:** «Модель получила верный result от shell, но выдала бред. Разобраться.» + «Просто отключи regexp детектирующий base64»
- **Тип:** bug fix (AD-036 LLM Gateway)
- **Исполнитель:** @fixer
- **Результат:** PASS (тесты/typecheck/lint зелёные)
- **Ветка:** fix/agent-role-fallback
- **Инструменты (независимая проверка):**
  - Tools в itphx (Open WebUI, type=openai) **работают** в `stream:true` (finish_reason=tool_calls при max_tokens=2000). Прежний вывод «не поддерживает tools в стриме» был **неверен**: при малом max_tokens у reasoning-модели qwen3.8:27b весь бюджет уходил в reasoning_content, не доходя до tool_calls.
  - Провайдер OpenAI-совместим; гипотеза про контекст 4k для ЭТОГО случая не подтвердилась.
- **Корень бреда в сессии «Разговор о разном» (msg 48→50):**
  - `execute_shell(pwd)` вернул `/mnt/data/Agent/dev/Synth/data/workspaces/WS1`.
  - LLM Gateway обфусцировал путь в `⟦SYNTH_SECRET_1⟧` (карта: ⟦SYNTH_SECRET_1⟧ → WS1) — **ложное срабатывание base64-детектора**: путь длиной ≥40 из только `[A-Za-z0-9+/]` похож на base64-строку.
  - Модель увидела плейсхолдер вместо пути, его значение не знает → галлюцинация `/home/oleg/go/src/git.silencedocs.io/pulse` (нет нигде в сессии).
- **Фикс:** удалён паттерн base64 из `DEFAULT_PATTERNS` и мёртвое условие `type !== 'base64'`; добавлен регрессионный тест «путь ФС WS1 не детектится как секрет».
- **Файлы:** packages/core/src/engine/gateway/secret-detector.ts, secret-detector.test.ts

## 2026-08-23 — feat: единая блокировка защищённых путей + секция «Безопасность»
- **Задача:** «Улучшить блокировку обращения к защищённым путям» (работа не только в shell, но и у файловых тулов; редактируемый список путей; переименовать «Шлюз безопасности» → «Безопасность»; переопределение по аналогии с контекстными файлами; отключение защиты; по умолчанию вкл.)
- **Тип:** feature
- **Исполнитель:** @fixer (+ независимый API smoke оркестратора)
- **Результат:** PASS (build/typecheck/lint/test + API-эндпоинты)
- **Ветка:** основная (master/main)
- **Принятые решения:** каскадное слияние (база + add − remove), жёсткий deny выше permission.rules, тумблер полного отключения (default true), охват всех файловых тулов + shell, override в `{dataDir}/security/protected-paths.json`.
- **Что сделано:**
  - Общий слой `packages/core/src/engine/security/protected-paths.ts` (каскад `{version:1, add, remove}`, резолв `~`/`$HOME`/`$PWD`, приоритет deny>ask>prefix).
  - Системный список `definitions/protected-paths.json`; override `{dataDir}/security/protected-paths.json` через `ProtectedPathsStore`; миграция legacy `context/shell-policy.json`.
  - `PermissionEvaluator` — жёсткий deny для read/write/edit/delete/glob/grep/git/shell до permission-rules; подсказка модели попросить пользователя изменить список.
  - Конфиг/runtime `security.protectedPaths.enabled` (default true) + live-применение (core и backend).
  - UI: `GatewaySettings.tsx` → `SecuritySettings.tsx`, секция «Безопасность», подсекция «Защищённые пути» + тумблер; локали ru/en; API `get/saveSecuritySettings`, `get/save/resetProtectedPaths`.
  - Backend-фикс: `createSettingsRoutes` теперь получает `protectedPathsStore` + `onSecurityChange` (раньше — 404/тумблер не применялся).
- **Файлы:** packages/core/src/engine/security/{protected-paths.ts,protected-paths-store.ts,protected-paths.test.ts,integration.test.ts,shell-guard.ts,index.ts}; packages/core/src/engine/permission/{evaluator.ts,evaluator.test.ts}; packages/core/src/{index.ts,server/app.ts,server/chat.ts,server/routes/settings.ts,storage/runtime-settings.ts,tools/task.ts,engine/orchestrator.ts}; packages/core/{package.json,definitions/protected-paths.json}; packages/shared/src/{config/types.ts,config/defaults.ts,index.ts}; packages/backend/src/main.ts; packages/ui/src/{components/settings/SecuritySettings.tsx,components/settings/SettingsModal.tsx,lib/api/synthApi.ts,lib/i18n/messages/ru.ts,lib/i18n/messages/en.ts}
- **Проверка:** `pnpm build` (6 пакетов), `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (shared 66 / core 840 / ui 29 / backend 170); curl: `GET/PUT/DELETE /api/v2/settings/protected-paths` → 200, `GET/PUT /api/v2/settings/security` → 200.

## 2026-08-23 — fix: сообщения защиты путей вынесены в локализуемые промпт-файлы
- **Задача:** «Текст Permission denied при чтении защищённого файла должен браться из системного контекстного файла и иметь перевод на английский»
- **Тип:** refactor/feature (локализация сообщений отказов)
- **Исполнитель:** @fixer
- **Результат:** PASS (build/typecheck/lint/test)
- **Ветка:** основная
- **Что сделано:**
  - Промпт-файлы `packages/core/prompts/security/{deny-protected-path,deny-protected-dir,ask-protected-path,deny-command}.{ru,en}.md` — каждый содержит весь текст сообщения целиком; обращение к модели в ед. числе («не повторяй», «выбери», «объясни»).
  - `ContextConfig.getSecurityMessage(messageId, language, params)` — каскад override `{dataDir}/context/user/system/security/{id}.{lang}.md` → встроенный `prompts/security/{id}.{lang}.md`; подстановка `{{path}}`/`{{dir}}`/`{{command}}`.
  - `checkPath` (protected-paths.ts) и `checkShellCommand` (shell-guard.ts) теперь возвращают `messageId`/`params` вместо захардкоженной строки; `PermissionDecision` расширен полями `messageId`/`params`.
  - `evaluator.ts` убрана захардкоженная подсказка и лишняя точка; `orchestrator.ts` и `task.ts` используют единый `getSecurityMessage` → текст main и саб-агентов идентичен.
- **Файлы:** packages/core/prompts/security/*.{ru,en}.md; packages/core/src/engine/{context/config.ts,context/config.security.test.ts,security/protected-paths.ts,security/shell-guard.ts,permission/evaluator.ts,orchestrator.ts,tools/task.ts,permission/evaluator.test.ts,security/protected-paths.test.ts,orchestrator-deny-abort.test.ts}; packages/shared/src/types/permission.ts
- **Проверка:** `pnpm build` (6 пакетов), `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (shared 66 / core 850 / ui 29 / backend 170). Пример ru: «Permission denied: Доступ запрещён: путь «/etc/passwd» защищён … Не повторяй вызов, выбери другой способ»; en: «Access denied … Do not repeat the call». Двойная точка `..` устранена.

## 2026-08-27
- **Задача:** Стоп во время работы сабагента не прерывает его
- **Тип:** bug + feature (прерывание тулов)
- **Исполнитель:** @fixer (2 вызова: задача A — сабагент, задача B — все тулы)
- **Результат:** PASS (typecheck ✓, lint 0 errors ✓, test 1157 passed ✓, core 891: +19 новых тестов)
- **Коммит:** не сделан — ждёт явной просьбы пользователя
- **Задача A:** оживлён AbortSignal (toolAbortController, двунаправленная связь cancelToken↔signal), task.ts реагирует на abort (частичный стрим сохраняется, tool_result: stopped_by_user + partial_output + steps_completed + child_session_id), ошибка провайдера сабагента → isError tool_result с child_session_id (без retry), родитель публикует stream.cancelled, child_session_id добавлен в обычный task_result
- **Задача B:** tools/abort.ts (хелперы), shell/git/project-context/web/search — реальный сигнал (SIGTERM процессам, abort fetch, подавление ретраев DDG/Bing), fs-read/fs-write/plan/todo/read-reference/project-manage/classify — guard на входе; 26 execute
- **Проблемы:** нет. Нюанс: у Session нет статусного поля завершения — прерывание выражено metadata-маркерами сообщений
- **Ожидают решения:** коммит; отдельная задача — retry сабагента при ошибке провайдера (3 попытки) + уведомление пользователя + resume дочерней сессии (UI + API)

## 2026-08-27 (сессия 2) — i18n core + resume при ошибках провайдера
- **Задачи:** A-core, A-ui, B-core, B-ui (все @fixer, B-core с продолжением сессии после лимита шагов)
- **Результат:** PASS — typecheck 6/6, lint 0 errors, тесты 1233 passed (shared 66, ui 85, core 912, backend 170; +101 новых)
- **Коммит:** не сделан — ждёт команды
- **A-core:** SystemMessages (190 ключей, engine/system-messages.ts), MessageI18n в shared, все системные строки движка → en-content + metadata.i18n; починена потеря ToolResult.metadata при персистентности; auto-title по session.language (TITLE.en.md), subagents *.en.md; мёртвый /api/v2/i18n удалён. Промпты ролей/режимов остались локализуемыми (осознанно)
- **A-ui:** resolveI18n (hasOwnProperty-защита), 190 ru-ключей, ветки рендера в ChatMessage/ToolCallPart; en-локаль → content без дублей словаря
- **B-core:** retry 3x (5/15/30с, recoverable-only, backoff-сон порциями с проверкой отмены, событие subagent.retry); рефакторинг task.ts → runSubagent(); task-resume.ts (validate + runSubagentResume: маркер resume → общий цикл → итог INFO metadata.type='subagent_resumed_result' в родителя); orchestrator.startSubagentResume (блокировки, abort-совместимость); POST /sessions/:id/resume-subagent (202/400/404/409) в core+backend
- **B-ui:** StreamErrorPanel (осн. агент, кнопка Повторить = disable старого + re-enqueue последнего user с last_error), SubagentPart (retry N/3 + Продолжить + Остановить), SubagentResumeBar (над заглушкой дочерней сессии); transportStore: subagent.retry/resume.*; i18n-ключи ru+en
- **Верификация:** curl-smoke (404 nonexistent, 400 NO_PARENT, abort 200), UI smoke через Playwright (логин, сессии, дочерняя сессия с read-only заглушкой)
- **Проблемы:** dev.sh из bash-инструмента не выживает (сессия убивает потомков) — запуск напрямую пакетными dev-командами через setsid
- **Открытое:** tool descriptions classify_conversation/read_session_reference на ru (вне схемы «не трогать descriptions»); промпт-блоки [КОНТЕКСТ СЕССИИ]/[PARENT NOTES] на ru (классифицированы как промпты); retry-now/cancel-retry для resume — не делалось; визуальная проверка плашек с реальной ошибкой провайдера — требует LLM-запроса

## 2026-08-28 — AD-041: унификация таксономии ошибок LLM + контракт локализации
- **Задача:** независимая оценка последних изменений → унифицировать таксономию ошибок и локализацию строк движка, зафиксировать AD-041 в AGENTS.md.
- **Тип:** refactor + docs
- **Исполнитель:** оркестратор (оценка + AD) + @fixer (2 задачи)
- **Результат:** PASS — typecheck 6/6, lint 0 errors, тесты 1288 passed (shared 72, core 959, ui 87, backend 170)
- **Коммит:** — (не выполнялся, нет явной просьбы; в дереве чужие незакоммиченные правки i18n/resume)
- **Сделано:**
  - **Таксономия ошибок (задача 1):** единая точка истины `llm-error.ts` — `isLlmErrorRecoverable(error, errMsg?, errorType?)`; `UNRECOVERABLE_PATTERNS` объединены (из llm-error + processor); `UNRECOVERABLE_TYPES` + `validation`; экспорт `LLM_MAX_ATTEMPTS=3`/`LLM_RETRY_DELAYS_MS=[5s,15s,30s]`. `orchestrator._handleLlmFailure` и `processor._isRecoverable` делегируют сюда, инлайновые списки удалены; `task.ts` — реэкспорт-алиасы. Новый `llm-error.test.ts`.
  - **Локализация (задача 2, уточнённая схема):** контракт в `shared/src/i18n/index.ts` — `ENGINE_MESSAGE_KEYS` (201 ключ, `as const`), `ENGINE_MESSAGE_PARAMS`, `extractParams`, тип `EngineMessageKey`, реэкспорт `MessageI18n`; subpath-экспорт `@itphx/synth-shared/i18n`. `core/system-messages.ts` — `as const satisfies Record<SystemMessageKey,string>`, `SystemMessageKey = EngineMessageKey`. Автопроверка синхронизации: тест core (ключи set-равны + params) и тест ui (каждый ключ в ru.ts, params совпадают; en — деградация на content). **Текст НЕ перемещён:** en остаётся в core, ru в ui; в shared только контракт.
  - **AGENTS.md:** добавлен AD-041 (строка в таблице + секция после «Отказ от JSON-блока», перед `## Аутентификация`).
- **Важно (решение по размещению строк):** изначальный план предполагал переезд каталога в shared. При реализации выяснилось, что ru-переводы потребляет только UI, en-шаблоны — только движок, поэтому **текст не переносился**; в shared вынесен только контракт (ключи+params+утилита). Это соответствует принципу «shared = только контракты» (AD-038) и снимает риск переписывания словарной загрузки UI. Зафиксировано в AD-041.
- **Проблемы:** нет. Открытое (из прошлой сессии) не затрагивалось.
