# ADR-005: JSON-файлы как хранилище

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический ADR-005 прототипа переписан под as-built TS-стек)

**Решение:** runtime-данные (сессии, проекты, провайдеры, модели, агенты, профили) хранятся как JSON-файлы в каталоге данных `$SYNTH_DATA_DIR`. Каждая запись — отдельный файл, имя которого совпадает с `id` сущности. Запись атомарная: содержимое пишется во временный файл `.tmp.{uuid}` и затем переименовывается через `rename()` в целевой файл — читатель никогда не видит частично записанный JSON.

**Контекст:** прототип (ADR-005 в `archive/AGENTS_OLD.md`) хранил сессии как JSON-файлы в `data/sessions/`. Обоснование — простота, отсутствие зависимости от БД, лёгкость бэкапа и анализа. В текущем TS-стеке решение сохранено и обобщено на все сущности; целевое хранилище в перспективе — PostgreSQL (ADR-097, не реализовано), поэтому слой хранения изолирован за интерфейсами и единым каталогом данных.

**Структура каталога данных:**

```
$SYNTH_DATA_DIR/
├── sessions/       # сессии (FileStore)      → {id}.json
├── projects/       # проекты (ProjectStore)  → {id}.json
├── providers/      # провайдеры LLM
├── models/         # модели
├── agents/         # определения агентов
├── context/        # конфигурация контекста
└── auth/           # profiles/, states/, sessions
```

В разработке `dev.sh` задаёт `SYNTH_DATA_DIR` вне репозитория. Путь резолвится: `SYNTH_DATA_DIR` или `storage.dataDir` в `config.yaml` (дефолт `/var/synth/data`).

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| `atomicWrite()` | `packages/shared/src/utils/index.ts` | write в `.tmp.{uuid}` → `rename()`; общий примитив для всех хранилищ |
| `AsyncLock` | `packages/shared/src/utils/index.ts` | асинхронный мьютекс: сериализует записи одной сущности |
| `FileStore` | `packages/core/src/storage/file-store.ts` | сессии: load/save/delete/list, per-session lock, сериализация `Session` ↔ JSON |
| `ProjectStore` | `packages/core/src/storage/project-store.ts` | проекты: JSON в `projects/{id}.json` |
| `JsonStore` | `packages/core/src/storage/json-store.ts` | типовое JSON-хранилище для провайдеров/моделей/агентов |
| `runtime-settings.ts` | `packages/core/src/storage/runtime-settings.ts` | `settings.json` (workspace override) |

`atomicWrite` также используется для `profiles.json`/`credentials.json` (`packages/core/src/profiles.ts`, `packages/core/src/remote/credentials.ts`) и прочих sidecar-хранилищ.

**Совместимость / миграция:** FileStore сам восстанавливает части (`parts`) из плоских `content`/`reasoning`/`tool_calls` при чтении (`deserializeMessage`), что упрощает эволюцию схемы. Прямая запись в JSON-файлы в обход API запрещена (см. AGENTS.md, «Типичные ошибки»), кроме багфиксов самого хранилища и миграций.

**Связь:** ADR-097 (миграция физического хранилища на PostgreSQL) — не реализовано; логическая модель (`parent_id`, `seq`, `origin`, `parts`) уже живёт в этой JSON-схеме.
