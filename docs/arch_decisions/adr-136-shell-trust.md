# ADR-136: Модель доверия shell — аудит исполнений и внешний чекер команд

> **Статус:** ⚠️ Частично — реализовано: append-only журнал исполнений (`CommandAuditEntry`),
> аудит на исполнителе и в control plane, `CommandPolicyProvider` (`http-json`/`opa`, fail modes,
> вызов до `spawn` + зеркало в control plane), `decidedBy: 'policy'`, журнал в UI и CSV.
> Остаток: plugin-провайдер политики, PG-репозиторий журнала, runtime-переключение чекера.
> **Дата:** 2026-11-13
> **Источник:** PROP-136 (файл удалён после принятия).
> **Связано:** [ADR-029](./adr-029-granular-permissions.md) (permissions), [ADR-135](./adr-135-execution-contour.md)
> (контур исполнения), [ADR-137](./adr-137-executor-isolation.md) (изоляция), [ADR-094](./adr-094-observability-metrics.md)
> (метрики), [ADR-099](./adr-099-egress-tls-trust.md) (egress); спецификация — [docs/EXECUTION.md](../EXECUTION.md) §9.1–9.2,
> конфиг — [docs/CONFIGURATION.md](../CONFIGURATION.md) §«Аудит исполнений shell», API — [docs/API_V2.md](../API_V2.md) §5.18.

## Контекст

Shell — произвольный код с доступом к ФС и сети. `shell-guard`, path-периметр и permission-слой — это
**guardrail и UX**, а не граница безопасности: команду можно обойти через `curl`, интерпретатор, сборку.
Формулировки «shell изолирован» удалены из ADR-029/`docs/TOOLS.md`/`docs/EXECUTION.md`. Вместо мнимой
изоляции нужны наблюдаемость и внешнее решение: журнал исполнений и чекер команд.

## Решение

1. **Аудит исполнений — отдельный append-only журнал.** `CommandAuditEntry` (идентификатор =
   `execution_id`, `seq` монотонный, `sessionId`/`projectId`/`actor`/`agentRole`/`profile`/`poolKey`,
   `tool`, обезличенная `command` ≤ 4 КиБ, `commandHash`, `cwd`, `background`, `decision`
   (`allow|deny|ask`), `decidedBy` (`permission|provider|policy`), `matchedRule`, `provider?`,
   `exitCode`/`durationMs`/`bytesOut`/`truncated`/`outputSha256`). Пишутся **две записи** на запуск —
   `phase: "started"` до и `phase: "finished"` после (один `id`); **тела stdout/stderr не пишутся** —
   только размер, hash и флаг обрезки. Журнал `{dataDir}/audit/commands.jsonl`
   (`security.commandAudit.path`), в PostgreSQL — insert-only (у роли приложения отзываются
   `UPDATE`/`DELETE`), retention **30 дней** (`DELETE /api/v2/audit/commands?older_than_days=N`, ADMIN).
2. **Сбой записи блокирует выполнение.** Сбой записи `started` при включённом аудите — команда **не
   исполняется**, модель получает `isError` с причиной; сбой `finished` — warning (команда уже
   выполнена). Managed — аудит включён по умолчанию, standalone — выключен (при явном включении
   блокирует и там).
3. **Обезличивание — в два слоя.** Значения карты обфускации сессии (ADR-036) заменяются
   плейсхолдерами, затем редакция шаблонов (`Bearer …`, `--password=`/`--token=`/`--api-key=`, URL с
   userinfo → `***`), затем обрезка до 4 КиБ; `commandHash` — sha256 полной обезличенной строки.
4. **Внешний чекер `CommandPolicyProvider` — единственная точка принуждения на исполнителе.** Вызов
   синхронно **до `spawn`** и до подготовки секретов (для фонового запуска — до создания процесса);
   контракты `http-json` (`POST /v1/check`) и `opa` (`POST /v1/data/synth/exec/decision`), адаптер
   `plugin` (in-process `HookBus.pre_tool_use`) — остаток. Команда обрезается до 4 КиБ; значения env и
   секретов **не передаются** — только имена. Таймаут обязателен; `failMode`: managed — `closed`,
   standalone — `open`; недоступность чекера не кэшируется. Кэш вердикта — по
   `sha256(command + cwd + background)`, TTL из ответа/конфига. Отказ → `403 policy_denied`
   (`ExecutionError.reason = 'policy_denied'`, код `EPOLICY`), команда не запускается.
   `ask` чекер **не возвращает** — человеческое подтверждение остаётся в permission-слое (ADR-029).
   Чекер судит **только по тексту команды** и не видит ФС/сеть/env — это ограничение, зафиксированное
   явно; парсинг команд защитой не считается.
5. **Зеркало в control plane — ранний отказ и UX, не граница.** Перед аудитом `started` команда
   уходит тому же чекеру (`security.commandPolicy`, env `SYNTH_COMMAND_POLICY_*`); `deny` →
   `isError: true` («Command denied by policy: …») и **одна** запись журнала (`decision: "deny"`,
   `decidedBy: "policy"`, `durationMs: 0`); `allow` → обе записи несут `decidedBy: "policy"` и
   `provider`. В `inline` зеркало — единственный внешний голос, но границей безопасности не является.
6. **Доступ и наблюдаемость.** `GET /api/v2/audit/commands` (managed — ADMIN/AUDITOR, standalone —
   `requireAuth`) с фильтрами `session_id`/`project_id`/`from`/`to`/`decision` и `limit` (строго целое
   > 0, ≤ 1000); вкладка «Безопасность» в UI и CSV-выгрузка. Метрики:
   `synth_command_audit_{written,failed,dropped}_total`, `synth_command_policy_*` (control plane) и
   `synth_executor_command_policy_*` (исполнитель) — по контракту ADR-094, серии не суммируются.
7. **Секреты — только файлом.** Токены чекера (`SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE`,
   `security.commandPolicy.tokenSecret`/`SYNTH_COMMAND_POLICY_TOKEN`) читаются из файла и не попадают
   в env, values, логи и тексты ошибок; заданный, но нечитаемый файл — ошибка старта (fail-closed).

## Альтернативы

- **Allowlist/парсинг команд как граница** — отклонено: обходится интерпретатором, `curl`, сборкой;
  даёт ложное чувство защиты.
- **Аудит в памяти с периодическим сбросом** — отклонено: след нужен после инцидента; журнал append-only
  и insert-only.
- **`ask` из чекера** — отклонено: человеческое подтверждение — только permission-слой (ADR-029), иначе
  два владельца решения.
- **Проверка только в control plane** — отклонено: при `remote` команда исполняется на исполнителе,
  и обход control plane оставил бы запуск без проверки.

## Последствия

- **Плюсы:** каждое исполнение shell/sandbox наблюдаемо и коррелируется по `execution_id`; внешняя
  политика может запретить команду до запуска; расхождение «решение/факт» — сигнал тревоги.
- **Минусы:** синхронный сетевой вызов перед каждой командой (кэш и TTL смягчают); при `failMode:
  closed` недоступность чекера останавливает shell; журнал требует ротации/ретеншна.
- **Остаток:** plugin-провайдер политики, PG-репозиторий журнала, runtime-переключение чекера (сейчас —
  только рестарт).

## История

- 2026-11-13 — принято из PROP-136 (реализация Ф1–Ф4); файл предложения удалён.
