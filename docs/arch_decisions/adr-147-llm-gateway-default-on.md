# ADR-147: LLM-шлюз включён по умолчанию во всех профилях

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-18
> **Источник:** решение владельца (ревью 2026-11-18).
> **Заменяет:** [ADR-139](./legacy/adr-139-llm-gateway-hybrid.md).
> **Связано:** [ADR-036](./adr-036-llm-gateway.md) (LLM Gateway), [ADR-023](./adr-023-configuration.md) (приоритет конфига), [ADR-045](./adr-045-hybrid-server-profiles.md) (гибрид), [ADR-094](./adr-094-observability-metrics.md) (health).

## Контекст

ADR-139 сделал `llmGateway.enabled: true` только для managed и hybrid, standalone оставался с
`false`. Внешние аудиты (S1) фиксировали это как разрыв между заявленным security-first и фактом:
защита зависела от режима запуска и по умолчанию отсутствовала. Остальные защитные механизмы
(`security.promptInjection.enabled`, `security.protectedPaths.enabled`) по умолчанию включены;
opt-in защита на практике означает её отсутствие.

## Решение

Единый дефолт `llmGateway.enabled: true` во всех профилях. Профильные шимы и второй проход
загрузки конфига в CLI удалены. Загрузка конфига — по ADR-023: env >
`config.yaml` > дефолт; runtime-тумблер UI применяется **поверх конфига** (выше `config.yaml`
и env). Явный opt-out (`config.yaml`,
`SYNTH_LLM_GATEWAY_ENABLED=false`, тумблер UI) сохраняется. При явном отключении `/health` и
`/ready` отдают `llmGateway: "disabled"` + `warnings: ["llm-gateway-disabled"]` (предупреждение,
readiness не ломается), UI показывает предупреждение. Rate-limit дефолты (60/120) не меняются.

## Статус в коде

- **Единый дефолт:** `packages/shared/src/config/defaults.ts` (`defaultConfig.llmGateway.enabled`),
  `packages/shared/src/config/types.ts` (Zod-дефолт схемы).
- **Runtime и API:** `packages/core/src/server/routes/settings.ts` (`DEFAULT_LLM_GATEWAY`),
  `packages/core/src/storage/runtime-settings.ts` (`mergeLlmGatewayConfig`).
- **Профильные шимы удалены:** `packages/backend/src/lib/app-config.ts` (нет `baseDefaults` для
  шлюза), `packages/core/src/server/app/standalone-options.ts` (нет `hybridGatewayBaseDefaults`),
  `packages/core/src/index.ts` (экспорт), `packages/synth/src/cli.ts` (нет второго прохода загрузки).
- **Тесты:** `packages/shared/src/config/loader.test.ts`, `packages/shared/src/config/types.test.ts`,
  `packages/backend/src/lib/app-config.test.ts`,
  `packages/core/src/server/app/standalone-options.test.ts`.

## Альтернативы

- **Оставить профильный дефолт** — отклонено: защита зависит от режима запуска и «по умолчанию
  отсутствует».
- **Жёстко запретить выключение** — отклонено: расходится с остальными тумблерами безопасности и
  мешает диагностике инцидентов.
- **Поднять лимиты вместе с флипом** — отложено: наблюдаем `outcome='rate_limited'`, лимиты
  настраиваются из UI/конфига.

## Последствия

- **+** Обфускация секретов, аудит каждого запроса и rate limit работают «из коробки» у всех,
  включая локальный standalone-инстанс.
- **−** Для тяжёлых сценариев возможны срабатывания лимита; обфускация меняет то, что видит модель
  (плейсхолдеры вместо секретов).
- **Апгрейд** не переписывает явный `enabled: false` в `config.yaml` или runtime-настройках.

## История

- 2026-11-18 — принято и реализовано; заменяет ADR-139.
