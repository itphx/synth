# PROP-090: Extension API v1 — слой плагинов: контракты, доверие, два режима исполнения

> **Статус:** 🧩 Предложение
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-12
> **Обновлено:** 2026-10-22 — документ переписан по решениям владельца продукта. Слой плагинов возвращён
> в работу (полный in-process SDK, форма прежняя), добавлены **два режима исполнения** (`inline` /
> `out-of-process`), **две новые точки расширения** (`promptBlocks`, `llmFilters`), **модель доверия**
> (PROP-068) и **полный контур управления** (API/CLI/UI). Прежняя редакция (🧊 Icebox, отложено
> 2026-10-19) заменена; фазы перестроены в Ф0–Ф7 с критериями приёмки.
> **Обновлено (Ф1):** 2026-10-22 — **Ф1 выполнен** (ветка `feature/plugin-host`): загрузчик `PluginHost`
> с пайплайном активации, integrity, семвер-гейт с файлом точных исключений, trust-floor, реестр
> активаций и журнал аудита плагинов (`PluginAuditRepository`). **Исполнение кода выключено по
> умолчанию** (`plugins.executionEnabled=false`) — загрузчика кода в core нет (Ф3/Ф4). Формат файла
> точных исключений семвер-гейта **зафиксирован** в Ф1 (требует подтверждения владельца — см.
> §«Открытые вопросы» → «Решено 2026-10-22»).
> **Обновлено (Ф3а):** 2026-10-22 — **Ф3а выполнен** (ветка `feature/plugin-points`): закрыта точка
> **`promptBlocks`** — контракт `PromptBlockProvider`/`PromptBlockContext` (`shared`), реестр
> `PromptBlockRegistry`, сборка блоков в `SystemPromptComposer`, контекст хода (`query`/`turnId`),
> бюджет символов блока (`plugins.promptBlockMaxChars`, дефолт 4 000) с обрезкой и
> `status: 'truncated'`, инвалидация `promptStates` по блокам провайдеров, фасад
> `PluginFacade.registerPromptBlock`. Решения Ф3а: тир `stable` у провайдера — **отказ** (не тихое
> понижение); `plugins.scan: 'disabled'` + `plugins.executionEnabled: true` — **fail-closed**
> (`plugin.scan_disabled_with_execution`); **версия правил сканера входит в ключ кэша сканов**.
> **Обновлено (Ф3б):** 2026-10-22 — **Ф3б выполнен** (та же ветка): закрыта точка **`llmFilters`** —
> контракт `LlmCallFilter` (`shared`), реестр `LlmFilterRegistry`, фильтры в `GatewayProvider`
> (три фазы: `pre_request`/`post_response`/`embedding`), право вето только у trust ≥ `trusted`,
> `failMode`/таймаут, аудит решений (`plugin_filter`), фасад `PluginFacade.registerLlmFilter` и
> **сверка `provides` ↔ фактические регистрации** (`plugin.provides_mismatch`). Эмбеддинги перестали
> быть дырой инварианта 3: `embed` идёт через gateway-контур. После Ф3б открытым в Ф3 остаётся только
> **Ф3в** — точка `tools`, сверка `provides.tools[]` и контрактный suite расширений.
> **Источник:** вынесено из зонтика [ADR-086](./adr-086-extensibility-plugins-editions.md) — Extension API
> проектировался там как первый из четырёх столпов (плагины, editions, contribution flow, add-on'ы);
> здесь он выделен в отдельный документ и детализирован.
> **Связано:** [ADR-086](./adr-086-extensibility-plugins-editions.md) (зонтик «Классы расширений»),
> [ADR-030](./adr-030-hooks-agent-events.md) (hooks), [ADR-096](./adr-096-storage-layer.md)/
> [ADR-097](./adr-097-storage-provider-class.md) (порты и контрактный suite),
> [ADR-100](./adr-100-extension-packs-pipelines.md) (поставка `synth.pack`),
> [ADR-103](./adr-103-gateway-core-channel-contract.md) (контракт внешнего канала — образец wire-протокола),
> [ADR-036](./adr-036-llm-gateway.md) (Gateway), [ADR-070](./adr-070-system-prompt-composer.md) (сборка промпта),
> [ADR-023](./adr-023-configuration.md) (конфиг), [ADR-029](./adr-029-granular-permissions.md) (permissions),
> [ADR-052](./adr-052-public-api-platform.md) (service-key/scopes),
> [ADR-079](./adr-079-local-home-independent-instances.md) (home-раскладка),
> [ADR-094](./adr-094-observability-metrics.md) (контракт метрик),
> [ADR-099](./adr-099-egress-tls-trust.md) (egress/CA),
> [PROP-068](./prop-068-skills-agents-registry.md) (модель доверия),
> [PROP-047](./prop-047-memory-gbrain.md) (память как плагин),
> [ADR-077](./adr-077-runtime-toolchain.md) (исполнитель — образец двух режимов),
> [PROP-082](./prop-082-full-images-deployment.md) (образы),
> [PROP-100](./prop-100-ssrf-dns-rebinding.md) (SSRF).

## Контекст

Два запроса владельца продукта определяют, зачем нужен слой плагинов:

1. **Память как расширение.** Синтез памяти ([PROP-047](./prop-047-memory-gbrain.md)) должен приходить
   плагином: `MemoryProvider` — это контракт, который доставляется плагином, а не подсистемой ядра.
   Аргумент «не через Plugin SDK, потому что PROP-090 в Icebox» **больше не действует** — слой возвращён в работу.
2. **Фильтрация вызовов к провайдеру.** Сторонним системам (мониторинг, аналитика, антивирусы, DLP)
   нужен вход в поток LLM-вызовов: увидеть запрос и ответ, при необходимости — заблокировать вызов.
   Сегодня такого входа нет: `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md)) — закрытый
   слой обфускации/rate-limit/guard'ов/аудита без публичной точки вмешательства.

**Что уже есть в коде.** Пакетный контур расширений: манифест `synth.pack`
(`packages/shared/src/types/pack.ts`; `PACK_KINDS` уже содержит `'plugin'`), порт `PackRepository`
(`packages/core/src/storage/ports/pack-repository.ts`), файловая реализация `{dataDir}/packs.json`,
роуты `/api/v2/packs` (`packages/core/src/server/routes/packs.ts`), установка/одобрение/снятие.
Каталог расширений — отдельный репозиторий `synth-registry` (записи `kind: addon|gateway|storage|pack`;
плагины публикуются **в тот же** каталог — `kind: plugin`, решение владельца 2026-10-22, см. «Открытые вопросы»
→ «Решено 2026-10-22»).
Шина хуков `HookBus` ([ADR-030](./adr-030-hooks-agent-events.md)) — готовый in-process примитив с
`on/off/emit/emitAsync`, priority и `sync`/`async`. Реестры тулов (`ToolRegistry`), MCP, агентов,
скиллов, событий, расписаний. Паттерн core-фабрик роутов `createXxxRoutes(auth, deps, opts)`
([ADR-017](./adr-017-api-v2-hono.md)). Паттерн runtime-настроек `GET/PUT/DELETE /api/v2/settings/<x>`.
Контрактные порты хранилища (34 порта + контрактный suite, [ADR-096](./adr-096-storage-layer.md)).
Сборка системного промпта — единственная точка `SystemPromptComposer`
([ADR-070](./adr-070-system-prompt-composer.md)). Gateway с guard'ами и аудитом.

**Чего нет.** В коде **ноль** совпадений по: `PluginHost`, `SynthPlugin`, `@itphx/synth-plugin`,
`definePlugin`, `plugins.lock.json`, `plugins.json`, `/api/v2/plugins*`, CLI `synth plugin *`, матрицы install-policy,
`VERDICT_INDEX`, файлового security-сканера, квот сканера, `content_hash`, кэша сканов,
`quarantine/`, реестра-аудита установок. Нет и **точек расширения** под новые сценарии: реестра
провайдеров prompt-блоков (блоки собираются хардкодом через `extraBlocks.push(...)` в
`packages/core/src/engine/context/composer.ts`), нет и реестра LLM-фильтров.

**Появилось в Ф0 (2026-10-22) — уже есть в коде** (подробно — §«Статус реализации в коде (Ф0)»): секция `plugins.*`
в конфиге и `RuntimeSettings.plugins`, единый перечень trust-уровней (`packages/shared/src/types/trust.ts`), явные
Zod-схемы вкладов плагина и полей `mode`/`permissions`/`trust` (`types/pack.ts`), semver-матчер и семвер-гейт
(`types/semver.ts`, `checkExtensionCompatibility`), политика `builtin` в `HookBus` и три эмита хуков. Исполнения
кода плагинов (загрузчик, `import()`, фасад) по-прежнему нет — это Ф1+.

**Почему не «просто форк ядра».** Форк разрывает обновления, не даёт аудита, не позволяет админу
управлять набором расширений и превращает каталог в канал произвольного исполнения. Расширение
должно быть: (а) версионированным контрактом, (б) с явной границей прав, (в) с обязательным
trust/scan, (г) с проверяемым составом вкладов.

## Решение

1. **Форма слоя — полный in-process SDK.** Манифест `synth.pack` (`kind: "plugin"`), загрузчик
   `PluginHost` (resolve → integrity → semver-гейт → trust/scan → политика режима → import → facade →
   сбор disposers → аудит), фасад `@itphx/synth-plugin` с disposer-моделью, bundle-only дистрибуция,
   trust/scan по [PROP-068](./prop-068-skills-agents-registry.md). Плагин — код в процессе core.
2. **Два режима исполнения.** `inline` (код в процессе core) **и** `out-of-process` (отдельный
   процесс, локальный HTTP-протокол). Один контракт точки расширения — два транспорта. Образец в
   коде — `ExecutionPort` ([ADR-077](./adr-077-runtime-toolchain.md)): порт в core, реализации
   `InlineExecutionPort` и удалённая через `@itphx/synth-executor` (HTTP/1.1 + JSON, bearer-токен из
   файла, `POST /exec` / `GET /capabilities` / `GET /health`, `EXECUTOR_PROTOCOL_VERSION = 1`).
   **Wire-протокол плагина — HTTP/1.1 + JSON** (по образцу исполнителя), а **контракт протокола
   живёт в `@itphx/synth-shared`**; отдельный пакет `@itphx/synth-plugin-protocol` **не создаётся**
   (§7).
3. **Право вето — только у доверенных.** Фильтр с вердиктом `deny` разрешён только плагинам с
   trust ≥ `trusted` (или `builtin`). Плагины уровня `community` могут только наблюдать (аудит,
   метрики, сигнал), но не блокировать.
4. **Первая волна — полный контур.** Каркас (манифест + загрузчик + реестр + аудит активации), две
   новые точки расширения (`promptBlocks`, `llmFilters`), контрактный suite расширений, модель
   доверия ([PROP-068](./prop-068-skills-agents-registry.md)), API/CLI/UI управления плагинами.
5. **[PROP-047](./prop-047-memory-gbrain.md) переписывается под слой плагинов** (отдельная задача):
   `MemoryProvider` — контракт, доставляемый плагином.
6. **Работа ведётся в ветке `feature/plugin-layer`** (worktree `wt-plugins`, от `master`).

### Что меняется против прежней редакции

| Аспект | Было (2026-10-12, отложено 2026-10-19) | Стало (2026-10-22) |
|---|---|---|
| Статус/срок | 🧊 Icebox, срок снят | 🧩 Предложение, `Решение до: 2026-11-14` |
| Форма | in-process SDK | in-process SDK **+** out-of-process (второй транспорт) |
| Точки | 12 (11 с seam'ом + отложенный UI-slot) | **14**: 12 прежних + `promptBlocks` + `llmFilters` |
| Доверие | «наследует модель контента», свой части нет | Явная иерархия, матрица install-policy с ячейкой `kind: "plugin"`, trust-floor `trusted`, отдельный журнал аудита плагинов |
| Семвер-гейт | `contracts: "1"` (строка) | `contracts` — semver-мажор контракта точки расширения |
| Аудит | «в audit log PROP-068» | Отдельный порт `PluginAuditRepository` + `{dataDir}/audit/plugins.jsonl` (семантика `SECURITY_AUDIT_SCOPES` — «изменение политики» — не подходит) |
| Манифест | `provides` без описания новых видов вкладов | `provides.tools[]`, `provides.promptBlocks[]`, `provides.llmFilters[]`, `mode`, `permissions`, `trust` — явными Zod-схемами |
| Фазы | Ф0–Ф5 (Ф0 отдельно не делался) | Ф0–Ф7 с критерием приёмки для каждой |
| Гибрид | Уровень 2 «проектируем сразу» | Уровень 2 — **вне первой волны** (Ф7) |

## Классы расширений

Классы разведены в [ADR-086](./adr-086-extensibility-plugins-editions.md) (§1) — здесь только
отличие плагина, без дублирования.

| Класс | Что запускается | Носитель | Контракт с Synth |
|---|---|---|---|
| **Plugin** | код, исполняемый **в процессе core** — `inline` **или** отдельный процесс (`out-of-process`) | self-contained bundle (JS) + манифест | Extension API v1: манифест `synth.pack`, интерфейс `SynthPlugin`, точки расширения; подчиняется permission-слою/Gateway/портам хранилища |
| **Gateway** | **внешний сервис-транспорт** внешний мир ↔ Synth (двусторонний) | образ + `docker-compose`/Helm | API v2 / MCP / внешние события ([ADR-089](./adr-089-external-events-automation.md)); контракт — [ADR-087](./adr-087-gateways.md) |
| **Add-on** | **внешний сервис** иного назначения — свой процесс/контейнер | образ + `docker-compose`/Helm | API v2 / MCP / внешние события; эталон — `synth-media` |
| **Storage-драйвер** | драйвер слоя хранения | пакет | порты [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) |
| **Контент-пак** (Declarative) | ничего (данные, без кода) | файлы контента + `synth.pack` | скиллы/команды, агенты, MCP-серверы, темы/i18n/провайдеры/промпты/policies ([PROP-068](./prop-068-skills-agents-registry.md)) |
| **Edition** | сборка/дистрибутив продукта | репозиторий + образ | contribution flow — вне первой волны |

**Отличие плагина от остальных — два режима исполнения.** Остальные классы не исполняются в процессе
ядра вовсе. Плагин умеет и встраиваться в поток (`inline`), и выноситься в отдельный процесс
(`out-of-process`) — при одном и том же контракте точки расширения.

## Точки расширения

Точки расширения — вклад **в существующие seam'ы** ядра, а не новый рантайм.

| # | Точка | Вклад | Seam в коде | Статус |
|---|---|---|---|---|
| 1 | hooks | обработчики жизненного цикла | `HookBus.on/off/emit/emitAsync` (`engine/hooks/hook-bus.ts`, [ADR-030](./adr-030-hooks-agent-events.md)) | ✅ шина есть; SDK-фасада нет |
| 2 | tools | новые инструменты | `ToolRegistry.register/deregister/deregisterByCapability` (`engine/tools/registry.ts`) | ✅ реестр есть |
| 3 | providers | LLM/decision-провайдеры | `ProviderFactory`/`BaseProvider` (`providers/*`), вызов только через `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md)) | ✅ фабрика есть |
| 4 | routes | HTTP-роуты API v2 | core-фабрики `createXxxRoutes(auth, deps, opts)` ([ADR-017](./adr-017-api-v2-hono.md)) | ✅ паттерн есть |
| 5 | commands | slash-команды/bundles | `engine/commands/*` ([ADR-046](./adr-046-skills-and-slash-commands.md)) | ✅ |
| 6 | skills | скиллы (механизм/каталог) | `engine/skills/*`, каталог [PROP-068](./prop-068-skills-agents-registry.md) | ✅ механизм; каталог — нет |
| 7 | agents | определения агентов | `AgentRegistry` (`engine/agents/*`) | ✅ |
| 8 | mcp | MCP-серверы (stdio/HTTP) | `McpRegistryStore`/`McpManager` (`engine/mcp/*`, [ADR-071](./adr-071-mcp-servers-prompt.md)) | ✅ |
| 9 | events | источники/правила/доставка событий | `EventIngress`/`EventRouter`/`RouteRuleProvider` (`engine/events/*`, [ADR-089](./adr-089-external-events-automation.md)) | ✅ |
| 10 | schedules | источники-расписания | `SchedulerService`/`SchedulerRuleProvider` (`engine/scheduler/*`, [ADR-051](./adr-051-scheduler-pipelines.md)) | ✅ (частично) |
| 11 | settings | свои настройки/секция | `RuntimeSettingsStore`, паттерн `GET/PUT/DELETE /api/v2/settings/<x>` | ✅ паттерн есть |
| 12 | UI-slot | панели/вкладки в SPA | — (seam отсутствует) | ⏳ отложено |
| **13** | **promptBlocks** | **блоки системного промпта** | **`SystemPromptComposer._collectBlocks` (`engine/context/composer.ts:426-646`)** | **🆕 новая точка (в прежней таблице §2 её не было)** |
| **14** | **llmFilters** | **наблюдение/фильтрация LLM-вызовов** | **`GatewayProvider._prepare` (`:377`) и `_auditCompletion` (`:453`)** | **🆕 новая точка** |

12 существующих точек покрывают 11 seam'ов в коде (UI-slot отложен — в SPA нет стабильной точки
монтирования сторонних React-компонентов). Две новые точки закрывают оба запроса владельца
(память → `promptBlocks`; фильтрация вызовов → `llmFilters`).

## Точка `promptBlocks`

**Зачем.** Единственная точка сборки system-промпта — `SystemPromptComposer`
(`packages/core/src/engine/context/composer.ts:277`): публичные `compose()` (`:294`) и
`manifest()` (`:326`), приватный `_collectBlocks()` (`:426-646`). Модель блока —
`packages/core/src/engine/context/prompt-blocks.ts:12-23`:
`PromptBlock { key, tier: 'stable'|'context'|'volatile', order, content, provenance?, status? }`,
тиры `TIER_ORDER` (`:25-29`), сортировка `sortPromptBlocks` (`:35`), склейка `joinPromptBlocks` (`:45`).
Сейчас блоки собираются **хардкодом** (`extraBlocks.push({ key, tier, order, content, provenance })`),
реестра провайдеров нет.

### Контракт `PromptBlockProvider`

```typescript
/** Провайдер блока системного промпта (точка расширения `promptBlocks`). */
export interface PromptBlockProvider {
  /** Ключ блока. Уникален в инстансе; для плагина — `plugin.<pluginName>.<slot>`. */
  readonly key: string;
  /** Тир блока. `stable` ЗАПРЕЩЁН (граница prompt-cache, см. ниже). */
  readonly tier: 'context' | 'volatile';
  /** Порядок внутри тира. */
  readonly order: number;
  /** Человекочитаемая подпись для манифеста промпта (в `PROMPT_BLOCK_LABELS`). */
  readonly title?: string;
  /** Содержимое блока. `null`/`''` — блок пуст (в манифесте `status: 'empty'`). */
  load(ctx: PromptBlockContext): Promise<PromptBlockContent | null> | PromptBlockContent | null;
}

/** Узкий контекст вызова — без портов и функций (см. §7). */
export interface PromptBlockContext {
  readonly sessionId: string;
  readonly agentRole: string;
  readonly language: string;
  readonly projectId?: string;
  readonly mode: 'plan' | 'act' | 'yolo';
  /**
   * Текст последнего сообщения пользователя — то, по чему идёт retrieval.
   * Не задан — «вопроса хода» нет (саб-агент `task`, шаг пайплайна).
   */
  readonly query?: string;
  /** Идентификатор хода (`streamId`) — для мемоизации/кэша провайдера. */
  readonly turnId?: string;
  /** Метка времени хода (ISO 8601) — для оценки «свежести» фактов. */
  readonly timestamp?: string;
}

export interface PromptBlockContent {
  content: string;
  provenance?: string;
  status?: 'loaded' | 'empty' | 'truncated';
}
```

### Откуда берётся `query` (контекст текущего хода)

**Проблема, которую закрывает `query`.** Блок тира `volatile` объявлен как «релевантное текущему
ходу», но без текста текущего сообщения пользователя провайдер не может ни понять, что релевантно,
ни выполнить retrieval — сценарий плагина-памяти «подкинуть агенту факты по текущему вопросу»
([PROP-047](./prop-047-memory-gbrain.md)) на тире `volatile` без `query` нерабочий. Поэтому `query` —
**часть контракта**, а не деталь реализации.

**Источник в коде.** Ход инициируется сообщением: это `message` в `ProcessSetupArgs`
(`packages/core/src/engine/orchestrator/phases/process-setup.ts:66`), далее
`_processMessage(session, message, …)` (`packages/core/src/engine/orchestrator.ts:2331-2337`).
Текст — `Message.content` (`packages/shared/src/types/message.ts:47`); в LLM уходит **тот же**
текст: история для запроса формируется `ChatOrchestrator._sessionMessagesToLlm`
(`packages/core/src/engine/orchestrator.ts:3711` → `sessionMessagesToLlm`,
`packages/core/src/engine/orchestrator/prompt-info.ts:26-130`, `msg.content`) и собирается в
`process-setup.ts:463-464`. Контекст Composer'а собирается в той же фазе setup:
`deps.buildComposerContext({…})` (`process-setup.ts:388-409`) →
`ChatOrchestrator._buildComposerContext` (`packages/core/src/engine/orchestrator.ts:1117-1181`) →
`deps.composer.compose(composerCtx)` (`process-setup.ts:410`); там же `message` уже используется
для `interviewEligible` (`:404`) и `schedulerCurrentTurn` (`:408`) — то есть **для контекста хода
сообщение доступно без новых источников**.

**Что уходит в провайдера.** Только узкий DTO (`PromptBlockContext`); история сессии
(`ComposerContext.historyMessages`, `orchestrator.ts:1156`) наружу не отдаётся — иначе контракт
перестаёт быть сериализуемым (§7) и провайдер получал бы весь диалог вместо вопроса.

### Реестр в `SystemPromptComposer`

- **Где.** Новая приватная коллекция провайдеров в `SystemPromptComposer` + вызов из
  `_collectBlocks()` — **перед** `return [...baseBlocks, ...extraBlocks];`
  (`packages/core/src/engine/context/composer.ts:645`). Блоки плагинов попадают в тот же массив,
  что и builtin-блоки, и проходят тот же `sortPromptBlocks` → один манифест, одна склейка.
- **Порядок обхода.** Провайдеры обходятся в порядке регистрации; итоговый порядок определяется
  `sortPromptBlocks` (тир → `order`). При равных `order` порядок регистрации сохраняется (сортировка
  стабильная) — поэтому регистрация должна быть детерминированной.
- **Подпись в манифесте.** `PROMPT_BLOCK_LABELS` (`composer.ts:37-62`) сейчас **не экспортируется**;
  при неизвестном ключе подставляется сам `key` (`composer.ts:335`). Для плагинных блоков добавляется
  явная запись (`plugin.<name>`), иначе в манифесте будет сырой ключ. Тип `PromptManifestStatus`
  переиспользуется (`packages/shared`), новых статусов не вводится.
- **Регистрация.** Провайдер регистрируется через фасад (`synth.promptBlocks.register(...)`) и
  возвращает disposer. Регистрация с `tier: 'stable'` — **отказ** (ошибка активации, не тихое
  понижение до `context`).

### Шов `PromptBlockProvider` — проектируется и реализуется

**Шов проектируется как `PromptBlockProvider`** — реестр провайдеров в `SystemPromptComposer`
(см. §«Реестр в `SystemPromptComposer» выше); реализация — **Ф3** (контракт, реестр, правила
тиров/порядка/инвалидации/деградации). Это **не** отдельная точка расширения: `PromptBlockProvider` —
контракт **внутри** точки `promptBlocks`, а не шестая/пятнадцатая точка.

