# AD-008: WebSocket для real-time событий

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический AD-008 прототипа переписан под as-built TS-стек)

**Решение:** real-time события (стриминг чанков LLM, новые/обновлённые сообщения, очередь, permission/question, план/todo) доставляются клиентам по WebSocket через единое соединение `WS /ws/events`. Соединение устанавливается один раз на клиента; подписка на сессии выполняется на уровне сервера (EventHub), а не отдельными WS-каналами на сессию.

**Контекст:** прототип (AD-008 в `archive/AGENTS_OLD.md`) решал задачу многопользовательского real-time: все клиенты, открывшие сессию, должны видеть стриминг и сообщения друг друга. В прототипе было соединение `WS /ws/chat` с комнатами по `session_id`, heartbeat и broadcast, а также fallback на SSE и UI-индикатор состояния (🟢 WS / 🟡 SSE / 🔴 backend недоступен). В TS-стеке суть сохранена, но транспорт унифицирован: вместо `WS /ws/chat` — `WS /ws/events`, а подписки централизует EventHub.

**Эволюция:** легло в основу AD-024 (единый транспорт EventHub + TransportClient). Разделение каналов «чат vs. прочие события» убрано — все события идут через `/ws/events`; SSE остаётся фоллбеком.

**Поток событий:**

```
server-side event (стирминг, план, todo, очередь…)
  → EventBus.publish(sessionId, type, data)      # AD-009
  → EventHub рассылает подписанным WS-клиентам    # AD-024
  → TransportClient (UI) обновляет сторы          # фоллбек на SSE
```

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| `WS /ws/events` (backend) | `packages/backend/src/app.ts` | HTTP-сервер поднимает WebSocket-эндпоинт; EventHub регистрирует клиентов |
| `EventHub` | `packages/backend/src/events/hub.ts` | центральный диспетчер подписок: client ⇄ sessions, broadcast |
| `WS /ws/events` (core/standalone) | `packages/core/src/server/app.ts` | тот же эндпоинт в standalone-core; auth middleware `/ws/*` |
| TransportClient (UI) | `packages/ui/src` | единый клиент событий с авто-фоллбеком на SSE |

**Статусы соединения (UI):** зелёный — WebSocket подключён; жёлтый — fallback на SSE; красный — бэкенд недоступен (историческая семантика прототипа сохранена).

**Связь:** AD-009 (SessionEventBus — источник событий), AD-024 (EventHub + TransportClient — реализующая архитектура).
