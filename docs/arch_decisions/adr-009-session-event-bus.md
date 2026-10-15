# ADR-009: SessionEventBus — шина событий сессии

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический ADR-009 прототипа переписан под as-built TS-стек)

**Решение:** `EventBus` — async pub/sub для событий сессии. Публикация события адресуется `sessionId` + `type` + `data`; все подписчики этой сессии получают его независимо от того, кто инициировал действие (отправитель, наблюдатель, фоновая задача). Один канал событий — все клиенты видят одно и то же.

**Контекст:** прототип (ADR-009 в `archive/AGENTS_OLD.md`) ввёл `SessionEventBus` на asyncio.Queue, чтобы UI-наблюдатели, открывшие сессию, видели streaming так же, как отправитель. Публиковались события `message_added`, `stream_start`, `stream_chunk`, `stream_done`, `queue_stalled` — и SSE-эндпоинт `/api/sessions/{id}/events` отдавал их наблюдателям. В TS-стеке сохранены и суть (единый канал событий сессии), и SSE-потребитель (см. `sseEventStream`).

**Эволюция:** `EventBus` — локальный слой публикации; поверх него ADR-024 добавил сетевое распределение (EventHub на backend, TransportClient в UI). Шина осталась транспортонезависимой: она не знает про WS/SSE.

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| `EventBus` | `packages/core/src/events/bus.ts` | subscribe/unsubscribe по `sessionId`, `subscribeAll` (глобальные подписчики), `publish`, диагностика по подписчикам |
| `sseEventStream()` | `packages/core/src/events/bus.ts` | async generator-обёртка для SSE-подписки на сессию |
| Типы событий | `packages/shared/src/types/index.ts` (`EventType`, `BusEvent`) | единый перечень: `stream.*`, `message.*`, `queue.stalled`, `permission.*`, `question.*`, `plan.approved`, `todos.updated`, `subagent.*`, `tool_call.*`, `context.*` и др. |

**Особенности реализации:**
- Подписчик может фильтроваться по `sessionId` (`subscribe`) или получать все события (`subscribeAll` — для гибридного режима: RemoteEventBridge публикует события удалённых сессий под `remote:<id>`).
- Упавший обработчик не ломает остальных (перехват исключений в цикле рассылки).
- Публикация в сессию без подписчиков логируется предупреждением `EVENT LOST` (диагностика).

**Связь:** ADR-008 (WebSocket-транспорт), ADR-024 (EventHub + TransportClient — сетевое распределение).