**Расхождение в документации пакета — правится в Ф3.** Строка `packages/core/AGENTS.md:410`
утверждает, что в `composer.ts` есть «`ContextSource`-шов `{ key, load(ctx) }`». **Это не
соответствует коду:**

| Что | Где | Что там на самом деле |
|---|---|---|
| `ContextSource` | `packages/shared/src/types/provider.ts:64` | **метаданные модели**: `'api' \| 'reference' \| 'manual' \| 'unknown'` — к промпт-блокам отношения не имеет |
| Шов промпт-блоков | `packages/core/src/engine/context/composer.ts` | **реестра нет**: блоки собираются хардкодом (`extraBlocks.push(...)`), `_collectBlocks` (`:426-646`) — приватный метод без внешней точки регистрации |

То есть шов `{ key, load(ctx) }` в коде **отсутствует**, а имя `ContextSource` уже занято другим
типом. Поэтому: контракт точки — **`PromptBlockProvider`** (имя не переиспользует `ContextSource`),
реализуется в **Ф3**, а строка `packages/core/AGENTS.md:410` приводится в соответствие **в рамках
Ф3** (правка инструкций согласовывается с владельцем отдельно — на момент написания документа
она не внесена).

### Правила

| Правило | Формулировка |
|---|---|
| Тир `stable` | **Запрещён.** `stablePrefix` = склейка **только** stable-блоков (`composer.ts:297-299`); вторая граница кэша — `stableToolCount` (`engine/orchestrator/phases/process-setup.ts:478`). Плагинный блок в `stable` ломал бы prompt-cache и инвалидировал бы префикс на каждой сборке. |
| Тиры `context`/`volatile` | Разрешены. `context` — зависит от проекта/сессии (инструкции, память), `volatile` — меняется каждый ход (сводка, состояние). |
| Контекст хода (`query`) | `query` — **текст последнего сообщения пользователя**, по которому идёт retrieval. Заполняет хост: сообщение, которым инициирован ход (`ProcessSetupArgs.message`, `engine/orchestrator/phases/process-setup.ts:66`; текст — `Message.content`, `shared/src/types/message.ts:47`), ровно тот же текст, что уходит в LLM (`sessionMessagesToLlm`, `process-setup.ts:464` → `engine/orchestrator/prompt-info.ts:26-130`). История в контекст **не** попадает — провайдер получает вопрос, а не диалог. `turnId`/`timestamp` — метки хода (для мемоизации и «свежести» фактов), опциональны. |
| `query` отсутствует | Саб-агент (`task` — промпт мимо Composer) и шаг пайплайна — «вопроса хода» нет. Правило: блок тира `volatile` без `query` — **пуст** (`content: ''`, `status: 'empty'`); хост **не** подставляет заглушку и **не** требует `query`. Провайдер вправе решить иначе (например, вернуть общий свод по сессии) — retrieval «по текущему вопросу» без `query` невозможен, и хост этого не проверяет. |
| Бюджет символов блока | Retrieval может вернуть много — нужен предел. Бюджет — **в символах на блок** и это **настраиваемый параметр: по умолчанию 4 000** (`plugins.promptBlockMaxChars`; в токены переводит движок, chars-per-token). Задаётся в секции `plugins.*` конфига ([ADR-023](./adr-023-configuration.md)) **и** в runtime-настройках `GET/PUT/DELETE /api/v2/settings/plugins` (§11) — runtime-override приоритетнее конфига. Провайдер **обязан** уложиться; не уложился — **хост** обрезает (голова+хвост, маркер усечения) и ставит `status: 'truncated'` (статус уже есть в `PromptBlockContent`). Образец — `ContextBuilder`: `waterFillAllocate` (`engine/context/instructions.ts:373`) + `truncateHeadTail` (`:426`) + маркер `buildTruncationMarker` (`:418`). |
| Порядок | `order` — число внутри тира; tie-break — порядок регистрации. Встроенные блоки занимают `order` 5–90 (`role` 10, `additional` 20, `profile` 10, `project.info` 20, `sticky` 10, `participants` 20, `summary` 30, `interview` 90 — `engine/context/builder.ts:137-144`; в `_collectBlocks`: `override` 5, `gateway` 30, `plan.guide` 40, `mode.policy` 45, `skills.catalog` 35, `skills.catalog.session` 55, `instructions` 15, `scheduler` 16, `scheduler.turn` 40, `mcp.servers` 50, `mcp.status` 70, `tools.guide` 25, `classification` 80, `session.info` 30). Плагинные блоки рекомендуется ставить в `order ≥ 100`, чтобы не спорить со встроенными. |
| `provenance` | **Обязателен** для плагинного блока (рекомендуемое значение `plugin:<name>`) — по нему видно источник в манифесте и в `debug`-сборке. |
| Инвалидация состояния | Плагинный блок учитывается в `session.promptStates[agentKey]` (`engine/context/prompt-state.ts`: `agentKeyOf:21`, `buildPromptState:41`, `isPrefixUnchanged:67`, `isBlockChanged:84`). Так как блок лежит вне `stable`, смена его содержимого не видна `isPrefixUnchanged` — нужен **отдельный** трек по образцу `instructions`: `isBlockChanged(prev, blocks, key)` (`process-setup.ts:440`) с добавлением плагинных ключей в отслеживаемые. Запись состояния — только при смене generation (`reason` = `init\|generation-change\|override`, `process-setup.ts:427-453`). |
| Деградация | Ошибка провайдера (`throw`) → `warning` в лог → блок пуст (`content: ''`), **ход не падает**. Образец: `orchestrator.ts:1399-1402` (warn → `undefined`). |
| Override `session.settings.systemPrompt` | Override **заменяет базу целиком** (`composer.ts:435-449`): при нём не добавляются `skills.catalog*`, `instructions`, `scheduler*`. Плагинные блоки в override-режиме **тоже не добавляются** (то же правило: пользовательский промпт заменяет всё). В провайдер уходит `stablePrefix: undefined` (`process-setup.ts:414-420`). |
| Саб-агент `task` | **Известное ограничение.** Тул `task` собирает промпт **мимо Composer** (`engine/tools/task/tool.ts:114-218`, `engine/tools/task/prompt.ts:21`) — плагинная память в саб-агента не попадёт без отдельной правки (вне Ф3). |
| Шаг пайплайна | Идёт **через Composer**, но с суженным контрактом `ComposerSessionLike = { settings: { agentRole, language }, promptStates: {}, projectId? }` (`engine/pipelines/executors/agent-step.ts:534-559`, `buildStepSessionLike` `:799-809`). Провайдер, которому нужен `sessionId`/полный `Session`, в шаге пайплайна получит суженный контекст: `sessionId` — идентификатор шага `pipeline:<runId>:<nodeId>` (тот же, что в `cacheKey`, `agent-step.ts:565`), `mode` — режим шага `ctx.mode` = `spec.mode` (`plan`/`act`/`yolo`, `engine/pipelines/step-context.ts:139`), `agentRole`/`language`/`projectId` — из контекста шага; **`query`/`turnId`/`timestamp` не заполняются** — у шага нет «сообщения пользователя» (задание узла + вход шага — не запрос), см. правило «`query` отсутствует». |
| Паритет «манифест ↔ байты» | Покрыт тестом `engine/context/composer.test.ts:315-345` — новый путь не должен его ломать. |

### Критерии приёмки точки

1. Плагин с одним `promptBlocks`-провайдером подключается, и его блок виден в `compose().blocks` и в
   `manifest()` (запись `source: 'system'`, `provenance: 'plugin:<name>'`).
2. Провайдер с `tier: 'stable'` отклоняется на регистрации с понятной причиной; активация плагина
   при этом не «падает вслед» — остальные точки регистрируются, плагин помечается частично-активным.
3. Ошибка провайдера не роняет ход: в лог — `warning`, блок пуст, `compose()` отдаёт результат.
4. Смена содержимого блока инвалидирует `promptStates` (проверяется тестом на `isBlockChanged` по
   образцу `instructions`).
5. При `session.settings.systemPrompt` блок плагина в промпт не попадает, `stablePrefix` в провайдер
   не уходит.
6. Тест паритета «манифест ↔ отправленные байты» (`composer.test.ts:315-345`) остаётся зелёным.
7. `query` доходит до провайдера: тест, что в `PromptBlockContext` есть текст последнего
   сообщения пользователя (источник — `ProcessSetupArgs.message`); при его отсутствии (шаг
   пайплайна, саб-агент) поведение согласовано — блок `volatile` пуст, ход не падает.
8. Блок длиннее бюджета символов обрезается с маркером усечения и `status: 'truncated'`
   (образец — `truncateHeadTail`, `engine/context/instructions.ts:426`).

## Точка `llmFilters`

**Зачем.** Сторонним системам (мониторинг, аналитика, антивирус, DLP) нужен наблюдаемый вход в
поток LLM-вызовов. Сегодня `GatewayProvider` — закрытый слой: `chat` (`:128`), `chatAsync` (`:189`),
`embed` (`:269`), `decide` (`:280`), `listModels` (`:369`); публичной точки вмешательства нет.

### Контракт `LlmCallFilter`

```typescript
/** Фильтр LLM-вызовов (точка расширения `llmFilters`). */
export interface LlmCallFilter {
  /** Идентификатор фильтра: `plugin:<pluginName>:<filterName>`. */
  readonly id: string;
  /** Фаза: до запроса провайдеру, после ответа или эмбеддинги. */
  readonly phase: 'pre_request' | 'post_response' | 'embedding';
  /** Поведение при ошибке/таймауте: `closed` — блокировать, `open` — пропустить. */
  readonly failMode: 'open' | 'closed';
  /** Бюджет времени на вызов, мс. Не задан — берётся из политики плагинов. */
  readonly timeoutMs?: number;
  /** Проверка. Возвращает вердикт. */
  inspect(input: LlmFilterInput): Promise<LlmFilterVerdict> | LlmFilterVerdict;
}

/** Вход фильтра — узкий DTO (без портов и функций). */
export interface LlmFilterInput {
  readonly phase: 'pre_request' | 'post_response' | 'embedding';
  readonly provider: string;
  readonly model: string;
  readonly sessionId?: string;
  /** `pre_request`: сообщения запроса. */
  readonly messages?: readonly LLMMessage[];
  /** `pre_request`: системный промпт. */
  readonly systemPrompt?: string;
  /** `post_response`: полный текст ответа. */
  readonly content?: string;
  /** `post_response`: расход токенов. */
  readonly usage?: TokenUsage;
  /** `embedding`: тексты, уходящие в эмбеддинг (для одиночного вызова — массив из одного). */
  readonly texts?: readonly string[];
}

export interface LlmFilterVerdict {
  /** `allow` — пропустить; `deny` — заблокировать вызов; `redact` — заменить содержимое. */
  readonly verdict: 'allow' | 'deny' | 'redact';
  /** Человекочитаемая причина (попадает в аудит и в текст ошибки). */
  readonly reason?: string;
  /** Машиночитаемый код причины. */
  readonly code?: string;
  /** Новое содержимое — только для `redact` в `post_response`. */
  readonly redactedContent?: string;
  /** Новые тексты — только для `redact` в `embedding`. */
  readonly redactedTexts?: readonly string[];
}
```

Типы `LLMMessage`/`SystemPromptInput`/`SystemPromptPayload`/`CancellationToken` —
`packages/core/src/providers/base.ts:151-231`; `LLMChunk`/`LLMResponse`/`TokenUsage` —
`packages/shared/src/types/llm.ts:11-36`.

### Где вклинивается

| Фаза | Seam | Что видит фильтр | Влияние на вызов |
|---|---|---|---|
| `pre_request` | `GatewayProvider._prepare` (`packages/core/src/engine/gateway/gateway-provider.ts:377-435`) — **после** карты обфускации (`:386` rate-limit по user, `:390` rate-limit по provider, `:395` `runInputGuard`, `:411` сохранение карты, `:415-425` blocked) | обфусцированные сообщения, системный промпт, tools, `provider`/`model`/`sessionId` | `deny` → вызов не уходит провайдеру; причина — в аудит gateway и в текст ошибки |
| `post_response` | `GatewayProvider._auditCompletion` (`:453-492`) — **после** output-guard | полный текст ответа, `usage` | первая волна — **только аудит/наблюдение**, блокировки нет (см. ограничение по стриму) |
| `embedding` | `GatewayProvider.embed` (`:269`) — **новая ветка `_prepareEmbedding`**, до `_inner.embed` | тексты к эмбеддингу (`texts`), `provider`/`model` | `deny` → эмбеддинг не уходит провайдеру; `redact` → тексты заменяются на `redactedTexts` до вызова |

Точки вызова провайдера в движке идут через `GatewayProvider` (основной ход — `orchestrator.ts:2534`,
эскалация — `orchestrator/phases/process-finalize.ts:253`, авто-заголовок — `sessions/auto-title.ts:80`,
debug — `orchestrator/debug.ts:92`, суммаризация — `orchestrator/summarization.ts:97` и
`context/optimizer.ts:243,292`, субагент — `engine/tools/task/run-cycle.ts:387,1040`, шаг пайплайна —
`engine/pipelines/executors/agent-step.ts:589`, micro-LLM — `router/micro/models/micro-llm-model.ts:61`,
quality-check — `router/quality-checker.ts:99`, decision — `router/decision-cascade.ts:139`,
LLM Proxy — `packages/backend/src/routes/llm.ts:283,355`).
Точка подключения — общая, поэтому фильтр видит **все** вызовы, а не только основной ход.

**Эмбеддинги — исключение, которое закрывается в Ф3.** `GatewayProvider.embed` (`:269`) сегодня —
прямой вызов `_inner.embed` **без** `_prepare`/`_auditCompletion` (guard, rate-limit, обфускация,
аудит не применяются), а микро-слой (`router/micro/models/embedding-model.ts:200,218`) зовёт
`provider.embed` напрямую через duck-типизированный `ProviderPool` — **мимо gateway вовсе**.
Поэтому embedding-фаза фильтров без правки этих путей не заработает: см. §«Фаза `embedding`».

### Фаза `embedding`

**Решение владельца (2026-10-22): эмбеддинги идут через фильтры.** Третья фаза `llmFilters` —
`embedding`; отдельный пакет/точка расширения не нужны.

**Seam.** Новая приватная ветка в `GatewayProvider` — `_prepareEmbedding(texts)`, вызывается из
`embed()` **до** `_inner.embed`. В Ф3 `embed` перестаёт быть прямым вызовом `_inner.embed` и проходит
**тот же gateway-контур**, что и chat-пути (rate-limit, guard там, где он применим к эмбеддингам,
аудит вызова), а микро-слой перестаёт звать `provider.embed` напрямую — только
`GatewayProvider.embed`. Иначе фильтр не увидит вызов, а инвариант 3 («любой LLM-вызов — через
`GatewayProvider`») остался бы дырой: сегодня эмбеддинги обходят guard полностью.

**Что видит фильтр.** Тексты, уходящие в эмбеддинг (`texts` — массив; для одиночного
`GatewayProvider.embed(text)` — массив из одного элемента), `provider`, `model`, `sessionId?`.
Системного промпта и истории в embedding-вызове нет.

**Вердикты.**

| Вердикт | Действие |
|---|---|
| `allow` | вызов идёт провайдеру как есть |
| `deny` | эмбеддинг **не** уходит провайдеру; причина — в аудит gateway и в текст ошибки (как в `pre_request`) |
| `redact` | тексты заменяются на `redactedTexts` **до** вызова провайдера (маскирование PII/секретов в корпусе); при несовпадении длины массивов — `deny` (fail-closed) |

**Правило вето распространяется и сюда.** `deny`/`redact` разрешены только плагинам с trust ≥
`trusted` — как в `pre_request` (см. §«Кто вправе блокировать»): фильтр с trust ниже порога,
вернувший блокирующий вердикт, **понижается хостом до `allow`**, факт — в аудит.

