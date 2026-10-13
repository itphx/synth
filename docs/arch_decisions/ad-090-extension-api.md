# AD-090: Extension API v1 — плагины, точки расширения и загрузчик

> **Статус:** ⏳ Не реализовано (концепт/проект)
> **Дата:** 2026-10-12
> **Источник:** вынесено из зонтика [AD-086](./ad-086-extensibility-plugins-editions.md) — Extension API
> проектировался там как первый из четырёх столпов (плагины, editions, contribution flow, add-on'ы);
> здесь он выделен в отдельный AD и детализирован.
> **Связано:** [AD-086](./ad-086-extensibility-plugins-editions.md) (зонтик), [AD-030](./ad-030-hooks-agent-events.md)
> (hooks/Plugin SDK), [AD-038](./ad-038-npm-packages.md) (npm-пакеты), [AD-046](./ad-046-skills-and-slash-commands.md)
> (скиллы/команды), [AD-068](./ad-068-skills-agents-registry.md) (реестр/каталог/trust), [AD-071](./ad-071-mcp-servers-prompt.md)
> (MCP), [AD-089](./ad-089-external-events-automation.md) (внешние события), [AD-023](./ad-023-configuration.md)
> (конфиг), [AD-025](./ad-025-plan-act-toggle.md)/[AD-028](./ad-028-plan-build-strictness.md)/[AD-029](./ad-029-granular-permissions.md)
> (permissions), [AD-036](./ad-036-llm-gateway.md) (Gateway), [AD-042](./ad-042-hybrid-mode.md)/[AD-073](./ad-073-client-integrity-hybrid.md)/[AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md)
> (гибрид/политики), [AD-052](./ad-052-public-api-platform.md) (service-key/scopes), [AD-082](./ad-082-full-images-deployment.md)
> (flavor-образы), [AD-077](./ad-077-runtime-toolchain.md) (executor).

**Решение:** ввести **Extension API v1** — версионированный контракт для расширения Synth кодом **без форка
ядра**. Extension API — это четыре части: **манифест** плагина (`synth`-поле в `package.json`), **загрузчик**
(`PluginHost`: resolve → integrity → semver-гейт → trust/scan → политика режима → `import` → facade → сбор
disposers → аудит), **модель доверия** (переиспользуется из [AD-068](./ad-068-skills-agents-registry.md):
trust-уровни, install-policy, статический сканер, quarantine) и **install/activate** (раскладка в
`<home>/plugin/`, `plugins.lock.json`, `plugins.json`, CLI/API).

**Три класса расширений жёстко разведены:** **Plugin** — код, монтируемый **в процесс core** через точки
расширения; **Add-on** — **внешний сервис** в своём процессе/контейнере, общающийся по API v2 / MCP /
внешним событиям (эталон — `synth-media`); **Declarative** — контент без кода (скиллы, команды, агенты,
MCP-сервера, маршруты, расписания). Каждый класс имеет свой «носитель» и свой контракт, и они не смешиваются:
add-on — **не** плагин.

**Плагины разрешены во всех режимах** (standalone, hybrid, managed). Ограничение «плагин только standalone»
снято: вопрос не «где запрещено», а «**кто ставит + какая политика + сила энфорса**». В managed установку
выполняет **ADMIN** (deploy-time по умолчанию, runtime-install — опция `deny` по умолчанию); в hybrid
действует **allow-list сервера**, усиливаемый в Уровне 2 **server-scoped токенами**.

**Основной безопасный путь расширения — add-on**, а не in-process плагин: вынесенный сервис общается по уже
отлаженным границам (API v2/MCP/события) и не требует компромисса «сторонний код в процессе ядра». Плагин —
для тех, кому действительно нужны in-process точки расширения; он идёт через trust/scan/install-policy и
подчиняется тем же инвариантам (permissions через `PermissionEvaluator`, LLM через `GatewayProvider`,
хранилище через `FileStore`).

## Контекст

Расширить Synth сегодня можно только форком ядра. При этом **фундамент уже есть**: hook-шина `HookBus`
([AD-030](./ad-030-hooks-agent-events.md)) — ядровый in-process примитив с `on`/`off`/`emit`/`emitAsync`,
priority, `sync`/`async` и флагом `builtin`; реестры тулов (`ToolRegistry`, [AD-071](./ad-071-mcp-servers-prompt.md)),
MCP (`McpRegistryStore`/`McpManager`), агентов (`AgentRegistry`), скиллов/команд ([AD-046](./ad-046-skills-and-slash-commands.md)),
событий (`EventIngress`/`EventRouter`/`RouteRuleProvider`, [AD-089](./ad-089-external-events-automation.md)),
расписаний (`SchedulerService`/`SchedulerRuleProvider`, [AD-051](./ad-051-scheduler-pipelines.md)); паттерн
core-фабрик HTTP-роутов `createXxxRoutes(auth, deps, opts)` ([AD-017](./ad-017-api-v2-hono.md)); паттерн
runtime-настроек `GET/PUT/DELETE /api/v2/settings/<x>` + guard + live-apply ([AD-089](./ad-089-external-events-automation.md)/[AD-084](./ad-084-decision-models-clef.md));
контент-платформа с trust/scan/install-policy ([AD-068](./ad-068-skills-agents-registry.md)).

**Чего нет:** Plugin SDK `SynthPlugin`, конфига/загрузчика плагинов, публичной точки регистрации внешних
обработчиков и install/activate-механизма. Остаток [AD-030](./ad-030-hooks-agent-events.md): нет политики
`builtin` (любой может снять builtin-обработчик через `off`), часть хуков (`plan_rejected`, `message_received`,
`callback`, `schedule_fired`) объявлена, но не эмитится.

**Почему не берём модель «всё в одном процессе без изоляции».** Сторонний JS-код в процессе ядра получает
доступ ко всем internals (сессии, `FileStore`, `GatewayProvider`, permissions). Это ломает инварианты
(permissions, Gateway, storage) и превращает каталог плагинов в канал произвольного исполнения — тот же
класс риска, что открытый каталог контента без guard'а ([AD-068](./ad-068-skills-agents-registry.md), инцидент
ClawHavoc). Поэтому: (а) код — только через версионированный Extension API с явными permission-границами;
(б) доверие/скан/install-policy — обязательны; (в) основной безопасный путь — **add-on** (внешний сервис),
а не in-process плагин; (г) в гибриде/managed — allow-list/ADMIN и честная сила энфорса.

