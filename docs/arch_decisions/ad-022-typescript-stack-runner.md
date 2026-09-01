# AD-022: TypeScript стек + Runner

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

- **@itphx/synth-core** — автономное ядро: сессии, очередь, LLM-провайдеры, MCP, HTTP API v2, CLI
- **@itphx/synth-backend** — облачный API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
- **@itphx/synth-runner** — мост между бэкендом и движками (opencode, cline, synth-core)
- **@itphx/synth-ui** — React 19 SPA + админка