**Деградация.** Семантика `failMode`/`timeoutMs` — общая с остальными фазами: блокирующий фильтр по
умолчанию `failMode: 'closed'` (сбой/таймаут → эмбеддинг не выполняется, причина
`plugin_filter_unavailable`/`plugin_filter_timeout`), наблюдательный — `'open'`.

### Кто вправе блокировать

**Решение владельца (2026-10-22): право вето — только у доверенных.**

| Trust плагина | `deny` в `pre_request` | `redact` в `post_response` | `deny`/`redact` в `embedding` | Наблюдение (аудит/метрики/сигнал) |
|---|---|---|---|---|
| `builtin` | ✅ | ✅ | ✅ | ✅ |
| `verified` | ✅ | ✅ | ✅ | ✅ |
| `trusted` | ✅ | ✅ | ✅ | ✅ |
| `community` | ❌ | ❌ | ❌ | ✅ |
| `agent-created` | ❌ | ❌ | ❌ | ✅ |

Энфорс на стороне хоста, а не плагина: фильтр `community`-плагина, вернувший `deny`, **понижается
хостом до `allow`**, а факт понижения пишется в аудит (`plugin_filter.deny_downgraded`) — плагин
не может «накрутить» свой trust, потому что уровень задаёт источник/реестр
([PROP-068](./prop-068-skills-agents-registry.md) §4.1), а не манифест. **Правило вето одинаково
для всех трёх фаз**, включая `embedding`: блокирующий вердикт фильтра с trust ниже `trusted`
понижается хостом до `allow` так же, как в `pre_request`.

### Семантика отказа и таймаут

- **По умолчанию** `failMode: 'closed'` для фильтра, который умеет `deny` (блокирующий класс): сбой
  или таймаут → вызов **не** уходит провайдеру, причина `plugin_filter_unavailable`.
- Для **наблюдательного** фильтра (только аудит/метрики) `failMode` по умолчанию `'open'`: сбой не
  влияет на вызов, факт фиксируется в аудите.
- **Таймаут** — отдельный бюджет на вызов фильтра (по умолчанию — из политики плагинов; значение
  открытый вопрос, §14). По истечении таймаута применяется `failMode`: `closed` → блокировка с
  причиной `plugin_filter_timeout`; `open` → вызов идёт, в аудит — `plugin_filter.timeout`.
- **`embed` сегодня обходит guard полностью** (`gateway-provider.ts:269` — прямой вызов `_inner.embed`):
  это дыра инварианта 3, и она **закрывается в Ф3** — `embed` получает ветку `_prepareEmbedding`,
  embedding-фазу фильтров и общий gateway-контур (rate-limit/аудит), а микро-слой перестаёт звать
  `provider.embed` напрямую. До Ф3 embedding-фаза фильтров **не работает** — эмбеддинги не видны
  фильтру (см. §«Фаза `embedding`»).
- **`config.enabled === false`** → `chat`/`chatAsync` идут в `_inner` напрямую
  (`gateway-provider.ts:140-144`, `:201-213`): обфускация, rate-limit, аудит и payload-лог
  **не выполняются**. Плагинные фильтры в этом режиме тоже не выполняются (единое правило: выключен
  gateway — нет его слоёв).

### Ограничение по стриму

В стриме чанки отдаются как есть (`yield chunk`, `gateway-provider.ts:248`), полный текст копится в
`accumulated` (`:246`) **только для аудита**. Блокировка или правка ответа в стриме **невозможна без
буферизации**, а [ADR-036](./adr-036-llm-gateway.md) прямо запрещает буферы и задержки
(«никаких буферов и задержек»). Отсюда решение первой волны:

- `deny` — **только** в `pre_request` и `embedding` (в `embedding` потока нет — эмбеддинг не стримится,
  блокировка до отправки провайдеру);
- `post_response` — **аудит без блокировки** (наблюдение, метрики, сигнал);
- буферизация ответа — **явная опция** (`redact`/блокировка в `post_response`) с явной ценой:
  буферизация всего ответа + задержка первого чанка; включается только плагином с trust ≥ `trusted`
  и только для конкретного вызова, по умолчанию **выключена**.

### Чего фильтр не может

- Отключить или обойти существующие guard'ы (`runInputGuard`/`runOutputGuard`).
- Вызвать эмбеддинг мимо gateway-контура (embedding-фаза — часть gateway, инвариант 3).
- Изменить `config.enabled` gateway.
- Изменить карту обфускации или rate-limit.
- Добавить свои лейблы метрик: набор имён и лейблов зафиксирован контрактом
  [ADR-094](./adr-094-observability-metrics.md); метрики фильтра — только существующие серии
  (`synth_llm_requests_total{provider,model,outcome}`,
  `synth_llm_duration_seconds{provider,model}`,
  `synth_llm_tokens_total{provider,model,kind}` — `packages/core/src/metrics/collectors/llm.ts:25-39`),
  а факт срабатывания — в аудит и журнал плагинов.
- Выдать свой ответ в обход gateway.

### Критерии приёмки точки

1. Фильтр с `phase: 'pre_request'` от плагина с trust ≥ `trusted` видит запрос (сообщения, системный
   промпт, `provider`/`model`); `deny` не даёт вызову уйти провайдеру, причина — в аудит gateway и
   в текст ошибки.
2. Фильтр с trust ниже `trusted`, вернувший `deny`, **понижается хостом до `allow`**, в аудит — факт
   понижения (`plugin_filter.deny_downgraded`); вызов уходит провайдеру.
3. `post_response`: фильтр видит полный текст ответа и `usage`; блокировки в стриме нет (буферизация
   ответа — явная опция, по умолчанию выключена).
4. `embedding`: вызов идёт через `GatewayProvider.embed` → `_prepareEmbedding` (микро-слой не зовёт
   `provider.embed` напрямую); фильтр видит `texts`/`provider`/`model`; `deny` — эмбеддинг не уходит
   провайдеру; `redact` — тексты заменены на `redactedTexts` (несовпадение длины массивов → `deny`,
   fail-closed).
5. Сбой/таймаут фильтра: `failMode: 'closed'` → вызов блокируется с причиной
   `plugin_filter_unavailable`/`plugin_filter_timeout`; `failMode: 'open'` → вызов идёт, факт — в аудите.
6. `config.enabled === false` gateway — фильтры не выполняются (единое правило: выключен gateway — нет
   его слоёв).

## Два режима исполнения

Один контракт точки расширения — два транспорта. Образец в коде — порт `ExecutionPort`
(`packages/core/src/execution/ports/execution-port.ts:78-80`, один метод
`execute(req): Promise<ExecResult>`; `ExecRequest` `:36-55`, `ExecResult` `:57-72`,
`ExecutionError.reason ∈ timeout|aborted|spawn_failed|nonzero_exit|max_output` `:83-154`,
`DEFAULT_MAX_OUTPUT_BYTES = 10 МБ` `:99`).

### `inline`

Код плагина исполняется **в процессе core**. Загрузчик делает `import()` ESM-бандла и вызывает
`definePlugin(apply)` с фасадом; плагин регистрирует вклады, каждый возвращает disposer. Изоляции
нет: плагин видит internals процесса — компромисс, закрытый trust/scan'ом, install-policy и
trust-floor'ом.

### `out-of-process`

Плагин исполняется в **отдельном процессе**; Synth общается с ним по локальному HTTP. Транспорт —
**HTTP/1.1 + JSON**, по образцу `@itphx/synth-executor`
(`packages/executor/src/protocol.ts`: `POST /exec`, `GET /capabilities`, `GET /health` без токена,
`EXECUTOR_PROTOCOL_VERSION = 1`, тело ошибки `{error:{reason,code,message,…}}`, коды 400/401/429/500,
сравнение bearer timing-safe по SHA-256 — `packages/executor/src/auth.ts:36-53`; клиент —
round-robin по адресам, failover только при ошибке соединения, лимит конкурентности с очередью,
отмена через `AbortSignal` — `packages/executor/src/client.ts`).

**Решение владельца (2026-10-22): wire-протокол — HTTP/1.1 + JSON, отдельный npm-пакет не нужен.**
Контракт протокола (DTO запроса/ответа, `PLUGIN_PROTOCOL_VERSION`) живёт в **`@itphx/synth-shared`** —
рядом с остальными контрактами типов. Отдельный пакет `@itphx/synth-plugin-protocol`
**не создаётся**: контракт нужен только ядру и плагинам, а оба уже зависят от `shared`
(ADR-038) — девятый пакет монорепо ради одного контракта был бы лишним. Плагин, пишущий
`out-of-process`-сторону, ставит `@itphx/synth-shared` в `peerDependencies` (bundle-only правило
§8 сохраняется: `@itphx/*` — external).

| Элемент | Значение |
|---|---|
| Версия протокола | `PLUGIN_PROTOCOL_VERSION = 1` (аналог `EXECUTOR_PROTOCOL_VERSION`) |
| Где живёт контракт | `@itphx/synth-shared` (рядом с контрактами типов) — отдельный пакет `@itphx/synth-plugin-protocol` не создаётся |
| Методы | `POST /invoke` (вызов точки расширения), `GET /capabilities` (список поддерживаемых точек + версия), `GET /health` (без токена) |
| Транспорт | HTTP/1.1 + JSON, только `127.0.0.1` (никакого внешнего bind'а) |
| Аутентификация | bearer-токен из файла (`{dataDir}/secrets/plugin-token`, `0600`) — по образцу `execution.remote.tokenSecret` (`packages/core/src/execution/remote.ts:95`); значение не логируется; сравнение timing-safe по SHA-256 |
| Fail-closed | Порядок проверок — как в `execution/remote.ts:146-186`: адрес → токен → пакет; при недоступности пакета/протокола — `RemotePluginUnavailableError`-подобная ошибка, а не «работаем без плагина» |
| Запуск процесса | порт запуска/остановки — по образу `packages/core/src/execution/startup.ts:73-106` |

### Сравнение режимов

| Аспект | `inline` | `out-of-process` |
|---|---|---|
| Изоляция | нет (код в процессе core) | процессовая (падение/утечка памяти не роняют core) |
| Латентность | ~0 (прямой вызов) | round-trip HTTP на каждый вызов точки расширения |
| Применимость | `llmFilters` (горячий путь каждого LLM-вызова), быстрые `promptBlocks` | тяжёлые `llmFilters` (ML-классификатор, антивирус, DLP), `promptBlocks` с тяжёлой загрузкой |
| Доступ к internals | прямой (ограничен фасадом) | только сериализуемые DTO |
| Требования к доверию | trust ≥ `trusted` для блокирующих прав | те же; для `out-of-process` — плюс контроль процесса (лимиты CPU/памяти — вне первой волны) |
| Что ломается при падении | исключение в процессе core → деградация точки (warn → пустой блок / fail-по-`failMode`) | процесс упал → фильтр недоступен → применяется `failMode`; ход не падает для наблюдательных фильтров |

**Правило по умолчанию.** `llmFilters` — **inline** (иначе каждый LLM-вызов платит round-trip);
`out-of-process` для фильтра — только явное решение плагина, с явным таймаутом и бюджетом.
`promptBlocks` — раз в ход: `out-of-process` допустим.

### Что пересекает границу

Через границу идут **только сериализуемые DTO**. `ComposerContext` (с портами и функциями)
**наружу не отдаётся** — вместо него наружу уходит узкий DTO запроса:

- `promptBlocks` → `PromptBlockContext` (`sessionId`, `agentRole`, `language`, `projectId?`, `mode`,
  `query?`, `turnId?`, `timestamp?`) и обратно `{ content, provenance?, status? }`;
- `llmFilters` → `LlmFilterInput` / `LlmFilterVerdict` (см. §6).

Всё, что не сериализуется (порты хранилища, `GatewayProvider`, реестры ядра), остаётся внутри
процесса core — фасад `out-of-process`-плагина состоит из «чистых» DTO-обменов. Это делает
контракт точки расширения переносимым между транспортами: один и тот же плагин работает в обоих
режимах, меняется только транспорт.

## Манифест `synth.pack` (`kind: "plugin"`)

Манифест — файл **`synth.pack`** (JSON) в корне расширения; единый формат для всех классов
([ADR-086](./adr-086-extensibility-plugins-editions.md) §5, [ADR-100](./adr-100-extension-packs-pipelines.md)).
`package.json` остаётся обычным npm-манифестом и **не** является каноническим манифестом расширения.

### Что добавляется к текущей схеме

Текущая схема `packages/shared/src/types/pack.ts`: `PACK_KINDS = ['plugin','gateway','addon','pack','storage']`
(`:29`) — `'plugin'` уже в списке; `contracts` — `z.record(z.string(), z.string())` (`:247+`);
`provides` — `packProvidesSchema` (`:227`) с `.passthrough()` (`:234`), то есть **новые виды
вкладов проходят валидацию молча**: тип элемента не проверяется, ключ не виден в инспекции.
Поэтому `tools`/`promptBlocks`/`llmFilters` должны быть описаны **явными Zod-схемами** (без
`.passthrough()` для этих ключей) — иначе правило «фактические регистрации обязаны совпадать с
`provides`» (§8) нечем проверять, а опечатка в манифесте проходит незамеченной.

| Поле/ключ | Что добавляется | Правило |
|---|---|---|
| `provides.tools[]` | массив имён тулов плагина | **новая Zod-схема**: `z.array(z.string().min(1))` (без пустых имён и дублей); имя тула — `tool.name` в `ToolRegistry.register` (`engine/tools/registry.ts:7-13`); фактические регистрации тулов должны совпадать с этим списком — иначе отказ активации |
| `provides.promptBlocks[]` | массив описаний плагинных блоков промпта | **новая Zod-схема** в `pack.ts` (не `.passthrough()`): `{ key, tier: 'context'\|'volatile', order, title? }`; `tier: 'stable'` — невалидно (запрещён, §5) |
| `provides.llmFilters[]` | массив описаний фильтров | **новая Zod-схема**: `{ id, phase: 'pre_request'\|'post_response', failMode: 'open'\|'closed', timeoutMs? }` |
| `contracts` | версии контрактов, которые плагин использует | `contracts: { extensionApi: "^1", promptBlocks: "^1", llmFilters: "^1" }`; semver-**мажор** контракта (расхождение мажора — отказ) |
| `host` | диапазон версий Synth | уже есть в схеме (`packHostSchema`) — semver-range, как `engines` |
| `mode` | режим исполнения | **новое поле**: `inline` \| `remote` \| `both`; по умолчанию — `inline`; `remote` требует явного `mode` и описания точки в `capabilities` |
| `permissions` | явные запросы | **новое поле**: `{ network?: string[], secrets?: string[], tools?: string[], hooks?: string[] }`; сетевые хосты — по egress-политике ([ADR-099](./adr-099-egress-tls-trust.md)), секреты — только через API, at-rest по модели [ADR-076](./adr-076-git-repo-registry-ssh.md) |
| `trust` | заявленный уровень/источник | **новое поле**: `{ level?: 'builtin'\|'verified'\|'trusted'\|'community'\|'agent-created', source?: string }`; **заявленный** уровень — только верхняя граница: фактический trust резолвится по источнику ([PROP-068](./prop-068-skills-agents-registry.md) §4.1), манифест не может его повысить |

### Пример манифеста

```json
{
  "name": "@acme/synth-plugin-memory",
  "version": "1.2.0",
  "kind": "plugin",
  "description": "Провайдер памяти: блок контекста памяти + фильтр запросов к провайдеру",
  "host": "^0.11.0",
  "contracts": { "extensionApi": "^1", "promptBlocks": "^1", "llmFilters": "^1" },
  "mode": "both",
  "provides": {
    "tools": ["memory_search"],
    "promptBlocks": [
      { "key": "plugin.memory.recall", "tier": "context", "order": 120, "title": "Memory recall" }
    ],
    "llmFilters": [
      { "id": "plugin.memory.dlp", "phase": "pre_request", "failMode": "closed", "timeoutMs": 200 }
    ],
    "mcp": [],
    "skills": [],
    "agents": [],
    "pipelines": []
  },
  "permissions": {
    "network": ["api.vault.example"],
    "secrets": ["memory-token"]
  },
  "trust": { "level": "trusted", "source": "catalog" }
}
```

### Правило соответствия

**Фактические регистрации обязаны совпадать с `provides`** — иначе активация отклоняется. Плагин,
заявивший `provides.llmFilters` и не зарегистрировавший их (или зарегистрировавший незаявленные),
не активируется: расхождение — признак несогласованной сборки, а не «мелочь». Проверка идёт после
`import()`/вызова `apply()` и **до** фиксации активации в аудите; расхождение перечисляется
поимённо.

**Тулы — тоже.** Фактические регистрации тулов плагина должны совпадать с `provides.tools[]` —
иначе **отказ активации**. Это не формальность: точка `tools` есть в таблице точек расширения
(§4), но без `provides.tools[]` в манифесте она не выразима, и плагин-память с тулом
`memory_search` ([PROP-047](./prop-047-memory-gbrain.md)) попал бы в «несовпадение» и не
активировался бы. Поэтому `provides.tools[]` — **обязательный** элемент манифеста плагина,
регистрирующего тулы (пустой список допустим, если тул не зарегистрирован).

### Bundle-only (обязательно)

Плагин распространяется как **self-contained бандл** (сборка `esbuild`/`tsup`): все зависимости,
кроме `@itphx/*`, вшиты в бандл; `@itphx/*` — external (peer). **Runtime-резолв npm-зависимостей
не выполняется**: `import()`-загрузчик не ходит в npm/registry. Для `out-of-process` — то же:
процесс запускается из распакованного бандла, а не из npm-дерева.

## Модель доверия (PROP-068)

Плагины **наследуют** модель доверия контента ([PROP-068](./prop-068-skills-agents-registry.md) §4) —
отдельной модели PROP-090 не вводится. Ниже — резюме и три решения сессии.

### Уровни и матрица install-policy

Иерархия (`PROP-068` §4.1): `builtin` → `verified` → `trusted` → `community` → `agent-created`.
Матрица `trust × вердикт` (`PROP-068` §4.2) — с **новой ячейкой для `kind: "plugin"`**:

| Trust \ Вердикт | `safe` | `caution` | `dangerous` |
|---|---|---|---|
| `builtin` | allow | allow | allow |
| `verified` | allow | allow | block |
| `trusted` | allow | allow | block |
| `community` | allow | block | block |
| `agent-created` | allow | allow | ask |
| **`kind: "plugin"` (любой trust)** | **установка — allow** | **установка — ask** | **установка — block** |

Отличие от контента: для плагина блокирующий вердикт — `dangerous`, а `caution` требует
подтверждения (`ask`), потому что за плагином стоит исполняемый код. Trust-floor (см. ниже)
действует независимо от install-policy.

### Три решения сессии (2026-10-22)

**1. Матрица `severity → verdict` — согласовано 2026-10-22, таблица — в PROP-068 §4.3.** Границы
`severity → verdict` и пороги квот заданы в [PROP-068](./prop-068-skills-agents-registry.md) §4.3 —
**каноническая таблица там** (здесь не дублируется, чтобы таблицы не разъехались). Напоминание
правил: `info|low → safe`, `medium → caution`, `high|critical → dangerous`; превышение квот
структуры (число файлов `MAX_FILE_COUNT=50`, общий размер `MAX_TOTAL_SIZE_KB=1024`) → минимум
`caution`; **бинарный исполняемый файл** или превышение `MAX_SINGLE_FILE_KB=256` → `dangerous`;
невидимый unicode (`invisible_unicode`) → не ниже `caution`. При изменении значений — правка обоих
документов.

**2. Trust-floor плагина = `trusted`.** Плагин ниже порога **устанавливается** (скан и вердикт видны,
запись в `plugins.lock.json` есть), но **не активируется** — отказ с причиной
`plugin.trust_below_floor`. Ключ конфига — `plugins.trustFloor` (дефолт `trusted`); в managed —
политика сервера. Следствие: плагины уровня `community` в инстансе **живут и наблюдают** (аудит,
метрики, сигнал), но **не блокируют** — это и есть право вето только у доверенных (§6).

**3. Аудит плагинов — отдельный журнал.** Не расширение `SECURITY_AUDIT_SCOPES`
(`packages/shared/src/types/egress.ts:131` — scope-enum + action `update|reset`, семантика
«изменение политики»), а **свой порт** `PluginAuditRepository` (по образцу
`MaintenanceAuditRepository`, `packages/core/src/storage/maintenance-audit-store.ts`) и файл
`{dataDir}/audit/plugins.jsonl` (append-only JSONL). События:
`install | uninstall | enable | disable | activate | deactivate | scan | trust_change`
(в Ф1 реализованы только `activate`/`deactivate`, в **Ф2** добавлено `scan` — перечень
`PLUGIN_AUDIT_ACTIONS`, см. §«Статус реализации в коде (Ф1)» и §«Статус реализации в коде (Ф2)»).
Секреты в журнал не пишутся (инвариант 13).

**Реализация Ф2 (2026-10-22).** Уровни trust, матрица install-policy (включая ячейку `kind: 'plugin'`),
сканер с квотами и кэшем, `quarantine/`, `plugins.lock.json` и порядок «**trust-floor до
install-policy**» — реализованы в коде; канон значений — PROP-068 §4.2–§4.4, детали — §«Статус
реализации в коде (Ф2)» ниже. Режим `plugins.scan: 'disabled'` — см. §«Решение 2026-10-22 —
`plugins.scan: 'disabled'`».

### Что переиспользуется из кода

| Что | Где | Как используется |
|---|---|---|
| Детект prompt-injection по словарю | `packages/core/src/engine/security/prompt-injection.ts` (`detectPromptInjection:61`, `applyPolicy:89`, режимы `flag\|sanitize\|block`, квота 5 совпадений) | один из сканеров плагина (категория `injection`) |
| Threat-scan проектных инструкций | `packages/core/src/engine/context/instructions.ts` (`_scan:1158`, `DIAGNOSTIC_META:1199`) | образец построения finding'ов `{category, severity, file, line, description}` |
| Install-tree guard | там же (`_isInstallTree:861`, `_guard:878`) | запрет вкладов из install-дерева |
| Project-trust | `packages/core/src/engine/skills/trust.ts` | ортогонален доверию реестра — не смешивать |
| Trust результатов тулов | `packages/core/src/engine/security/trust.ts` | отдельная ось, не участвует в install-policy |
| Egress-политика | `packages/core/src/engine/net/egress-guard.ts`, `egress-policy.ts` | сетевые вызовы плагина — через общий egress-слой ([ADR-099](./adr-099-egress-tls-trust.md)) |

### Что дописывается

- Категории сканера: 6 базовых (`exfiltration`, `injection`, `destructive`, `persistence`,
  `network`, `obfuscation`) + `invisible_unicode`; для плагинов — расширенный набор
  (исполняемые файлы, `child_process`/`eval`, запись в `process.env`, сетевые вызовы).
- Квоты `MAX_FILE_COUNT=50`, `MAX_TOTAL_SIZE_KB=1024`, `MAX_SINGLE_FILE_KB=256` — по
  [PROP-068](./prop-068-skills-agents-registry.md) §4.3.
- `content_hash` — sha256 отсортированного набора файлов; фиксируется в lock.
- Кэш сканов — ключ `sha256(source\0source_url)` + `content_hash`; повторный скан идентичного
  содержимого не выполняется.
- `.skillignore` — исключения при подсчёте структуры.
- Бинарные расширения — исключаются/флагуются, содержимое не исполняется; исполняемый файл —
  `dangerous`.
- **`quarantine/`** — всё скачанное распаковывается и сканируется здесь; при провале — изолируется
  и в `installed/` не попадает.
- **`plugins.lock.json`** — источник истины для update/uninstall (модель `lock.json` из
  [PROP-068](./prop-068-skills-agents-registry.md) §4.4).
- **Подписи** — статус «вне первой волны»: verifiability/catalog-signature — задача [PROP-068](./prop-068-skills-agents-registry.md).

## Установка и активация

### Раскладка

Home-модель ([ADR-079](./adr-079-local-home-independent-instances.md)); без home — `{dataDir}/plugin/`:

```text
<home>/plugin/
├── installed/
│   └── <name>@<version>/
│       ├── synth.pack            # манифест (kind: plugin)
│       ├── dist/index.js         # бандл (все зависимости внутри, @itphx/* — external)
│       └── PLUGIN_INTEGRITY.json # { sha256, source, fetched_at }
├── plugins.lock.json             # провенанс — источник истины для update/uninstall
└── plugins.json                  # runtime-override включения/настроек
```

### Запись lock

`plugins.lock.json` — на плагин: `{ name, version, source, identifier, trust_level, scan_verdict,
content_hash, ref, entry, installed_at, updated_at }`. **Pin обязателен**: `ref` (sha/тег) +
`content_hash`; update — только явная операция, «всегда latest» нет.

### Пайплайн `PluginHost` (активация одного плагина)

1. **resolve** — найти установленный бандл + манифест (по `plugins.lock.json`).
2. **integrity** — сверить sha256 с lock и `PLUGIN_INTEGRITY.json`; несовпадение — отказ.
3. **semver-гейт** — `contracts` (semver-мажор) совместим и `host` покрывает текущую версию Synth;
   иначе — `plugin.host_incompatible`. Файл **exact-исключений** (аналог peer-gate) — формат
   зафиксирован в Ф1: текстовый файл, **одна версия host в строке**, `#` — комментарий, разбор
   fail-closed (не-semver строка пропускается, недоступный файл — исключений нет); формат
   **требует подтверждения владельца** (§«Открытые вопросы» → «Решено 2026-10-22 — формат файла
   точных исключений»).
4. **trust/scan** — резолв trust по источнику; статический сканер → вердикт (`severity → verdict`,
   §9); install-policy; **trust-floor** (`plugins.trustFloor`, дефолт `trusted`) — ниже порога:
   `plugin.trust_below_floor`, активация не выполняется.
5. **политика режима** — standalone/hybrid/managed решают, можно ли активировать (§10);
   в managed/hybrid — allow-list/ADMIN.
6. **import** — `import()` ESM-бандла в процессе core (`inline`) либо запуск/проверка внешнего
   процесса (`out-of-process`).
7. **facade** — `definePlugin(apply)` вызывается с фасадом `SynthPlugin`; плагин регистрирует вклады,
   каждый возвращает disposer. Проверка соответствия фактических регистраций `provides` — здесь же.
8. **сбор disposers** — накопление в порядке регистрации.
9. **аудит** — запись `activate` (кто, что, trust, scan, версия, режим) в `{dataDir}/audit/plugins.jsonl`.

### Выключение/reload

**Обратная прокрутка**: вызвать все disposers в обратном порядке (снять блоки/фильтры/тулы/хуки/
роуты), затем аудит `deactivate`. Ошибка disposer не прерывает остальные (изолируется, логируется).

**Hot-reload vs restart.** В standalone допустим hot-reload (deactivate → integrity/scan → activate).
В **managed — restart**: активация на старте, выключение — деплоем/рестартом, без смены кода в живом
процессе (согласовано с [PROP-082](./prop-082-full-images-deployment.md)/
[ADR-077](./adr-077-runtime-toolchain.md) и инвариантом 24).

### Матрица режимов

| Режим | Plugin | Кто ставит | Сила энфорса |
|---|---|---|---|
| **standalone** | ✅ (`inline` + `out-of-process`) | владелец инстанса | локальный процесс владельца; полный trust-контроль локально |
| **hybrid** | ✅ (allow-list сервера для серверного контура; локальный — по политике) | владелец локально + allow-list сервера | серверный трафик — 🟢; локальный плагин — 🔴 кооперативно |
| **managed** | ✅ (deploy-time по умолчанию; runtime-install — `deny` по умолчанию) | **ADMIN** | deploy-time — 🟢 (бандл в образе/PVC); runtime-install — только ADMIN + allow-политика |

### Managed: deploy-time и runtime-install

**(a) deploy-time — дефолт.** Плагины перечислены в Helm-values/config, бандлы — в образе (flavor
[PROP-082](./prop-082-full-images-deployment.md)) или на PVC; активация — на старте; смена набора —
деплоем. Код плагина фиксируется вместе с деплоем — воспроизводимо и аудируемо.

**(b) runtime-install — опция, по умолчанию `deny`.** Установка через API при
`plugins.runtimeInstall: allow`; RBAC — **ADMIN**; запись под guarded-guard'ом (по образцу
`eventsWriteGuard`/`decisionWriteGuard`, [ADR-089](./adr-089-external-events-automation.md)); каждая
операция — в аудит плагинов.

