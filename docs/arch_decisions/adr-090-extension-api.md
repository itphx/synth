# ADR-090: Слой плагинов Synth — Extension API v1: три точки расширения, два режима исполнения, модель доверия

> **Статус:** ✅ Реализовано — фазы Ф0–Ф7 закрыты (2026-10-22…2026-10-23); слой развёрнут в test (0.12.1); авторская спецификация — [docs/PLUGINS.md](../PLUGINS.md)
> **Дата:** 2026-10-23 (решение владельца — 2026-10-22, «добить Ф7 и перенести в ADR»)
> **Обновлено:** 2026-10-24 — п. 9: схема записи каталога генерируется автоматически из опубликованного `@itphx/synth-shared` в CI каталога (bot-коммит) — **реализовано**. Фактический механизм: репозиторий каталога `synth-registry` (`scripts/gen-schema.mjs` + джоба `schema` в `.gitverse/workflows/registry.yaml`) берёт контракт из опубликованного npm-пакета, пересобирает `schema/` и коммитит результат в `master` ботом; пока версия пакета с контрактом каталога не опубликована, пересборка пропускается с явным сообщением в логе джобы.
> **Связано:** [ADR-029](./adr-029-granular-permissions.md) (permission-слой), [ADR-030](./adr-030-hooks-agent-events.md) (шина хуков), [ADR-036](./adr-036-llm-gateway.md) (шлюз LLM), [ADR-052](./adr-052-public-api-platform.md) (модель service-key), [ADR-070](./adr-070-system-prompt-composer.md) (сборка промпта), [ADR-076](./adr-076-git-repo-registry-ssh.md) (секреты at-rest), [ADR-077](./adr-077-runtime-toolchain.md) (образец порта), [ADR-086](./adr-086-extensibility-plugins-editions.md) (зонтик классов расширений), [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) (порты и драйверы), [ADR-099](./adr-099-egress-tls-trust.md) (egress), [PROP-047](./prop-047-memory-gbrain.md) (память — контрактом плагина), [PROP-068](./prop-068-skills-agents-registry.md) (каталог и модель доверия), [PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md) (гибрид); спецификация — [docs/PLUGINS.md](../PLUGINS.md), HTTP — [docs/API_V2.md](../API_V2.md) §5.36, эксплуатация — [docs/MAINTENANCE.md](../MAINTENANCE.md) §Плагины.

## Контекст

Два запроса владельца продукта определили, зачем нужен слой плагинов. Первый: синтез памяти ([PROP-047](./prop-047-memory-gbrain.md)) должен приходить плагином — `MemoryProvider` есть контракт, доставляемый плагином, а не подсистемой ядра. Второй: внешним системам (мониторинг, аналитика, DLP) нужен вход в поток LLM-вызовов — увидеть запрос и ответ, при необходимости заблокировать вызов; `GatewayProvider` ([ADR-036](./adr-036-llm-gateway.md)) такого публичного входа не давал.

К моменту решения уже были: пакетный контур расширений (манифест `synth.pack`, порт `PackRepository`, роуты `/api/v2/packs`), шина хуков `HookBus` ([ADR-030](./adr-030-hooks-agent-events.md)), реестры тулов/MCP/агентов/скиллов, паттерн core-фабрик роутов, порты хранилища с контрактным suite ([ADR-096](./adr-096-storage-layer.md)), единственная точка сборки системного промпта ([ADR-070](./adr-070-system-prompt-composer.md)). Не было: загрузчика плагинов, модели доверия для кода, точек расширения для блоков промпта и LLM-фильтров, единого контура управления плагинами.

## Решение