## 1. Терминология: Plugin ≠ Add-on ≠ Declarative

| Класс | Что запускается | Носитель | Контракт с Synth |
|---|---|---|---|
| **Plugin** | код **в процессе core** | self-contained bundle (JS), грузится `import()` | Extension API v1: манифест `synth`, интерфейс `SynthPlugin`, точки расширения; подчиняется permission-слою/Gateway/FileStore |
| **Add-on** | **внешний сервис** — свой процесс/контейнер/репозиторий | образ + `docker-compose`/Helm | API v2 / MCP / внешние события ([AD-089](./ad-089-external-events-automation.md)); эталон — `synth-media` |
| **Declarative** | ничего (данные, без кода) | файлы контента | скиллы/команды ([AD-046](./ad-046-skills-and-slash-commands.md)), агенты, MCP-сервера ([AD-071](./ad-071-mcp-servers-prompt.md)), маршруты/расписания ([AD-089](./ad-089-external-events-automation.md)/[AD-051](./ad-051-scheduler-pipelines.md)) |

> **Add-on — не плагин.** Внешний сервис **не** монтируется в процесс ядра и **не** получает точек расширения
> через Extension API: он потребляет публичные контракты (API v2/MCP/события) и не имеет доступа к internals
> по определению. Плагин, наоборот, исполняется в процессе core и потому обязан проходить trust/scan/policy.
> Смешение этих понятий («плагин-сервис», «add-on как npm-плагин») запрещено — от него расходятся модель угроз,
> способ установки и энфорс.

## 2. Точки расширения

Точки расширения Extension API v1 — вклад **в существующие seam'ы** ядра, а не новый рантайм:

| Точка | Вклад | Существующий seam в коде | Статус |
|---|---|---|---|
| hooks | обработчики жизненного цикла | `HookBus.on/off/emit/emitAsync` (`engine/hooks/hook-bus.ts`, [AD-030](./ad-030-hooks-agent-events.md)) | ✅ шина есть; SDK-фасада нет |
| tools | новые инструменты | `ToolRegistry.register/deregister/deregisterByCapability` (`engine/tools/registry.ts`), `source: 'builtin'\|'mcp'` | ✅ реестр есть |
| providers | LLM/decision-провайдеры | `ProviderFactory`/`BaseProvider` (`providers/*`), вызов только через `GatewayProvider` ([AD-036](./ad-036-llm-gateway.md)) | ✅ фабрика есть |
| routes | HTTP-роуты API v2 | core-фабрики `createXxxRoutes(auth, deps, opts)`, монтирование `server/app.ts` ([AD-017](./ad-017-api-v2-hono.md)) | ✅ паттерн есть |
| commands | slash-команды/bundles | `engine/commands/*` ([AD-046](./ad-046-skills-and-slash-commands.md)) | ✅ |
| skills | скиллы (механизм/каталог) | `engine/skills/*` ([AD-046](./ad-046-skills-and-slash-commands.md)), каталог [AD-068](./ad-068-skills-agents-registry.md) | ✅ механизм; каталог — нет |
| agents | определения агентов | `AgentRegistry` (`engine/agents/*`) | ✅ |
| mcp | MCP-серверы (stdio/HTTP) | `McpRegistryStore`/`McpManager` (`engine/mcp/*`, [AD-071](./ad-071-mcp-servers-prompt.md)) | ✅ |
| events | источники/правила/доставка событий | `EventIngress`/`EventRouter`/`RouteRuleProvider` (`engine/events/*`, [AD-089](./ad-089-external-events-automation.md)) | ✅ |
| schedules | источники-расписания | `SchedulerService`/`SchedulerRuleProvider` (`engine/scheduler/*`, [AD-051](./ad-051-scheduler-pipelines.md)) | ✅ (частично) |
| settings | свои настройки/секция | `RuntimeSettingsStore`, паттерн `GET/PUT/DELETE /api/v2/settings/<x>` + guard + live-apply | ✅ паттерн есть |
| UI-slot | панели/вкладки в SPA | — (seam отсутствует) | ⏳ отложено |