Ограничения managed:
- **Запрет снятия builtin/management-плагинов** (аналог `protectedModules`).
- **Reload/restart** — в managed по умолчанию **restart**.
- **Плагин — инстанс-уровневый, не per-user** (в отличие от скиллов/scope).
- **Egress** — сетевые вызовы плагинов идут через единый egress-слой ([ADR-099](./adr-099-egress-tls-trust.md)).
- **Секреты** — плагин **не** читает `$SYNTH_DATA_DIR/secrets/*` напрямую; секреты выдаются через
  API (scoped, по запросу настроек плагина), at-rest — по модели [ADR-076](./adr-076-git-repo-registry-ssh.md).

### Гибрид

Сервер и локальный core — два мира; плагин должен явно объявлять, какому миру служит. Уровни силы —
как в прежней редакции: **Уровень 1 — cooperative** (allow-list как политика соответствия, 🔴),
**Уровень 2 — server-scoped токены** (плагин получает доступ к серверу только с `plugin_id`-scoped
токеном; сервер применяет политику, 🟢), **Уровень 3 — attestation** (будущее усиление).
**Уровень 2 — вне первой волны** (Ф7): `plugin_id`-scope поверх service-key
([ADR-052](./adr-052-public-api-platform.md)) — открытый вопрос (§14).

## API / CLI / UI

### HTTP API (`/api/v2/plugins*`)

По образцу `/api/v2/packs` (`packages/core/src/server/routes/packs.ts`): core-фабрика
`createPluginsRoutes(auth, deps, opts)`, `auth` = `{ requireAuth: Middleware }`, `opts` =
`readGuard?/writeGuard?/approveGuard?/uninstallGuard?/scopeGuard?/messages?`; guard-формула —
`opts.readGuard ?? auth.requireAuth` (`packs.ts:464-469`); ошибки — `{ error: { code, message } }`.

| Метод | Путь | Guard (core / managed) | Коды | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/plugins` | `requireAuth` / ADMIN | 200, 401, 403 | список установленных + статус активации |
| GET | `/api/v2/plugins/:name` | `requireAuth` / ADMIN | 200, 401, 403, 404 | инспекция: манифест, trust, scan, hash, `provides` |
| POST | `/api/v2/plugins/install` | `requireAuth` / ADMIN (+ scope `addons:install`) | 201, 202 (нужно подтверждение), 400, 403, 409 | pull → `quarantine/` → scan → policy → `installed/` |
| POST | `/api/v2/plugins/:name/enable` | `requireAuth` / ADMIN | 200, 400, 404, 409 | активация (шаги §10) |
| POST | `/api/v2/plugins/:name/disable` | `requireAuth` / ADMIN | 200, 404, 409 | обратная прокрутка |
| POST | `/api/v2/plugins/update` | `requireAuth` / ADMIN | 200, 400, 404 | обновление по pinned ref/hash, явно |
| DELETE | `/api/v2/plugins/:name` | `requireAuth` / ADMIN | 204, 404, 409 | снятие по записи lock (идемпотентно) |
| GET/PUT/DELETE | `/api/v2/settings/plugins` | `requireAuth` / ADMIN | 200, 400, 401, 403 | runtime-настройки: `enabled`, `runtimeInstall`, `trustFloor`, `scan`, `allowlist`, `denylist`, `promptBlockMaxChars` (бюджет символов блока, дефолт 4 000) |

**Правило RBAC.** Managed — **ADMIN** (чтение и мутации; реестр плагинов — инстанс-уровневый).
Standalone — владелец инстанса (в core `requireAuth` — единственный пользователь, [ADR-079](./adr-079-local-home-independent-instances.md)).
**Тест-перепись.** Появится префикс `/api/v2/plugins/:name` — нужна **своя** матрица (негативная 403 +
позитивная по ролям) по образцу `packages/backend/src/routes/session-idor-matrix.test.ts` (существующая
матрица покрывает `sessions|messages|queue` — для плагинов она не применима).

### CLI (`synth plugin *`)

Команды объявляются **параллельно в двух местах**: `packages/core/src/main.ts` (dev/standalone CLI,
`commander`, группы через `.addCommand(new Command('…'))`) **и** `packages/synth/src/cli.ts`
(публичная обёртка, реализация — прямым импортом из `@itphx/synth-core`, ADR-038). Правило: «не
добавлять в core команды, которых нет в `src/main.ts`» — значит `synth plugin *` объявляется в обоих.
Режим `--json` — как у остальных команд.

| Команда | Действие |
|---|---|
| `synth plugin list` | список установленных + статус |
| `synth plugin inspect <name>` | манифест, trust, scan, hash, `provides` |
| `synth plugin install <id> [--ref <sha\|tag>] [--force]` | установка (карантин → скан → политика) |
| `synth plugin enable <name>` / `disable <name>` | вкл/выкл (активация/обратная прокрутка) |
| `synth plugin update [<name>]` | обновление по pinned ref/hash, явно |
| `synth plugin remove <name>` | снятие по записи lock |
| `synth plugin scan <name>` | повторный скан без установки |

### UI

Админ-раздел **«Плагины»** — по образцу «Аддоны»
(`packages/ui/src/components/settings/AddonsSettings.tsx`: `canManage` по роли, `confirm()` из
`@/lib/confirm`, `notify`, `data-testid`, карточка `<li>` с бейджами статуса, `InfoField`).

| Файл | Действие |
|---|---|
| `packages/ui/src/lib/settings-catalog.ts` | **изменить** — категория `{ id: 'plugins', group: 'adminIntegrations', labelKey: 'settings.category.plugins', icon: 'puzzle-piece', roles: ['ADMIN'] }` |
| `packages/ui/src/components/settings/PluginsSettings.tsx` | **создать** — список, карточка (trust/scan/hash/version/`contracts`/`host`/`provides`), тумблеры enable/disable, кнопки install/update/remove |
| `packages/ui/src/components/settings/SettingsModal.tsx` | **изменить** — рендер `{activePage === 'plugins' && <PluginsSettings />}` (по образцу `addons`, `:327`) |
| `packages/ui/src/lib/api/plugins.ts` | **создать** — домен `pluginsApi` (по образцу `lib/api/packs.ts`, 97 стр.) |
| `packages/ui/src/lib/api/synthApi.ts` | **изменить** — barrel + экспорт домена (контрактный тест `synthApi.contract.test.ts`) |
| `packages/ui/src/lib/i18n/messages/ru.ts` / `en.ts` | **изменить** — ключи `settings.category.plugins` и строки раздела (в **оба** словаря; тест паритета `parity.test.ts`) |

Карточка плагина обязана показывать: **trust-уровень**, **источник**, **content hash**, версию,
`contracts`/`host`, **вердикт сканера**, перечень `provides`, режим исполнения (`inline`/`remote`) и
результат последнего скана.

## Ограничения и «что не делаем»

**Плагин не может ни при каких условиях:**
- обойти `PermissionEvaluator` ([ADR-025](./adr-025-plan-act-toggle.md)/[ADR-028](./adr-028-plan-build-strictness.md)/[ADR-029](./adr-029-granular-permissions.md));
- обойти `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md)) — любой LLM-вызов плагина идёт через него;
- обойти порты хранилища ([ADR-096](./adr-096-storage-layer.md)) — запись в `$SYNTH_DATA_DIR` мимо порта запрещена;
- читать секреты в обход API;
- снять/подменить **builtin**-обработчики и builtin/management-плагины (политика `builtin` — реализована в Ф0, см. [ADR-030](./adr-030-hooks-agent-events.md): `off`/функция отписки отказывают, снятие — только `HookBus.offBuiltin` силами ядра);
- отключить существующие guard'ы gateway или изменить `config.enabled`;
- добавить свои лейблы метрик (контракт [ADR-094](./adr-094-observability-metrics.md));
- выдать свой ответ в обход gateway;
- выполнить runtime-резолв npm-зависимостей (bundle-only);
- заявить trust выше фактического (trust резолвится по источнику).

**Чего нет в слое:**
- **Runtime npm-резолв** — загрузчик не ходит за зависимостями.
- **pnpm-в-рантайме** как основной механизм установки.
- **In-process без trust/scan** — код не активируется мимо trust/скана/install-policy/trust-floor.
- **Авто-установка без явного действия** — установка только явной операцией владельца/ADMIN.
- **«Всегда latest»** — pin обязателен (`ref`/`content_hash`), update — явно.
- **Доверие по звёздам** — звёзды не критерий ([PROP-068](./prop-068-skills-agents-registry.md)).
- **Смешение классов** — Gateway ≠ Add-on ≠ Plugin.

## Фазы

Каждая фаза — с критерием приёмки (тест/команда).