1. **Форма слоя — in-process SDK с манифестом.** Манифест `synth.pack` (`kind: "plugin"`), загрузчик `PluginHost` (resolve → integrity → семвер-гейт → trust/scan → политика режима → import → facade → disposers → аудит), bundle-only дистрибуция, модель доверия по [PROP-068](./prop-068-skills-agents-registry.md).
2. **Три точки расширения в первой волне:** `promptBlocks` (блоки системного промпта; сборка в `SystemPromptComposer`), `llmFilters` (фазы `pre_request`/`post_response`/`embedding`) и `tools`; контракты — в `@itphx/synth-shared`, сверка объявленного (`provides`) и фактического состава вкладов — при активации.
3. **Два режима исполнения:** `inline` (код в процессе core) и `out-of-process` (отдельный процесс, wire-протокол HTTP/1.1 + JSON по образцу исполнителя [ADR-077](./adr-077-runtime-toolchain.md); контракт протокола — в `@itphx/synth-shared`, отдельный пакет не создаётся).
4. **Право вето — только у доверенных:** вердикт `deny` фильтра действует только при trust ≥ `trusted`, плагины уровня `community` наблюдают, но не блокируют; trust-floor инстанса — `trusted`, установщик **отказывает в установке** плагина ниже порога (`plugin.trust_below_floor`).
5. **Управление — полный контур:** HTTP API `/api/v2/plugins*` (RBAC-матрица), CLI `synth plugin *`, UI-раздел «Плагины», журнал аудита плагинов (отдельный порт), обновление/откат версии, карантин, контрактный suite (автору — subpath `@itphx/synth-core/engine/plugins/contract.js`).
6. **Режимы инстанса:** standalone — полный контроль локально; managed — deploy-time установка по умолчанию, runtime-install `deny`, **смена набора расширений — только рестартом** (деплоем); hybrid — серверная политика (allow-list) плюс локальный контур, см. [ADR-086](./adr-086-extensibility-plugins-editions.md).
7. **Гибрид (Ф7).** Сервер публикует политику (`plugins.hybrid.mode`/`allow`) — сигналом в `/auth/oidc-meta` и полным списком через `GET /api/v2/settings/plugins`. **Уровень 1 (cooperative):** локальный core не активирует плагин вне серверного allow-list (`plugin.hybrid_not_allowed`), но при недоступном сервере работает кооперативно («не проверен сервером»). **Уровень 2:** доступ к серверу — только с токеном, привязанным к `plugin_id` (модель service-key, [ADR-052](./adr-052-public-api-platform.md)); сервер требует совпадающий `X-Synth-Plugin-Id`, scope `plugins:invoke` и плагин в allow-list — иначе 403. **Уровень 3** (attestation) — вне объёма v1.
8. **Публикация — в общий каталог** `synth-registry` (`kind: plugin`); `trust_level` записи — источник истины для доверия, заявленный в манифесте `trust.level` — только верхняя граница.
9. **Принятые решения по спорным местам** (владелец, 2026-10-23): окно deprecation контракта — мажор живёт **не менее 3 минорных релизов и не менее 90 дней** после выхода следующего мажора; бюджет времени фильтра — общий `plugins.llmFilterTimeoutMs` на все фазы, **отдельного бюджета для embedding нет**; вердикт `caution` → `plugin.approval_required`, подтверждение выдаёт **ADMIN**, привязано к **content-hash** бандла, срок — **24 ч**; режим `plugins.scan: 'disabled'` остаётся (без исполнения кода скан не выполняется), fail-closed (`plugin.scan_disabled_with_execution`) — **только** при `executionEnabled: true`; кэш сканов — **in-process**, **версия правил входит в ключ**; файл точных исключений семвер-гейта — **текстовый** (одна полная semver-версия host в строке, `#` — комментарий, разбор fail-closed); JSON-схема записи каталога генерируется из `packages/shared/src/types/catalog.ts` **в CI монорепо** (ручное обновление не нужно).

## Альтернативы

- **Форк ядра под каждую интеграцию** — отвергнут: разрывает обновления, не даёт аудита и превращает каталог в канал произвольного исполнения.
- **Только MCP** — отвергнут как единственный механизм: MCP-тулы не дают блоков промпта и фильтров вызовов.
- **Только `inline`** — отвергнут: нужен изолированный контур для недоверенного кода; выбран второй транспорт с тем же контрактом точки расширения.
- **Отдельный пакет `@itphx/synth-plugin-protocol`** — отвергнут: контракт протокола живёт в `shared`.
- **Отдельный реестр плагинов** — отвергнут: публикация идёт в общий каталог расширений.
- **14 точек расширения сразу** — отвергнут: в первой волне три точки с явными контрактами.