**Вывод:** **11 из 12** точек уже имеют seam в коде. Значит, Extension API v1 нужен **манифест + загрузчик +
trust/install/activate**, а не новый рантайм: плагин — это упорядоченный набор регистраций через фасад над
существующими реестрами. UI-slot осознанно отложен (в SPA нет стабильной точки монтирования сторонних
React-компонентов; до неё — только декларативные вклады и админ-секции).

## 3. Манифест плагина

Манифест — поле `synth` в `package.json` плагина (совместимо с npm-экосистемой и [AD-038](./ad-038-npm-packages.md)):

```json
{
  "name": "@acme/synth-plugin-slack",
  "version": "1.2.0",
  "license": "MIT",
  "main": "dist/index.js",
  "peerDependencies": { "@itphx/synth-plugin": "^1" },
  "synth": {
    "apiVersion": "1",
    "host": "^0.9.0",
    "kind": "plugin",
    "entry": "dist/index.js",
    "contributes": {
      "hooks": ["pre_tool_use", "post_tool_use", "session_end"],
      "tools": ["slack_notify"],
      "commands": ["slack-post"],
      "routes": false,
      "providers": false,
      "settings": ["slack"]
    },
    "permissions": {
      "tools": ["slack_notify"],
      "hooks": ["pre_tool_use"],
      "settings": ["slack"],
      "network": ["hooks.slack.com"]
    }
  }
}
```

| Поле | Смысл |
|---|---|
| `apiVersion` | Версия Extension API (semver-major-совместимость; сейчас `"1"`) |
| `host` | Диапазон версий Synth (host-приложения), semver-range — как `engines` |
| `kind` | Класс расширения: `plugin` (add-on/declarative манифестом `synth` не описываются) |
| `entry` | Точка входа бандла (относительный путь внутри пакета) |
| `contributes` | Декларация вкладов (что плагин регистрирует) — для инспекции/аудита и permission-резолвинга |
| `permissions` | Явные запросы (тулы, хуки, настройки, сеть); **без** совпадения с фактическими регистрациями плагин отвергается |
| `peerDependencies` | `@itphx/synth-plugin` — external/peer: типы SDK из хоста |

**Bundle-only (обязательно).** Плагин распространяется как **self-contained бандл** (сборка `esbuild`/`tsup`):
все зависимости, кроме `@itphx/*`, вшиты в бандл. `@itphx/*` — **external (peer)**: типы и рантайм-фасад
приходят из процесса core, дублировать их в бандле нельзя. **Runtime-резолв npm-зависимостей не выполняется**:
ноль runtime-пакетного менеджера — `import()`-загрузчик не ходит в npm/registry за зависимостями. Это
исключает «плагин как зависимость, которая тянет транзитивное дерево» и делает установку воспроизводимой
(один файл-бандл + манифест + хеш).

## 4. SDK: `@itphx/synth-plugin`

Публичный SDK — отдельный пакет (`@itphx/synth-plugin`, [AD-038](./ad-038-npm-packages.md)), тонкий фасад
над точками расширения core:

```typescript
// @itphx/synth-plugin (скетч)
export interface SynthPlugin {
  readonly apiVersion: 1;
  readonly log: PluginLogger;                       // scoped-логгер (префикс plugin:<name>)
  hooks: {
    on<K extends HookName>(name: K, handler: HookHandler<K>, opts?: { priority?: number; mode?: HookMode }): Disposer;
  };
  tools: { register(def: PluginToolDefinition): Disposer };
  commands: { register(def: PluginCommandDefinition): Disposer };
  routes: { register(def: PluginRouteDefinition): Disposer };
  providers: { register(def: PluginProviderDefinition): Disposer };
  settings: { register(section: PluginSettingsSection): Disposer };
  events: { registerSource(def: PluginEventSourceDefinition): Disposer };
}

export type Disposer = () => void | Promise<void>;

export interface PluginToolDefinition {
  name: string;                                     // обязателен префикс/namespace (напр. slack_notify)
  description: string;
  parameters: z.ZodTypeAny;                         // zod, как у встроенных тулов
  capabilities: ToolCapability[];                   // доступность — по capability (AD-071)
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/** definePlugin — точка входа: apply вызывается загрузчиком один раз при активации. */
export function definePlugin(apply: (synth: SynthPlugin) => void | Promise<void>): PluginModule;

export interface PluginModule { apply: (synth: SynthPlugin) => void | Promise<void>; }
```

