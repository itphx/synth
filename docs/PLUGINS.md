# Плагины Synth: руководство автора

> **Назначение:** практический путь «от нуля до работающего плагина» — что такое плагин, как
> устроен бандл и манифест, как работают три точки расширения, как установить, проверить и
> опубликовать расширение.
> **Аудитория:** автор плагина (внешний разработчик или разработчик Synth, пишущий расширение).
> **Канон:** [ADR-090](./arch_decisions/adr-090-extension-api.md) (Extension API v1) — модель
> доверия, манифест, wire-протокол, установка/обновление, RBAC. Здесь — то же самое, но со стороны
> автора: без внутренних обоснований, с проверяемыми примерами.
> **Статус:** слой плагинов принят как решение (ADR-090, фазы Ф0–Ф7 и долги Д1–Д3). Исполнение кода
> плагинов **выключено по умолчанию** (`plugins.executionEnabled: false`) — это осознанный дефолт,
> а не «плагины не работают».
> **Смежные документы:** HTTP-контур — [API_V2.md](./API_V2.md) §5.36; эксплуатация —
> [MAINTENANCE.md](./MAINTENANCE.md) §«Плагины»; ключи конфигурации — [CONFIGURATION.md](./CONFIGURATION.md)
> §«Плагины (`plugins.*`)»; пайплайны и пакеты расширений — [PIPELINES.md](./PIPELINES.md).

---

## Содержание