| Фаза | Содержание | Критерий приёмки |
|---|---|---|
| **Ф0 — предпосылки** — ✅ **выполнено 2026-10-22** (ветка `feature/plugin-layer`, коммитов нет) | Остаток [ADR-030](./adr-030-hooks-agent-events.md): политика `builtin` (защита builtin-обработчиков от снятия) + 4 недостающих эмита (`plan_rejected`, `message_received`, `callback`, `schedule_fired`); семвер-гейт `contracts`/`host` (semver-мажор контракта); явные Zod-схемы `provides.tools`/`provides.promptBlocks`/`provides.llmFilters` в `packages/shared/src/types/pack.ts` (без `.passthrough()`); `RuntimeSettings.plugins` + `plugins.*` в конфиге ([ADR-023](./adr-023-configuration.md)). **Сделано:** `builtin` (`off`/отписка отказывают, `offBuiltin` — путь владельца), 3 эмита (`callback` — обоснованно вне core, остаток ADR-030), semver-матчер + `checkExtensionCompatibility`, схемы вкладов + `mode`/`permissions`/`trust` + `diffPackProvides`, секция `plugins` + `mergePluginsConfig` | тест: builtin-обработчик нельзя снять через `off`; эмиты вызываются; `validatePackManifest` отклоняет `tier: 'stable'` в `provides.promptBlocks`, невалидный `provides.tools[]` (пустое имя/дубль) и расхождение `provides` — в т.ч. `provides.tools[]` ↔ фактические регистрации тулов; `pnpm --filter @itphx/synth-shared build` зелёный |
| **Ф1 — манифест + `PluginHost`** — ✅ **выполнено 2026-10-22** (ветка `feature/plugin-host`, коммитов нет) | Схема манифеста плагина, `PluginHost`-пайплайн (§10), integrity, semver-гейт, реестр активаций, аудит активации. **Исполнение кода выключено по умолчанию**: только resolve/integrity/гейт/скан/аудит, без `import()`. **Сделано:** модуль `engine/plugins/*` (`PluginHost`, контракты активации, `computePluginContentHash`/`verifyPluginIntegrity`, `readExactHostExceptions`), порт `PluginAuditRepository` (файл/память/PG + контрактный suite), ключ `plugins.executionEnabled` (дефолт `false`); seam'ы `PluginLoader`/`PluginScanHook`/`PluginFacade` оставлены под Ф2/Ф3/Ф4 | тест: `PluginHost.activate` доходит до шага «import» и останавливается; несовпадение integrity → отказ; тест аудита: запись `activate`/`deactivate` в `audit/plugins.jsonl` — **выполнено**, см. §«Статус реализации в коде (Ф1)» |
| **Ф2 — модель доверия** — ✅ **выполнено 2026-10-22** (ветка `feature/plugin-trust`, коммитов нет) | Уровни trust, матрица install-policy с ячейкой `kind: "plugin"`, сканер (6+1 категорий, квоты, `content_hash`, кэш сканов, `.skillignore`, бинарные расширения), матрица `severity → verdict`, `quarantine/`, `plugins.lock.json`, порт `PluginAuditRepository` + `{dataDir}/audit/plugins.jsonl`. **Сделано:** встроенный статический сканер (`engine/plugins/scan/*`: правила, `.skillignore`, кэш, дефолтный хук скана), матрица install-policy одной функцией `installPolicyDecision` (`shared`, ячейка `kind: 'plugin'`), раскладка `<home>/plugin/` с карантином и `PLUGIN_INTEGRITY.json` (`engine/plugins/layout.ts`), порт `PluginLockRepository` (файл/память/PostgreSQL + миграция `007_plugin_lock`), аудит-событие `scan` (+ `plugin.approval_required`), шаг trust/scan в `PluginHost` — **trust-floor до install-policy** | тест: вердикт по severity (`info\|low → safe`, `medium → caution`, `high\|critical → dangerous`); квоты → `caution`; бинарник → `dangerous`; `community` + `dangerous` → `block`; trust-floor: `community` устанавливается, но не активируется (`plugin.trust_below_floor`) — **выполнено**, см. §«Статус реализации в коде (Ф2)» |
| **Ф3 — точки `promptBlocks` + `llmFilters`** — ✅ **Ф3 выполнено 2026-10-22** (ветка `feature/plugin-points`, коммитов нет): закрыта точка **`promptBlocks`** (Ф3а) и точка **`llmFilters`** (Ф3б); остаток — точка `tools` и контрактный suite расширений (Ф3в) | Контракты `PromptBlockProvider`/`LlmCallFilter` (в т.ч. третья фаза `embedding`), реестры в `SystemPromptComposer` и `GatewayProvider`, правила тиров/порядка/инвалидации/деградации, контекст хода (`query`/`turnId`/`timestamp`) и бюджет символов блока (`plugins.promptBlockMaxChars`, дефолт 4 000), право вето только для trust ≥ `trusted` (во всех фазах, включая `embedding`), **эмбеддинги через gateway-контур** (`GatewayProvider.embed` → `_prepareEmbedding`; микро-слой — только через gateway), приведение `packages/core/AGENTS.md:410` в соответствие (шов — `PromptBlockProvider`, а не `ContextSource`), **контрактный suite расширений**. **Сделано (Ф3а):** контракт `PromptBlockProvider`/`PromptBlockContext` (`shared`, `types/prompt-blocks.ts`), реестр `PromptBlockRegistry` (`engine/context/prompt-block-registry.ts`), сборка блоков провайдеров в `SystemPromptComposer` (`_collectProviderBlocks`), контекст хода (`query`/`turnId`), бюджет символов блока + обрезка (`status: 'truncated'`), инвалидация `promptStates` по блокам провайдеров (`provider: true`), фасад `PluginFacade.registerPromptBlock` (disposer снимает блок при деактивации), решение fail-closed `plugins.scan='disabled'` + `executionEnabled=true` (`plugin.scan_disabled_with_execution`), **версия правил сканера в ключе кэша сканов** | контрактный suite расширений зелёный (по образцу `packages/core/src/storage/contract/*`): `stable`-тир отклоняется; ошибка провайдера не роняет ход; `deny` от `community`-плагина понижается до `allow` + аудит (во всех фазах, включая `embedding`); `query` доходит до провайдера, при его отсутствии блок `volatile` пуст; блок длиннее бюджета обрезан с `status: 'truncated'`; embedding-вызов идёт через `GatewayProvider.embed` и виден фильтру (`deny` → эмбеддинг не уходит провайдеру, `redact` → тексты заменены на `redactedTexts`); фактические регистрации тулов сверены с `provides.tools[]` (расхождение → отказ активации); тест паритета «манифест ↔ байты» (`composer.test.ts:315-345`) зелёный — **по части `promptBlocks` выполнено**, см. §«Статус реализации в коде (Ф3а)»; критерии `llmFilters` — **выполнено, см. §«Статус реализации в коде (Ф3б)»**; сверка `provides.tools[]` ↔ регистрации и контрактный suite расширений — **Ф3в** |
| **Ф4 — два режима исполнения** | `inline` (по умолчанию) + `out-of-process`: wire-протокол (`PLUGIN_PROTOCOL_VERSION = 1`, `POST /invoke`, `GET /capabilities`, `GET /health`), контракт протокола — в `@itphx/synth-shared` (отдельный пакет не создаётся), bearer-токен из файла, `127.0.0.1`, fail-closed, `failMode`/деградация | тест: плагин в `out-of-process` регистрирует `promptBlocks` и отдаёт блок; неверный токен → 401; недоступный процесс → деградация по `failMode`; контрактный suite порта расширений зелёный |
| **Ф5 — install/activate: CLI + API + managed deploy-time** | Раскладка `<home>/plugin/`, `plugins.lock.json`, `plugins.json`, установка из `local`/`npm`/`builtin`/`catalog`, CLI `synth plugin *` (в `main.ts` **и** `packages/synth/src/cli.ts`), `/api/v2/plugins*` + `/api/v2/settings/plugins`, матрица RBAC, managed deploy-time (бандлы в образе/PVC) | тест: install → scan → activate → disable → remove проходит по API и по CLI; `synth plugin list --json` совпадает с API; **негативная** матрица RBAC (чужой/не-ADMIN → 403) и **положительная** (ADMIN → 200); managed: runtime-install при `deny` → 403 |
| **Ф6 — UI** | Раздел «Плагины»: список, карточка (trust/scan/hash/version/`contracts`/`host`/`provides`/режим), тумблеры enable/disable, install/update/remove, статус скана | тест UI: карточка показывает trust/scan/hash; переключатель enable вызывает API и обновляет список; i18n-паритет `ru.ts`/`en.ts` зелёный (`parity.test.ts`) |
| **Ф7 — hybrid** | Allow-list сервера, форма политики, discovery (`/api/v2/settings/plugins` + сигнал в `/auth/oidc-meta`), server-scoped токены с `plugin_id`-scope (Уровень 2) | тест: плагин вне allow-list не активируется в hybrid; токен с чужим `plugin_id` отвергается сервером; локальный плагин без сервера — cooperative (помечено в UI/доках) |

### Статус реализации в коде (Ф0, 2026-10-22)

Ф0 закрыт в ветке `feature/plugin-layer`: появились предпосылки слоя, **исполнения кода плагинов нет** (Ф1+).
Пути — фактические, проверены по коду.

**Хуки ([ADR-030](./adr-030-hooks-agent-events.md) — остаток закрыт, кроме `callback`).**

| Что | Где |
|---|---|
| Политика `builtin`: builtin-обработчик не снимается ни `off(name, handler)`, ни функцией отписки из `on`; явный путь — `offBuiltin(name, handler)` (зовёт владелец регистрации ядра), `removeAll()` — служебный | `packages/core/src/engine/hooks/hook-bus.ts` |
| Отписка builtin-подписок аналитики через `offBuiltin` | `packages/core/src/analytics/hooks.ts` (`attachAnalyticsActivityHooks`) |
| `message_received` — в начале `_processMessage`, под `count`, `async`, только `role: user` и `attempt <= 1`; payload — метаданные (`sessionId`/`agent`/`mode`/`kind`/`source`/`type`), **без текста** | `packages/core/src/engine/orchestrator.ts` |
| `plan_rejected` — рядом с `plan_approved`; трактовка «неудачный `plan_exit`» (`reason: 'plan_exit_failed'`) | там же |
| `schedule_fired` — в `_dispatch` **до** `EventIngress.ingest`, только при наличии подписчиков; метаданные расписания, без текста задания | `packages/core/src/engine/scheduler/scheduler.ts`; шина — `SchedulerServiceDeps.hooks` (`packages/core/src/server/app/deps.ts`, `packages/backend/src/app/deps.ts`) |
| Формы контекстов `message_received`/`schedule_fired` + `MessageReceivedKind` (`user`/`scheduler`/`external`) | `packages/shared/src/types/hooks.ts` |
| `callback` — **не реализован**: в core нет точки «нажатие инлайн-кнопки» (контракт внешнего канала [ADR-087](./adr-087-gateways.md)/[ADR-103](./adr-103-gateway-core-channel-contract.md)) | — |

**Манифест `synth.pack` — вклады и поля плагина.**

| Что | Где |
|---|---|
| `provides.tools[]` — явная схема (непустые имена, без дублей); `provides.promptBlocks[]` — `{key, tier, order, title?, provenance?}`, `.strict()`, тир `stable` **запрещён** (граница prompt-cache, [ADR-070](./adr-070-system-prompt-composer.md)); `provides.llmFilters[]` — `{id, phase, failMode?, timeoutMs?}`, `.strict()`, фазы `pre_request`/`post_response`/`embedding` | `packages/shared/src/types/pack.ts` |
| Поля манифеста: `mode` (`inline`/`remote`/`both`, только `kind: plugin`), `permissions` (`network`/`secrets`/`tools`/`hooks` — заявление, не разрешение), `trust` (`{level?, source?}` — заявленный уровень = верхняя граница, фактический резолвится по источнику) | там же |
| Правила `validatePackManifest` 12–14: вклады плагина по явным схемам; `mode` только у `plugin`; `trust.level` плагина не выше `trusted` (trust-floor, §9) | там же |
| Сверка объявленного и зарегистрированного — `diffPackProvides` (`missing`/`unexpected` по `tool`/`promptBlock`/`llmFilter`) | там же |
| Семвер-гейт — `checkExtensionCompatibility`: порядок «контракт → host», вердикты `contract_mismatch`/`host_mismatch`, точные исключения `exactHostExceptions`, имя контракта по умолчанию `DEFAULT_EXTENSION_CONTRACT = 'extensionApi'` | там же |

**Semver и доверие (новые модули `shared`).**

| Что | Где |
|---|---|
| semver-рандж-матчер без зависимостей: `SEMVER_RANGE_REGEX`, `isSemverRange`, `parseSemver`, `satisfiesSemverRange`; операторы `^ ~ >= <= > < =`, wildcard `x`/`*`, конъюнкция пробелом; `\|\|` **не поддерживается** (fail-closed). `PACK_HOST_RANGE_REGEX` теперь ссылается на `SEMVER_RANGE_REGEX`, а `contracts` манифеста валидируются тем же матчером | `packages/shared/src/types/semver.ts` |
| Единый перечень уровней доверия `builtin`/`verified`/`trusted`/`community` + `trustLevelRank`; используется и каталогом (`catalog.ts` реэкспортирует), и манифестом (модуль выделен, чтобы не было цикла `catalog → pack`) | `packages/shared/src/types/trust.ts` |

**Конфиг и runtime-настройки ([ADR-023](./adr-023-configuration.md)).**

| Что | Где |
|---|---|
| Секция `plugins`: `enabled` (`true`), `runtimeInstall` (`allow\|deny`, `deny`), `trustFloor` (`trusted`), `scan` (`enabled\|disabled`, `enabled`), `allowlist`/`denylist`/`remoteAllowlist` (`[]`), `exactHostExceptions` (`''`), `promptBlockMaxChars` (`4000`) | `packages/shared/src/config/types.ts` (`pluginsConfigSchema` + `PluginsConfig`), `packages/shared/src/config/defaults.ts`; скалярные env `SYNTH_PLUGINS_*` — `packages/shared/src/config/env-overrides.ts` (списки остаются в `config.yaml`) |
| `PluginsRuntimeSettings`, `RuntimeSettings.plugins`, `getPlugins`/`setPlugins`/`clearPlugins` и `mergePluginsConfig` (приоритет runtime > config > defaults; результат — полный `PluginsConfig`) | `packages/core/src/storage/runtime-settings.ts` |

**Тесты Ф0.** `packages/core/src/engine/hooks/hook-bus.test.ts` (политика `builtin`: `off`, отписка, `offBuiltin`, `removeAll`;
поведение priority/block/patch не изменилось), `packages/core/src/engine/orchestrator-hooks.test.ts` (`message_received`:
один эмит на сообщение, без текста, ретрай не дублирует, `kind` для внешнего события и `Scheduler`; `plan_rejected`),
`packages/core/src/engine/scheduler/scheduler.test.ts` (`schedule_fired` до публикации события, без текста задания),
`packages/shared/src/types/pack.test.ts` (поля `mode`/`permissions`/`trust` не выбрасываются схемой, вклады плагина,
правила 12–14, `diffPackProvides`), `packages/shared/src/types/semver.test.ts` (грамматика, операторы, fail-closed,
`checkExtensionCompatibility`), `packages/shared/src/config/env-overrides.test.ts`, `packages/core/src/storage/runtime-settings.test.ts`.

**Остаток после Ф0.** Загрузчик `PluginHost` и исполнение кода (Ф1) — **выполнено, см. §«Статус реализации
в коде (Ф1)» ниже**; сканер/доверие/lock (Ф2), точки `promptBlocks`/`llmFilters` в композере и gateway (Ф3),
два режима исполнения (Ф4), install/activate + API/CLI/UI (Ф5/Ф6), hybrid (Ф7); регистрация
`/api/v2/settings/plugins` в HTTP-роутах ещё не сделана (сейчас есть только типы, схема и runtime-store).

### Статус реализации в коде (Ф1, 2026-10-22)

Ф1 закрыт в ветке `feature/plugin-host`: появился загрузчик `PluginHost` и журнал аудита плагинов.
**Исполнения кода плагинов нет** — загрузчик (`PluginLoader`) в core отсутствует, а
`plugins.executionEnabled` по умолчанию `false` (Ф3/Ф4). Пути — фактические, проверены по коду.

**Пайплайн активации (`PluginHost.activate`) — шаг | код отказа | что проверяет | где в коде.**

| Шаг | Код отказа | Что проверяет | Где в коде |
|---|---|---|---|
| `resolve` | `plugin.not_found`, `plugin.manifest_invalid` | дескриптор установки непуст; `manifest.kind === 'plugin'`; имя/версия дескриптора совпадают с манифестом; **повторная активация активного плагина** — `plugin.already_active` (переключение — только `deactivate` → `activate`) | `packages/core/src/engine/plugins/plugin-host.ts` (`_resolve`) |
| `integrity` | `plugin.integrity_mismatch`, `plugin.integrity_unverifiable` | content-hash бандла (sha256 от отсортированного набора файлов) против ожидаемого; хеш не задан — шаг пропускается; хеш задан, а файлов нет — **fail-closed** | `packages/core/src/engine/plugins/integrity.ts` (`computePluginContentHash`, `verifyPluginIntegrity`) |
| `semver` | `plugin.contract_mismatch`, `plugin.host_mismatch` | порядок «контракт → host»: `contracts` (semver-мажор) и диапазон `host` против версии Synth; точные исключения — из файла `plugins.exactHostExceptions` | `plugin-host.ts` (`_checkSemver`) + `packages/shared/src/types/semver.ts` (`checkExtensionCompatibility`) |
| `trust` | `plugin.trust_below_floor`, `plugin.scan_rejected` | trust-floor инстанса (`plugins.trustFloor`): не задан — `community` (fail-closed); ниже порога — отказ. Сканер — **Ф2**: подключённый хук `PluginScanHook` возвращает вердикт, не `safe` — отказ | `plugin-host.ts` (`_checkTrust`) |
| `policy` | `plugin.disabled`, `plugin.not_allowlisted`, `plugin.denylisted`, `plugin.runtime_install_denied` | мастер-выключатель `plugins.enabled`; списки имён `allowlist`/`denylist`; `plugins.runtimeInstall=deny` для `installKind: 'runtime'` | `plugin-host.ts` (`_checkPolicy`) |
| `import` | `plugin.execution_disabled`, `plugin.loader_unavailable` | **Ф1: код не грузится.** При `plugins.executionEnabled=false` шаг останавливается явно; при `true` без загрузчика — `plugin.loader_unavailable` (`import()` чужого кода в ядре отсутствует) | `plugin-host.ts` (шаг 6) |
| `facade` | `plugin.loader_unavailable` | вызов `apply()` фасадом; ошибка — откат уже зарегистрированных вкладов (`disposers`) | `plugin-host.ts` (шаги 7–8), контракт — `engine/plugins/activation.ts` (`PluginFacade`, `PluginDisposer`) |
| аудит | — | запись `activate`/`deactivate` (исход `ok`/`rejected`, код причины, trust/hash/режим) — при **обоих** исходах; сбой записи аудита не ломает активацию (best-effort) | `plugin-host.ts` (`_writeAudit`), порт `PluginAuditRepository` |

**Обратная прокрутка (`deactivate`).** Disposer'ы выполняются **в обратном порядке** регистрации; ошибка
одного **не прерывает** остальные (изолируется и логируется), факт — в аудите (`plugin.disposer_failed`).

**Журнал аудита плагинов (PROP-090 §9).**

| Что | Где |
|---|---|
| Порт `PluginAuditRepository` (append-only; `append`/`list` «свежие первыми» с фильтрами `plugin`/`action`/`outcome`/`limit`/`clear`) | `packages/core/src/storage/ports/plugin-audit-repository.ts` |
| Тип записи `PluginAuditEntry` + перечни `PLUGIN_AUDIT_ACTIONS`/`PLUGIN_AUDIT_OUTCOMES`/`PLUGIN_SCAN_VERDICTS`/`PLUGIN_AUDIT_REASONS` (17 кодов — по одному на гейт пайплайна) | `packages/shared/src/types/plugin-audit.ts` |
| Файловая реализация — JSONL `{dataDir}/audit/plugins.jsonl` (append под `AsyncLock`, `clear` атомарно tmp→rename) | `packages/core/src/storage/file-plugin-audit-store.ts` |
| In-memory реализация (герметичные тесты) | `packages/core/src/storage/memory/plugin-audit.ts` |
| БД-драйвер: таблица `plugin_audit` (`seq bigserial` — порядок «свежие первыми»), миграция `006_plugin_audit` | `packages/storage-postgres/src/ports/plugin-audit.ts`, `packages/storage-postgres/src/migrations/006-plugin-audit.ts` |
| Контрактный suite порта (прогон на file/memory/PG) | `packages/core/src/storage/contract/plugin-audit-repository.contract.ts` (PG — `contract/postgres.test.ts`) |
| Подключение к `StorageContext` (`pluginAudit`) | `packages/core/src/storage/storage-context.ts` |

**Конфиг.** Добавлен ключ `plugins.executionEnabled` (дефолт `false`) — главный переключатель исполнения
кода плагинов; приоритет runtime > config > defaults (`mergePluginsConfig`), env-оверрайд
`SYNTH_PLUGINS_EXECUTION_ENABLED`. Остальные ключи секции `plugins` — из Ф0.

**Seam'ы, оставленные под Ф2/Ф3/Ф4** (описаны в `engine/plugins/activation.ts`):

| Seam | Что под него | Статус |
|---|---|---|
| `PluginScanHook` | сканер/проверка доверия (Ф2) | хук есть, реализации нет |
| `PluginLoader` | загрузчик кода: `inline` (Ф3) / `out-of-process` (Ф4) | тип есть, реализации нет |
| `PluginFacade` | регистрация вкладов (Ф3: тулы/хуки/блоки промпта/фильтры LLM) | Ф1 — только сбор `disposer`ов |