Правило: **каждый `register()`/`on()` возвращает disposer** — ровно как `HookBus.on → off`. Загрузчик
накапливает disposers и при выключении/reload вызывает их **в обратном порядке** (обратная прокрутка),
гарантируя, что плагин не оставит за собой зарегистрированных тулов/хуков/роутов.

**Чего SDK НЕ выдаёт.** Фасад намеренно узкий — плагин **не получает**:
- прямой `FileStore`/`JsonStore`/`ProjectStore`/`SessionManager` (доступ к данным — только через свои
  точки и permission-слой; запись в `$SYNTH_DATA_DIR` мимо `FileStore` запрещена, [AD-005](./ad-005-json-storage.md));
- прямой `GatewayProvider`/`ProviderFactory` «в обход» (LLM-вызовы плагина, если он их делает, идут только
  через `GatewayProvider`, [AD-036](./ad-036-llm-gateway.md));
- `PermissionEvaluator` (нельзя «одобрить» тул в обход permission-слоя, [AD-025](./ad-025-plan-act-toggle.md)/[AD-028](./ad-028-plan-build-strictness.md)/[AD-029](./ad-029-granular-permissions.md));
- произвольный доступ к реестрам ядра и внутренним модулям (`engine/*`, `server/*`) — только объявленные
  методы фасада.

## 5. Установка (install)

Раскладка (home-модель [AD-079](./ad-079-local-home-independent-instances.md); без home — `{dataDir}/plugin/`):

```
<home>/plugin/
├── installed/
│   └── <name>@<version>/          # распакованный self-contained бандл + манифест
│       ├── package.json           # с полем synth
│       ├── dist/index.js          # бандл (все зависимости внутри, @itphx/* — external)
│       └── PLUGIN_INTEGRITY.json   # {sha256, source, fetched_at}
├── plugins.lock.json               # провенанс (источник истины для update/uninstall)
└── plugins.json                    # runtime-override включения/настроек (см. §6)
```

**Источники установки:**

| Источник | Описание | Trust-дефолт |
|---|---|---|
| `npm` | опубликованный пакет (pull бандла; **не** резолвит зависимости) | по записи/источнику ([AD-068](./ad-068-skills-agents-registry.md)) |
| `local` | локальный каталог/бандл | `community` |
| `builtin` | в составе поставки Synth (management/core-плагины) | `builtin` |
| `catalog` | каталог плагинов [AD-068](./ad-068-skills-agents-registry.md) (индекс, провенанс, подписи) | по trust-уровню записи |

**Integrity:** sha256 содержимого бандла фиксируется при install (`PLUGIN_INTEGRITY.json` + запись в
`plugins.lock.json`); на активации хеш перепроверяется. Несовпадение — отказ.

**Lock — источник истины.** `plugins.lock.json` хранит на плагин: `{name, version, source, identifier,
trust_level, scan_verdict, content_hash, ref, entry, installed_at, updated_at}` — update/uninstall идут
только по записи lock (pin обязателен, §15). **CLI:**

```
synth plugin install <id> [--ref <sha|tag>] [--force]
synth plugin enable <name>
synth plugin disable <name>
synth plugin list
synth plugin inspect <name>          # манифест, trust, scan, hash, contributes
synth plugin update [<name>]         # по pinned ref/hash; явно
synth plugin remove <name>
```

## 6. Активация (activate) и жизненный цикл

**Включение:** `plugins.json` (runtime-override, как settings-снапшоты) + `config.plugins[]` (дефолты из
config/Helm). Эффективный набор = merge (runtime > config > дефолт); мастер-флаг `plugins.enabled` —
глобальный выключатель.

**Пайплайн `PluginHost`** (активация одного плагина):

1. **resolve** — найти установленный бандл + манифест (по `plugins.lock.json`).
2. **integrity** — сверить sha256 с lock/`PLUGIN_INTEGRITY.json`.
3. **semver-гейт** — `synth.apiVersion` совместим и `synth.host` покрывает текущую версию Synth; иначе —
   отказ с причиной `plugin.host_incompatible`. Файл **exact-исключений** (аналог peer-gate) позволяет
   точечно разрешить конкретную пару `plugin@version ↔ host@version` (формат — открытый вопрос, §16).
4. **trust/scan** — trust-резолвинг и статический сканер ([AD-068](./ad-068-skills-agents-registry.md));
   вердикт → install-policy (default-политика плагинов, §10).
