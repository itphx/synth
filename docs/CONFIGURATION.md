# Конфигурация Synth

## Приоритет

```
CLI-флаги > env vars (SYNTH_*) > config.yaml > defaults
```

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `SYNTH_API_KEY` | Ключ для входа в API | — |
| `SYNTH_DATA_DIR` | Каталог данных (сессии, файлы) | `/var/synth/data` |
| `SYNTH_CONFIG` | Путь к `config.yaml` | каскадный поиск |
| `SYNTH_PORT` | Порт бэкенда | `5000` |
| `SYNTH_CORE_PORT` | Порт core | `4300` |
| `SYNTH_RUNNER_PORT` | Порт раннера | `5200` |
| `SYNTH_AUTH_DEBUG` | Режим отладки auth (тестовые пользователи) | `false` |
| `SYNTH_BACKEND_URL` | URL бэкенда (для раннера) | `http://localhost:5000` |
| `SYNTH_CORS_ORIGIN` | CORS origin (приоритет выше конфига) | — |

**UI (Vite):**

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `VITE_BACKEND_URL` | URL бэкенда (прокси Vite) | `http://localhost:5000` |
| `VITE_PORT` | Порт dev-сервера Vite | `5002` |
| `VITE_ALLOWED_HOSTS` | Разрешённые хосты (`true` — все) | `true` |

**Провайдеры LLM (см. [LLM_PROVIDERS.md](LLM_PROVIDERS.md)):**

| Переменная | Назначение |
|-----------|------------|
| `SYNTH_PROVIDER_<NAME>_URL` | URL провайдера |
| `SYNTH_PROVIDER_<NAME>_API_KEY` | API-ключ |
| `SYNTH_PROVIDER_<NAME>_MODEL` | Модель по умолчанию |
| `SYNTH_PROVIDER_<NAME>_TYPE` | Тип: `openai`, `anthropic`, `ollama` |

## config.yaml

Каскадный поиск (от высшего приоритета к низшему):

1. `--config` CLI-флаг или `SYNTH_CONFIG` env var
2. `./synth.config.yaml` (CWD)
3. `./config.yaml` (CWD)
4. `~/.config/synth/config.yaml` (пользовательский)
5. `/etc/synth/config.yaml` (системный)

### Пример

```yaml
server:
  port: 5000

storage:
  dataDir: "/var/synth/data"   # каталог данных вне репозитория

llm:
  defaultProvider: ""           # пусто — админ настраивает сам
  defaultModel: ""

core:
  port: 4300
  apiKey: ""

runner:
  port: 5200
  backendUrl: "http://localhost:5000"

ui:
  port: 5002
  backendUrl: "http://localhost:5000"
```

## Первый запуск

- `ensureDataDir()` создаёт структуру подкаталогов в `dataDir`
- `createDefaultConfig()` опционально пишет `config.yaml` с дефолтами

## Права доступа к файлам

- `config.yaml` — `600` (rw-------)
- `data/` — вне репозитория, в `.gitignore`
- API-ключи — никогда не коммитить
