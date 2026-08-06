
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