5. **политика режима** — standalone/hybrid/managed решают, **можно ли** активировать (§7–§9); в managed/
   hybrid — allow-list/ADMIN.
6. **import** — динамический `import()` ESM-бандла в процессе core.
7. **facade** — `definePlugin(apply)` вызывается с фасадом `SynthPlugin`; плагин регистрирует вклады,
   каждый возвращает disposer.
8. **сбор disposers** — накопление в порядке регистрации.
9. **аудит** — запись `plugin.activate` (кто, что, trust, scan, версия) в audit log ([AD-068](./ad-068-skills-agents-registry.md)).

**Выключение/reload** — **обратная прокрутка**: вызвать все disposers в обратном порядке (снять тулы/хуки/
роуты), затем аудит `plugin.deactivate`. Ошибка disposer не прерывает остальные (изолируется, логируется).

**Hot-reload vs restart.** В standalone допустим hot-reload (deactivate → integrity/scan → activate).
В **managed безопаснее restart** процесса/пода: активация на старте, выключение — деплоем/рестартом, без
смены кода в живом процессе (интеграция с [AD-082](./ad-082-full-images-deployment.md)/[AD-077](./ad-077-runtime-toolchain.md)).

## 7. Матрица режимов

| Режим | Declarative | Plugin | Add-on | Кто ставит плагин | Сила энфорса |
|---|---|---|---|---|---|
| **standalone** | ✅ | ✅ | ✅ | владелец инстанса | плагин — локальный процесс владельца; full trust-контроль локально |
| **hybrid** | ✅ | ✅ (allow-list сервера для серверного контура; локальный — по политике) | ✅ | владелец локально + allow-list сервера | серверный трафик — 🟢; локальный плагин — 🔴 кооперативно (§9) |
| **managed** | ✅ | ✅ (deploy-time default; runtime-install — опция `deny` default) | ✅ | **ADMIN** | deploy-time — 🟢 (бандл в образе/PVC); runtime-install — только ADMIN + allow-политика |

## 8. Managed: deploy-time и runtime-install

Два способа поставить плагин в managed:

**(a) deploy-time — дефолт.** Плагины перечислены в Helm-values/config, бандлы — в образе (flavor [AD-082](./ad-082-full-images-deployment.md)) или на PVC. Активация — на старте; смена набора — деплоем.
Это рекомендуемый путь: код плагина фиксирован вместе с деплоем, воспроизводим, аудируем.

**(b) runtime-install — опция, по умолчанию `deny`.** Установка через API при `plugins.runtimeInstall: allow`.
RBAC — **ADMIN**; запись под guarded `pluginsWriteGuard` (по образцу `eventsWriteGuard`/`decisionWriteGuard`,
[AD-089](./ad-089-external-events-automation.md)); каждая операция (install/enable/disable/update/remove) —
в аудит. Без явного `allow` runtime-install недоступен.

Ограничения managed:
- **Запрет снятия builtin/management-плагинов** — аналог `protectedModules`: плагины, помеченные `builtin`
  (в поставке) и management (нужные самому инстансу), нельзя disable/remove через API; только деплой.
- **Reload/restart** — в managed по умолчанию **restart** (не hot-reload живого процесса): безопаснее для
  контроля кода и воспроизводимости.
- **Плагин — инстанс-уровневый, не per-user.** Набор плагинов один на инстанс; per-user включения нет
  (в отличие от скиллов/scope). Доступность разделов/тулов конкретному пользователю — через RBAC/permissions,
  а не через «личные плагины».
- **Egress** — сетевые вызовы плагинов идут через единый egress-слой ([AD-088](./ad-088-http-proxy.md)).
- **Секреты** — плагин **не** читает `$SYNTH_DATA_DIR/secrets/*` напрямую; секреты выдаются через API
  (scoped, по запросу настроек плагина), at-rest — по модели [AD-076](./ad-076-git-repo-registry-ssh.md).

## 9. Hybrid: allow-list

В гибриде сервер и локальный core — два мира. Плагин должен явно объявлять, **какому миру он служит**
(локальные сессии vs серверные); «мостовой» плагин, ходящий в сервер, требует серверной авторизации.

**Три уровня силы.**

| Уровень | Что делает | Сила |
|---|---|---|
| **Уровень 1 — cooperative** | allow-list как политика соответствия: локальный core сам решает, какие плагины включать | 🔴 кооперативная (модифицированный клиент соврёт, [AD-073](./ad-073-client-integrity-hybrid.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md)) |
| **Уровень 2 — tokens (проектируем сразу)** | allow-list усиливается **server-scoped токенами**: плагин получает доступ к серверу только с `plugin_id`-scoped токеном; сервер применяет политику и отвергает несоответствия | 🟢 сильная граница для всего, что ходит на сервер |
| **Уровень 3 — attestation (будущее усиление)** | подписанный манифест плагина/аттестация бандла на сервере | 🟢 (усиление на будущее) |

