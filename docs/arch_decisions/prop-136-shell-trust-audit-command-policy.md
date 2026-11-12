# PROP-136: Модель доверия shell: аудит исполнений и внешний чекер команд

> **Статус:** 🧩 Предложение — shell считается произвольным кодом: append-only аудит исполнений (30 дней, без тел вывода, блок при сбое записи) + внешний чекер команд на исполнителе
> **Решение до:** 2026-11-30
> **Дата:** 2026-11-12
> **Обсуждено:** 2026-11-11…12 — решения владельца зафиксированы в тексте; ожидает утверждения и отмашки на реализацию.
> **Источник:** обсуждение 2026-11-11…12 (аудит места исполнения тулов, модели доверия shell, изоляции исполнителя).
> **Связано:** [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-077](./adr-077-runtime-toolchain.md), [ADR-094](./adr-094-observability-metrics.md), [ADR-099](./adr-099-egress-tls-trust.md), [PROP-135](./prop-135-execution-topology-pools-profiles.md), [PROP-137](./prop-137-executor-isolation-nonroot-network.md)

## Решение (предложение)

### Позиционирование

Shell — **произвольный код** с доступом к файловой системе и сети. Надёжного контроля shell, `curl` и подобных команд не существует. `shell-guard` и path-периметр shell (`external_directory`, `askKind: 'external'`) — это **guardrail и UX**, а не граница безопасности.

Следствия:

- из документов убираются формулировки, которые можно прочитать как «shell изолирован» ([ADR-029](./adr-029-granular-permissions.md), `docs/TOOLS.md`, `docs/EXECUTION.md`);
- контроль сети для shell — только CNI/NetworkPolicy и egress-прокси ([PROP-137](./prop-137-executor-isolation-nonroot-network.md), [ADR-099](./adr-099-egress-tls-trust.md)); app-level egress на shell **не действует**;
- вместо мнимой изоляции вводится **наблюдаемость и внешнее решение**: журнал исполнений и чекер команд.

### Аудит исполнений

Append-only журнал (по образцу `EgressRequestLogEntry`), **отдельный** от `SecurityAuditEntry`:

```ts
CommandAuditEntry {
  id: string;                 // = execution_id
  seq: number;                // монотонный в пределах исполнителя
  ts: string;
  sessionId?: string;
  projectId?: string;
  actor?: string;
  agentRole?: string;
  profile?: string;
  poolKey?: string;
  tool: string;               // execute_shell | sandbox_exec | …
  command: string;            // ≤ 4 КиБ, редактирован
  commandHash: string;
  cwd: string;
  background: boolean;
  processId?: string;
  decision: 'allow' | 'deny' | 'ask';
  decidedBy: 'permission' | 'provider' | 'policy';
  matchedRule?: string;
  provider?: { kind: string; ruleId?: string; latencyMs?: number };
  exitCode?: number;
  durationMs?: number;
  bytesOut?: number;
  truncated?: boolean;
  outputSha256?: string;
}
```

Правила:

- **тела stdout/stderr не пишутся** — только размер, hash и флаг обрезки;
- редакция значений `secrets[]` вызова выполняется **на исполнителе**, карта обфускации сессии применяется в control plane;
- хранение **30 дней** (`prune(days)`), insert-only; в PostgreSQL у роли приложения отзываются `UPDATE`/`DELETE`;
- опционально hash-chain `prevHash` — защита от подмены задним числом;
- доступ: `GET /api/v2/audit/commands` (ADMIN/AUDITOR; владелец проекта — свои записи), CSV-экспорт, вкладка «Безопасность» в UI;
- **сбой записи аудита блокирует выполнение**, если аудит включён: managed — включён по умолчанию, standalone — выключен по умолчанию (при явном включении блокирует и там);
- метрики: `synth_command_audit_written_total`, `synth_command_audit_failed_total`, `synth_command_audit_seq_gap_total` (контракт [ADR-094](./adr-094-observability-metrics.md)).

### Внешний чекер

Интерфейс `CommandPolicyProvider`. Вызов — **на исполнителе**, синхронно до `spawn` (единственная точка принуждения) + зеркально в control plane для раннего отказа и UX.

Контракт `http-json`:

```
POST /v1/check
{ execution_id, ts, tool, command, cwd, project_id, session_id, actor,
  agent_role, profile, background, timeout_ms, secrets: [имена] }
→ 200 { action: "allow" | "deny", reason?, rule_id?, ttl_ms? }
```

- команда обрезается до 4 КиБ; значения env и секретов **не передаются** (только имена);
- адаптеры: `http-json`, `opa` (трансляция в `POST /v1/data/synth/exec/decision`, `input`/`result`), `plugin` (in-process `HookBus.pre_tool_use`, [ADR-030](./adr-030-hooks-agent-events.md));
- кэш вердикта по `sha256(command) + profile + policyVersion` с TTL;
- таймаут обязателен; `failMode`: managed — `closed`, standalone — `open`;
- `ask` чекер **не возвращает** — человеческое подтверждение остаётся в permission-слое ([ADR-029](./adr-029-granular-permissions.md));
- чекер судит **только по тексту команды** и не видит ФС, сеть и env — это ограничение фиксируется явно, и никакой парсинг команд не считается защитой.

### Связь записей

На каждый вызов — **две** записи: решение (permission/чекер) и факт исполнения, коррелируются `execution_id`; расхождение — сигнал тревоги. Пишет исполнитель (локально, `fsync`, `seq`, батчами отправляет в control plane), канон — журнал control plane; дубли отсекаются по `execution_id`, пропуски определяются по `seq`.

## Границы

Не входит: песочница и изоляция ([PROP-137](./prop-137-executor-isolation-nonroot-network.md)), сетевой контроль shell (только CNI/прокси), парсинг команд как защита, allowlist команд как граница безопасности.

## Этапы

- **Ф1** — `CommandAuditEntry` + порт + запись на исполнителе и в control plane + API/CLI.
- **Ф2** — чекер `http-json` + `opa` + `failMode` + метрики.
- **Ф3** — редакция секретов и hash-chain.
- **Ф4** — UI-вкладка и экспорт.

## Влияние на документы

Будущий ADR (после реализации); аддендум [ADR-029](./adr-029-granular-permissions.md) (guardrail, канонические пути/результаты); [ADR-099](./adr-099-egress-tls-trust.md) (app-level egress не действует на shell); `docs/EXECUTION.md` (раздел «модель доверия»); `docs/OBSERVABILITY.md`; `docs/API_V2.md`; `docs/TOOLS.md`; `docs/CONFIGURATION.md`.

## История

- 2026-11-12 — документ создан: зафиксированы модель доверия shell, формат аудита исполнений и контракт внешнего чекера (обсуждение 2026-11-11…12).
