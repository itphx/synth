# AD-068: Реестр и каталог скиллов и агентов (контент-платформа)

> **Статус:** 🧩 Предложение — Реестр и каталог скиллов и агентов: индекс, trust/guard, install-policy, agent-packs
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-17
> **Парный документ:** [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» —
> механизм (формат `SKILL.md`, discovery, доставка, тул `skill`, команды). AD-068 отвечает за
> **контент и распространение**: собственный категоризированный каталог, agent-packs,
> централизованный индекс, адаптеры источников, доверие/безопасность установки, UI.

**Решение:** построить **реестр скиллов и агентов** как отдельную контент-платформу:
свой git-репозиторий с категоризированным каталогом (`skills/<category>/<name>/SKILL.md`)
и agent-packs (`agents/<name>/AGENT.md`), централизованный JSON-индекс с TTL-кэшем и
честным fallback на stale-кэш, набор адаптеров источников с единым интерфейсом
`search/inspect/fetch`, уровни доверия и статический сканер безопасности, провенанс
(`lock.json`, `taps.json`, audit log, quarantine) и UI управления установленными
скиллами. **Внешние каталоги по умолчанию выключены** — Synth лишь показывает список
рекомендуемых проверенных источников; включение выполняет пользователь/админ явно.
Реестр **не владеет форматом** `SKILL.md` — это AD-046; реестр владеет каталогом,
доставкой и доверием.

**Контекст:** механизм скиллов (AD-046) без контента бесполезен: пользователю нужен
подбор скиллов под задачу, установка из проверенных источников и гарантия, что
установленный контент не выполнит произвольный код. Сегодня источники фрагментированы:
вендорские репозитории (`anthropics/skills`, `openai/plugins`, `google/skills`,
`microsoft/skills`, `NVIDIA/skills` и др.), агрегаторы (`skills.sh`, `lobehub`,
`browse.sh`), GitHub-коллекции и awesome-списки. Установка «как есть» из интернета —
это произвольный код и промпты в контексте агента: инцидент **ClawHavoc** (по разным
оценкам 341–1184 вредоносных скиллов в ClawHub; точная цифра не подтверждена) показал,
что открытый каталог без guard'а превращается в канал доставки exfiltration/injection.
Референсы: hermes-agent (`tools/skills_hub.py`, `tools/skills_guard.py`, индекс с
health floors и watchdog'ом) и openchamber (захардкоженные каталоги, установка =
копирование текущего состояния, без версий/хешей/лицензий/отката). Оба подтверждают:
нужен собственный реестр с доверием, сканером и провенансом, а не список URL.

---

## 1. Схема

```
Источники                     Реестр Synth                          Установка
┌──────────────────┐   search/inspect/fetch   ┌────────────────┐   ┌────────────────┐
│ official (свой)  │◄────────────────────────►│ SourceRegistry │   │ ~/{dataDir}/   │
│ own-index        │                          │  (адаптеры)    │   │  skills/<cat>/ │
│ github taps      │                          └───────┬────────┘   │  <name>/       │
│ well-known       │                                  │            └───────▲────────┘
│ url (SKILL.md)   │                          ┌───────▼────────┐         │
│ skills.sh (поиск)│                          │ Index (JSON)   │   ┌─────┴────────┐
└──────────────────┘                          │ trust + scan   │──►│ Installer    │
                                              │ TTL / stale    │   │ guard + lock │
                                              └───────┬────────┘   └─────┬────────┘
                                                      │                  │
                                              ┌───────▼────────┐   ┌─────▼────────┐
                                              │ quarantine     │   │ lock.json    │
                                              │ audit.log      │   │ taps.json    │
                                              └────────────────┘   └──────────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │ discovery      │ ← AD-046 (тул skill,
                                              │ SKILL.md       │   команды, enable/disable)
                                              └────────────────┘
```

Поток установки: **источник → inspect (скачивание в quarantine) → trust-резолвинг →
сканер → install-policy → копирование в cache root → lock.json**. Ни один шаг не
пропускается; `--force` смягчает только вердикт `caution`, но **не** `dangerous`.

---

## 2. Свой репозиторий и структура каталога

Отдельный git-репозиторий Synth (рабочее имя `synth-skills`, финальное — открытый
вопрос). Каждый скилл — директория с `SKILL.md` и вспомогательными файлами; скилл
самодостаточен и копируется целиком.

```
synth-skills/
├── README.md
├── LICENSE                       # лицензия каталога (не путать с лицензиями скиллов)
├── index/
│   ├── skills.json               # собранный индекс (CI, см. §5)
│   └── skills.json.sig           # detached-подпись индекса (см. §6.6)
├── skills/
│   ├── engineering/
│   │   └── code-review/
│   │       ├── SKILL.md
│   │       ├── LICENSE           # опционально: лицензия конкретного скилла
│   │       └── references/
│   ├── productivity/             # ...
│   ├── software-development/
│   ├── devops/
│   ├── security/
│   ├── research/
│   ├── data/
│   ├── legal/                    # не-IT отрасли
│   ├── marketing/
│   ├── sales-crm/
│   ├── finance/
│   ├── support/
│   ├── media/
│   └── creative/
└── agents/
    ├── <pack-name>/              # agent-pack (набор агентов)
    │   ├── pack.json             # {name, version, description, agents[], groups[], skills[]}
    │   └── <agent-name>/
    │       └── AGENT.md
    └── ...
```

**Категории** (минимум 14, расширяемый список): `engineering`,
`productivity`, `software-development`, `devops`, `security`, `research`, `data`,
`legal`, `marketing`, `sales-crm`, `finance`, `support`, `media`, `creative`.
Набор сознательно выходит за пределы IT: юристы, турагентства, маркетинг, CRM —
категория задаётся в метаданных скилла, а не в имени каталога, чтобы один и тот же
контент не дублировался.

**Метаданные скилла.** Источник истины — frontmatter `SKILL.md` (формат — [AD-046](./ad-046-skills-and-slash-commands.md)).
Реестр **обогащает** карточку скилла полями индекса/lock, не дублируя и не переопределяя формат frontmatter.
Соответствие: `category`/`tags` — это `metadata.synth.category`/`metadata.synth.tags` (AD-046 §3.2);
`minSynth` — нормализованное представление `compatibility`; `source`/`identifier`/`version` — поля
реестра (индекс/lock), а не frontmatter:

| Поле | Назначение |
|---|---|
| `name` | Идентификатор внутри реестра (уникален в пределах source) |
| `description` | Краткое описание для поиска/UI |
| `category` | Одна из категорий каталога |
| `tags` | Свободные метки (поиск, фильтры) |
| `version` | SemVer контента; инкрементируется при любом изменении файлов |
| `license` | SPDX-идентификатор; обязателен для сторонних скиллов |
| `source` | Каталог/адаптер происхождения |
| `identifier` | Устойчивый id в источнике (owner/repo/path или URL) |
| `minSynth` | Минимальная версия Synth (совместимость) |
| `agents` | Совместимые/целевые агенты (для agent-packs) |
| `groups` | Группы для binding'а (AD-046) |

**Версионирование.** Каталог — обычный git; релиз каталога — тег `skills-vX.Y.Z`.
Индекс публикуется вместе с тегом и содержит `generated_at`. Контент скилла
меняется только через PR с ревью; CI валидирует frontmatter, лицензии и запускает
сканер (§6.3) — вредоносный/невалидный скилл не попадает в индекс.

**Agent-packs.** Каталог агентов закладывается как основа: `agents/<pack>/pack.json`
описывает набор агентов и их группы; каждый агент — `AGENT.md`. Связь с AD-046 —
через binding `agents`/`groups` (формат `AGENT.md` и семантика групп — открытый
вопрос, §10). Agent-pack не исполняется реестром: реестр его доставляет и
устанавливает, а применение — движок/сессии (AD-025/AD-026).

---

## 2.1. Единый манифест `synth.pack` и типы контент-паков

Манифест **всех** классов расширений и контент-паков — единый файл **`synth.pack`** (JSON) в корне репозитория
расширения ([AD-086](./ad-086-extensibility-plugins-editions.md), [AD-090](./ad-090-extension-api.md)). Для
контент-паков — `kind: "pack"` + `packType`.

Поля манифеста: `name`, `version`, `kind` (`plugin|gateway|addon|pack`), `host`, `contracts`, `description`,
`provides` (для `pack` дополнительно `packType`).

**Типы контент-паков (`kind: "pack"` + `packType`):**

| `packType` | Что содержит | Текущее состояние в коде |
|---|---|---|
| `skills` | скиллы/команды (`SKILL.md`) | механизм есть ([AD-046](./ad-046-skills-and-slash-commands.md)); паков нет |
| `agents` | agent-packs (наборы агентов, `AGENT.md`) | определения — `packages/core/src/engine/agents/definitions/*.json` (11 шт.); паков нет |
| `mcp` | MCP-серверы | реестр есть ([AD-071](./ad-071-mcp-servers-prompt.md)); паков нет |
| `themes` | темы оформления | только встроенные — `packages/ui/src/lib/theme/*`; паков нет |
| `i18n` | локали/переводы | en-шаблоны в core, ru — в ui ([AD-041](./ad-041-llm-error-taxonomy.md)); механизма пакетов локалей нет |
| `providers` | провайдеры/модели | JSON в `$DATA/providers\|models` + API; паков нет |
| `prompts` | персоны/промпт-блоки | блоки `prompts/` ядра ([AD-070](./ad-070-system-prompt-composer.md)); паков нет |
| `automation` | маршруты/расписания/loops/pipelines | маршруты/расписания ([AD-089](./ad-089-external-events-automation.md)/[AD-051](./ad-051-scheduler-pipelines.md)) есть; паков нет |
| `policies` | пресеты permissions/tools-policy/mcp-policy | политики есть ([AD-029](./ad-029-granular-permissions.md)/[AD-071](./ad-071-mcp-servers-prompt.md)); пресетов-паков нет |
| `memory` | индексы/паки памяти | нет ([AD-047](./ad-047-memory-gbrain.md)) |
| `ui` | UI-слоты/виджеты | нет (UI-slot отложен, [AD-090](./ad-090-extension-api.md)) |

**Реестр/индекс/trust/install-policy/провенанс — единые** для всех классов (`kind`) и типов контент-паков
(`packType`): та же trust-иерархия (`builtin → verified → trusted → community`), матрица install-policy,
статический сканер, quarantine, `lock.json` и audit log, что и для скиллов/агентов (§3–§5). Отдельных реестров
на каждый `packType` не вводится.

---

## 3. Формат индекса

Централизованный JSON-индекс (формат hermes-подобный, с добавлением версионирования
и подписи). Публикуется CI каталога, кэшируется Synth с TTL.

```json
{
  "version": 1,
  "generated_at": "2026-09-17T06:00:00Z",
  "skill_count": 412,
  "sources": [
    {"id": "official", "label": "Synth", "trust_level": "builtin", "enabled_by_default": true},
    {"id": "anthropics", "label": "Anthropic", "repo": "anthropics/skills",
     "subpath": "skills", "trust_level": "trusted", "enabled_by_default": false}
  ],
  "skills": [
    {
      "name": "code-review",
      "description": "Ревью изменений с чек-листом и адверсальными пробами",
      "source": "official",
      "identifier": "official/engineering/code-review",
      "trust_level": "builtin",
      "repo": null,
      "path": "skills/engineering/code-review",
      "tags": ["review", "quality"],
      "version": "1.2.0",
      "license": "Apache-2.0",
      "extra": {},
      "resolved_github_id": null
    }
  ]
}
```

| Поле | Смысл |
|---|---|
| `version` | Версия схемы индекса |
| `generated_at` | Момент сборки (ISO-8601 UTC) — база для freshness-watchdog |
| `skill_count` | Число скиллов (после дедупликации) |
| `sources[]` | Каталоги и их дефолты (trust, enabled_by_default) |
| `skills[].trust_level` | `builtin/verified/trusted/community/agent-created` |
| `skills[].identifier` | Устойчивый id: `owner/repo#path`, `skills.sh/<...>`, `url/<sha>` |
| `skills[].resolved_github_id` | Для агрегаторов (напр. skills.sh) — куда указывает GitHub-путь |
| `skills[].extra` | Источник-специфичные поля (рейтинги, даты, автор) |

**Кэш и freshness.** Индекс кладётся в `{dataDir}/skills/index.json` атомарно
(AD-005), с `fetched_at` и TTL. При истечении TTL Synth пытается обновить индекс;
если сеть недоступна или новый индекс не проходит проверку подписи/health floors —
работает **stale-кэш** с честным предупреждением в UI (`stale: true`, возраст).
Офлайн-режим — тот же stale-путь, без падений (по образцу offline-деградации AD-042).

### 3.1. Адаптеры источников

Единый интерфейс: `search(query) → SkillMeta[]`, `inspect(identifier) → SkillBundle`,
`fetch(identifier, ref?) → archive + manifest`. Адаптер не решает про trust/скан —
это делает ядро реестра.

| Адаптер | Параметры | Операции | Trust по умолчанию | Примечание |
|---|---|---|---|---|
| `official` | свой каталог | search/inspect/fetch | `builtin` | Единственный включён по умолчанию |
| `own-index` | URL индекса | search/inspect/fetch | по `trust_level` записи | Собственный централизованный индекс; подпись проверяется |
| `github` | `owner/repo` + subpath, taps | search/inspect/fetch | `trusted` для вендорских, иначе `community` | Вендорский список — белый (см. §7) |
| `well-known` | домен | search/inspect/fetch | `community` | `GET /.well-known/skills/index.json` |
| `url` | прямой `SKILL.md` | inspect/fetch | `community` | SSRF-защита, запрет redirect на private/link-local |
| `skills.sh` | — | **только search** | `community` | Каталог-агрегатор, fetch делегируется `github`/`url` |
| `tap` | `{repo, path}` | search/inspect/fetch | как `github` | Пользовательские taps из `taps.json` |
| `clawhub` | — | **выключен** | `community` | НЕ адаптер по умолчанию (инцидент ClawHavoc, §7) |

---

## 4. Доверие и безопасность установки

### 4.1. Уровни доверия

Иерархия: `builtin` → `verified` → `trusted` → `community` → `agent-created`.

| Уровень | Кто | Критерий |
|---|---|---|
| `builtin` | свой каталог | Код и контент в контроле проекта, PR-ревью, CI-скан |
| `verified` | подписанные вендорские | Есть подпись + governance-карта (эталон — `NVIDIA/skills` с `skill.oms.sig` и `skill-card.md`) |
| `trusted` | вендорские репозитории | Белый список (`TRUSTED_REPOS`-подобный), но без подписи |
| `community` | всё остальное | Любой GitHub/URL/агрегатор; звёзды — **не** критерий доверия |
| `agent-created` | созданные агентом | Отдельный gate, по умолчанию выключен |

Trust резолвится по источнику и по репозиторию: `owner/repo` из белого списка даёт
`trusted`/`verified`, иначе `community`. Записи агрегатора (skills.sh) наследуют trust
от `resolved_github_id`.

> **Не путать с project-trust.** `trust_level` здесь — доверие к **источнику/записи реестра**
> (иерархия `builtin…agent-created`, install-policy). Доверие к **локальному проектному каталогу**
> скиллов (бинарное trusted/untrusted, `skills.trustedProjectDirs`, команды
> `synth skills trust-project/untrust-project`) — mechanism [AD-046](./ad-046-skills-and-slash-commands.md);
> оно ортогонально и не переопределяется install-policy реестра.

> **Примечание.** Звёзды GitHub в этом окружении аномально завышены и не отражают
> доверие — в рейтинге/сортировке не используются. Значимы только вендор, подпись
> и лицензия.

### 4.2. Матрица install-policy

| Trust \ Вердикт | `safe` | `caution` | `dangerous` |
|---|---|---|---|
| `builtin` | allow | allow | allow |
| `verified` | allow | allow | block |
| `trusted` | allow | allow | block |
| `community` | allow | block | block |
| `agent-created` | allow | allow | ask |

`--force` понижает запрет только для `caution`: для `dangerous` в `verified`,
`trusted`, `community` установка отклоняется всегда. Для `agent-created` вместо
жёсткого блока используется `ask` — агент получает ошибку с причиной и может
перегенерировать контент без опасных конструкций.

### 4.3. Сканер безопасности (advisory)

Статический regex-сканер по всем файлам скилла. Категории: `exfiltration`,
`injection`, `destructive`, `persistence`, `network`, `obfuscation`. Каждое
совпадение — finding `{category, severity, file, line, description}`; вердикт
`safe | caution | dangerous` = максимум severity по `VERDICT_INDEX`.

- **Лимиты структуры:** `MAX_FILE_COUNT=50`, `MAX_TOTAL_SIZE_KB=1024`,
  `MAX_SINGLE_FILE_KB=256`; превышение → `caution`/`dangerous`.
- **Невидимый unicode:** zero-width/bidi/invisible-символы → finding `invisible_unicode`
  (сокрытие инструкций для LLM).
- **Бинарные расширения:** исключаются/флагуются, содержимое не исполняется.
- **Inline shell** (`` !`cmd` ``): конструкция механизма [AD-046](./ad-046-skills-and-slash-commands.md), по умолчанию **выключена** (`skills.inlineShell: false`); сканер независимо флагует shell-конструкции категориями `injection`/`destructive`.
- **`content_hash`:** sha256 отсортированного набора файлов; фиксируется в lock.
- **Кэш сканов:** ключ `sha256(source\0source_url)` + `content_hash` — повторный скан
  идентичного контента не выполняется.
- **`.skillignore` / `.clawhubignore`:** исключения при подсчёте структуры.
- **Advisory-этап не блокирует публикацию/установку сам по себе** — блокирует только
  матрица install-policy. Сканер лишь выносит вердикт.

### 4.4. Провенанс

- **`lock.json`** (`{dataDir}/skills/lock.json`): запись на установленный скилл —
  `{source, identifier, trust_level, scan_verdict, content_hash, install_path,
  files[], version, ref, scan_provenance, installed_at, updated_at, timestamp}`.
  Именно lock — источник истины для update/uninstall.
- **`taps.json`:** список внешних taps `{repo, path, label, trust_level, added_at}`.
  Taps добавляются только явно.
- **`audit.log`:** append-only JSONL — `install/update/uninstall/enable/disable/scan/
  trust_change/tap_add`; в аудит не пишутся секреты.
- **`quarantine/`:** всё скачанное распаковывается и сканируется здесь; при провале —
  удаляется/остаётся изолированно, в cache root не попадает.
- **Pin:** в lock пишется `ref` (commit SHA/тег) + `content_hash`. Update — только
  явная операция; автоматического «взять latest» нет. Откат — по сохранённому
  `content_hash`/предыдущей записи.

### 4.5. Безопасность установки

- **Path traversal / absolute path:** install_path валидируется и обязан
  заканчиваться на `<name>`; `..`, абсолютные пути и побег из cache root отклоняются.
- **Симлинки:** при копировании запрещены (не следуем, не создаём) — защита от
  выхода за cache root.
- **Cross-origin:** ссылки на контент вне объявленного источника не подтягиваются.
- **SSRF (URL-источник):** только https; запрет private/link-local/loopback и
  redirect на них; ограничение размера и таймаута.
- **Исполнение:** реестр не запускает код скилла; установка = копирование файлов.

### 4.6. Подписи и checksums

- **Индекс подписывается** (detached `skills.json.sig`); публичный ключ доверенной
  сборки вшит в Synth. Подпись не сошлась → индекс не принимается, используется
  stale-кэш.
- **`verified`-скиллы:** подпись контента (`skill.oms.sig`-совместимо) + governance-
  карта; отсутствие подписи понижает trust до `trusted`/`community`.
- **Checksums контента:** `content_hash` в индексе и lock; несовпадение при
  update → блок.

---

## 5. Дефолт и UX включения

**Дефолт: внешние каталоги выключены.** Активен только `official` (свой каталог) и
уже установленные скиллы. Это осознанный выбор: «ноль интернета по умолчанию» вместо
«удобно, но небезопасно». Речь о **реестровых/удалённых** источниках
(github/well-known/url/skills.sh/taps). Локальные каталоги агентов-совместимости
(`.opencode/skills`, `.claude/skills`, `.agents/skills`) — read-only discovery
механизма [AD-046](./ad-046-skills-and-slash-commands.md); это не источники установки
и не подключаются через реестр.

При развёртывании/настройке Synth показывает **список рекомендуемых проверенных
источников** (вендорские), но ни один не включается автоматически. Пользователь/
админ отмечает нужные — только тогда адаптер активируется, попадает в `taps.json`
и участвует в поиске/установке.

### 5.1. Рекомендуемые источники

| Источник | Репозиторий / subpath | Trust | Лицензия |
|---|---|---|---|
| Synth (свой) | `official` | `builtin` | по каталогу |
| Anthropic | `anthropics/skills` → `skills` | `trusted` | per-skill: часть Apache-2.0; docx/pdf/pptx/xlsx — source-available |
| OpenAI | `openai/plugins` (**не** deprecated `openai/skills`) | `trusted` | по репозиторию |
| Vercel | `vercel-labs/agent-skills`, `vercel-labs/skills` | `trusted` | по репозиторию |
| Google | `google/skills` | `trusted` | Apache-2.0 |
| Microsoft | `microsoft/skills`, `microsoft/azure-skills` | `trusted` | MIT |
| AWS | `aws/agent-toolkit-for-aws` | `trusted` | Apache-2.0 |
| Cloudflare | `cloudflare/skills` | `trusted` | Apache-2.0 |
| Supabase | `supabase/agent-skills` | `trusted` | MIT |
| Hugging Face | `huggingface/skills` | `trusted` | Apache-2.0 |
| NVIDIA | `NVIDIA/skills` | **`verified`** | Apache-2.0; подпись `skill.oms.sig` — эталон supply-chain |

**Среднее/опционально** (включаются вручную, trust `community`): `mattpocock/skills`
(MIT, репутация автора), `cursor/plugins`, `obra/superpowers`, `lobehub`, `browse.sh`,
`Shopify/agent-skills`. Awesome-списки — **только discovery** (ссылки, не источник
установки).

**Низкое / НЕ включать по умолчанию:** `ClawHub` (`openclaw/clawhub`) — инцидент
ClawHavoc, в hermes помечен `community`; произвольные URL/`SKILL.md`; `garrytan/gstack`.
ClawHub может быть добавлен только как осознанный tap с `community`-trust и полным
сканером — и никогда как рекомендация.

---

## 6. Health floors и watchdog

Сборка индекса — CI-пайплайн собственного каталога (2×/сутки, аналог
`skills-index.yml`). Публикация индекса возможна только при выполнении «полов»:
деградация источника означает сбой краулера, а не реальное исчезновение контента.

| Источник | Floor |
|---|---|
| skills.sh | ≥ 10000 |
| lobehub | ≥ 100 |
| clawhub | ≥ 20000 (если включён; иначе источник не собирается) |
| official | ≥ 50 |
| github (вендорский taps) | ≥ 30 |
| browse.sh | ≥ 50 |
| **MIN_TOTAL** | **≥ 1500** |

При провале любого floor индекс **не публикуется**, сборка падает с диагностикой.
Второй контур — **freshness-watchdog** (внешний probe каждые 4 ч): проверяет
доступность опубликованного индекса, парсится ли JSON, и что `generated_at` не
старше **26 ч**; иначе — алерт. В Synth freshness-watchdog дополняется клиентской
проверкой возраста stale-кэша (§3).

---

## 7. API / UI / CLI

| Операция | API | CLI | UI | Назначение |
|---|---|---|---|---|
| browse | `GET /api/v2/skills/catalog` | `synth skills browse` | Каталог | Список по категориям/источникам |
| search | `GET /api/v2/skills/search?q=` | `synth skills search <q>` | Поиск | По name/description/tags |
| inspect | `GET /api/v2/skills/inspect` | `synth skills inspect <id>` | Карточка | Метаданные, лицензия, trust, версия, хеш, findings |
| install | `POST /api/v2/skills/install` | `synth skills install <id> [--ref --force]` | Кнопка | Скачать → quarantine → скан → policy → копирование |
| update | `POST /api/v2/skills/update` | `synth skills update [<name>]` | Обновить | По pinned ref/hash; явно |
| enable | `POST /api/v2/skills/:name/enable` | `synth skills enable <name>` | Тумблер | Доступность тулу `skill` (AD-046) |
| disable | `POST /api/v2/skills/:name/disable` | `synth skills disable <name>` | Тумблер | Скрыть из discovery |
| audit | `GET /api/v2/skills/audit` | `synth skills audit` | Вкладка аудита | Audit log + вердикты сканов |
| trust | `POST /api/v2/skills/trust` | `synth skills trust <source> --level` | Селектор (ADMIN) | Смена trust-уровня источника |
| uninstall | `DELETE /api/v2/skills/:name` | `synth skills uninstall <name>` | Удалить | По записи lock.json |
| taps | `GET/POST/DELETE /api/v2/skills/taps` | `synth skills taps add\|rm\|ls` | Настройки | Управление внешними источниками |

UI карточки обязателен для отображения: **лицензия**, **trust-уровень**, **источник**,
**content hash**, версия, вердикт сканера и число findings. RBAC: install/enable —
USER; trust/taps и глобальные источники — ADMIN (совместимо с ролевой моделью
backend). Установка никогда не происходит автоматически: только явное действие.

---

## 8. Связь с AD-046 и другими AD

- **[AD-046](./ad-046-skills-and-slash-commands.md) (парный):** формат `SKILL.md`, discovery, доставка, тул `skill`,
  slash-команды, binding `agents`/`groups`, project-trust гейт. AD-068 поставляет
  контент, индекс и доверие; AD-046 потребляет установленное. Реестр **не**
  переопределяет формат.
- **AD-023 (конфигурация):** секция `skills` в `config.yaml` (источники, TTL кэша,
  install-policy overrides, путь cache root) по общему приоритету CLI > env > config >
  defaults; ключи — `SYNTH_SKILLS_*`.
- **AD-029 (permissions):** установка/обновление скиллов — это mutating-операции;
  политики `allow/deny/ask` распространяются на инструменты реестра. `dangerous`-блок
  не обходится настройкой permission.
- **AD-036 (Gateway) / AD-037 (security step):** тот же принцип «независимый слой
  безопасности»; сканер реестра — статический аналог для контента. Аудит установок
  совместим с аудит-логом безопасности.
- **AD-038 (npm):** builtin-каталог и схема доставляются как npm-пакет
  (`@itphx/synth`-зависимость), индекс публикуется из CI каталога; никакого
  копирования ассетов между пакетами.
- **AD-045 (dataDir):** все данные реестра (кэш индекса, `lock.json`, `taps.json`,
  `audit.log`, `quarantine/`, cache root) — в едином `dataDir`, вне репозитория,
  атомарная запись (AD-005).
- **AD-042 (гибрид):** в гибридном режиме индекс и установка доступны локально;
  при недоступности сети — stale-кэш и установка только из уже закэшированного
  (remote-операции — по правилам offline-деградации).
- **AD-046 §4.5 / AD-071 §2.4, §2.9 (уровни и включение):** реестр переиспользует
  модель уровней `system`/`project`/`session` и enable/disable (группами и точечно)
  — см. §8.1; собственной модели уровней реестр не вводит.

### 8.1. Уровни и включение (переиспользование AD-046/AD-071)

Реестр скиллов/агентов **не дублирует** модель уровней и включения:

- **уровни** `system`/`project`/`session` и merge `system > project > session` —
  [AD-046](./ad-046-skills-and-slash-commands.md) §4.5 (для скиллов) и
  [AD-071](./ad-071-mcp-servers-prompt.md) §2.4 (для MCP);
- **enable/disable** группами и отдельными записями, неотключаемость механизма —
  там же; реестр хранит статус включения и историю (`audit.log`, §4.4), UI-тумблеры
  enable/disable (§7) работают поверх этой модели;
- **уровень записи** в индексе/lock (`level`, `origin`) — поле реестра, обогащающее
  карточку (как `source`/`identifier`/`version`, §2), а не новый формат frontmatter.

---

## 9. Фазы реализации

**Фаза 1 — свой репозиторий + индекс + установка из GitHub.**
Отдельный репозиторий с деревом категорий и 15–25 стартовыми скиллами; генератор
индекса + CI; TTL-кэш и stale-fallback; адаптеры `official` и `github`; установка
в cache root с `lock.json`; базовые CLI/API browse/search/install/uninstall.
Тесты: схема индекса, кэш/сталей, валидация install_path, идемпотентность установки,
дедупликация name/identifier.

**Фаза 2 — trust / guard / подписи.**
Уровни `builtin/verified/trusted/community/agent-created`; матрица install-policy;
сканер (6 категорий, лимиты, невидимый unicode, кэш, `.skillignore`); quarantine,
audit log, `taps.json`; подпись индекса и checksum-проверка; SSRF/симлинк/path-
traversal-защита. Тесты: фикстуры на каждую категорию сканера, dangerous-контент,
`--force` не обходит dangerous, подпись/подмена индекса, обход cache root.

**Фаза 3 — UI каталога + agent-packs + внешние адаптеры.**
UI browse/search/inspect/install/enable/audit/taps; отображение лицензии/trust/источника/
хеша; agent-packs и `AGENT.md`; адаптеры `own-index`, `well-known`, `url`, `skills.sh`,
внешние taps; рекомендуемые вендорские источники с явным включением; health floors +
watchdog. Тесты: UI-сценарии (Playwright), адаптеры на mock-серверах, health floors и
watchdog, offline-поведение.

Общие требования к тестам: Vitest — юниты ядра реестра; API-тесты — curl/эндпоинты;
UI — smoke через dev-сервер; фикстуры вредоносных скиллов — в тестовом каталоге, не в
рабочем cache root.

---

## 10. Что НЕ делаем

- **ClawHub по умолчанию** — не включаем, не рекомендуем; только осознанный tap с
  `community`-trust и полным сканером.
- **Auto-install без согласия** — никаких автоматических установок по результатам
  поиска или по запросу агента без явного действия пользователя/админа.
- **Отключение guard'а** — сканер и install-policy не имеют глобального «выключить
  насовсем»; можно лишь добавить явный tap/повышенный trust с аудитом.
- **Unpinned версии** — установка/обновление всегда фиксируют `ref`/`content_hash`;
  «всегда latest» запрещено.
- **Доверие по звёздам** — не используем как критерий.
- **Исполнение кода скиллов реестром** — только доставка файлов.
- **Дублирование формата `SKILL.md`** — это AD-046.

---

## 11. Открытые вопросы

1. **Имя репозитория** — `synth-skills`? Домен/организация (GitVerse vs GitHub).
2. **Формат `AGENT.md` и agent-packs** — схема `pack.json`, семантика groups/binding.
3. **Кто владелец индекса** — CI каталога или отдельный сервис; ключ подписи и его
   ротация.
4. **Судьба `verified` vs `trusted`** — не слить ли, если подписанных вендоров будет
   больше одного.
5. **Хранение cache root** — `{dataDir}/skills/` или проектный `.synth/skills/` для
   проектных скиллов (гейт — [AD-046](./ad-046-skills-and-slash-commands.md)).
6. **TTL индекса и политика stale** — значения по умолчанию (предлагается TTL 6 ч,
   stale ≤ 7 суток с предупреждением).
7. **Совместимость версий** — правила `minSynth` и что делать со старым скиллом при
   обновлении Synth.

---

## Последствия

**Плюсы:** единая точка входа для скиллов и агентов; проверенные источники и
управляемое доверие; воспроизводимость установки (pin + lock); аудит и откат;
не-IT категории с самого начала; безопасный дефолт (внешние каталоги выключены).

**Минусы/риски:** поддержка собственного каталога и CI; ложные срабатывания сканера
(advisory, не блокирует без policy); необходимость обновлять индекс и следить за
freshness; расхождение trust-моделей с внешними агрегаторами.

**Связи:** AD-046 (механизм), AD-005 (атомарная запись), AD-023 (конфиг), AD-025/026
(агенты/контекст), AD-029 (permissions), AD-036/037 (безопасность), AD-038 (npm),
AD-042/045 (гибрид/dataDir).