**Тесты Ф1.** `packages/core/src/engine/plugins/plugin-host.test.ts` (пайплайн, гейты, коды отказа, реестр,
обратная прокрутка, аудит), `packages/core/src/engine/plugins/exact-host-exceptions.test.ts` (формат файла,
fail-closed), `packages/core/src/storage/contract/plugin-audit-repository.contract.ts` (file/memory/PG),
`packages/core/src/storage/runtime-settings.test.ts` (приоритет runtime > config для `executionEnabled`).

**Остаток после Ф1.** Сканер/install-policy/карантин/`plugins.lock.json` (Ф2), точки `promptBlocks`/
`llmFilters` в композере и gateway (Ф3), два режима исполнения (Ф4), install/activate + API/CLI/UI
(Ф5/Ф6), hybrid (Ф7); HTTP-роут `/api/v2/settings/plugins` не зарегистрирован (есть типы, схема и
runtime-store).

### Статус реализации в коде (Ф2, 2026-10-22)

Ф2 закрыт в ветке `feature/plugin-trust`: появились встроенный статический сканер расширений, матрица
install-policy **одной функцией**, раскладка слоя плагинов с карантином и порт lock-файла.
**Исполнение кода плагинов по-прежнему выключено** — `plugins.executionEnabled` (дефолт `false`), загрузчика
(`PluginLoader`) в core нет (Ф3/Ф4). Пути — фактические, проверены по коду.

**Сканер — категории, что ищется, severity по умолчанию** (таблица правил — `PLUGIN_SCAN_RULES`,
`packages/core/src/engine/plugins/scan/rules.ts`; категории и severity — канон
[PROP-068](./prop-068-skills-agents-registry.md) §4.3, `packages/shared/src/types/plugin-scan.ts`):

| Категория | Что ищется | Severity по умолчанию | Правила (id) |
|---|---|---|---|
| `exfiltration` | вынос данных наружу: чтение окружения, доступ к файлам с секретами, домашний каталог | `low` (чтение `process.env`) / `medium` (env + сеть, `.netrc`/`.npmrc`, `os.homedir()`) / `high` (`.env`, `id_rsa`, `credentials.json`, `*.pem`) | `exfil_env_read`, `exfil_env_network` (составное), `exfil_secret_path`, `exfil_dotfile_credentials`, `exfil_home_dir` |
| `injection` | инструкции модели (prompt injection) | `medium` (подмена роли, скрытие действий от пользователя, inline-shell) / `high` («игнорируй предыдущие указания», «раскрой системный промпт») | `inj_ignore_previous`, `inj_reveal_prompt`, `inj_role_switch`, `inj_hide_from_user`, `inj_inline_shell` + словарный детектор `detectPromptInjection` (`engine/security/prompt-injection.ts`, `medium`) |
| `destructive` | разрушающие операции | `medium` (`rm -rf`, `fs.rm/unlink`, `chmod 777`, `sudo`, `child_process`) / `high` (`DROP TABLE`, `TRUNCATE`, `DELETE FROM`) | `des_shell_rm_rf`, `des_fs_delete`, `des_sql_drop`, `des_chmod_777`, `des_sudo`, `des_child_process` |
| `persistence` | закрепление в системе | `medium` (глобальная установка пакета, lifecycle-скрипты `pre/postinstall`) / `high` (cron, systemd/launchd, профили оболочки, `authorized_keys`) | `per_crontab`, `per_systemd`, `per_shell_rc`, `per_ssh_authorized_keys`, `per_global_install`, `per_install_script` |
| `network` | сетевые вызовы из бандла | `low` (fetch/axios/XHR, сокеты, DNS) / `high` (удалённое выполнение кода `curl … \| sh`) | `net_fetch`, `net_socket`, `net_dns`, `net_remote_exec` |
| `obfuscation` | замаскированное содержимое | `medium` (base64, длинные hex-экранирования) / `high` (`eval`, `new Function`); бинарный **исполняемый** файл — `high`; обычный бинарник — `info` (содержимое не исполняется) | `obf_eval`, `obf_function_ctor`, `obf_base64`, `obf_hex_escape` + бинарники по расширению/признаку NUL |
| `invisible_unicode` | скрытые символы (zero-width, bidi-управление, unicode-tag, soft hyphen) | `medium` — вердикт **не ниже** `caution` | `INVISIBLE_UNICODE_PATTERNS` (не regex-правила, отдельный проход) |

**Квоты структуры бандла** (канон — `PLUGIN_SCAN_QUOTAS` + `PLUGIN_SCAN_QUOTA_SEVERITIES`,
`packages/shared/src/types/plugin-scan.ts`; переопределение — опция `quotas` сканера):

| Квота | Значение | Нарушение → severity | Вердикт |
|---|---|---|---|
| Число файлов в бандле | `maxFileCount = 50` | `medium` | `caution` (не выше) |
| Суммарный размер бандла | `maxTotalSizeKb = 1024` КиБ | `medium` | `caution` (не выше) |
| Размер **одного** файла | `maxSingleFileKb = 256` КиБ | `high` | `dangerous` (установка блокируется) |

Находки квот отнесены к категории `destructive` (ресурсная нагрузка/риск для инстанса) — отдельной
«структурной» категории в PROP-068 §4.3 нет.

**Матрица install-policy** — одна функция `installPolicyDecision({ trust, verdict, kind })`
(`packages/shared/src/types/plugin-scan.ts`); ячейка `kind: 'plugin'` — **новая**, для плагинов:

| Trust \ Вердикт | `safe` | `caution` | `dangerous` |
|---|---|---|---|
| `builtin` | allow | allow | allow |
| `verified` | allow | allow | block |
| `trusted` | allow | allow | block |
| `community` | allow | block | block |
| `agent-created` | allow | allow | ask |
| **`kind: 'plugin'` (любой trust)** | **allow** | **ask** | **block** |

**Порядок проверок в `PluginHost` (важно).** Сначала **trust-floor** (`plugins.trustFloor`), затем скан,
затем install-policy. Плагин ниже порога не активируется **ни при каком вердикте**
(`plugin.trust_below_floor`) — доверенность проверяется раньше вердикта, а не наоборот.
Для плагина `caution` → `ask` (явное подтверждение владельца, код `plugin.approval_required`) — это **не**
блокировка; `dangerous` → `block` (`plugin.scan_rejected`).

**Раскладка `<home>/plugin/`** (без home — `{dataDir}/plugin/`; приоритет корня: явный home > env
`SYNTH_HOME` > `{dataDir}/plugin` — ADR-079). Реализация — `engine/plugins/layout.ts`:

```text
<home>/plugin/
├── installed/
│   └── <name>@<version>/
│       ├── synth.pack            # манифест (kind: plugin)
│       ├── dist/index.js         # бандл
│       └── PLUGIN_INTEGRITY.json # { sha256, source, fetched_at }
├── quarantine/                   # всё скачанное распаковывается и сканируется здесь
├── plugins.lock.json             # провенанс — источник истины для update/uninstall
└── plugins.json                  # runtime-override включений/настроек
```

`stagePluginBundle` раскладывает бандл по решению install-policy: `allow` → в `installed/<name>@<version>/`,
`ask`/`block` → остаётся в `quarantine/<name>@<version>/` (в `installed/` **не попадает**); `PLUGIN_INTEGRITY.json`
пишется в обоих случаях. `releaseFromQuarantine` переносит бандл из карантина в `installed/` после
подтверждения владельца (каталог карантина удаляется).

**Формат `.skillignore`** (файл в корне бандла; `PLUGIN_IGNORE_FILE`) — упрощённый `.gitignore`:

```text
# комментарий (целая строка)
node_modules/          # каталог (только каталог)
dist/*.map             # glob (якорь — от корня бандла)
**/*.test.js           # любой вложенности
!dist/keep.js          # отрицание — вернуть файл в обход
```

Правила разбора: пустые строки и `#` — комментарии; ведущий `!` — отрицание; хвостовой `/` — только
каталоги; ведущий `/` **или** слэш внутри правила — якорь от корня бандла; правило без слэша совпадает с
любым сегментом пути на любой глубине; `*` — любые символы кроме `/`, `?` — ровно один символ кроме `/`,
`**` — любые символы вместе с `/`. **Последнее совпадение выигрывает** (как в gitignore). Реализация —
`engine/plugins/scan/ignore.ts` (`parseIgnorePatterns`/`isIgnored`); симлинки не следуются
(защита от выхода за пределы бандла), `node_modules`/`.git` не обходятся.

**Формат кэша сканов** — ключ `sha256(версия правил \0 source \0 sourceUrl \0 contentHash)`
(`PluginScanCache.key`, `engine/plugins/scan/cache.ts`): повторный скан **идентичного** содержимого из того
же источника не выполняется. Кэш **in-process** на инстанс (FIFO, по умолчанию 100 записей);
постоянное хранилище кэша — задача Ф5 (установщик). **Ф3а: версия правил сканера входит в ключ**
(`PLUGIN_SCAN_RULES_VERSION`) — при изменении правил старый вердикт из кэша не переиспользуется,
идёт пересчёт.

**Аудит-события Ф2.** Действие `scan` добавлено в `PLUGIN_AUDIT_ACTIONS` (`activate`/`deactivate`/`scan`);
запись аудита плагина получила поля `scanVerdict?`, `scanPerformed?`, `scanFindings?`
(`packages/shared/src/types/plugin-audit.ts`). По журналу видно, **чем** решена активация: вердикт, был ли
скан выполнен и сколько находок. Запись `scan` пишется на шаге trust/scan — и при успешном вердикте,
и при отказе (если активация дошла до этого шага; отказ по trust-floor происходит **раньше**).

**Новые коды отказа** (`PLUGIN_AUDIT_REASONS`, всего 19 — по одному на гейт пайплайна):

| Код | Когда | Смысл |
|---|---|---|
| `plugin.scan_rejected` | вердикт `dangerous` **или** сбой сканера | установка/активация заблокированы (сбой сканера — **fail-closed**) |
| `plugin.approval_required` | вердикт `caution` (install-policy `ask`) | требуется **явное подтверждение** владельца — не блокировка |

**Порт `PluginLockRepository`** (ADR-096; `plugins.lock.json` — источник истины для update/uninstall):

| Что | Где |
|---|---|
| Порт (`save`/`get`/`list`/`delete`; ключ — **имя плагина**, `installed_at` иммутабельно) | `packages/core/src/storage/ports/plugin-lock-repository.ts` |
| Файловая реализация (JSON + атомарная запись tmp→rename; путь задаёт раскладка) | `packages/core/src/storage/file-plugin-lock-store.ts` (`defaultPluginLockPath` → `{dataDir}/plugin/plugins.lock.json`) |
| In-memory реализация | `packages/core/src/storage/memory/plugin-lock.ts` |
| БД-драйвер: таблица `plugin_lock`, upsert по имени (`ON CONFLICT`), миграция `007_plugin_lock` | `packages/storage-postgres/src/ports/plugin-lock.ts`, `packages/storage-postgres/src/migrations/007-plugin-lock.ts` |
| Контрактный suite порта (file/memory/PG) | `packages/core/src/storage/contract/plugin-lock-repository.contract.ts` (PG — `contract/postgres.test.ts`) |
| Подключение к `StorageContext` (`pluginLock`) + опция `pluginLockPath` | `packages/core/src/storage/storage-context.ts` |

Запись lock'а — snake_case (`name, version, source, identifier, trust_level, scan_verdict, content_hash,
ref, entry, installed_at, updated_at`), формат файла — `PluginLockFile` (`schemaVersion` + `plugins[]`).
Тип runtime-override (`plugins.json`) — `PluginRuntimeOverride`/`PluginSettingsFile`
(`packages/shared/src/types/plugin-runtime.ts`).

**Миграции БД (ADR-097).** `007_plugin_lock` (таблица `plugin_lock`) и `008_plugin_audit_scan`
(поля `scan_performed`/`scan_findings` в `plugin_audit`) — обе идемпотентны
(`IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`).

**Seam'ы: что закрыто, что осталось.**

| Seam | Что под него | Статус |
|---|---|---|
| `PluginScanHook` | сканер/проверка доверия (Ф2) | **закрыт** — дефолтная реализация `createPluginScanHook` (`engine/plugins/scan/hook.ts`); seam остаётся для внешнего сканера |
| `PluginLoader` | загрузчик кода: `inline` (Ф3) / `out-of-process` (Ф4) | тип есть, реализации нет |
| `PluginFacade` | регистрация вкладов (Ф3: тулы/хуки/блоки промпта/фильтры LLM) | Ф1/Ф2 — только сбор `disposer`ов |

### Решение 2026-10-22 — `plugins.scan: 'disabled'`

Админ-настройка выключает скан (`plugins.scan: 'disabled'`, `SYNTH_PLUGINS_SCAN=disabled`). Поведение:

1. **Сканирование не выполняется** — хук сканера не вызывается вовсе; вердикт по умолчанию `safe`.
2. **Доверие всё равно проверяется по trust-floor** — проверка trust-floor идёт **до** install-policy
   (§«Порядок проверок в `PluginHost`» выше), поэтому fail-open при выключенном скане **ограничен
   уже доверенными плагинами**: плагин ниже `plugins.trustFloor` не активируется даже при `scan: 'disabled'`
   (отказ `plugin.trust_below_floor`).
3. **Факт отражается в аудите** — запись `scan` пишется с `scanPerformed: false`, `scanVerdict: 'safe'`,
   `scanFindings: 0`: по журналу видно, что скана **не было**, и его нельзя спутать с чистым бандлом.
4. **Это осознанный компромисс админ-настройки**, а не «сканирование не работает»: выключая скан, владелец
   сознательно снимает advisory-контроль **содержимого**; компенсирующие гейты — trust-floor (fail-closed
   по доверию) и `plugins.executionEnabled` (код плагинов по умолчанию не исполняется).

**Уточнение Ф3а (2026-10-22) — fail-closed при включённом исполнении.** Вариант «запретить `disabled`
при `plugins.executionEnabled: true`» **реализован**: активация отклоняется с кодом
`plugin.scan_disabled_with_execution` (шаг `trust`, проверка — **до** скана, поэтому в журнале аудита
не остаётся записи «скан выполнен, вердикт safe»). Исполняемый код обязан быть просканирован:
админ-настройка не может отключить контроль содержимого для кода, который реально исполняется.
Без исполнения кода (`plugins.executionEnabled=false`) поведение прежнее — компромисс п. 1–4.

**Требует подтверждения владельца** (см. «Открытые вопросы»): оставшаяся альтернатива — требовать скан
при установке из источника ниже trust-floor.

**Тесты Ф2.** `packages/shared/src/types/plugin-scan.test.ts` (23 — матрицы `severity → verdict`, квоты,
install-policy для всех 15 ячеек `trust × verdict` + ячейка `kind: 'plugin'`),
`packages/core/src/engine/plugins/scan/scanner.test.ts` (24 — находка по каждой из 7 категорий, бинарники,
квоты, невидимый unicode, совпадение `content_hash` с шагом integrity Ф1, словарный детектор),
`scan/ignore.test.ts` (14 — `.skillignore`), `scan/cache.test.ts` (10 — кэш сканов),
`scan/hook.test.ts` (8 — дефолтный хук скана), `engine/plugins/layout.test.ts` (9 — раскладка и карантин),
`engine/plugins/plugin-host.test.ts` (+9 — trust/scan: trust-floor до install-policy, `dangerous` →
`plugin.scan_rejected`, `caution` → `plugin.approval_required`, `scan: 'disabled'` → `scanPerformed: false`,
сбой сканера — fail-closed, запись аудита `scan`).

**Остаток после Ф2.** Точки `promptBlocks`/`llmFilters` в композере и gateway (Ф3), два режима исполнения
(Ф4), install/activate + API/CLI/UI (Ф5/Ф6), hybrid (Ф7); HTTP-роут `/api/v2/settings/plugins`
не зарегистрирован (есть типы, схема и runtime-store).

### Статус реализации в коде (Ф3а, 2026-10-22)

Ф3а закрывает **первую половину Ф3** — точку `promptBlocks` (контракт, реестр, сборка блоков,
контекст хода, бюджет символов, инвалидация состояния промпта, фасад плагина). Вторая половина —
точка `llmFilters` в `GatewayProvider` — **Ф3б, не начата**. Ветка `feature/plugin-points`,
коммитов нет.

**Контракт (в `shared`, browser-safe).**

| Что | Где |
|---|---|
| `PromptBlockProvider` (`key`/`tier`/`order`/`title?`/`load(ctx)`), `PromptBlockContent`, узкий DTO `PromptBlockContext` (`sessionId`/`agentRole`/`language`/`projectId?`/`mode`/`query?`/`turnId?`/`timestamp?`) | `packages/shared/src/types/prompt-blocks.ts` (реэкспорт — `types/index.ts`) |
| Тир провайдера ограничен `context`/`volatile` **на уровне типа** (`PROMPT_BLOCK_PROVIDER_TIERS`) — `stable` запрещён (граница prompt-cache, [ADR-070](./adr-070-system-prompt-composer.md)) | там же |
| Единый источник истины для бюджета символов: `DEFAULT_PROMPT_BLOCK_MAX_CHARS = 4000` (совпадает с `plugins.promptBlockMaxChars` в конфиге) | там же + `packages/shared/src/config/defaults.ts` |
| Префикс ключа плагинного блока `plugin.` + хелпер `isPluginPromptBlockKey` | там же |

**Реестр и сборка блоков (core).**

| Что | Где |
|---|---|
| `PromptBlockRegistry` — реестр провайдеров: `register()` (fail-closed: пустой ключ, нечисловой `order`, занятый ключ, тир `stable` → `PromptBlockRegistrationError`), `unregister`/`get`/`list`/`size`/`clear`; `register` возвращает **disposer** (идемпотентный) | `packages/core/src/engine/context/prompt-block-registry.ts` |
| Сборка блоков провайдеров в `SystemPromptComposer` (`_collectProviderBlocks`): обход в порядке регистрации, блоки попадают в **тот же** массив, что и встроенные (один манифест, одна склейка, одна сортировка по тирам) | `packages/core/src/engine/context/composer.ts` |
| Узкий контекст вызова (`_providerContext`): `sessionId`/`agentRole`/`language`/`projectId?`/`mode` + `query?`/`turnId?`/`timestamp?`; **история сессии наружу не отдаётся** | там же |
| «Вопрос хода» (`resolveTurnQuery`): только сообщения **пользователя** (`role: user`), не отключённые (`disabled`/`hidden`), не state-сообщения (`metadata.state=true`); сначала — сообщение, которым инициирован ход, затем последнее пользовательское сообщение истории | `packages/core/src/engine/orchestrator/prompt-info.ts` |
| Хост обрезает блок по бюджету (`plugins.promptBlockMaxChars`, дефолт 4 000): голова+хвост с **своим** маркером усечения (без `read_file` — блок провайдера не файл), `status: 'truncated'`; общая форма обрезки — `truncateHeadTailWithMarker` | `packages/core/src/engine/context/composer.ts`, `packages/core/src/engine/context/instructions.ts` |
| Подпись блока в манифесте: для плагинных ключей — «Plugin block» (сырой ключ `plugin.<name>.<slot>` в манифесте не торчит) | `packages/core/src/engine/context/composer.ts` (`promptBlockLabel`) |
| `PromptBlock.source = 'provider'` + `PromptBlockState.provider` — пометка блока провайдера в состоянии промпта | `packages/core/src/engine/context/prompt-blocks.ts`, `packages/shared/src/types/prompt.ts` |

**Инвалидация состояния промпта.**

Блоки провайдеров лежат вне тира `stable`, поэтому `isPrefixUnchanged` их не видит — трек ведётся
отдельно, по образцу блока `instructions` ([ADR-069](./adr-069-project-instructions-agents-md.md) §11):
`process-setup.ts` собирает множество ключей блоков провайдеров (текущие + бывшие — плагин мог быть
деактивирован, и блок исчез) и при изменении любого из них пересобирает `session.promptStates`
(`reason: 'generation-change'`).

**Фасад плагина.**

`PluginFacade.registerPromptBlock(provider, opts?)` (`packages/core/src/engine/plugins/activation.ts`)
— возвращает disposer (снимает блок), при отказе — no-op + предупреждение в лог хоста (остальные
точки расширения плагина при этом регистрируются). Реализация фасада — в `PluginHost`
(`packages/core/src/engine/plugins/plugin-host.ts`): реестр провайдеров передаётся в хоста опцией
`promptBlocks`; без него точка недоступна (предупреждение, no-op).

**Решения, закрытые в Ф3а.**

| Решение | Как реализовано |
|---|---|
| `plugins.scan: 'disabled'` + `plugins.executionEnabled: true` | **fail-closed**: активация отклоняется с новым кодом `plugin.scan_disabled_with_execution` (шаг `trust`, до скана — в журнале не остаётся записи «скан выполнен, вердикт safe»). Без исполнения кода поведение прежнее: скан не выполняется, вердикт `safe`, в аудите `scanPerformed: false` |
| Кэш сканов и смена правил | **Версия правил входит в ключ**: `sha256(версия правил\0source\0source_url\0content_hash)` (`PLUGIN_SCAN_RULES_VERSION`, `packages/shared/src/types/plugin-scan.ts`). При изменении правил сканера старый вердикт из кэша **не переиспользуется** — пересчёт. Кэш остаётся **in-process** (FIFO, 100 записей); постоянное хранилище — задача Ф5 |
| Тир `stable` у провайдера | **Отказ** на регистрации (`PromptBlockRegistrationError`), а не тихое понижение до `context`; в фасаде — предупреждение, активация плагина не падает |

**Тесты Ф3а.** `packages/core/src/engine/context/composer.prompt-blocks.test.ts` (реестр: блок в
`compose().blocks` и в `manifest()` с `provenance`; отказ тира `stable`; дубликат/пустой ключ; ошибка
провайдера → warning + пустой блок, ход не падает; пустой результат → `status: 'empty'`; обрезка по
бюджету + `status: 'truncated'`; бюджет по умолчанию 4 000; override `session.settings.systemPrompt`;
порядок «тир → order, tie-break — регистрация»; контекст провайдера; disposer снимает блок),
`packages/core/src/engine/plugins/plugin-host.test.ts` (Ф3а: блок плагина попадает в промпт и
`provenance: 'plugin:<name>'`; `deactivate()` — блок исчезает; тир `stable` — отказ без падения
активации; провайдер бросает исключение — ход не падает, блок пуст; без реестра — предупреждение;
`plugin.scan_disabled_with_execution` — fail-closed),
`packages/core/src/engine/context/prompt-state.test.ts` (блок провайдера помечается `provider: true`),
`packages/core/src/engine/orchestrator/phases/process-setup.test.ts` («вопрос хода» доходит до
контекста композера; state-сообщения в вопрос не попадают; смена содержимого плагинного блока
инвалидирует `promptStates`),
`packages/core/src/engine/plugins/scan/cache.test.ts` (версия правил в ключе: другая версия → другой
ключ → пересчёт, а не попадание в кэш),
`packages/shared/src/types/prompt-blocks.test.ts` (контракт: тиры, префикс ключа, бюджет).

**Остаток после Ф3а.** Точка `llmFilters` в `GatewayProvider` (Ф3б: контракт `LlmCallFilter`, фазы
`pre_request`/`post_response`/`embedding`, право вето, таймаут, семантика отказа — см. §«Точка
`llmFilters»), сверка фактических регистраций тулов с `provides.tools[]` и **контрактный suite
расширений** (Ф3), два режима исполнения (Ф4), install/activate + API/CLI/UI (Ф5/Ф6), hybrid (Ф7);
HTTP-роут `/api/v2/settings/plugins` не зарегистрирован (есть типы, схема и runtime-store).

