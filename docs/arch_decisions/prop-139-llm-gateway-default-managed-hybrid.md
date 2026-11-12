# PROP-139: LLM-шлюз по умолчанию включён в managed и hybrid

> **Статус:** 🧩 Предложение — `llmGateway.enabled` по умолчанию `true` для managed и hybrid, `false` для standalone; приоритет настроек не меняется
> **Решение до:** 2026-11-30
> **Дата:** 2026-11-12
> **Обсуждено:** 2026-11-11…12 — решения владельца зафиксированы в тексте; ожидает утверждения и отмашки на реализацию.
> **Источник:** обсуждение 2026-11-11…12 (аудит места исполнения тулов, модели доверия shell, изоляции исполнителя).
> **Связано:** [ADR-036](./adr-036-llm-gateway.md), [ADR-045](./adr-045-hybrid-server-profiles.md), [ADR-035](./adr-035-micro-model-first.md)

## Решение (предложение)

**Текущее состояние.** `llmGateway.enabled` по умолчанию `true` для backend/managed (`packages/backend/src/lib/app-config.ts` передаёт `baseDefaults: { llmGateway: { enabled: true } }`) и `false` для standalone. Hybrid-контур (локальный core + центральный сервер, [ADR-045](./adr-045-hybrid-server-profiles.md)) в дефолтах **не учтён**. Внешний аудит систематически фиксирует это как замечание.

**Решение:** **managed — `true` (уже), hybrid — `true`, standalone — `false`.**

- hybrid определяется при старте локального core (активное подключение к центральному серверу по [ADR-045](./adr-045-hybrid-server-profiles.md)) и добавляет профильный `baseDefaults: { llmGateway: { enabled: true } }`;
- приоритет не меняется: CLI > `SYNTH_LLM_GATEWAY_ENABLED`/env > `config.yaml` > runtime-тумблер UI > профильный дефолт > общий дефолт;
- явное отключение остаётся возможным;
- `/health`/`/ready` при выключенном шлюзе продолжают отдавать `llmGateway: "disabled"` и предупреждение — это не ошибка готовности.

## Этапы

- **Ф1** — определить шов определения hybrid при загрузке конфига.
- **Ф2** — профильный дефолт + тесты (`managed`/`hybrid`/`standalone`, явное отключение, приоритет env/runtime).
- **Ф3** — документация.

## Влияние на документы

`docs/CONFIGURATION.md` + `docs/en/CONFIGURATION.md` (строка про дефолты профилей), корневой `AGENTS.md` (инвариант 25), аддендум [ADR-045](./adr-045-hybrid-server-profiles.md), заметки релиза.

## История

- 2026-11-12 — документ создан: зафиксирован профильный дефолт LLM-шлюза для hybrid (обсуждение 2026-11-11…12).