1. [Что такое плагин](#1-что-такое-плагин)
2. [Быстрый старт](#2-быстрый-старт)
3. [Справочник манифеста `synth.pack`](#3-справочник-манифеста-synthpack)
4. [Точки расширения](#4-точки-расширения)
5. [Два режима исполнения](#5-два-режима-исполнения)
6. [Правила пакета (bundle-only)](#6-правила-пакета-bundle-only)
7. [Доверие и install-policy](#7-доверие-и-install-policy)
8. [Тестирование плагина](#8-тестирование-плагина)
9. [Установка и обновление](#9-установка-и-обновление)
10. [Плагин в гибридном режиме](#10-плагин-в-гибридном-режиме)
11. [Версионирование контракта](#11-версионирование-контракта)
12. [Справочник ошибок](#12-справочник-ошибок)
13. [Публикация](#13-публикация)
14. [Чек-лист автора](#14-чек-лист-автора)

---

## 1. Что такое плагин

**Плагин** — код, который исполняет сам Synth и который встраивается в три готовых шва ядра:

| Точка | Что даёт плагин | Где применяется | Что видит плагин |
|---|---|---|---|
| `promptBlocks` | блок системного промпта | сборка промпта (каждый ход) | узкий контекст хода: сессия, агент, язык, проект, режим, текст вопроса |
| `llmFilters` | фильтр LLM-вызовов | LLM-шлюз (`pre_request` / `post_response` / `embedding`) | запрос/ответ/тексты эмбеддинга |
| `tools` | инструмент для модели | цикл Tool Use, permission-слой | аргументы вызова и идентификаторы хода |

Это **не** рантайм и не «свой агент»: плагин не заводит новых циклов, не выбирает модель и не
переписывает ролевые промпты. Он добавляет ровно три вида вкладов — и они попадают в существующие
подсистемы (`SystemPromptComposer`, `GatewayProvider`, `ToolRegistry`).

### 1.1. Что плагин может

- добавить блок в системный промпт (тиры `context`/`volatile`), в том числе с retrieval по
  текущему вопросу;
- наблюдать LLM-вызовы и — при достаточном доверии — блокировать их (`pre_request`, `embedding`)
  или маскировать тексты эмбеддинга;
- зарегистрировать инструмент, который модель видит наравне со встроенными (но под своим
  namespace и через permission-слой).

### 1.2. Что плагин не может

| Ограничение | Почему |
|---|---|
| изменить модель, ролевой промпт или шаблоны промптов | это не вклад точки расширения; выбор модели — настройка сессии/инстанса |
| обойти permission-слой (`plan`/`act`/`yolo`, `allow`/`deny`/`ask`) | [ADR-025](./arch_decisions/adr-025-plan-act-toggle.md)/[ADR-029](./arch_decisions/adr-029-granular-permissions.md); тул плагина — обычный тул с capabilities |
| обойти LLM-шлюз, его guard'ы, rate-limit и аудит | [ADR-036](./arch_decisions/adr-036-llm-gateway.md) |
| читать файлы/секреты «напрямую» в обход разрешений и API | секреты плагину не выдаются; ФС — только через инструменты и permission-слой |
| писать в `$SYNTH_DATA_DIR` мимо слоя хранения | [ADR-096](./arch_decisions/adr-096-storage-layer.md) |
| снять/подменить builtin-обработчики, builtin/management-плагины | политика `builtin` в `HookBus`, `plugin.managed_readonly` |
| добавить свои метрики/лейблы | контракт наблюдаемости [ADR-094](./arch_decisions/adr-094-observability-metrics.md) |
| заявить доверие выше фактического | доверие резолвит источник (реестр/CLI/deploy), а не манифест |
| подтянуть npm-зависимости в рантайме | bundle-only: `node_modules` и `npm install` не появляются |

### 1.3. Границы доверия

`inline`-плагин исполняется **в процессе core**: технически он видит Node API процесса. Изоляции
нет — границей служат доверие, статический скан, install-policy и trust-floor (§7). Если это
неприемлемо для вашего сценария, используйте `out-of-process` (§5): там через границу идут только
сериализуемые DTO.

> **Важно про доступные точки.** В Extension API v1 фасадом доступны **только** `promptBlocks`,
> `llmFilters` и `tools`. Остальные точки из таблицы ADR-090 (hooks, providers,
> routes, commands, skills, agents, mcp, events, schedules, settings, UI-slot) в v1 **не
> экспонируются** — на них нельзя зарегистрироваться из плагина.

---

## 2. Быстрый старт

### 2.1. Требования

- Synth версии, попадающей в `host` манифеста (в примере — `>=0.11.0 <0.13.0`);
- Node.js 20+ для сборки бандла;
- ESM-бандл (CommonJS и TypeScript-исходники не загружаются: точка входа — `.js`/`.mjs`).

### 2.2. Каталог бандла

```text
my-plugin/
├── synth.pack          # манифест (kind: plugin)
├── package.json        # обычный npm-манифест (не канонический манифест расширения)
├── src/index.ts        # исходник
└── dist/index.js       # собранный ESM-бандл (его грузит Synth)
```

`package.json` — только для сборки; Synth читает **`synth.pack`**.

### 2.3. Манифест `synth.pack` (полный пример)

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "kind": "plugin",
  "description": "Пример плагина: блок заметок, DLP-фильтр запросов и инструмент поиска по заметкам",
  "host": ">=0.11.0 <0.13.0",
  "contracts": {
    "extensionApi": "^1",
    "promptBlocks": "^1",
    "llmFilters": "^1"
  },
  "mode": "inline",
  "provides": {
    "tools": ["notes_search"],
    "promptBlocks": [
      {
        "key": "plugin.my-plugin.notes",
        "tier": "context",
        "order": 120,
        "title": "Заметки проекта"
      }
    ],
    "llmFilters": [
      {
        "id": "plugin:my-plugin:dlp",
        "phase": "pre_request",
        "failMode": "closed",
        "timeoutMs": 200
      }
    ]
  },
  "permissions": { "network": [], "secrets": [], "tools": [], "hooks": [] },
  "trust": { "level": "community", "source": "local" }
}
```

Минимум для активации: `name`, `version`, `kind: "plugin"`, `description`, `provides` хотя бы с
одним вкладом. `host` и `contracts` настоятельно рекомендуются: без них семвер-гейт не проверяет
совместимость, и плагин может «тихо» активироваться на несовместимом хосте.

### 2.4. Код плагина (полный пример)

```typescript
// src/index.ts
import { z } from 'zod';
import type { LlmCallFilter, PromptBlockProvider } from '@itphx/synth-shared';
import type { PluginFacade } from '@itphx/synth-core';

/** Локальный справочник плагина (в реальном плагине — ваш источник данных). */
const NOTES: Record<string, string> = {
  'релиз': 'Релиз 0.12.0: слой плагинов закрыт (Ф0–Ф6).',
  'шифрование': 'Секреты at-rest — AES-256-GCM, мастер-ключ в secrets/master.key.',
};

/** Точка `promptBlocks`: блок контекста, зависит от вопроса хода. */
const notesBlock: PromptBlockProvider = {
  key: 'plugin.my-plugin.notes',
  tier: 'context',
  order: 120,
  title: 'Заметки проекта',
  load(ctx) {
    const query = ctx.query?.trim().toLowerCase();
    if (!query) return null; // вопроса хода нет (саб-агент/шаг пайплайна) — блок пуст
    const hit = Object.entries(NOTES).find(([topic]) => query.includes(topic));
    return hit ? `Заметка по теме «${hit[0]}»: ${hit[1]}` : null;
  },
};

/** Точка `tools`: инструмент для модели (локальное имя — без namespace). */
const searchTool: Parameters<PluginFacade['registerTool']>[0] = {
  name: 'notes_search',
  description: 'Ищет заметку по ключевому слову в локальном справочнике плагина.',
  // `parameters` — zod-схема: по ней хост валидирует аргументы перед вызовом.
  parameters: z.object({ query: z.string().min(1) }),
  // `jsonSchema` — то, что увидит модель. Задаём явно: схема конвертируется
  // хостом, а ваша копия zod может быть другой версии (см. §4.3).
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Ключевое слово' },
    },
    required: ['query'],
  },
  capabilities: ['search'],
  async execute(params) {
    // Аргументы уже прошли валидацию по `parameters`; приводим тип явно.
    const { query } = params as { query: string };
    const q = query.toLowerCase();
    const rows = Object.entries(NOTES).filter(
      ([topic, text]) => topic.includes(q) || text.toLowerCase().includes(q),
    );
    if (rows.length === 0) return { content: `Ничего не найдено по «${query}».` };
    return { content: rows.map(([topic, text]) => `- ${topic}: ${text}`).join('\n') };
  },
};

/** Точка `llmFilters`: DLP-проверка запроса. Вето — только при trust ≥ `trusted`. */
const dlpFilter: LlmCallFilter = {
  id: 'plugin:my-plugin:dlp',
  phase: 'pre_request',
  failMode: 'closed',
  timeoutMs: 200,
  inspect(input) {
    const text = [
      input.systemPrompt ?? '',
      ...(input.messages ?? []).map((message) => message.content),
    ].join('\n');
    if (/AKIA[0-9A-Z]{16}/.test(text)) {
      return { verdict: 'deny', code: 'aws_key', reason: 'в запросе найден AWS access key' };
    }
    return { verdict: 'allow' };
  },
};

/** Точка входа: хост вызывает `apply(facade)` после `import()`. */
export function apply(facade: PluginFacade): void {
  facade.registerPromptBlock(notesBlock);
  facade.registerLlmFilter(dlpFilter);
  facade.registerTool(searchTool);
}
```

`package.json` для сборки:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "@itphx/synth-shared": "^0.12.0",
    "@itphx/synth-core": "^0.12.0"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0",
    "zod": "^3.24.0"
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/index.js"
  }
}
```

Оба `@itphx/*` здесь — **только для типов** (`import type`): такие импорты стираются при сборке,
поэтому в бандле не остаётся ни одного обращения к пакетам хоста. `zod` вшивается в бандл — это
нормально и соответствует bundle-only (§6).

### 2.5. Установка и активация

```bash
# 1. Сухой прогон: манифест + вердикт сканера + находки + content-hash (ничего не пишет)
synth plugin scan ./my-plugin

# 2. Установка. trust по умолчанию `community`, а trust-floor инстанса — `trusted`,
#    поэтому локальный плагин ставится с явным --trust trusted.
synth plugin install ./my-plugin --trust trusted

# 3. Проверка пайплайна активации в одноразовом процессе CLI
synth plugin enable my-plugin

# 4. Список установленного и статус активации
synth plugin list
```

Два важных уточнения, которые экономят час отладки:

- **CLI — офлайн-инструмент.** `install` пишет файлы инстанса и `plugins.lock.json`, но не
  переключает живой процесс; `enable`/`disable` проверяют пайплайн активации в процессе CLI и
  **тоже не переключают** работающий инстанс (инвариант 24). Изменения применяются после
  перезапуска инстанса (`./scripts/dev.sh`, `synth serve`, рестарт пода).
- **Исполнение кода должно быть включено.** Пока `plugins.executionEnabled: false` (дефолт),
  активация останавливается на шаге `import` с кодом `plugin.execution_disabled`. Включите ключ в
  `config.yaml` (или `PUT /api/v2/settings/plugins`) **и перезапустите** инстанс.

Для **живого** инстанса активация выполняется по HTTP/UI: `POST /api/v2/plugins/:name/enable`
(или тумблер «Включить» в админ-разделе «Плагины»). Установка через API — это runtime-установка:
она требует `plugins.runtimeInstall: allow` (дефолт `deny`) и роли `ADMIN`.

### 2.6. Проверка результата

1. **Блок в промпте.** Откройте сессию, отправьте сообщение со словом «релиз» и запросите состав
   промпта:

   ```bash
   curl -s http://localhost:5000/api/v2/sessions/<sessionId>/prompt \
     -H 'Authorization: Bearer admin-key-123' | jq '.manifest.entries[] | select(.key=="plugin.my-plugin.notes")'
   ```

   Ожидаемо: запись с `tier: "context"`, `source: "system"`, `provenance: "plugin:my-plugin"`,
   `status: "loaded"` (или `"empty"`, если в вопросе нет темы из справочника).

2. **Инструмент.** В том же ходе попросите агента: «найди заметку про релиз инструментом
   `plugin_my_plugin_notes_search`». Полное имя — `plugin_<namespace>_<локальное имя>`, namespace
   строится из имени плагина (`my-plugin` → `my_plugin`); в `provides.tools[]` объявляется
   **локальное** имя (`notes_search`).

3. **Фильтр.** В запросе появится тестовый AWS-ключ — вызов должен быть отклонён. Помните: вето
   работает только для плагина с фактическим trust ≥ `trusted` **и** при включённом LLM-шлюзе
   (`llmGateway.enabled: true`). Для `community`-плагина `deny` будет понижен до `allow`
   (в журнале — `plugin_filter.deny_downgraded`).

4. **Статус и журнал.** `GET /api/v2/plugins` (или раздел «Плагины») показывает версию, режим,
   доверие, вердикт скана, content-hash и активность; журнал операций —
   `{dataDir}/audit/plugins.jsonl`.

---

## 3. Справочник манифеста `synth.pack`

`synth.pack` — JSON в корне бандла. Разбор: `packManifestSchema` + `validatePackManifest`
(`packages/shared/src/types/pack.ts`). Схема **строгая** там, где это важно: у
`provides.promptBlocks[]`/`provides.llmFilters[]` неизвестное поле — ошибка, а не молчаливый проход.

| Поле | Обяз. | Что это | Правила |
|---|---|---|---|
| `name` | да | имя плагина | slug (`my-plugin`) или npm-имя со scope (`@acme/synth-plugin-x`); строчные латинские буквы/цифры, разделитель — `-`; ≤ 214 символов. Из него строится namespace тулов |
| `version` | да | версия плагина | semver `MAJOR.MINOR.PATCH` (+ пре-релиз/сборка) |
| `kind` | да | класс расширения | для плагина — строго `"plugin"` |
| `description` | да | краткое описание | непустая строка; видна в инспекции/каталоге |
| `host` | нет | диапазон версий Synth | semver-range, конъюнкция через пробел (`>=0.11.0 <0.13.0`); `\|\|` не поддерживается. Несовпадение — `plugin.host_mismatch` |
| `contracts` | нет | версии контрактов | значения — semver-range. **Проверяется только `contracts.extensionApi`** (мажор контракта хоста; сейчас `1`, хост объявляет `1.0.0`). Ключи `promptBlocks`/`llmFilters`/`tools` — декларация для читателя и будущих проверок. Расхождение мажора — `plugin.contract_mismatch` |
| `mode` | нет | режим исполнения | `inline` \| `remote` \| `both`; по умолчанию `inline`. Поле допустимо только для `kind: "plugin"` |
| `provides` | да | объявленные вклады | см. ниже; пустой `provides` — невалидный манифест |
| `permissions` | нет | заявленные доступы | `{ network: string[], secrets: string[], tools: string[], hooks: string[] }`. Это **заявление**, не разрешение: фактический доступ решают permission-слой и egress-политика |
| `trust` | нет | заявленный уровень/источник | `{ level?: 'builtin'\|'verified'\|'trusted'\|'community', source?: string }`. Верхняя граница, не повышение: фактический уровень резолвит источник. У плагина `level` выше `trusted` (`builtin`/`verified`) — **ошибка манифеста**; допустимы `trusted` и `community` |

### 3.1. `provides` — что именно проверяется

```json
"provides": {
  "tools": ["notes_search"],
  "promptBlocks": [{ "key": "plugin.my-plugin.notes", "tier": "context", "order": 120, "title": "Заметки проекта" }],
  "llmFilters": [{ "id": "plugin:my-plugin:dlp", "phase": "pre_request", "failMode": "closed", "timeoutMs": 200 }]
}
```

| Ключ | Форма | Правила |
|---|---|---|
| `tools[]` | массив строк | непустые, без дублей; **локальные** имена (без `plugin_`-префикса) |
| `promptBlocks[]` | `{ key, tier, order, title?, provenance? }` | `tier` — только `context`/`volatile`; `stable` невалиден; `key` уникален в массиве; `order` — целое; лишние поля запрещены |
| `llmFilters[]` | `{ id, phase, failMode?, timeoutMs? }` | `phase` — `pre_request`/`post_response`/`embedding`; `timeoutMs` — положительное целое; лишние поля запрещены |

Ключи `mcp`/`skills`/`agents`/`pipelines` у плагина обычно пустые: они относятся к другим классам
расширений. Если плагин объявляет `tools`/`promptBlocks`/`llmFilters`, **фактические регистрации
обязаны совпасть с объявлением поимённо** — иначе активация отклоняется с
`plugin.provides_mismatch` (§4.4).

> **Пустой `provides` невалиден.** Плагин без единого вклада не установится: `validatePackManifest`
> требует хотя бы один элемент.

---

## 4. Точки расширения

Контракт всех трёх точек живёт в `@itphx/synth-shared` (browser-safe: только типы и чистые
функции). Фасад — `PluginFacade` из `@itphx/synth-core`; при активации хост вызывает `apply(facade)`.

```typescript
export type PluginDisposer = () => void | Promise<void>;

export interface PluginFacade {
  registerDisposer(disposer: PluginDisposer): void;
  registerPromptBlock(provider: PromptBlockProvider, opts?: { title?: string }): PluginDisposer;
  registerLlmFilter(filter: LlmCallFilter, opts?: { failMode?: 'open' | 'closed'; timeoutMs?: number }): PluginDisposer;
  registerTool(def: PluginToolDefinition): PluginDisposer;
}
```

Каждая регистрация возвращает **disposer** — обратную операцию. При деактивации хост вызывает
disposers **в обратном порядке регистрации**; ошибка одного не прерывает остальные. `disposer`
идемпотентен — повторный вызов ничего не делает.

Отказ регистрации (занятый ключ, тир `stable`, зарезервированная capability) **не роняет
активацию**: хост пишет предупреждение и возвращает no-op disposer. Но если такой вклад был
объявлен в `provides`, сверка превратит это в отказ активации.

### 4.1. `promptBlocks` — блок системного промпта

```typescript
export const PROMPT_BLOCK_PROVIDER_TIERS = ['context', 'volatile'] as const;

export interface PromptBlockProvider {
  readonly key: string;
  readonly tier: 'context' | 'volatile';
  readonly order: number;
  readonly title?: string;
  load(ctx: PromptBlockContext): Promise<PromptBlockContent | string | null> | PromptBlockContent | string | null;
}

export interface PromptBlockContext {
  readonly sessionId: string;
  readonly agentRole: string;
  readonly language: string;
  readonly projectId?: string;
  readonly mode: 'plan' | 'act' | 'yolo';
  readonly query?: string;   // текст последнего сообщения пользователя
  readonly turnId?: string;  // идентификатор хода
  readonly timestamp?: string;
}
```

**Куда попадает блок.** `SystemPromptComposer` обходит провайдеров при сборке промпта и кладёт их
блоки в **тот же** массив, что и встроенные: одна сортировка (тир → `order`), одна склейка, один
манифест. В манифесте (`GET /api/v2/sessions/:id/prompt`) запись выглядит как
`{ key, tier, order, source: "system", provenance: "plugin:<name>", status }`.

**Правила и ограничения.**

| Правило | Детали |
|---|---|
| Тир `stable` запрещён | `stablePrefix` — граница prompt-cache ([ADR-070](./arch_decisions/adr-070-system-prompt-composer.md)); регистрация с `stable` отклоняется, тихого понижения до `context` нет |
| Ключ уникален в инстансе | рекомендуемая форма — `plugin.<pluginName>.<slot>`; занятый ключ → отказ регистрации |
| `order` | число внутри тира; для плагинов рекомендуется `order ≥ 100`, чтобы не спорить со встроенными блоками (они занимают 5–90) |
| `provenance` | хост подставляет `plugin:<name>` автоматически; можно переопределить в возвращаемом объекте |
| Бюджет символов | `plugins.promptBlockMaxChars` (дефолт 4 000). Не уложились — **хост** обрежет блок (голова + хвост с маркером `[TRUNCATED: …]`) и поставит `status: "truncated"` |
| Деградация | исключение из `load()` → `warning` в лог, блок пуст, **ход не падает** |
| Нет вопроса хода | `query` не задан у саб-агента `task` и у шага пайплайна; блок `volatile` в этом случае логично делать пустым (хост этого не требует) |
| Override промпта | если у сессии задан `settings.systemPrompt`, блоки плагинов **не добавляются** (пользовательский промпт заменяет всё) |
| Саб-агент `task` | известное ограничение: промпт саб-агента собирается мимо Composer, блок плагина туда не попадёт |
| Шаг пайплайна | идёт через Composer, но с суженным контекстом: `sessionId` = `pipeline:<runId>:<nodeId>`, `query`/`turnId`/`timestamp` не заполняются |

**Пример: блок с retrieval по вопросу хода.**

```typescript
import type { PromptBlockProvider } from '@itphx/synth-shared';

const provider: PromptBlockProvider = {
  key: 'plugin.my-plugin.facts',
  tier: 'volatile',           // меняется каждый ход
  order: 110,
  title: 'Факты по вопросу',
  async load(ctx) {
    if (!ctx.query) return { content: '', status: 'empty' };
    const facts = await searchFacts(ctx.query, { projectId: ctx.projectId });
    if (facts.length === 0) return null;           // пустой блок
    const text = facts.map((f) => `- ${f.text}`).join('\n');
    return { content: text, status: 'loaded' };     // длиннее бюджета — обрежет хост
  },
};
```

`searchFacts` — ваш код: сеть только через разрешённые хосты (`permissions.network` + egress-политика
инстанса, [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)), секреты — не из файлов, а через
API инстанса.

### 4.2. `llmFilters` — фильтр LLM-вызовов

```typescript
export const LLM_FILTER_PHASES = ['pre_request', 'post_response', 'embedding'] as const;

export interface LlmCallFilter {
  readonly id: string;
  readonly phase: 'pre_request' | 'post_response' | 'embedding';
  readonly failMode?: 'open' | 'closed';
  readonly timeoutMs?: number;
  inspect(input: LlmFilterInput): Promise<LlmFilterVerdict> | LlmFilterVerdict;
}

export interface LlmFilterVerdict {
  readonly verdict: 'allow' | 'deny' | 'redact';
  readonly reason?: string;
  readonly code?: string;
  readonly redactedContent?: string;   // только `redact` в post_response (в v1 не поддерживается)
  readonly redactedTexts?: readonly string[]; // только `redact` в embedding
}
```

**Что видит фильтр.**

| Фаза | Данные | Влияние на вызов |
|---|---|---|
| `pre_request` | `messages` (**вся история сессии**), `systemPrompt`, `tools`, `provider`, `model`, `sessionId` | `deny` доверенного фильтра — вызов не уходит провайдеру; `redact` **не поддерживается** (хост фиксирует `plugin_filter.redact_unsupported` и продолжает) |
| `post_response` | полный текст ответа (`content`), `usage` | только наблюдение: `deny`/`redact` отклоняются хостом (`plugin_filter.buffering_required`) — буферизация ответа запрещена [ADR-036](./arch_decisions/adr-036-llm-gateway.md) |
| `embedding` | `texts` (массив) | `deny` — эмбеддинг не уходит; `redact` — тексты заменяются на `redactedTexts` (длина массива обязана совпасть, иначе fail-closed `deny`) |

**Текст уже обфусцирован.** `pre_request` вызывается **после** карты обфускации: фильтр видит
запрос в том виде, в котором он пойдёт провайдеру (секреты заменены плейсхолдерами).

**Требование к шлюзу.** Фильтры живут внутри `GatewayProvider`, поэтому применяются **только при
`llmGateway.enabled: true`**. При выключенном шлюзе вызов идёт мимо gateway-контура, и фильтры не
вызываются — это не ошибка плагина.

**Право вето.** `deny`/`redact` действуют только у плагина с фактическим trust ≥ `trusted`
(`builtin`/`verified`/`trusted`). Для `community` хост понижает вердикт до `allow` и пишет
`plugin_filter.deny_downgraded` в журнал плагинов. Наблюдать (аудит, метрики, сигнал) может любой.

**Сбой и таймаут.** Действует `failMode`:

- `closed` — вызов **не** уходит провайдеру (причина `plugin_filter.unavailable`, в тексте ошибки —
  `plugin_filter.timeout`/`plugin_filter.error`);
- `open` — вызов идёт, факт сбоя — в аудите шлюза.

Значение по умолчанию: для блокирующей фазы (`pre_request`/`embedding`) с правом вето — `closed`,
иначе `open`. `timeoutMs` фильтра приоритетнее инстансного `plugins.llmFilterTimeoutMs`
(дефолт 1 000 мс). Неизвестный вердикт (опечатка в `verdict`) трактуется как сбой — то есть по
`failMode`.

**Порядок.** Фильтры обходятся в порядке регистрации; первый `deny` доверенного фильтра
останавливает вызов (остальные фильтры этой фазы уже не вызываются).

**Пример: DLP-фильтр с вето.**

```typescript
import type { LlmCallFilter } from '@itphx/synth-shared';

const filter: LlmCallFilter = {
  id: 'plugin:my-plugin:secrets',   // конвенция: plugin:<name>:<filter>
  phase: 'pre_request',
  failMode: 'closed',
  timeoutMs: 150,
  inspect({ systemPrompt, messages }) {
    const text = [systemPrompt ?? '', ...(messages ?? []).map((m) => m.content)].join('\n');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
      return { verdict: 'deny', code: 'private_key', reason: 'в запросе приватный ключ' };
    }
    return { verdict: 'allow' };
  },
};
```

**Пример: маскирование текстов эмбеддинга.**

```typescript
const embeddingFilter: LlmCallFilter = {
  id: 'plugin:my-plugin:embed-pii',
  phase: 'embedding',
  failMode: 'closed',
  inspect({ texts }) {
    const redacted = (texts ?? []).map((text) => text.replace(/\b\d{12}\b/g, '<ID>'));
    return { verdict: 'redact', redactedTexts: redacted };
  },
};
```

> **Ограничение по стриму.** В стриме чанки уходят как есть; `post_response` получает уже
> отправленный ответ. Блокировка/правка ответа в v1 не поддерживается осознанно.

### 4.3. `tools` — инструмент для модели

```typescript
export interface PluginToolDefinition {
  name: string;                       // локальное имя, без `plugin_`
  description: string;                // описание для модели
  parameters: z.ZodTypeAny;           // zod-схема (валидация аргументов хостом)
  capabilities: ToolCapability[];     // обязательны
  execute: ToolExecutor;              // (params, ctx) => ToolResult
  jsonSchema?: Record<string, unknown>; // схема для модели (иначе конвертируется из parameters)
}
```

**Namespace.** Имя в общем реестре составляет **хост**: `plugin_<namespace>_<localName>`, где
namespace — имя плагина в нижнем регистре, небуквенно-цифровые символы → `_`
(`my-plugin` → `my_plugin`). В манифесте объявляется **локальное** имя (`notes_search`) — так
`provides.tools[]` не зависит от деталей namespace. Локальное имя: `^[A-Za-z0-9][A-Za-z0-9_-]*$`,
префикс `plugin_` запрещён (иначе сверка `provides` была бы неоднозначной).

**Capabilities.** Обязательны и непусты, значения — из `ToolCapability`:
`file_read`, `file_write`, `shell`, `search`, `web`, `git_read`, `git_write`, `task`, `user`
(`mcp` и `runtime` **зарезервированы**: первый — слой MCP, второй — неотключаемые админом
примитивы ядра). Без capabilities тул был бы невидим permission-слою и админ-отключению, поэтому
регистрация отклоняется.

**Доступность.** Решает permission-слой ([ADR-029](./arch_decisions/adr-029-granular-permissions.md)),
а не тул: плагинные инструменты адресуются группой `plugin` (матч **по источнику** `plugin`, а не
по capability) и подчиняются режиму сессии. В `plan` режиме мутирующие capabilities (`file_write`,
`shell`, `git_write`) получают `deny` ([ADR-025](./arch_decisions/adr-025-plan-act-toggle.md)), в
`act` — по правилам (`allow`/`ask`/`deny`); `search`/`file_read` в `plan` доступны.
Инстанс может выключить инструмент по имени (`plugin_<ns>_<tool>`) или по capability через
`PUT /api/v2/settings/tools-disabled` — но это же выключит и встроенные тулы с той же capability.

**Что приходит в `execute`.** `(params, ctx)`, где `ctx.sessionId`, `ctx.messageId`,
`ctx.workingDir`, `ctx.agentRole?`, `ctx.abortSignal?`. Не опирайтесь на `ctx.extra` — это
внутренний объект ядра, его состав не является частью контракта и может меняться.

**Почему стоит задавать `jsonSchema`.** `parameters` — ваша zod-схема; хост валидирует ею
аргументы (`safeParse`). Но для модели схема конвертируется хостом в JSON Schema, и конвертер
распознаёт классы **своей** копии zod. Собранный бандл несёт свою копию — поэтому явный
`jsonSchema` (то, что увидит модель) безопаснее и предсказуемее.

**Пример: инструмент, возвращающий ошибку без исключения.**

```typescript
import { z } from 'zod';
import type { PluginFacade } from '@itphx/synth-core';

const tool: Parameters<PluginFacade['registerTool']>[0] = {
  name: 'notes_search',
  description: 'Ищет заметку по ключевому слову.',
  parameters: z.object({ query: z.string().min(1) }),
  jsonSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  capabilities: ['search'],
  async execute(params) {
    const { query } = params as { query: string };
    if (query.length < 2) {
      // Штатная ошибка тула: контент уходит модели как есть, ход не падает.
      return { content: 'Слишком короткий запрос: минимум 2 символа.', isError: true };
    }
    return { content: `Найдено по «${query}»: 0 заметок.` };
  },
};
```

### 4.4. Сверка «объявлено ↔ зарегистрировано»

После `apply()` и **до** фиксации активации хост сравнивает `provides` с фактическими
регистрациями по всем трём точкам:

- `promptBlocks` — по `key`;
- `llmFilters` — по `id`;
- `tools` — по локальному имени.

Расхождение в любую сторону (`missing` — объявлено, но не зарегистрировано; `unexpected` —
зарегистрировано, но не объявлено) → **отказ активации** `plugin.provides_mismatch` с обратной
прокруткой уже сделанных регистраций. Это не придирка: так ловится несогласованная сборка
(например, в манифесте новая версия блока, а в бандле — старая).

Типичные причины:

| Симптом | Причина |
|---|---|
| `missing: plugin.my-plugin.notes` | имя/ключ в манифесте и в коде разошлись (опечатка, другой регистр) |
| `unexpected: notes_search` | в `provides.tools` забыли добавить инструмент (или объявили старое имя) |
| `missing: plugin:my-plugin:dlp` | фильтр не зарегистрирован из-за отказа (неизвестная фаза), а в `provides` остался |

Отклонённая регистрация «зарегистрированной» не считается: например, блок с тиром `stable`
отклоняется, и если он был объявлен в `provides`, активация упадёт с `provides_mismatch`.

---

## 5. Два режима исполнения

Один контракт точки расширения — два транспорта. Режим задаётся `mode` манифеста.

| Аспект | `inline` | `out-of-process` (`remote`) |
|---|---|---|
| Где код | в процессе core | отдельный процесс Node, HTTP/1.1 + JSON |
| Изоляция | нет | процессовая: падение/утечка памяти не роняют core |
| Латентность | ~0 | round-trip на каждый вызов точки |
| Доступ к internals | есть (ограничен фасадом и дисциплиной) | только сериализуемые DTO |
| Что нужно в бандле | `dist/index.js` | `dist/server.js` |
| Когда выбирать | `llmFilters` (горячий путь), быстрые блоки, простые тулы | тяжёлые фильтры (ML, антивирус, DLP), блоки с тяжёлой загрузкой, недоверенный код |

`mode: "both"` — компромисс: хост выбирает `inline`, если в бандле есть `dist/index.js`, иначе
`remote`. Для `both` в бандле должны быть оба входа, если вы хотите предсказуемости.

### 5.1. `inline`: контракт модуля

Хост делает `import()` точки входа и принимает **одну из трёх форм**:

```typescript
export function apply(facade) { /* … */ }        // 1
export default { apply(facade) { /* … */ } };    // 2
export default function apply(facade) { /* … */ }// 3
```

Любая другая форма → `plugin.module_invalid` («модуль загружен, но контракт не выполнен»).
Ограничения загрузчика: файл обязан лежать внутри каталога установки (containment по `realpath` —
`..`, абсолютные пути и симлинки наружу отклоняются), расширение только `.js`/`.mjs`, размер файла
входа ≤ 8 МиБ. `import()` идёт с cache-busting (`?v=<contentHash|mtime>`), поэтому переустановка не
отдаёт старый модуль.

### 5.2. `out-of-process`: wire-протокол

```text
GET  /health        → 200 (без токена; процесс жив)
GET  /capabilities  → { protocol: 1, name, version, points: { promptBlocks?, llmFilters?, tools? } }
POST /invoke        → { protocol: 1, point, id, input } → { output }
```

- **Только loopback**: `127.0.0.1`/`::1`/`localhost`, схема `http://`.
- **Bearer-токен** на `/capabilities` и `/invoke` (не на `/health`). Токен — инстансный, из файла
  `{dataDir}/secrets/plugin-token` (`0600`); хост передаёт его процессу в окружении.
- **Окружение процесса** ровно: `PATH`, `NODE_ENV`, `SYNTH_PLUGIN_PORT=0`, `SYNTH_PLUGIN_TOKEN`.
  Остальные переменные процесса Synth плагину **не** передаются.
- **Готовность**: сервер печатает в **stdout** строку `SYNTH_PLUGIN_READY port=<n>`; хост читает
  её и далее опрашивает `/health`. Только stdout: диагностика — в stderr.
- **Ошибки**: `{ error: { reason, message } }` с `reason` из `invalid_request`/`unknown_point`/
  `unknown_id`/`unauthorized`/`timeout`/`internal_error`/`protocol_mismatch`.
- **Идентичность**: `name`/`version` в `/capabilities` обязаны совпасть с манифестом, иначе
  `protocol_mismatch` (fail-closed).
- **Тулы** объявляются в `points.tools[]` (`name` — локальное, `description`, `parameters?` —
  JSON Schema, `capabilities` — **обязательны**), а не через `apply()`: кода в процессе хоста нет.

Минимальный сервер (`dist/server.js` — **скрипт**, его запускает хост: `node dist/server.js`):

```typescript
// src/server.ts  →  dist/server.js
import { createServer } from 'node:http';

const TOKEN = process.env.SYNTH_PLUGIN_TOKEN ?? '';
const PORT = Number(process.env.SYNTH_PLUGIN_PORT ?? '0');
const PLUGIN = { name: 'my-plugin', version: '0.1.0' };

const server = createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    json(200, { status: 'ok' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(401, { error: { reason: 'unauthorized', message: 'bad token' } });
    return;
  }
  if (req.method === 'GET' && req.url === '/capabilities') {
    json(200, {
      protocol: 1,
      ...PLUGIN,
      points: {
        promptBlocks: [
          { key: 'plugin.my-plugin.notes', tier: 'context', order: 120, title: 'Заметки проекта' },
        ],
        tools: [
          {
            name: 'notes_search',
            description: 'Ищет заметку по ключевому слову.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            capabilities: ['search'],
          },
        ],
      },
    });
    return;
  }
  // POST /invoke: разбор тела, вызов точки, ответ { output } — см. формат DTO
  json(400, { error: { reason: 'unknown_point', message: 'not implemented in example' } });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : PORT;
  // Единственная строка, которую хост читает из stdout.
  console.log(`SYNTH_PLUGIN_READY port=${actual}`);
});

process.on('SIGTERM', () => process.exit(0));
```

Типы `PluginServerOptions`/`PluginServerHandle`/`PluginServerFactory` в `@itphx/synth-shared`
описывают форму сервера для тестов и вспомогательных обвязок; **сам хост фабрику не импортирует** —
он запускает файл как скрипт и ждёт строку готовности.

Сборка второго входа: `esbuild src/server.ts --bundle --format=esm --platform=node --target=node20
--outfile=dist/server.js`.

> **`package.json` с `"type": "module"` обязателен** в корне бандла: без него Node трактует `.js`
> как CommonJS, и `import`/`export` в точке входа не работают (касается обоих режимов).

### 5.3. Что пересекает границу

Только сериализуемые DTO:

| Точка | Вход | Выход |
|---|---|---|
| `promptBlocks` | `PromptBlockContext` | `{ content, provenance?, status? }` (строка/`null` тоже допустимы) |
| `llmFilters` | `LlmFilterInput` | `LlmFilterVerdict` |
| `tools` | `{ parameters, context: { sessionId, messageId, workingDir } }` | `{ content, isError? }` |

Порты хранилища, реестры ядра, `GatewayProvider`, `ToolContext.extra` наружу **не отдаются**.

---

## 6. Правила пакета (bundle-only)

Плагин распространяется как **self-contained ESM-бандл**: всё, что нужно в рантайме, вшито в файлы
бандла. `npm install` для плагина не выполняется, `node_modules` не появляется, рантайм-резолва
npm-зависимостей нет.

### 6.1. Что можно и нельзя класть в бандл

| Артефакт | Правило |
|---|---|
| обычные файлы и каталоги | да |
| `node_modules/`, `.git/` | не входят в состав бандла (пропускаются при установке) |
| симлинки | не читаются: при установке пропускаются, в архивах **отклоняются** (fail-closed) |
| устройства, FIFO, hardlink | в архивах отклоняются |
| точка входа | `.js`/`.mjs`, внутри каталога бандла, ≤ 8 МиБ |
| `@itphx/*` | можно оставить external, но **надёжнее** — только `import type` (стирается сборкой): рантайм-импорт пакета хоста требует разрешения из каталога плагина |
| прочие npm-зависимости | обязаны быть вшиты в бандл |
| бинарные ассеты | копируются байтами; в `content_hash` входят только текстовые файлы (сканер видит и бинарные) |

### 6.2. Что делает сканер

Сканер — **статический и advisory**: код не исполняется, сканер лишь выносит вердикт; блокирует
установку матрица install-policy (§7). Категории находок (7):

| Категория | Что ищет |
|---|---|
| `exfiltration` | чтение `process.env`, обращение к `.env`/`id_rsa`/`credentials.json`/сертификатам, `~` |
| `injection` | «ignore previous instructions», просьбы раскрыть промпт, смена роли, скрытие от пользователя, inline-shell |
| `destructive` | `rm -rf`, удаление ФС, `DROP`, `chmod 777`, `sudo`, `child_process` |
| `persistence` | `crontab`, `systemd`, shell rc, `authorized_keys`, глобальные установки, install-скрипты |
| `network` | сетевые вызовы, сокеты, DNS, удалённое исполнение |
| `obfuscation` | кодированные строки, `eval`, динамические импорты |
| `invisible_unicode` | zero-width, bidi, unicode-tags, soft-hyphen |

Границы `severity → verdict`: `info|low → safe`, `medium → caution`, `high|critical → dangerous`.
Вердикт бандла — максимум по находкам.

Квоты структуры: **50** файлов, **1024 КиБ** суммарно → не выше `caution`; **256 КиБ** на файл или
исполняемый бинарник → `dangerous`. Исключения — `.skillignore` в стиле gitignore (`#`, `!`, `/`,
`*`, `**`, «последнее совпадение выигрывает»).

Практический вывод: не пишите в бандле `child_process`, `eval`, чтение `process.env` рядом с сетью
и «скрытые» unicode-символы — это либо `caution` (ручное подтверждение), либо `dangerous` (блок).

---

## 7. Доверие и install-policy

Плагины наследуют модель доверия расширений ([PROP-068](./arch_decisions/prop-068-skills-agents-registry.md)
§4). Уровни (от старшего): `builtin` → `verified` → `trusted` → `community`. Уровень
**резолвит источник**, а не манифест:

| Источник установки | Откуда берётся trust |
|---|---|
| CLI `synth plugin install --trust <level>` | значение флага (дефолт `community`) |
| API `POST /api/v2/plugins/install { trustLevel }` | значение запроса |
| deploy-каталог (`plugins.deployDir`) | `plugins.deployTrust` (дефолт `trusted`) |
| Каталог расширений | `trust_level` записи каталога — **источник истины** для публикации |

`trust` в манифесте — только **верхняя граница** (заявка), фактический уровень определяется
источником. Повысить доверие манифестом нельзя.

### 7.1. Trust-floor

`plugins.trustFloor` (дефолт `trusted`) — минимальный уровень **для установки** плагина. Проверка
идёт **до** install-policy и до скана-решения:

```text
манифест → состав бандла/hash → fail-closed (scan+executionEnabled) → trust-floor → скан →
runtime-install → install-policy (allow/ask/block)
```

Если trust ниже порога — отказ `plugin.trust_below_floor` (на диск ничего не пишется). Поэтому
локальный плагин и ставится с `--trust trusted`, иначе дефолтный `community` не пройдёт порог.

### 7.2. Матрица install-policy для плагина

Для `kind: "plugin"` действует отдельная ячейка матрицы — она **не зависит** от trust:

| Вердикт скана | Решение | Что происходит |
|---|---|---|
| `safe` | `allow` | установка в `installed/<name>@<version>/`, запись в lock |
| `caution` | `ask` | бандл в `quarantine/<name>@<version>/`; установка **не завершена** — нужно явное `approve` |
| `dangerous` | `block` | отказ `plugin.scan_rejected` |

Подтверждение карантина (`synth plugin approve <name>` / `POST /api/v2/plugins/:name/approve`)
повторно прогоняет гейты и сверяет `PLUGIN_INTEGRITY.json` с фактическим хешем; после этого бандл
переносится в `installed/`.

### 7.3. Управляемый плагин (deploy-time)

Плагины, поставленные **образом или PVC** (`plugins.deployDir`), ставятся при старте инстанса и
**не снимаются** через API/CLI:

- `plugins.deployTrust` (дефолт `trusted`) — доверие deploy-бандлов;
- `plugins.managedReadonly` (дефолт `true`) — плагин управляемый ⇔ `managedReadonly` включён и
  (`lock.source === "deploy"` или `lock.identifier` внутри `deployDir`);
- попытка `DELETE /api/v2/plugins/:name` или `update` → `403 plugin.managed_readonly` (CLI — код 1).

Почему так: снятый вручную плагин вернулся бы при следующем старте, а `update` подменил бы поставку
образа. Изменение такого плагина — **новый образ или переразвёртывание каталога**. Для автора это
значит: если ваш плагин планируется в managed-контуре, версия должна подниматься вместе с образом.

---

## 8. Тестирование плагина

### 8.1. Контрактный suite слоя

В ядре есть «паспорт» контракта расширений — `describePluginContract` (`@itphx/synth-core`):
набор проверок, которым обязан удовлетворять слой. Он прогоняется на **8 фикстурах** (эталон +
по одному нарушению: `stable-block`, `bad-phase`, `bad-verdict`, `provides-mismatch`,
`unknown-capability`, `reserved-tool-name`, `untrusted-deny`) и на **двух транспортах** — по 23
проверки на транспорт.

Что именно проверяется:

| Блок | Проверки |
|---|---|
| `promptBlocks` | тир/ключи/`order`; `stable` отклоняется; бюджет символов; `status` (`empty`/`truncated`); блок попадает в промпт, `provenance` = `plugin:<name>` |
| `llmFilters` | валидные фазы; порядок обхода = порядок регистрации; `failMode` по умолчанию соответствует доверию; неизвестный вердикт трактуется по `failMode`; понижение вето недоверенного |
| `tools` | namespace `plugin_<ns>_<tool>`; нет коллизии с builtin/MCP; источник `plugin`; инструмент виден permission-слою и может быть запрещён; `deregister` работает |
| `provides` | сверка всех трёх видов вкладов поимённо |
| dispose | после `deactivate()` не остаётся ни одной регистрации |
| запрет обхода | неизвестная/зарезервированная capability, чужой namespace, заявленный trust выше фактического |

> **Честное уточнение.** `describePluginContract` — «паспорт» **слоя**: фикстуры встроены в ядро,
> и подставить туда произвольный бандл нельзя. Для проверки **своего** плагина используйте рецепт
> из §8.2 — он проверяет те же свойства на вашем бандле.
>
> Контрактный suite доступен отдельным subpath'ом (он не входит в основной бандл пакета — в нём
> `vitest`, которого нет в прод-образе):
>
> ```typescript
> import { describePluginContract, createContractHarness } from '@itphx/synth-core/engine/plugins/contract.js';
> ```
>
> `createContractHarness` собирает эталонный харнесс (реестры, композер, gateway, permission-слой) —
> его можно переиспользовать в интеграционном тесте вашего бандла вместо ручной сборки.

### 8.2. Интеграционный тест своего плагина

`PluginHost`, `PromptBlockRegistry`, `LlmFilterRegistry`, `ToolRegistry` и
`createInlinePluginLoader` — публичные экспорты `@itphx/synth-core`. Этого достаточно, чтобы
прогнать «паспорт» на **своём** бандле:

```typescript
// test/contract.test.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PluginHost,
  PromptBlockRegistry,
  LlmFilterRegistry,
  ToolRegistry,
  createInlinePluginLoader,
} from '@itphx/synth-core';
import { pluginsConfigSchema } from '@itphx/synth-shared';

const ROOT = process.cwd();               // каталог плагина
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

/** Минимальный журнал аудита: хосту нужен порт, содержимое тесту не важно. */
const audit = {
  entries: [] as unknown[],
  async append(entry: unknown) { this.entries.push(entry); },
  async list() { return this.entries; },
  async clear() { this.entries = []; return 0; },
} as never;

describe('контракт плагина my-plugin', () => {
  let host: PluginHost;
  let tools: ToolRegistry;
  let promptBlocks: PromptBlockRegistry;
  let llmFilters: LlmFilterRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    promptBlocks = new PromptBlockRegistry();
    llmFilters = new LlmFilterRegistry();
    host = new PluginHost({
      audit,
      // Для теста доверие не должно мешать: политика `community` + исполнение включено.
      config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
      hostVersion: '0.12.0',
      loader: createInlinePluginLoader(),
      tools,
      promptBlocks,
      llmFilters,
      logger: { warn: () => undefined },
    });
  });

  it('активируется, даёт блок, фильтр и инструмент; снимается без остатка', async () => {
    const manifest = JSON.parse(await read('synth.pack'));
    const result = await host.activate(
      {
        name: manifest.name,
        version: manifest.version,
        manifest,
        rootDir: ROOT,
        entry: 'dist/index.js',
        trustLevel: 'trusted',
        installKind: 'deploy',
        files: { 'synth.pack': await read('synth.pack'), 'dist/index.js': await read('dist/index.js') },
      },
      { actor: 'test' },
    );

    expect(result.outcome).toBe('activated');

    // promptBlocks: ключ, тир, provenance
    const block = promptBlocks.get('plugin.my-plugin.notes');
    expect(block?.provider.tier).not.toBe('stable');
    expect(block?.provenance).toBe('plugin:my-plugin');

    // tools: namespace и источник
    expect(tools.get('plugin_my_plugin_notes_search')?.source).toBe('plugin');

    // llmFilters: зарегистрирован ровно один
    expect(llmFilters.size).toBe(1);

    // dispose-дисциплина: после деактивации реестры пусты
    await host.deactivate('my-plugin');
    expect(promptBlocks.size).toBe(0);
    expect(tools.listPlugin()).toHaveLength(0);
    expect(llmFilters.size).toBe(0);
  });
});
```

Проверьте на своём плагине то же, что проверяет паспорт:

- [ ] ключ блока начинается с `plugin.<name>.`, тир не `stable`, `order` задан;
- [ ] бюджет: блок длиннее `plugins.promptBlockMaxChars` обрезается с `status: "truncated"`
      (проверьте на длинном ответе);
- [ ] `provides` совпадает с фактическими регистрациями (активация не падает с `provides_mismatch`);
- [ ] фильтр: `phase` валидна; `failMode` осознан; `deny` для `community` не блокирует;
- [ ] тул: имя локальное, capabilities непусты, аргументы валидируются, ошибки возвращаются как
      `isError`, а не исключением;
- [ ] после `deactivate()` не осталось ни блоков, ни фильтров, ни тулов.

### 8.3. Проверка на живом инстансе

1. `synth plugin scan ./my-plugin` — вердикт и находки (код 1 при `dangerous`);
2. `synth plugin install ./my-plugin --trust trusted` → перезапуск инстанса;
3. раздел «Плагины»: активность, вердикт скана, trust, режим;
4. `GET /api/v2/sessions/:id/prompt` — блок в манифесте;
5. журнал `{dataDir}/audit/plugins.jsonl` — действия `install`/`activate`/`filter` и коды отказа.

---

## 9. Установка и обновление

### 9.1. Источники

| Вид | CLI | Проверка целостности | Что пишется в lock |
|---|---|---|---|
| каталог | `synth plugin install ./my-plugin` | нет (файлы читает установщик) | `source: local`, абсолютный путь |
| локальный архив | `synth plugin install ./dist/my-plugin-0.1.0.tgz` | `ref = sha256:<hash архива>` считается по факту | `source: local`, путь, `ref` |
| npm | `synth plugin install my-plugin --version 0.1.0` | **обязателен** SRI `sha512` (`dist.integrity`), `shasum` — дополнительно; нет SRI → отказ | `source: npm`, точная версия |
| https-URL | `synth plugin install https://…/my-plugin-0.1.0.tgz --sha256 <64-hex>` | **обязателен** pin `sha256` | `source: url`, URL, `ref` |

Вид источника выводится из `<ref>`; можно задать явно `--source dir|archive|npm|url`. Для URL pin
обязателен: произвольный адрес без хеша не ставится. Сеть идёт через общий egress-слой (прокси,
TLS/CA, [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)), редиректы проверяются (переход на
`http:` отклоняется), лимит скачивания — 32 МиБ.

Архив разбирается своим кодом: поддерживаются ustar/pax/GNU long name, распаковываются только
обычные файлы и каталоги; симлинки, hardlink, устройства, FIFO, абсолютные пути, `..`, windows-диски
и превышение лимитов (500 записей / 16 МиБ файл / 64 МиБ сумма) — отказ.

### 9.2. CLI

```bash
synth plugin list [--json]
synth plugin install <ref> [--source …] [--version …] [--sha256 …] [--trust …] [--activate] [--yes]
synth plugin update <name> [--version …] [--sha256 …] [--activate] [--yes]
synth plugin rollback <name>
synth plugin approve <name> [--version …] [--activate] [--yes]
synth plugin enable <name> | disable <name>
synth plugin remove <name> [--keep-files] [--yes]
synth plugin scan <path> [--json]
```

Коды выхода: `0` — операция выполнена (включая «бандл в карантине» и «не был установлен» для
`remove`), `1` — отказ (код причины — в stderr). Общие флаги путей: `--data-dir`, `--config`,
`--home`.

Помните: `install`/`update`/`remove` из CLI — **офлайн-операции**; они передают
`installKind: "deploy"`, поэтому политика `plugins.runtimeInstall` к ним не применяется, а изменения
вступают в силу после перезапуска. Управление живым инстансом — API/UI.

### 9.3. HTTP API

| Действие | Запрос | Успех |
|---|---|---|
| список | `GET /api/v2/plugins` | `200 { plugins: [...] }` |
| деталь (манифест + integrity) | `GET /api/v2/plugins/:name` | `200 { plugin, manifest?, integrity? }` |
| установка | `POST /api/v2/plugins/install` `{source?, path?, name?, version?, url?, sha256?, trustLevel?}` | `201` установлено, `202` нужен `approve` |
| подтверждение | `POST /api/v2/plugins/:name/approve` | `200` |
| включить/выключить | `POST /api/v2/plugins/:name/enable` \| `.../disable` | `200 { activation }` / `200 { deactivation }` |
| снять | `DELETE /api/v2/plugins/:name` | `204` (идемпотентно) |
| обновить | `POST /api/v2/plugins/update` `{name, version?, sha256?, activate?}` | `200 { outcome: "unchanged" \| "updated" }` |
| откатить | `POST /api/v2/plugins/:name/rollback` | `200 { outcome: "rolled_back", version, previousVersion }` |
| политика | `GET/PUT/DELETE /api/v2/settings/plugins` | `200` (применяется после рестарта) |

RBAC: managed — `ADMIN`; установка/активация — также service-key со scope `addons:install`;
`approve` и `DELETE` — только `ADMIN`. Core (standalone) — единый `requireAuth`. Локальные
источники (`dir`/`archive`) в managed запрещены (`403 LOCAL_INSTALL_DISABLED`), сетевые
(`npm`/`url`) разрешены.

Runtime-установка через API требует `plugins.runtimeInstall: allow` (дефолт `deny`).

### 9.4. Обновление и откат

- Источник обновления берётся **из записи lock**, а не из тела запроса: `npm` → имя + версия
  (по умолчанию `latest`, в lock пишется точная); `local` → каталог/архив; `url` → адрес +
  **обязательный новый** `sha256`.
- Совпал `content_hash` → `unchanged` (ничего не пишется).
- Иначе — обычная установка с теми же гейтами (доверие берётся из lock), каталог прежней версии
  сохраняется, в lock пишется `previous` — **одна** ступень отката.
- `rollback` меняет текущую и предыдущую версии местами (поэтому откат обратим; «на две версии
  назад» — два `rollback`). Нет ступени или каталога → `plugin.rollback_unavailable`.
- Активный плагин деактивируется и активируется заново; `activate: false` — не активировать, не
  задано — сохранить состояние.

### 9.5. Карантин

`caution` → бандл в `quarantine/<name>@<version>/`, lock не пишется, ответ `202`. Подтверждение
(`approve`) повторяет гейты и сверяет integrity; доверие берётся из `PLUGIN_INTEGRITY.json`, а не
угадывается. Без подтверждения плагин не установлен — в списке `GET /plugins` его нет.

### 9.6. Deploy-time (образ/PVC)

```text
plugins.deployDir/
├── analytics/  synth.pack + dist/index.js
└── notes/      synth.pack + dist/index.js
```

При старте инстанс сначала **ставит** бандлы из каталога (те же гейты: манифест → fail-closed →
trust-floor → скан → install-policy), затем активирует установленное из lock. Совпадение версии и
`content_hash` → `skipped`; ошибка одного бандла не ломает остальные и не роняет старт. Симлинки не
читаются. Управляемый плагин меняется только новым образом/переразвёртыванием (§7.3).

---

## 10. Плагин в гибридном режиме

В гибриде локальный core и удалённый сервер — два мира, и плагин должен явно объявлять, какому
миру служит. Серверная политика задаётся оператором сервера, автор плагина на неё только
рассчитывает.

### 10.1. Форма политики и allow-list

Секция `plugins.hybrid` в конфиге сервера и в runtime-настройках (`GET/PUT/DELETE
/api/v2/settings/plugins`):

```yaml
plugins:
  hybrid:
    mode: allowlist   # off (дефолт) | allowlist
    allow:            # имена плагинов, которым сервер разрешает работать
      - my-plugin
```

- `mode: 'off'` (дефолт) — **сервер не ограничивает** плагины: ни клиентский гейт активации, ни
  проверка allow-list по server-scoped токену не применяются;
- `mode: 'allowlist'` — сервер ограничивает: разрешены только плагины из `allow`; **пустой список —
  не разрешён никто**.

Env-оверрайд режима — `SYNTH_PLUGINS_HYBRID_MODE` (список имён остаётся в `config.yaml`).

### 10.2. Дискавери: что клиент узнаёт о сервере

| Поверхность | Что отдаёт | Кто читает |
|---|---|---|
| `GET /auth/oidc-meta` (публичный) | сигнал `plugins: { enabled, mode }` — **без списка имён** | локальный core при подключении к серверу |
| `GET /api/v2/settings/plugins` (аутентифицированный) | блок `hybrid: { mode, allow }` — полный allow-list (список приходит **только** при `mode: 'allowlist'`) | локальный core (кэш с TTL) |

Старый сервер без поля `plugins` → клиент считает политику **неизвестной** и работает в режиме
cooperative (см. §10.4). Список имён в публичном дискавери не публикуется намеренно: полный
allow-list — только аутентифицированным запросом.

### 10.3. Уровень 1 — cooperative (политика соответствия)

Локальный core **перед активацией** сверяется с серверной политикой:

- сервер доступен, режим `allowlist`, плагина нет в `allow` → активация отклоняется с
  `plugin.hybrid_not_allowed` (HTTP 403, запись в журнал аудита плагинов);
- сервер недоступен или политика неизвестна → **плагин работает**, но помечается «не проверен
  сервером» (`serverPolicy: 'unverified'` в API, бейдж в UI).

Гейт относится к **активации**, а не к установке: установить плагин можно, запустить — только если
сервер разрешает. Ключ проверки — имя плагина.

**Что это значит для автора.** Уровень 1 — политика соответствия, а не принуждение: исполняемый
код на клиенте остаётся под ответственностью владельца локального контура. Клиентский enforcement
**не гарантирован** — сервер не может проверить, что клиентский core действительно сверился с
политикой. Гарантию даёт Уровень 2.

### 10.4. Cooperative-маркер

Статус `serverPolicy` в ответе `GET /api/v2/plugins` (и в карточке плагина в UI):

| Статус | Значение |
|---|---|
| `allowed` | сервер подтвердил: режим `off` либо плагин входит в allow-list |
| `denied` | сервер запретил: режим `allowlist`, плагина нет в списке (и не активируется) |
| `unverified` | сервер недоступен или политика неизвестна — плагин работает, но сервер его не подтвердил |

`unverified` — это **не** ошибка плагина: он означает, что серверной проверки не было. В UI рядом
с бейджем показывается пояснение про cooperative-режим.

### 10.5. Уровень 2 — server-scoped токен (что даёт гарантию)

Чтобы плагин мог обращаться к серверу, оператор выдаёт ему **service-key с привязкой к
`plugin_id`**:

```http
POST /api/v2/plugins/token
Authorization: Bearer <admin-ключ>
Content-Type: application/json

{ "pluginId": "my-plugin", "scopes": ["events:ingest"], "expiresInSec": 3600 }
```

Ответ — `201 { "token": "synth_svc_…", "pluginId": "my-plugin", "scopes": […], "expiresAt": … }`.
Секрет отдаётся **единожды** (at-rest — sha256). Выдаёт **ADMIN** (в managed) или владелец
инстанса (в core); scope `plugins:invoke` добавляется всегда.

Сервер принимает такой ключ **только** если запрос несёт заголовок с тем же `plugin_id`:

```http
Authorization: Bearer synth_svc_…
X-Synth-Plugin-Id: my-plugin
```

Проверяются три условия (fail-closed, применяются ко **всем** серверным API, а не только к
плагинным):

1. заголовок `X-Synth-Plugin-Id` присутствует и совпадает с `plugin_id` ключа — иначе `403
   PLUGIN_ID_MISMATCH`;
2. у ключа есть scope `plugins:invoke` — иначе `403 SCOPE_REQUIRED`;
3. `plugin_id` входит в серверный allow-list (при `mode: 'allowlist'`) — иначе `403
   PLUGIN_NOT_ALLOWED`.

**Что это значит для автора.** Токен нельзя переиспользовать от имени другого плагина и нельзя
выдать ключ без нужного scope: сервер применяет политику сам. Уровень 3 (attestation — проверка
целостности клиента) в объём слоя не входит.

---

## 11. Версионирование контракта

Контракт Extension API версионируется **семвер-мажором**:

- `contracts.extensionApi` — диапазон версии контракта, с которым собран плагин. Хост объявляет
  версию `1.0.0`; плагин пишет `^1`. Сравнивается мажор.
- **Мажор меняется только при несовместимости**: удаление/переименование поля, смена семантики
  вердикта, изменение формы DTO, ужесточение обязательности. Новые необязательные поля,
  дополнительные точки и additive-изменения — минор/патч, мажор не трогают.
- `host` — независимый диапазон версий Synth: он отвечает на вопрос «в каком ядре это
  проверялось», а `contracts` — «на каком контракте написан код».

**Окно deprecation (зафиксировано в ADR-090).** Мажор `N` продолжает приниматься хостом **не менее 3
минорных релизов ядра и не менее 90 дней** после выхода мажора `N+1` (что наступит позже); в этот
период хост поддерживает оба мажора, а в журнал/документацию пишется предупреждение об устаревшем
контракте. Решение владельца зафиксировано в [ADR-090](./arch_decisions/adr-090-extension-api.md) §9.

**Что делать при `plugin.contract_mismatch`:**

1. посмотрите фактические значения в сообщении отказа (`expected`/`actual`);
2. обновите `contracts.extensionApi` до поддерживаемого мажора (`^1`) и пересоберите бандл;
3. если плагин уже несовместим с текущим API — выпустите новую мажорную версию плагина; не
   пытайтесь «подогнать» манифест без правки кода.

`plugin.host_mismatch` — то же, но про `host`: расширьте диапазон только после проверки на новой
версии ядра. Оператор инстанса может добавить точную версию в файл исключений
(`plugins.exactHostExceptions`, одна версия в строке, `#` — комментарий) — это аварийный обход, а
не норма для автора.

---

## 12. Справочник ошибок

Коды причин — `PLUGIN_AUDIT_REASONS` (`packages/shared/src/types/plugin-audit.ts`), 29 значений.
Код виден в ответе API (`reason`), в журнале `{dataDir}/audit/plugins.jsonl` и в stderr CLI.

### 12.1. Установка и источник

| Код | Что означает | Что делать автору |
|---|---|---|
| `plugin.source_unavailable` | источник не отдал бандл: нет пути/каталога, архив отклонён (симлинк, `..`, лимиты), npm без SRI/недоступен, URL без pin/несовпадение хеша | проверьте путь и вид источника, для npm — наличие `dist.integrity`, для URL — `--sha256`; локально это `400`, для сети — `502` |
| `plugin.manifest_invalid` | `synth.pack` не разобран или не прошёл `validatePackManifest` | читайте текст: чаще всего пустой `provides`, `tier: stable`, неизвестная фаза, `trust.level` выше `trusted`, лишнее поле в `provides` |
| `plugin.remote_entry_missing` | `mode: "remote"`, но в бандле нет `dist/server.js` | соберите серверную точку входа или переключите режим на `inline`/`both` |
| `plugin.integrity_mismatch` | содержимое установленного бандла изменилось после установки | переустановите бандл; не редактируйте файлы в `installed/…` |
| `plugin.integrity_unverifiable` | ожидаемый хеш есть, а проверить нечем (нет файлов) | ставьте из источника/архива, а не «полусобранным» каталогом |
| `plugin.approval_required` | вердикт `caution` — нужен `approve` | проверьте находки скана (`synth plugin scan`), затем подтвердите установку |
| `plugin.scan_rejected` | вердикт `dangerous` (или сбой сканера — fail-closed) | устраните находки (`child_process`/`eval`/чтение секретов/исполняемый бинарник) |

### 12.2. Доверие и политика

| Код | Что означает | Что делать автору |
|---|---|---|
| `plugin.trust_below_floor` | уровень доверия ниже `plugins.trustFloor` (дефолт `trusted`) | публикуйте запись с корректным `trust_level` или просите оператора поставить с `--trust trusted`; манифест доверие не повышает |
| `plugin.disabled` | слой плагинов выключен (`plugins.enabled: false`) | это настройка инстанса, не ошибка плагина |
| `plugin.not_allowlisted` | имя не входит в `plugins.allowlist` (список задан) | попросите оператора добавить имя |
| `plugin.denylisted` | имя в `plugins.denylist` | плагин запрещён на инстансе |
| `plugin.runtime_install_denied` | установка во время работы запрещена (`plugins.runtimeInstall: deny`) | используйте deploy-time/CLI или включите `allow` |
| `plugin.scan_disabled_with_execution` | скан выключен, а исполнение включено — fail-closed | это политика инстанса: исполняемый код обязан сканироваться |
| `plugin.execution_disabled` | исполнение кода плагинов выключено (`plugins.executionEnabled: false`) | включите ключ и перезапустите инстанс |
| `plugin.managed_readonly` | плагин поставлен развёртыванием, снятие/обновление запрещено | меняйте версию образом/каталогом (`deployDir`) |
| `plugin.hybrid_not_allowed` | серверная политика гибрида запрещает плагину работать (`plugins.hybrid.mode: allowlist`, имени нет в `plugins.hybrid.allow`) | попросите оператора сервера добавить имя плагина в allow-list; локально код появляется только в гибридном режиме |

### 12.3. Активация, загрузка, вклады

| Код | Что означает | Что делать автору |
|---|---|---|
| `plugin.not_found` | записи в lock нет | установите плагин |
| `plugin.not_active` | деактивировать нечего | проверьте `list`/`GET /plugins` |
| `plugin.already_active` | повторная активация | сначала `disable`, если нужен перезапуск активации |
| `plugin.contract_mismatch` | несовместимый мажор `contracts.extensionApi` | приведите `contracts` в соответствие с API хоста (§11) |
| `plugin.host_mismatch` | версия Synth вне `host` | расширьте `host` после проверки или обновите плагин |
| `plugin.loader_unavailable` | загрузчик недоступен или загрузка сорвалась (нет `rootDir`, файл вне каталога, не `.js`/`.mjs`, > 8 МиБ, ошибка `import()`), а также исключение из `apply()` | проверьте точку входа и её расположение; `apply()` не должен бросать |
| `plugin.module_invalid` | модуль загружен, но не отдал `apply` | используйте одну из трёх форм модуля (§5.1) |
| `plugin.provides_mismatch` | объявленное в `provides` не совпало с фактическими регистрациями (или наоборот) | синхронизируйте манифест и код; см. §4.4 |
| `plugin.disposer_failed` | сбой disposer'а при деактивации (остальные выполнены) | disposer должен быть идемпотентным и не бросать |
| `plugin.rollback_unavailable` | нет ступени `previous` или каталога прежней версии | откат возможен только после `update`; иначе ставьте нужную версию установкой |

### 12.4. Решения фильтров (`plugin_filter.*`)

| Код | Где | Что означает | Что делать автору |
|---|---|---|---|
| `plugin_filter.denied` | журнал плагинов + аудит шлюза | доверенный фильтр заблокировал вызов | ожидаемо при срабатывании; проверьте `reason`/`code` |
| `plugin_filter.deny_downgraded` | журнал плагинов + аудит шлюза | блокирующий вердикт понижен: у плагина нет права вето (trust < `trusted`) | получите доверие у источника/реестра — это не настройка плагина |
| `plugin_filter.unavailable` | журнал плагинов + аудит шлюза | фильтр упал или не уложился в бюджет | сократите работу в `inspect`, увеличьте `timeoutMs`, проверьте, что `fan`-вызовы не блокируют event loop |
| `plugin_filter.allowed` | только аудит шлюза | вызов пропущен | — |
| `plugin_filter.timeout` / `.error` | только аудит шлюза | истёк бюджет / исключение или неизвестный вердикт | то же + проверьте форму `verdict` |
| `plugin_filter.redact_unsupported` | только аудит шлюза | `redact` в `pre_request` не поддерживается | используйте `deny` или маскируйте данные до вызова |
| `plugin_filter.buffering_required` | только аудит шлюза | `deny`/`redact` в `post_response` отклонены (нет буферизации) | `post_response` — только наблюдение |
| `plugin_filter.redact_invalid` | только аудит шлюза | `redactedTexts` не массив строк той же длины — fail-closed `deny` | верните массив той же длины |

Маппинг причин в HTTP — единая таблица `PLUGIN_REASON_HTTP` (`packages/core/src/server/routes/plugins.ts`):
`400` — `manifest_invalid`, `contract_mismatch`, `host_mismatch`, `module_invalid`,
`provides_mismatch`, локальный `source_unavailable`; `403` — `trust_below_floor`, `disabled`,
`not_allowlisted`, `denylisted`, `runtime_install_denied`, `scan_disabled_with_execution`,
`managed_readonly`, `hybrid_not_allowed`; `404` — `not_found`, `not_active`; `409` — `scan_rejected`,
`integrity_mismatch`, `integrity_unverifiable`, `execution_disabled`, `rollback_unavailable`;
`202` — `approval_required`; `500` — `loader_unavailable`, `disposer_failed`; `502` — сетевой
`source_unavailable`.

---

## 13. Публикация

Каталог расширений — отдельный репозиторий **`synth-registry`** (записи `entries/`, общий индекс
`index.json` для всех классов расширений). Витрина — **`synth-market`** (статический сайт поверх
индекса).

### 13.1. Запись каталога

Скопируйте `synth-registry/templates/entry.yml` в `entries/<owner>__<repo>.yml` и заполните.
Ключевое для плагина:

| Поле | Значение |
|---|---|
| `kind` | `plugin` |
| `name` | имя плагина (совпадает с `synth.pack.name`) |
| `version` | версия публикуемого бандла |
| `trust_level` | `community` (дефолт) / `verified` / `trusted` / `builtin`. **Это источник истины** для фактического доверия при установке из каталога |
| `identifier` | `<owner>/<repo>` (для монорепо-подпакета — `<owner>/<repo>#packages/<name>`) |
| `source` | канал доставки (`npm`, `github`, `registry`, …) |
| `install.command` | команда, которую покажет витрина; для плагина по умолчанию — `synth plugin install <name>` |
| `extra.provides` | для плагина имеет смысл указать `tools`/`promptBlocks`/`llmFilters` (форма свободная) |
| `extra.compatibility.contracts` | `extensionApi: "^1"` — то же, что в манифесте |
| `extra.docs` / `extra.changelog` | ссылки на документацию и историю |

`trust_level` записи не повышается манифестом: при установке из каталога фактический уровень
берётся отсюда. Заявка в манифесте (`trust.level`) — только верхняя граница.

### 13.2. Команда установки на витрине

Витрина строит команду по умолчанию **с учётом `kind`**:

- `kind: "plugin"` → `synth plugin install <name>` (CLI принимает путь, `.tgz`, npm-имя или
  https-URL; версия пинуется флагом `--version`, URL — обязательным `--sha256`);
- остальные классы → прежняя команда (`synth addons install <name>@<version>`).

Явное `extra.install.command` в записи имеет приоритет над командой по умолчанию — если плагин
публикуется из архива или по URL, укажите там точную команду с пином.

### 13.3. Требования к записи

- `kind: plugin` соответствует `synth.pack.kind` опубликованного бандла;
- версия в записи совпадает с `synth.pack.version` (иначе пользователь получит один номер на
  витрине и другой в `plugin list`);
- `provides` записи не обещает того, чего нет в манифесте;
- репозиторий содержит `synth.pack` и собранный `dist/` (или релизный архив с ними);
- лицензия указана (SPDX; при отсутствии публичной — `UNLICENSED` + `licenseNote`);
- `description` — обе локали (`ru`/`en`), без превосходных степеней.

---

## 14. Чек-лист автора

Перед публикацией:

- [ ] `synth.pack`: `kind: "plugin"`, `name`/`version`/`description`, `host` и
      `contracts.extensionApi` заданы;
- [ ] `provides` **точно** совпадает с регистрациями (ключи блоков, id фильтров, локальные имена
      тулов);
- [ ] блоки: ключи `plugin.<name>.*`, тиры только `context`/`volatile`, `order ≥ 100`;
- [ ] фильтры: `phase` валидна, `failMode` выбран осознанно, `inspect` укладывается в `timeoutMs`,
      `deny` не единственный механизм (на `community` он не сработает);
- [ ] тулы: локальные имена без `plugin_`, capabilities непусты и без `mcp`/`runtime`, задан
      `jsonSchema`, ошибки — `{ isError: true }`, а не исключения;
- [ ] бандл self-contained: нет рантайм-импортов `@itphx/*`, нет `node_modules`, точка входа
      ≤ 8 МиБ, сборка ESM;
- [ ] `synth plugin scan ./my-plugin` — `safe` (или `caution` с пониманием, почему);
- [ ] интеграционный тест (§8.2) зелёный: активация, блок, фильтр, тул, деактивация без остатка;
- [ ] проверили на живом инстансе: блок в `GET /sessions/:id/prompt`, тул вызывается, журнал
      `audit/plugins.jsonl` без неожиданных кодов;
- [ ] запись каталога: `kind: plugin`, `trust_level` честный, `extra.provides` и
      `extra.compatibility.contracts` заполнены, `install.command` (если нужен) с пином;
- [ ] версия поднята (semver), changelog обновлён, лицензия указана.

---

## См. также

- [ADR-090 — Extension API v1](./arch_decisions/adr-090-extension-api.md): канон слоя плагинов.
- [API_V2.md](./API_V2.md) §5.36 — HTTP-контур плагинов.
- [MAINTENANCE.md](./MAINTENANCE.md) §«Плагины» — эксплуатация: установка, диагностика, deploy.
- [CONFIGURATION.md](./CONFIGURATION.md) §«Плагины (`plugins.*`)» — ключи и дефолты.
- [ADR-036](./arch_decisions/adr-036-llm-gateway.md) — LLM-шлюз (почему `post_response` только
  наблюдает).
- [ADR-070](./arch_decisions/adr-070-system-prompt-composer.md) — сборка промпта и тиры блоков.
- [ADR-029](./arch_decisions/adr-029-granular-permissions.md) — permission-слой для инструментов.
- [PROP-068](./arch_decisions/prop-068-skills-agents-registry.md) — модель доверия, install-policy,
  сканер, каталог.
- [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) — egress, TLS/CA и прокси для сетевых
  вызовов плагина.