### Статус реализации в коде (Ф3б, 2026-10-22)

Ф3б закрывает **вторую половину Ф3** — точку `llmFilters`: контракт фильтра, реестр, три фазы в
`GatewayProvider`, политику вето, бюджет времени и семантику отказа, аудит решений, фасад плагина и
**сверку `provides` ↔ фактические регистрации**. Ветка `feature/plugin-points`, коммитов нет.

**Контракт (в `shared`, browser-safe).**

| Что | Где |
|---|---|
| `LlmCallFilter` (`id`/`phase`/`failMode?`/`timeoutMs?`/`inspect(input)`), `LlmFilterInput` (узкий DTO: `phase`/`provider`/`model`/`sessionId?` + поля по фазе), `LlmFilterVerdict` (`allow`/`deny`/`redact` + `reason`/`code`/`redactedContent?`/`redactedTexts?`), `LlmFilterMessage` (роль + текст + `toolCalls?`, без служебных полей `LLMMessage`) | `packages/shared/src/types/llm-filters.ts` (реэкспорт — `types/index.ts`) |
| Перечни `LLM_FILTER_PHASES` (`pre_request`/`post_response`/`embedding`), `LLM_FILTER_FAIL_MODES` (`open`/`closed`), `LLM_FILTER_VERDICTS` + предикаты `isLlmFilterPhase`/`isLlmFilterFailMode`/`isLlmFilterVerdictKind` | там же |
| `phaseCanBlock(phase)` — блокировать вызов может только `pre_request`/`embedding`; `post_response` в первой волне — наблюдение (ADR-036 запрещает буферизацию) | там же |
| `DEFAULT_LLM_FILTER_TIMEOUT_MS = 1000` — единый источник истины для `plugins.llmFilterTimeoutMs` (конфиг/дефолты) и для реестра | там же |

**Реестр (core).**

| Что | Где |
|---|---|
| `LlmFilterRegistry` — `register(filter, opts)` (fail-closed: пустой `id`, неизвестная фаза, занятый `id` → `LlmFilterRegistrationError`), возвращает **disposer** (идемпотентный); `unregister`/`get`/`list(phase?)`/`size`/`clear` | `packages/core/src/engine/gateway/llm-filter-registry.ts` |
| Метаданные регистрации (`LlmFilterRegistrationOptions`): `trustLevel?`, `pluginName?`, `pluginVersion?`, `onAudit?`, `failMode?`, `timeoutMs?`; владелец (плагин) подставляет их через фасад, а не фильтр | там же |
| Право вето: `canVetoLlmFilter` (`trustLevelRank ≤ rank('trusted')`), порог `LLM_FILTER_VETO_TRUST_LEVEL = 'trusted'`; неуказанное доверие — `community` (fail-closed) | там же |
| Режим отказа по умолчанию — `defaultLlmFilterFailMode(phase, trust)`: блокирующий класс + право вето → `closed`, иначе `open` | там же |
| **Runtime-бюджет:** `setDefaultTimeoutMs(ms)` (валидация: положительное конечное число, иначе `RangeError`) + геттер `defaultTimeoutMs`. Действует на **последующие** регистрации; у уже зарегистрированных фильтров бюджет зафиксирован при регистрации. Live-wiring из `RuntimeSettings.plugins.llmFilterTimeoutMs` — **не сделан** (Ф5/Ф6, остаток) | там же |

