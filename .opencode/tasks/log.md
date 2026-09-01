# Журнал задач оркестратора

## 2026-08-31 — feat: гибридный режим (локальный synth ↔ сервер K3s) — T1–T8
- **Задача:** «Реализовать гибридный режим: локальный synth подключается к серверу в K3s; доступны локальные и удалённые проекты; LLM централизован.»
- **Тип:** feature
- **Исполнитель:** @orchestrator → @fixer (8 задач)
- **Результат:** PASS
- **Коммит:** см. коммиты ветки feat/hybrid-mode (T1–T8)
- **Что сделано:** конфиг `remote` (shared); RemoteBackendClient + OIDC device flow + credentials (core/remote); CLI `serve --connect`/`connect`/`disconnect`/`project publish|fork` (core+synth); агрегация миров с `origin` и namespace `remote:<id>` (core server); UI (OriginBadge, HybridStatusIndicator, подтверждения, селектор мира); LLM Proxy `POST /api/v2/llm/chat/completions` (backend, Gateway AD-036); RemoteProvider + запрет локальных провайдеров; RemoteEventBridge (SSE→EventBus→UI); publish/fork с переносом проекта+сессий+файлов (e2e подтверждён).
- **Проверка:** pnpm test — shared 72 / core 1081 / ui 92 / backend 201; typecheck+lint чисто; e2e publish→fork на dev-backend (история сообщений и todos перенесены).
- **Требования:** docs/HYBRID.md (ветка feat/hybrid-mode).

## 2026-09-01 — bug: провайдер не найден (K3s) — рассинхронизация кеша провайдеров/моделей
- **Задача:** «Провайдер omn.itphx.loc добавлен в K3s-инстанс через админку, но при отправке сообщения — ошибка "Провайдер не найден" (502 PROVIDER_NOT_FOUND).»
- **Тип:** bug
- **Исполнитель:** @fixer
- **Результат:** PASS
- **Коммит:** нет (не коммитим без явной просьбы; изменения в рабочем дереве)
- **Причина:** providerCache/modelCache в backend заполняются только при старте (app.ts:317-327); API-роуты POST/DELETE /providers и /models пишут только в JsonStore, не обновляя кеш. LLM Proxy резолвит провайдера только из кеша → новый провайдер невидим до рестарта пода (GET /providers читает с диска, поэтому провайдер «виден», но не резолвится). Тот же дефект в standalone-core.
- **Исправление:** backend + core — createProviderRoutes/createModelRoutes теперь принимают кеши и синхронизируют их при создании/обновлении/удалении провайдера и модели (в т.ч. POST /models/fetch и set_as_default).
- **Изменённые файлы:** packages/backend/src/app.ts, routes/providers.ts, routes/models.ts, routes/models.test.ts; packages/core/src/server/app.ts, routes/providers.ts, routes/models.ts, routes/models.remote.test.ts; новые тесты providers.test.ts (backend+core), models.cache.test.ts (core).
- **Проверка:** pnpm test — shared 72 / core 1097 / backend 220 / ui 94; typecheck+lint чисто.
- **Рантайм (K3s):** rollout restart deploy/synth-backend — кеш заполнился из PVC; тестовый запрос к POST /api/v2/llm/chat/completions с моделью omn.itphx.loc/qwen3.8:27b-256k прошёл успешно (ответ «Да.»), PROVIDER_NOT_FOUND ушёл.
- **Важно:** фикс в коде ещё не задеплоен в K3s (образ backend 0.4.1). Для постоянного эффекта без рестартов: закоммитить → релиз (GitVerse CI) → обновить tag в synth-deploy/values.yaml → Fleet. Пока действует только перезапуск пода.