**Форма политики** (сервер, источник истины):

```json
{
  "plugins": {
    "mode": "allowlist",
    "allowed": ["@itphx/synth-plugin-*", "@acme/synth-plugin-slack@^1"],
    "denied": ["@evil/*"],
    "byRole": { "ADMIN": ["*"], "USER": ["@itphx/*"] },
    "trustFloor": "trusted",
    "enforce": "tokens"
  }
}
```

Матчинг — **glob + semver + trust-floor + роль**: запись разрешена, если имя совпадает с `allowed`
(и не попадает в `denied`), версия удовлетворяет semver-выражению, trust ≥ `trustFloor` и роль вызывающего
допускает. `enforce: "cooperative"|"tokens"` выбирает Уровень 1/2.

**Discovery:** `GET /api/v2/settings/plugins` (auth) отдаёт эффективную политику; сигнал `plugins_allowed`
добавляется в `/auth/oidc-meta` (public, [AD-043](./ad-043-unified-identity-login.md)) — чтобы локальный core
решал, предлагать ли серверные плагины, без 401-циклов (по образцу `hybrid_allowed`, [AD-081](./ad-081-hybrid-policy-leak-protection.md)).

**Ось «кому служит плагин».** Локальный плагин, не ходящий на сервер, — 🔴 кооперативная политика (сервер
его не видит и не может проконтролировать). Плагин, ходящий на сервер, — под server-scoped токеном Уровня 2:
сервер проверяет `plugin_id`-scope и отвергает вне политики.

**Честная таблица силы энфорса:**

| Политика | Как энфорсится | Сила |
|---|---|---|
| server-scoped токен (`enforce: tokens`) | сервер проверяет `plugin_id`-scope на каждом вызове | 🟢 сильная |
| allow-list серверных плагинов | сервер выдаёт/не выдаёт токен и применяет политику | 🟢 сильная (для серверного трафика) |
| `denied` (сервер) | сервер отвергает токен/вызов | 🟢 сильная (для серверного трафика) |
| `mode: allowlist` (локальный плагин без сервера) | локальный core фильтрует включение | 🔴 кооперативная (модифицированный core соврёт) |
| `byRole` | claims IdP на сервере; локально — по данным пользователя | 🟢 сервер / 🔴 локально |

Правило: всё, что ходит на сервер, — настоящая граница (🟢); чисто локальный плагин — кооперативная
политика соответствия (🔴), в UI/доке подаётся именно так.

## 10. Политики и конфиг

Секция `plugins` ([AD-023](./ad-023-configuration.md), приоритет CLI > env > config.yaml > defaults):

| Ключ | Значение | Дефолт |
|---|---|---|
| `plugins.enabled` | глобальный мастер-выключатель Extension API | `true` (но без установленных плагинов ничего не активируется) |
| `plugins.runtimeInstall` | `allow`\|`deny` — runtime-установка через API (managed) | `deny` |
| `plugins.trustFloor` | минимальный trust для активации | `trusted` |
| `plugins.scan` | `enabled`\|`disabled` — статический сканер на активации | `enabled` |
| `plugins.allowlist` / `plugins.denylist` | глобальные списки имён (локальный режим) | `[]` |
| `plugins.remoteAllowlist` | серверный allow-list (hybrid, §9) | — |
| `plugins.exactHostExceptions` | файл точных исключений semver-гейта (§6) | пусто |

**Runtime-настройки:** `RuntimeSettingsStore.plugins` ([AD-005](./ad-005-json-storage.md), атомарно) +
**endpoints** `GET/PUT/DELETE /api/v2/settings/plugins` (по паттерну [AD-089](./ad-089-external-events-automation.md),
мутации — ADMIN в managed через `pluginsWriteGuard`, в core — `requireAuth`) и CRUD-эндпоинты
`GET/POST/DELETE /api/v2/plugins*` (§13).

## 11. Ограничения и возможности

**Плагин может:** регистрировать хуки/тулы/команды/роуты/провайдеры/настройки/источники событий через
фасад (§4); читать/писать свои настройки через SDK; логировать через scoped-логгер.

**Плагин не может ни при каких условиях:**
- обойти `PermissionEvaluator` ([AD-025](./ad-025-plan-act-toggle.md)/[AD-028](./ad-028-plan-build-strictness.md)/[AD-029](./ad-029-granular-permissions.md)) — доступ к тулам/ресурсам идёт только через permission-слой;
- обойти `GatewayProvider` ([AD-036](./ad-036-llm-gateway.md)) — любой LLM-вызов через gateway;
- обойти `FileStore` ([AD-005](./ad-005-json-storage.md)) — запись в `$SYNTH_DATA_DIR` мимо FileStore запрещена;
- снять/подменить **builtin**-обработчики и builtin/management-плагины (политика `builtin`, закрывает остаток
  [AD-030](./ad-030-hooks-agent-events.md); в managed — `protectedModules`);