**Три фазы в `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md)).**

| Фаза | Seam (фактические пути:строки) | Что видит фильтр | Что может |
|---|---|---|---|
| `pre_request` | `gateway-provider.ts:529` — вызов `_applyPreRequestFilters` **после** `saveMap` (карта обфускации сохранена), до отправки провайдеру; сам метод — `:681` | обфусцированные сообщения, текст системного промпта, `tools`, `provider`/`model`/`sessionId` | `allow` — пропустить; `deny` — вызов **не уходит** провайдеру (причина — в текст ошибки и аудит); `redact` — **отклоняется хостом** (нужно переписывать запрос) |
| `post_response` | `gateway-provider.ts:991` — вызов `_applyPostResponseFilters` в `_auditCompletion` (после output-guard); сам метод — `:889` | полный текст ответа, `usage` | **только наблюдение** (`allow` по факту): `deny`/`redact` отклоняются хостом (`plugin_filter.buffering_required`) — буферизация ответа запрещена ADR-036 |
| `embedding` | `gateway-provider.ts:352` `embed()` → `:359` `_prepareEmbedding` (метод — `:783`) **до** `_inner.embed` | тексты, уходящие в эмбеддинг (`texts`), `provider`/`model` | `deny` — эмбеддинг не уходит провайдеру; `redact` — тексты заменяются на `redactedTexts` (несовпадение длины/нестроковые элементы → fail-closed `deny`) |

**Путь эмбеддингов: было/стало.** Было: `GatewayProvider.embed` — прямой вызов `_inner.embed` в обход
guard/обфускации/rate-limit/аудита, а микро-слой (`router/micro/models/embedding-model.ts`) звал
`provider.embed` через duck-типизированный `ProviderPool` — **мимо gateway вовсе** (дыра инварианта 3).
Стало: `embed` идёт через `_prepareEmbedding` (фильтры фазы `embedding`, аудит вызова, rate-limit), а
`ProviderPool` оборачивает провайдера в `GatewayProvider` (`filters` прокинут из оркестратора) — прямых
вызовов `provider.embed` в микро-слое не осталось. Как следствие, embedding-фаза фильтров **работает**,
а не только объявлена.

**Чего не может каждая фаза (и почему).**

- `pre_request`: `redact` — не поддерживается, хост отклоняет вердикт (`plugin_filter.redact_unsupported`):
  правка запроса требует пересборки сообщений/промпта/tools и повторной проверки guard'ами.
- `post_response`: `deny`/`redact` — не поддерживаются (`plugin_filter.buffering_required`): блокировка или
  правка ответа требует буферизации всего ответа и задержки первого чанка, а ADR-036 это запрещает.
- `embedding`: нет rate-limit по пользователю/провайдеру в прежнем смысле и нет обфускации текстов —
  эмбеддинг-путь использует те же слои, что применимы к тексту без ролей и истории; `redact` ограничен
  заменой массива `texts` той же длины.

**`failMode` × таймаут/сбой × доверие → поведение.**

| `failMode` | Сбой/таймаут фильтра | Доверие владельца | Поведение | Код в аудите gateway |
|---|---|---|---|---|
| `closed` (дефолт блокирующего класса) | да | ≥ `trusted` | вызов **не уходит** провайдеру (`pre_request`/`embedding`) | `plugin_filter.unavailable` (+ `plugin_filter.timeout`/`.error` как причина) |
| `open` (дефолт наблюдательного класса) | да | любое | вызов идёт как есть, факт в аудите | `plugin_filter.unavailable` |
| любой | нет | ≥ `trusted`, вердикт `deny` | вызов заблокирован | `plugin_filter.denied` |
| любой | нет | < `trusted`, вердикт `deny`/`redact` | **понижение до `allow`** (права вето нет), факт в журнале плагинов | `plugin_filter.deny_downgraded` |
| любой | нет | ≥ `trusted`, вердикт `allow` | вызов идёт | `plugin_filter.allowed` |
| любой | нет | любое, `post_response` | только наблюдение | `plugin_filter.allowed` / `.buffering_required` |

Бюджет времени: `filter.timeoutMs` > `opts.timeoutMs` (хост-политика регистрации) > бюджет реестра
(`plugins.llmFilterTimeoutMs`, дефолт 1 000 мс) на момент регистрации.

**Аудит (два журнала, разные перечни).**

- **Аудит gateway** (`AuditLogger`, `type: 'plugin_filter'`): `filterId`/`filterPhase`/`filterTrust`/
  `filterVerdict`/`filterEffectiveVerdict`/`filterDowngraded`/`filterCode`/`filterTimeoutMs` — видно **все**
  решения, включая коды хоста `plugin_filter.allowed`/`.timeout`/`.error`/`.redact_unsupported`/
  `.buffering_required`/`.redact_invalid`. Текст запроса/ответа/эмбеддингов **не пишется**.
- **Журнал плагинов** (`PluginAuditRepository`, `action: 'filter'`): только **канонические** коды —
  `plugin_filter.denied` (вызов заблокирован, `outcome: 'rejected'`), `plugin_filter.deny_downgraded`
  (понижено, `outcome: 'ok'`), `plugin_filter.unavailable` (сбой/таймаут; `outcome` — по эффективному
  вердикту). Коды хоста в журнал плагинов **не идут**: `PLUGIN_AUDIT_REASONS` не расширяется без решения
  владельца. Запись содержит плагин/версию/доверие и код; идентификатор фильтра и фаза остаются в аудите
  gateway.

**Фасад плагина.**

`PluginFacade.registerLlmFilter(filter, opts?)` (`packages/core/src/engine/plugins/activation.ts`,
опции — `PluginLlmFilterOptions` `{failMode?, timeoutMs?}`) возвращает disposer (снимает фильтр).
Реализация — `PluginHost` (`packages/core/src/engine/plugins/plugin-host.ts:377`): регистрирует фильтр
**от имени плагина** (`pluginName`/`pluginVersion`/`trustLevel` из активации — не из манифеста) и
подставляет `onAudit` в журнал плагинов (`_writeFilterAudit`, `:852`). Реестр передаётся опцией
`PluginHostOptions.llmFilters` — тот же экземпляр, что у `GatewayProvider` (`orchestrator.getLlmFilters()`,
`packages/core/src/engine/orchestrator.ts:938`); без реестра точка недоступна (предупреждение + no-op).
Отказ регистрации (пустой/занятый `id`, неизвестная фаза, недоступный реестр) — **предупреждение в лог,
активация не падает**; при деактивации фильтры снимаются обратной прокруткой disposers.

**Сверка `provides` ↔ фактические регистрации (Ф3б).**

`diffPackProvides` (`packages/shared/src/types/pack.ts`) вызывается в `PluginHost` **после** `apply()` и
**до** фиксации активации (шаг `facade`, `plugin-host.ts:431-455`). Сверяются реализации, доведённые до
кода: `provides.promptBlocks[]` и `provides.llmFilters[]`. Расхождение в **любую** сторону
(`missing` — объявлено, но не зарегистрировано; `unexpected` — зарегистрировано, но не объявлено) →
**отказ активации** `plugin.provides_mismatch`: PROP-090 §«Правило соответствия» трактует это как признак
несогласованной сборки. Перед отказом выполняется обратная прокрутка disposers — отклонённый плагин не
оставляет блоков/фильтров в живых реестрах. В сообщении об отказе расхождения перечислены **поимённо**
(«фильтр LLM-вызовов «…» объявлен, но не зарегистрирован»). Учитываются только **успешные** регистрации:
отклонённая точка (например, тир `stable` у блока) не выглядит как «зарегистрировано».
`provides.tools[]` в сверку **пока не входит** — точка `tools` ещё не реализована (Ф3в), а манифест
плагина с тулами обязан объявлять их (§«Правило соответствия»).

**Решения, закрытые в Ф3б.**

| Решение | Как реализовано |
|---|---|
| Расхождение `provides` — отказ или предупреждение | **Отказ** активации (`plugin.provides_mismatch`), как требует PROP-090 §«Правило соответствия»; с откатом уже сделанных регистраций |
| Коды хоста в журнале плагинов | **Не пишутся**: журнал плагинов получает только `denied`/`deny_downgraded`/`unavailable`; коды `allowed`/`timeout`/`error`/`redact_unsupported`/`buffering_required`/`redact_invalid` живут только в аудите gateway (перечень `PLUGIN_AUDIT_REASONS` — закрытый, 23 кода) |
| Runtime-бюджет фильтра | `LlmFilterRegistry.setDefaultTimeoutMs(ms)` (+ геттер). Действует на последующие регистрации; live-wiring из runtime-настроек — остаток Ф5/Ф6 |
| Право вето и `redact` в `pre_request` | Вето — только trust ≥ `trusted`; `redact` в `pre_request` отклоняется (`redact_unsupported`), в `embedding` — поддержан, в `post_response` — запрещён (ADR-036) |

**Тесты Ф3б.** `packages/core/src/engine/gateway/gateway-filters.test.ts` (24 кейса: три фазы, вето/понижение,
таймаут/сбой по `failMode`, аудит `plugin_filter` без текста, пустой реестр — регрессия, эмбеддинги через
gateway и пул, бюджет: `setDefaultTimeoutMs` меняет только последующие регистрации, явный `timeoutMs`
приоритетнее, невалидный бюджет → `RangeError`), `packages/core/src/engine/plugins/plugin-host.test.ts`
(Ф3б: фильтр из плагина применяется — `deny` блокирует вызов и пишет `plugin_filter.denied`; `deactivate()`
снимает фильтр; `community`-плагин — `deny` понижается до `allow` + `plugin_filter.deny_downgraded`;
битый фильтр (дубль `id`, пустой `id`) — предупреждение, активация не падает, disposer no-op; без реестра —
предупреждение; `provides` — объявлено/не зарегистрировано и зарегистрировано/не объявлено → отказ
`plugin.provides_mismatch` с откатом).

**Остаток после Ф3б.** Точка `tools` + сверка `provides.tools[]` + **контрактный suite расширений**
(Ф3в); буферизация `post_response` (явная опция, по умолчанию выключена); live-применение
`plugins.llmFilterTimeoutMs` из runtime-настроек; payload-лог эмбеддингов и их rate-limit в прежней
семантике; два режима исполнения (Ф4), install/activate + API/CLI/UI (Ф5/Ф6), hybrid (Ф7); HTTP-роут
`/api/v2/settings/plugins` не зарегистрирован (есть типы, схема и runtime-store).

## Открытые вопросы

> Закрыто решениями владельца продукта 2026-10-22: форма out-of-process-протокола (HTTP/1.1 + JSON,
> контракт — в `@itphx/synth-shared`, отдельный пакет не создаётся); место контракта
> `MemoryProvider` (`@itphx/synth-shared`, реализации — плагинами); матрица `severity → verdict`
> (каноническая таблица — PROP-068 §4.3); третья фаза `llmFilters` — `embedding`. Решения по каталогу и
> маркету — ниже, «Решено 2026-10-22 — каталог и маркет». **Ф1 слоя выполнена 2026-10-22**
> (ветка `feature/plugin-host`): пайплайн `PluginHost` реализован, **исполнение кода выключено по
> умолчанию** (`plugins.executionEnabled=false`), журнал аудита плагинов — **отдельный порт**
> `PluginAuditRepository` (не расширение `SECURITY_AUDIT_SCOPES`).
>
> **Ф2 слоя выполнена 2026-10-22** (ветка `feature/plugin-trust`): встроенный сканер
> (`engine/plugins/scan/*`), матрица install-policy одной функцией (`installPolicyDecision`, ячейка
> `kind: 'plugin'`), раскладка `<home>/plugin/` с карантином, порт `PluginLockRepository`, аудит-событие
> `scan` и код `plugin.approval_required`. **Закрыто реализацией Ф2** (решения владельца по сути не
> требовали — канон согласован 2026-10-22 в PROP-068 §4.2–§4.4): матрица `severity → verdict`
> (канон — PROP-068 §4.3), install-policy (PROP-068 §4.2 + ячейка `kind: 'plugin'`), формат lock-записи и
> раскладки карантина (`plugins.lock.json` / `quarantine/` / `PLUGIN_INTEGRITY.json`), формат `.skillignore`
> (упрощённый `.gitignore`), формат кэша сканов (`sha256(source \0 sourceUrl \0 contentHash)`, in-process).
> Требуют подтверждения владельца: формат файла точных исключений (ниже) и режим `plugins.scan: 'disabled'`
> (см. «Решение 2026-10-22 — `plugins.scan: 'disabled'`»).
>
> **Ф3а слоя выполнена 2026-10-22** (ветка `feature/plugin-points`): закрыта точка **`promptBlocks`** —
> контракт `PromptBlockProvider`/`PromptBlockContext` (`shared`), реестр `PromptBlockRegistry`, сборка
> блоков в `SystemPromptComposer`, контекст хода (`query`/`turnId`), бюджет символов блока
> (`plugins.promptBlockMaxChars`, дефолт 4 000) с обрезкой и `status: 'truncated'`, инвалидация
> `promptStates` по блокам провайдеров, фасад `PluginFacade.registerPromptBlock`. **Закрыто реализацией
> Ф3а:** тир `stable` у провайдера — отказ на регистрации
> (не тихое понижение); `plugins.scan: 'disabled'` вместе с `plugins.executionEnabled: true` —
> **fail-closed** (`plugin.scan_disabled_with_execution`); **версия правил сканера входит в ключ кэша
> сканов** (при смене правил — пересчёт, а не попадание в кэш). Остальные открытые вопросы (в т.ч.
> подтверждение владельца по формату файла точных исключений и режиму `plugins.scan: 'disabled'`) — ниже.
>
> **Ф3б слоя выполнена 2026-10-22** (та же ветка): закрыта точка **`llmFilters`** — контракт
> `LlmCallFilter` (`shared`, `types/llm-filters.ts`), реестр `LlmFilterRegistry`, фильтры в трёх фазах
> `GatewayProvider` (`pre_request`/`post_response`/`embedding`), право вето только у trust ≥ `trusted`
> (понижение — `plugin_filter.deny_downgraded`), `failMode`/таймаут, аудит решений (`plugin_filter` в
> аудите gateway + `action: 'filter'` в журнале плагинов), фасад `PluginFacade.registerLlmFilter` и
> **сверка `provides` ↔ фактические регистрации** (расхождение — отказ `plugin.provides_mismatch`).
> **Закрыто реализацией Ф3б:** «что видит и что может каждая фаза» (в т.ч. запрет `redact` в
> `pre_request`, только наблюдение в `post_response`); путь эмбеддингов «было/стало» (закрыта дыра
> инварианта 3 — `embed` и микро-слой идут через gateway-контур); правило «коды хоста живут только в
> аудите gateway» (журнал плагинов получает лишь `denied`/`deny_downgraded`/`unavailable`); механизм
> runtime-бюджета (`setDefaultTimeoutMs`, live-wiring — остаток). **Осталось:** буферизация
> `post_response` (явная опция, по умолчанию выключена), live-применение `plugins.llmFilterTimeoutMs` из
> runtime-настроек, payload-лог и rate-limit эмбеддингов в прежней семантике; точка `tools`, сверка
> `provides.tools[]` и контрактный suite расширений — Ф3в.

1. **Версии контракта расширений и окно deprecation.** Как версионируется контракт точки
   (`promptBlocks@1`, `llmFilters@1`), сколько релизов живёт старая мажорная версия, что делает
   плагин на несовместимом контракте (отказ активации vs «мягкий» режим).
2. **Бюджет времени фильтра.** Значение по умолчанию для `timeoutMs` плагинных фильтров и
   отдельный лимит для embedding-фазы (индексация — latency-чувствительный путь). **Механизм закрыт
   Ф3б:** `DEFAULT_LLM_FILTER_TIMEOUT_MS = 1 000`, приоритет `filter.timeoutMs` > хост-опция регистрации >
   бюджет реестра (`plugins.llmFilterTimeoutMs`), `LlmFilterRegistry.setDefaultTimeoutMs(ms)` меняет
   бюджет **последующих** регистраций. **Осталось:** live-применение runtime-значения
   `plugins.llmFilterTimeoutMs` (реестр держит бюджет с момента создания — wiring из
   `RuntimeSettings.plugins` в Ф5/Ф6) и решение, нужен ли **отдельный** бюджет для embedding-фазы.
3. **Hot-reload vs restart в managed** — где граница: всегда restart или отдельные плагины допускают
   reload (в managed перезапуск пода = `kubectl rollout restart`, инвариант 24).
4. **Поддержка схемы каталога при изменении контракта.** Владелец каталога — мы: записи плагинов
   публикуются **в общий** каталог [PROP-068](./prop-068-skills-agents-registry.md) `synth-registry`
   (решение 2026-10-22, см. ниже). Схема записи — `packages/shared/src/types/catalog.ts` (**файл есть в
   `master`**), JSON Schema каталога (`synth-registry/schema/catalog-entry.schema.json`) **генерируется из
   неё** скриптом каталога `scripts/gen-schema.mjs` (`zod-to-json-schema`). Открытый вопрос теперь не «где
   схема», а **как держать её в актуальном состоянии**: генерировать в CI монорепо при изменении контракта
   (и публиковать артефакт) или обновлять вручную по чек-листу при каждом ломающем изменении `catalog.ts`.
   Пока — ручной перезапуск генерации (известное ограничение каталога); при изменении контракта
   `provides`/`trust` синхронизация обязательна.
5. **Нужен ли `plugin_id`-scope поверх service-key** ([ADR-052](./adr-052-public-api-platform.md)) —
   точная механика выдачи/валидации для Уровня 2 (Ф7).
6. **Транспортная обвязка `out-of-process`.** Контракт протокола живёт в `@itphx/synth-shared` (§7),
   но где лежит реализация клиента/сервера: в core рядом с `execution/remote.ts`
   (`packages/core/src/execution/remote.ts`) или отдельным пакетом по образцу
   `@itphx/synth-executor`? От ответа зависит, кто собирает `out-of-process`-плагин.
7. **Режим `plugins.scan: 'disabled'` — подтверждение владельца.** **Частично закрыто Ф3а:** вариант
   «запретить `disabled` при `plugins.executionEnabled: true`» **реализован** — fail-closed, отказ
   `plugin.scan_disabled_with_execution` (шаг `trust`, до скана). Без исполнения кода поведение
   прежнее: скан не выполняется, **trust-floor проверяется до install-policy**, поэтому fail-open
   ограничен уже доверенными плагинами; в аудите — `scanPerformed: false` (см. «Решение 2026-10-22 —
   `plugins.scan: 'disabled'`»). **Осталось подтвердить владельцу:** сама совместимость режима
   `disabled` без исполнения кода (и альтернатива «требовать скан при установке из источника ниже
   trust-floor»).
8. **Кэш сканов — постоянный или in-process, и как инвалидируется при смене правил.** Ф2: кэш
   **in-process** (FIFO, 100 записей). **Ф3а: вариант (а) реализован** — в ключ кэша входит **версия
   правил сканера**: `sha256(версия правил \0 source \0 sourceUrl \0 contentHash)`
   (`PLUGIN_SCAN_RULES_VERSION`, `packages/shared/src/types/plugin-scan.ts`), поэтому при изменении
   таблицы правил (`PLUGIN_SCAN_RULES`) старый вердикт **не переиспользуется** — идёт пересчёт.
   **Осталось подтвердить владельцу:** постоянный кэш (файл/БД — тогда нужен порт) или сброс кэша
   при старте процесса (варианты (б)/(в) — задача Ф5, установщик).
9. **Кто и как подтверждает `ask`** (вердикт `caution` → `plugin.approval_required`): API/CLI/UI — это
   Ф5/Ф6, но сама механика подтверждения не определена: чем подтверждается (вердикт / версия /
   content-hash), какой срок жизни подтверждения и кто именно может его выдать (владелец / ADMIN).

### Решено 2026-10-22 — формат файла точных исключений

Файл точных исключений семвер-гейта (путь — конфиг `plugins.exactHostExceptions`) — **текстовый**,
**одна полная semver-версия host в строке** (`readExactHostExceptions`,
`packages/core/src/engine/plugins/exact-host-exceptions.ts`):

```text
# Точные исключения семвер-гейта плагинов (PROP-090 §10).
# Одна версия Synth в строке; строки с `#` — комментарии.
0.11.0
0.11.1
```

Правила разбора — **fail-closed**:

- пустые строки и строки с `#` (в т.ч. с ведущими пробелами) — пропускаются;
- строка должна быть полной semver-версией (`MAJOR.MINOR.PATCH`); **не-semver строка
  пропускается с предупреждением** — исключение не выдаётся;
- файл недоступен (нет файла/нет прав) — список **пуст**, предупреждение в лог: исключений
  **нет** (гейт остаётся строгим).

**Формат требует подтверждения владельца.** Текстовый формат выбран исполнителем в Ф1 как
минимальный (без новой зависимости и без Zod-схемы на стороне конфига), но это **не решение
владельца**: допустимые альтернативы — JSON/YAML (схема в `shared`, валидация при чтении) или
список прямо в секции `plugins.*` конфига. Вопрос остаётся открытым (формат файла — не сам
механизм гейта); при смене формата меняются только `readExactHostExceptions` и путь из
`plugins.exactHostExceptions` — сам семвер-гейт и его вердикты (`contract_mismatch`/
`host_mismatch`) не меняются.

### Решено 2026-10-22 — каталог и маркет

Решения владельца продукта (касаются доставки плагинов; модель доверия — [PROP-068](./prop-068-skills-agents-registry.md) §4):

1. **Плагины публикуются в общий каталог `synth-registry`** — отдельный репозиторий для плагинов не заводим:
   одна запись = один `entries/<owner>__<repo>.yml` с `kind: plugin` ([PROP-068](./prop-068-skills-agents-registry.md) §2/§12).
2. **`trust_level` записи каталога — истина** для доверия (каталогом управляем мы: запись проходит ревью/PR и CI).
   Заявленный в манифесте `trust.level` — только **верхняя граница** (§9): манифест не может поднять доверие выше
   записи каталога. В будущем — **локальные каталоги у заказчиков**: там доверенным для инстанса считается
   **их** каталог (per-instance trust), а не наш; до этого — только наш каталог.
3. **Отдельная CLI-команда `synth plugin *` принимается** (§«CLI»): класс Plugin отличается от Add-on по контуру —
   код/доверие/скан/активация против декларативного контента; смешивать команды `synth addons install` и
   `synth plugin install` в одну нельзя.
4. **Витрина `synth-market` и шаблон каталога `synth-registry/templates/entry.yml` должны стать kind-aware**:
   для `kind: plugin` — команда установки `synth plugin install <name>@<version>` и API-эквивалент
   `POST /api/v2/plugins/install` (сейчас витрина и шаблон по умолчанию показывают `synth addons install` и
   `POST /api/v2/packs`). Правка — в репозиториях каталога/витрины, не в ядре; эндпоинт появится в Ф5.

## Связи

- [ADR-086](./adr-086-extensibility-plugins-editions.md) — зонтик «Классы расширений»; PROP-090 — детальный слой плагинов.
- [ADR-030](./adr-030-hooks-agent-events.md) — hook-шина: точка `hooks`; остаток ADR-030 закрыт в Ф0 (политика `builtin` + эмиты `message_received`/`plan_rejected`/`schedule_fired`; `callback` — контракт внешнего канала).
- [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) — порты и контрактный suite; новые порты `PluginAuditRepository` (Ф1) и `PluginLockRepository` (Ф2) обязательны и в PG-драйвере.
- [ADR-100](./adr-100-extension-packs-pipelines.md) — поставка `synth.pack`: манифест — общий для всех классов.
- [ADR-103](./adr-103-gateway-core-channel-contract.md) — контракт внешнего канала: образец wire-протокола и семвера.
- [ADR-036](./adr-036-llm-gateway.md) — Gateway: точка `llmFilters` встраивается в `_prepare`/`_auditCompletion`; буферы/задержки запрещены.
- [ADR-070](./adr-070-system-prompt-composer.md) — сборка промпта: точка `promptBlocks`; тиры, `stablePrefix`, `promptStates`.
- [ADR-023](./adr-023-configuration.md) — конфиг: секция `plugins.*`, `RuntimeSettings.plugins`.
- [ADR-025](./adr-025-plan-act-toggle.md)/[ADR-028](./adr-028-plan-build-strictness.md)/[ADR-029](./adr-029-granular-permissions.md) — permissions: плагин не обходит permission-слой.
- [ADR-052](./adr-052-public-api-platform.md) — service-key/scopes: основа server-scoped токенов (Ф7).
- [ADR-079](./adr-079-local-home-independent-instances.md) — home-раскладка: `<home>/plugin/`.
- [ADR-094](./adr-094-observability-metrics.md) — контракт метрик: плагин не добавляет лейблы.
- [ADR-099](./adr-099-egress-tls-trust.md) — egress/CA: сетевые вызовы плагинов.
- [PROP-068](./prop-068-skills-agents-registry.md) — модель доверия: уровни, install-policy, сканер, карантин, lock, провенанс, подписи.
- [PROP-047](./prop-047-memory-gbrain.md) — память: `MemoryProvider` доставляется плагином (переписывается отдельно).
- [ADR-077](./adr-077-runtime-toolchain.md) — `ExecutionPort` и исполнитель: образец двух режимов и wire-протокола.
- [PROP-082](./prop-082-full-images-deployment.md) — flavor-образы: бандлы плагинов в образе (managed deploy-time).
- [PROP-100](./prop-100-ssrf-dns-rebinding.md) — SSRF: адресная политика для сетевых вызовов плагинов.

## История

- 2026-10-22 — **Ф0 выполнен** (ветка `feature/plugin-layer`): политика `builtin` в `HookBus` (+ `offBuiltin`), эмиты `message_received`/`plan_rejected`/`schedule_fired` (`callback` — вне core, контракт внешнего канала), semver-матчер `types/semver.ts` + `checkExtensionCompatibility`, модуль `types/trust.ts`, явные схемы `provides.tools/promptBlocks/llmFilters` и поля `mode`/`permissions`/`trust` + `diffPackProvides`, секция `plugins.*` и `RuntimeSettings.plugins` + `mergePluginsConfig`; добавлен раздел «Статус реализации в коде (Ф0)». Решения по каталогу/маркету (общий `synth-registry`, `trust_level` записи = истина, `synth plugin *`, kind-aware витрина) — в «Открытые вопросы» → «Решено 2026-10-22».
- 2026-10-22 — **Ф1 выполнен** (ветка `feature/plugin-host`): модуль `engine/plugins/*` (`PluginHost` — пайплайн resolve → integrity → semver → trust → policy → import → facade, реестр активных плагинов, обратная прокрутка disposers; `computePluginContentHash`/`verifyPluginIntegrity`; `readExactHostExceptions`), журнал аудита плагинов — **отдельный порт** `PluginAuditRepository` (файл `{dataDir}/audit/plugins.jsonl` / память / PostgreSQL, миграция `006-plugin-audit.ts`, контрактный suite), ключ `plugins.executionEnabled` (дефолт `false` — код плагинов не грузится); формат файла точных исключений зафиксирован и **требует подтверждения владельца** (см. «Открытые вопросы» → «Решено 2026-10-22 — формат файла точных исключений»).
- 2026-10-22 — **Ф2 выполнен** (ветка `feature/plugin-trust`): встроенный статический сканер (`engine/plugins/scan/*` — 7 категорий, квоты `50` файлов / `1024` КиБ суммарно / `256` КиБ на файл, `.skillignore`, кэш `sha256(source \0 sourceUrl \0 contentHash)`, дефолтный хук `PluginScanHook`), матрица install-policy **одной функцией** `installPolicyDecision` (ячейка `kind: 'plugin'`: `safe→allow`, `caution→ask`, `dangerous→block`) в `shared`, раскладка `<home>/plugin/` с `quarantine/` и `PLUGIN_INTEGRITY.json` (`engine/plugins/layout.ts`), порт `PluginLockRepository` (файл/память/PostgreSQL, миграция `007_plugin_lock`, контрактный suite), аудит-событие `scan` + поля `scanVerdict`/`scanPerformed`/`scanFindings` и новый код отказа `plugin.approval_required` (миграция `008_plugin_audit_scan`); в `PluginHost` — **trust-floor до install-policy**; решение по `plugins.scan: 'disabled'` (скан не выполняется, доверие проверяется всегда, в аудите `scanPerformed: false`) — **требует подтверждения владельца**; добавлен раздел «Статус реализации в коде (Ф2)».
- 2026-10-22 — **Ф3а выполнен** (ветка `feature/plugin-points`): закрыта точка **`promptBlocks`** — контракт `PromptBlockProvider`/`PromptBlockContext`/`PromptBlockContent` (`packages/shared/src/types/prompt-blocks.ts`, тир провайдера ограничен `context`/`volatile` **на уровне типа**), реестр `PromptBlockRegistry` (`engine/context/prompt-block-registry.ts`, fail-closed: пустой ключ / нечисловой `order` / занятый ключ / тир `stable`), сборка блоков провайдеров в `SystemPromptComposer` (`_collectProviderBlocks`: один манифест, одна склейка, одна сортировка по тирам; override `session.settings.systemPrompt` — блоки не добавляются), контекст хода (`query` — только пользовательский текст, `turnId`, `timestamp`; `resolveTurnQuery`), бюджет символов блока (`plugins.promptBlockMaxChars`, дефолт 4 000 — `DEFAULT_PROMPT_BLOCK_MAX_CHARS`) с обрезкой голова+хвост и `status: 'truncated'`, деградация (ошибка провайдера → `warning`, блок пуст, **ход не падает**), инвалидация `promptStates` по блокам провайдеров (`PromptBlock.source='provider'` → `PromptBlockState.provider`), фасад `PluginFacade.registerPromptBlock` (disposer снимает блок при деактивации), решения: **fail-closed** `plugins.scan='disabled'` + `plugins.executionEnabled=true` (новый код отказа `plugin.scan_disabled_with_execution`) и **версия правил сканера в ключе кэша сканов** (`PLUGIN_SCAN_RULES_VERSION`); добавлен раздел «Статус реализации в коде (Ф3а)». Точка `llmFilters` — **Ф3б, не начата**.
- 2026-10-22 — **Ф3б выполнен** (ветка `feature/plugin-points`): закрыта точка **`llmFilters`** — контракт `LlmCallFilter`/`LlmFilterInput`/`LlmFilterVerdict`/`LlmFilterMessage` (`packages/shared/src/types/llm-filters.ts`, browser-safe: только типы и чистые функции; `phaseCanBlock`, `DEFAULT_LLM_FILTER_TIMEOUT_MS = 1000`), реестр `LlmFilterRegistry` (`engine/gateway/llm-filter-registry.ts`: fail-closed регистрация, disposer, `canVetoLlmFilter` — вето только у trust ≥ `trusted`, `defaultLlmFilterFailMode`, `setDefaultTimeoutMs` для runtime-бюджета), фильтры в `GatewayProvider` (три фазы: `pre_request` после `saveMap`, `post_response` — только наблюдение, `embedding` через `_prepareEmbedding`; таймаут `Promise.race`, понижение вето недоверенных, `FILTER_CODES`), **эмбеддинги перестали быть дырой инварианта 3** (`embed` и микро-слой идут через gateway-контур), аудит: `type: 'plugin_filter'` в аудите gateway (без текста) + `action: 'filter'` в журнале плагинов только для канонических кодов (`plugin_filter.denied`/`deny_downgraded`/`unavailable`; коды хоста `allowed`/`timeout`/`error`/`redact_*`/`buffering_required` — только в gateway), фасад `PluginFacade.registerLlmFilter` (владелец — плагин: имя/версия/фактическое доверие; отказ — предупреждение, активация не падает), **сверка `provides` ↔ фактические регистрации** (`diffPackProvides` после `apply()`: `provides.promptBlocks[]`/`provides.llmFilters[]`, расхождение в любую сторону → отказ `plugin.provides_mismatch` с откатом disposers; `provides.tools[]` — вместе с точкой `tools`, Ф3в). Кодов отказа в `PLUGIN_AUDIT_REASONS` — **23** (19 прежних + 3 канонических кода фильтров + `plugin.provides_mismatch`). Добавлен раздел «Статус реализации в коде (Ф3б, 2026-10-22)».
