
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