- читать секреты в обход API (см. §8);
- выполнять runtime-резолв npm-зависимостей (bundle-only, §3).

**Квоты/лимиты:** число регистраций на плагин (тулы/хуки/роуты/источники) ограничено; таймауты на `apply`
и на async-обработчики (по образцу `HOOK_ASYNC_TIMEOUT_MS = 5000`, [AD-030](./ad-030-hooks-agent-events.md));
лимит на объём бандла и на число находок сканера. Точные значения — открытый вопрос (§16).

## 12. Связь с AD-068

Каталог [AD-068](./ad-068-skills-agents-registry.md) закладывается **сразу** как источник плагинов —
переиспользуется, а не изобретается заново:
- **trust-уровни** (`builtin → verified → trusted → community`) — для записей каталога плагинов;
- **install-policy** (матрица trust × verdict) — для установки/активации;
- **статический сканер** (категории, лимиты, невидимый unicode, кэш) — на активации плагина;
- **quarantine** — распаковка/скан до попадания в `installed/`;
- **`lock.json`**-модель → `plugins.lock.json` (провенанс, pin, откат);
- **audit log** — операции плагинов;
- **провенанс** (источник/identifier/ref/хеш) и подписи — для `verified`-плагинов.

Плагины **наследуют** trust/guard-модель контента; отдельной модели доверия AD-090 не вводит.

## 13. API / CLI / UI

| Операция | API | CLI | UI | Назначение |
|---|---|---|---|---|
| list | `GET /api/v2/plugins` | `synth plugin list` | Список | Установленные + статус активации |
| inspect | `GET /api/v2/plugins/:name` | `synth plugin inspect <name>` | Карточка | Манифест, trust, scan, hash, contributes |
| install | `POST /api/v2/plugins/install` | `synth plugin install <id> [--ref --force]` | Кнопка (ADMIN в managed) | pull → quarantine → scan → policy → `installed/` |
| enable | `POST /api/v2/plugins/:name/enable` | `synth plugin enable <name>` | Тумблер | Активация (§6) |
| disable | `POST /api/v2/plugins/:name/disable` | `synth plugin disable <name>` | Тумблер | Обратная прокрутка |
| update | `POST /api/v2/plugins/update` | `synth plugin update [<name>]` | Обновить | По pinned ref/hash; явно |
| remove | `DELETE /api/v2/plugins/:name` | `synth plugin remove <name>` | Удалить | По записи lock |
| policy | `GET/PUT/DELETE /api/v2/settings/plugins` | `synth config` | Секция настроек (ADMIN) | Политика/дефолты (§9–§10) |

Карточка плагина в UI обязана показывать: **trust-уровень**, **источник**, **content hash**, версию,
`apiVersion`/`host`, вердикт сканера, перечень `contributes`. RBAC: list/inspect — `requireAuth`;
install/enable/disable/update/remove/policy — ADMIN (managed) / владелец (standalone). UI-объём —
открытый вопрос (§16).

## 14. Фазы реализации

- **Ф0 — предпосылки.** Остаток [AD-030](./ad-030-hooks-agent-events.md): политика `builtin` (защита
  builtin-обработчиков от снятия) и недостающие эмиты (`plan_rejected`, `message_received`, `callback`,
  `schedule_fired`); конфиг включённых плагинов ([AD-023](./ad-023-configuration.md)). Кода плагинов ещё нет.
- **Ф1 — манифест + `PluginHost` + trust/scan.** Схема манифеста, `PluginHost`-пайплайн (§6), integrity,
  semver-гейт, trust/scan ([AD-068](./ad-068-skills-agents-registry.md)). **Исполнение кода выключено по
  умолчанию** — только резолв/integrity/гейт/скан/аудит, без `import()`.
- **Ф2 — install/activate CLI/API + managed deploy-time.** Раскладка `<home>/plugin/`, `plugins.lock.json`,
  `plugins.json`, установка из `local`/`npm`/`builtin`, CLI/API (§13), активация (фактический `import()`),
  managed deploy-time (бандлы в образе/PVC, [AD-082](./ad-082-full-images-deployment.md)).
- **Ф3 — hybrid allow-list + scoped-токены.** Уровни 1/2 (§9), форма политики, discovery
  (`/settings/plugins` + `/auth/oidc-meta`), server-scoped токены на `plugin_id`.
- **Ф4 — managed runtime-install.** `plugins.runtimeInstall: allow`, `pluginsWriteGuard`, аудит, запрет снятия
  builtin/management-плагинов, restart-модель.
