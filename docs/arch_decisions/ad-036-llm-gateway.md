# AD-036: LLM Gateway — независимый слой безопасности

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** декоратор `GatewayProvider extends BaseProvider` в `@itphx/synth-core`, оборачивающий все LLM-вызовы (покрывает 11 точек: tool-loop, fallback-эскалация, debug, суммаризация, auto-title, саб-агенты, micro-LLM). Защита данных: детекция секретов, обфускация, деобфускация в точках потребления, rate limiting, аудит и cost tracking. Полностью независимый компонент — не связан с выбором модели, маршрутизацией или фильтрацией запросов. **HTTP-прокси не нужен** — весь LLM-трафик in-process, backend/runner получают gateway «бесплатно» через `ChatOrchestrator`.

**Контекст:** промпты и ответы агентов могут содержать секреты (API-ключи, токены, карты, email). При прямом вызове LLM-провайдера секрет уходит наружу и оседает в логах провайдера. Gateway перехватывает трафик и не допускает утечки, при этом пользователи продолжают работать со своими данными внутри доверенной зоны.

**Принципы:**
- **Выключен по умолчанию.** Весь слой защиты — опция. Пока не включён — трафик идёт напрямую, без задержек.
- **Если включён — по умолчанию обфусцируем**, а не блокируем. Блокировка — отдельный режим.
- **Независимость.** Работает на уровне «запрос → провайдер → ответ → потребление».
- **Наследование секретов.** Карта обфускации живёт в сессии независимо от глобального тумблера — после отключения шлюза старые плейсхолдеры остаются раскрываемыми.

**Точка перехвата:** `ProviderPool.getProvider` + `orchestrator._getProvider/_routeProvider` оборачивают провайдер в `GatewayProvider`. Если шлюз выключен — возвращается оригинальный провайдер без изменений (обратная совместимость).

**Два режима Input Guard:**

| Режим | Поведение |
|---|---|
| **obfuscate** (default при включении) | Секрет заменяется на `⟦SYNTH_SECRET_N⟧`, карта сохраняется, запрос идёт в LLM |
| **block** | Секрет найден → запрос блокируется, возвращается warning, в LLM ничего не уходит |

**Плейсхолдер:** `⟦SYNTH_SECRET_N⟧` (юникод-скобки U+27E6/27E7 + префикс `SYNTH_`). Выбран вместо `{{SECRET_N}}` — двойные фигурные скобки конфликтуют с шаблонными движками (Mustache/Handlebars/Vue), юникод-скобки не встречаются в коде. Regex: `⟦SYNTH_SECRET_(\d+)⟧`.

**Обфускация:**

```
Вход:  "мой ключ sk-abc123 используй для подключения"
       ↓ obfuscate (карта: ⟦SYNTH_SECRET_1⟧ → sk-abc123)
       "мой ключ ⟦SYNTH_SECRET_1⟧ используй для подключения"
       ↓ LLM
Ответ: "Подключение с ⟦SYNTH_SECRET_1⟧ установлено"
       ↓ деобфускация НЕ в стриме, а в точках потребления
```

**Карта обфускации (словарь):**
- Хранится в **`Session.obfuscationMap`** (`Record<string, string>`), сериализуется в `FileStore` как `obfuscation_map`. Живёт всю сессию, не теряется.
- Сама карта — секрет: доступ только у админов и аудиторов (вкладка «Словарь обфускации» в правой панели UI).
- Сгенерированные моделью `⟦SYNTH_SECRET_N⟧` (которых нет в карте) — **не восстанавливаются**.

**Отображение в UI:**
- В ответе и в сообщениях пользователя секрет отображается как плейсхолдер `⟦SYNTH_SECRET_N⟧` — бейдж `SecretPlaceholder`.
- Реальные значения встраиваются в `message.metadata.secrets` — клик раскрывает локально.
- Раскрытие логируется в аудит (`type: revealed`).

**Деобфускация — только в точках потребления:**

| Точка | Когда |
|---|---|
| Запись файла | Перед write_file/edit_file — restore |
| Shell-команда | Перед exec — restore аргументов |
| Веб-запрос | Перед web_fetch/web_search — restore url/query |
| Git-операции | Перед exec — restore |
| Поиск | Перед grep — restore |
| MCP-вызов | Перед callTool — restore аргументов |

Стриминг ответа идёт как есть (с плейсхолдерами) — никаких буферов и задержек. Деобфускация только на финальном собранном ответе (chat) и в точках потребления.

**Output Guard:**
- Детекция секретов в ответе модели (галлюцинированные ключи, extraction-попытки) — пишется в аудит `output_guard`
- Подозрительные URL и команды

**Rate Limiting:**
- **Индивидуальный** — N запросов/мин на пользователя (`rateLimit.userPerMinute`)
- **Общий** — M запросов/мин на провайдера (`rateLimit.providerPerMinute`, защита от исчерпания квоты)
- Реализация: in-memory sliding window на уровне провайдера в core — покрывает и внутренние LLM-вызовы (суммаризация, auto-title, саб-агенты), а не только HTTP-запросы

**Аудит и Cost:**
- Хранение: **JSONL-файл** `{dataDir}/audit/llm-gateway.jsonl`, append-only, одна строка = одна запись (атомарный append, tail-friendly)
- Просмотр: `GET /api/v2/audit` (RBAC ADMIN/AUDITOR, фильтры `userId/sessionId/since/until/limit`) + CLI `synth audit`
- Формат записи: `{ts, type, sessionId, userId, provider, model, secretsFound, placeholders, tokensIn, tokensOut, costUsd, reason}`. Типы: `obfuscated`, `blocked`, `revealed`, `rate_limited`, `output_guard`
- Секреты в логах — только как плейсхолдеры
- Cost-трекинг: счётчики `inputCost/outputCost` в `_saveAssistantMessage`

**Конфигурация:**

```yaml
# config.yaml
llmGateway:
  enabled: false          # выключен по умолчанию
  inputMode: "obfuscate"  # obfuscate | block
  rateLimit:
    userPerMinute: 60
    providerPerMinute: 120
  audit:
    enabled: true
    logPath: ""           # по умолчанию {dataDir}/audit/llm-gateway.jsonl
```

- Глобальный тумблер вкл/выкл: секция «Шлюз безопасности» в настройках UI (только ADMIN)
- Per-session override — не требуется, тумблер глобальный

**Реализация:** каталог `packages/core/src/engine/gateway/` (`secret-detector.ts`, `obfuscator.ts`, `input-guard.ts`, `output-guard.ts`, `rate-limiter.ts`, `audit-logger.ts`, `gateway-provider.ts`, `obfuscation-map-store.ts`).

**Что не делаем в демо:**
- ML-детекция секретов (только regex)
- Распределённый rate limit (per-process)

Дополняющее решение — [AD-037: Security step перед коммитом](./ad-037-commit-security-step.md) (pre-commit hook + маркер-хеш).