## Последствия

- Появился код, исполняемый в процессе core: обязательны trust/scan, install-policy, trust-floor и семвер-гейт; право вето ограничено доверенными; каждое действие попадает в журнал плагинов.
- Плагин — инстанс-уровневый (не per-user); его инструменты проходят через permission-слой ([ADR-029](./adr-029-granular-permissions.md)), сетевые вызовы — через egress-слой ([ADR-099](./adr-099-egress-tls-trust.md)), секреты — только через API, at-rest по [ADR-076](./adr-076-git-repo-registry-ssh.md).
- Появились контрактный suite плагинов и авторская спецификация — плагин можно писать и проверять вне ядра.
- Гибрид: локальный контур кооперативен по отношению к серверной политике; привязанный к `plugin_id` токен даёт серверу точку принуждения.

## Статус в коде

| Что | Где |
|---|---|
| Манифест и поля плагина, `provides`, `mode`/`permissions`/`trust` | `packages/shared/src/types/pack.ts` |
| Контракты точек расширения и протокола | `packages/shared/src/types/plugin-protocol.ts`, `plugin-tools.ts` |
| Гибридная политика (сигнал, allow-list, статусы) | `packages/shared/src/types/plugin-hybrid.ts` |
| Модель доверия, сканер, install-policy | `packages/shared/src/types/trust.ts`, `packages/core/src/engine/plugins/scan/*` |
| Загрузчик, активация, runtime, установщик, раскладка | `packages/core/src/engine/plugins/{plugin-host,activation,runtime,installer,layout}.ts` |
| Серверная политика; два режима исполнения | `packages/core/src/engine/plugins/hybrid-policy.ts`, `{inline-loader,remote/*}.ts` |
| Контрактный suite (доступен автору) | `packages/core/src/engine/plugins/contract/*` (subpath `./engine/plugins/contract.js`) |
| HTTP API, RBAC, plugin-bound токен | `packages/core/src/server/routes/plugins.ts`, `packages/core/src/server/service-scope.ts`, `packages/backend/src/auth/plugin-scope.ts` |
| CLI / UI / конфигурация | `packages/core/src/cli/plugin-commands.ts`, `packages/ui/src/components/settings/PluginsSettings.tsx`, `packages/shared/src/config/{types,defaults,env-overrides}.ts` |
| Аудит и lock (порты), `plugin_id` у ключа | `packages/core/src/storage/ports/{plugin-audit,plugin-lock,service-key}-repository.ts` |

## Остаток и развитие

- **Уровень 3** (attestation клиента в гибриде) — вне объёма v1.
- **[PROP-047](./prop-047-memory-gbrain.md)** переписывается под слой плагинов: `MemoryProvider` — контракт, доставляемый плагином (отдельная задача).
- **Подтверждение `caution`**: привязка к content-hash реализована; **срок 24 ч** и **генерация JSON-схемы каталога в CI монорепо** — решения приняты (п. 9 «Решения»), реализация — в работе.
- Версия точки расширения — семвер-мажор; окно deprecation — п. 9 «Решения», поведение при несовместимой версии — в [docs/PLUGINS.md](../PLUGINS.md) §11.

## История

- 2026-10-22 — решение владельца: слой возвращён в работу (был Icebox), форма — in-process SDK + два режима исполнения; фазы Ф0–Ф6 выполнены.
- 2026-10-23 — Ф7 (гибрид) закрыта; предложение принято как решение (ADR-090); спецификация автора — [docs/PLUGINS.md](../PLUGINS.md).
- 2026-10-24 — п. 9: схема записи каталога генерируется автоматически из опубликованного `@itphx/synth-shared` в CI каталога (bot-коммит) — реализовано.