- **Ф5 — UI.** Список/карточка/тумблеры, секция настроек, статус сканера/trust (объём — §16).

## 15. Что НЕ делаем

- **Runtime npm-резолв** — bundle-only: загрузчик не ходит за зависимостями (§3).
- **pnpm-в-рантайме** как основной механизм установки плагинов — нет.
- **In-process без trust/scan** — не активируем код мимо trust/скана/install-policy.
- **Снятие builtin** — builtin-обработчики и builtin/management-плагины защищены.
- **Авто-установка без явного действия** — установка только явной операцией владельца/ADMIN.
- **«Всегда latest»** — pin обязателен (`ref`/`content_hash`), update — явно.
- **Доверие по звёздам** — звёзды не критерий (как [AD-068](./ad-068-skills-agents-registry.md)).
- **Add-on как «плагин»** — смешение классов запрещено (§1).

## 16. Открытые вопросы

1. **Hot-reload vs restart в managed** — где граница: всегда restart или отдельные плагины допускают reload?
2. **Лимиты квот** — число регистраций, таймауты `apply`, объём бандла, лимит находок сканера.
3. **Формат файла exact-исключений** semver-гейта (`plugins.exactHostExceptions`).
4. **Кто владеет каталогом плагинов** — CI каталога [AD-068](./ad-068-skills-agents-registry.md) или отдельный
   репозиторий; ключ подписи и ротация.
5. **UI-объём Ф5** — что показываем в карточке/секции, где ставим тумблеры.
6. **Scoped-токены Уровня 2** — точная механика выдачи/валидации `plugin_id`-scope (взаимосвязь с
   [AD-052](./ad-052-public-api-platform.md): service-key/scopes реализованы — этап I; остаётся
   `plugin_id`-scope поверх).
7. **Эмиты остатка [AD-030](./ad-030-hooks-agent-events.md)** — порядок и приоритет доделки недостающих хуков.

## Последствия

**Плюсы:** расширять Synth без форка ядра; единая контент-платформа с trust/guard ([AD-068](./ad-068-skills-agents-registry.md));
11 из 12 точек уже имеют seam — дешёвый вход; add-on как основной безопасный путь; плагины во всех режимах
с понятной моделью «кто ставит + политика + сила энфорса»; воспроизводимость (bundle-only + pin + lock).

**Минусы/риски:** in-process код — доверенный после trust/скана (компромисса «полная изоляция» не даём);
hot-reload в managed рискован (отсюда restart-модель); серверный allow-list для чисто локальных плагинов —
кооперативен; зависимость от [AD-068](./ad-068-skills-agents-registry.md) и остатка [AD-052](./ad-052-public-api-platform.md);
UI-slot отложен — часть расширений (панели) пока недоступна.

**Связи:**

- [AD-086](./ad-086-extensibility-plugins-editions.md) — зонтик расширяемости; AD-090 — вынесенный детальный Extension API.
- [AD-030](./ad-030-hooks-agent-events.md) — hook-шина: фундамент точки `hooks`; остаток (политика `builtin`, эмиты) — предпосылка Ф0.
- [AD-038](./ad-038-npm-packages.md) — npm-пакеты: `@itphx/synth-plugin` и распространение плагинов.
- [AD-046](./ad-046-skills-and-slash-commands.md) — скиллы/команды: точки `skills`/`commands`.
- [AD-068](./ad-068-skills-agents-registry.md) — trust/scan/install-policy/quarantine/lock/audit: переиспользуемая инфраструктура.
- [AD-071](./ad-071-mcp-servers-prompt.md) — MCP-серверы: точка `mcp`; разделение слоёв `tools`/`mcp.tools`.
- [AD-089](./ad-089-external-events-automation.md) — внешние события: точка `events`; паттерн settings-API.
- [AD-023](./ad-023-configuration.md) — конфиг: секция `plugins.*`.
- [AD-025](./ad-025-plan-act-toggle.md)/[AD-028](./ad-028-plan-build-strictness.md)/[AD-029](./ad-029-granular-permissions.md) — permissions: плагин не обходит permission-слой.
- [AD-036](./ad-036-llm-gateway.md) — Gateway: любой LLM-вызов плагина — через него.
- [AD-042](./ad-042-hybrid-mode.md)/[AD-073](./ad-073-client-integrity-hybrid.md)/[AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md) — гибрид/политики: allow-list, честная сила энфорса, недоверенный клиент.
- [AD-052](./ad-052-public-api-platform.md) — service-key/scopes: основа server-scoped токенов Уровня 2.
- [AD-082](./ad-082-full-images-deployment.md) — flavor-образы: бандлы плагинов в образе (managed deploy-time).
- [AD-077](./ad-077-runtime-toolchain.md) — executor/toolchain: размещение и запуск в managed.
- [AD-088](./ad-088-http-proxy.md) — egress: сетевые вызовы плагинов.
