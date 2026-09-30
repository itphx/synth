# @itphx/synth-shared

> Точечные правила пакета. Слои, инварианты и команды — в корневом [AGENTS.md](../../AGENTS.md);
> конфиг — [AD-023](../../docs/arch_decisions/ad-023-configuration.md), i18n — [AD-041](../../docs/arch_decisions/ad-041-llm-error-taxonomy.md) (здесь не дублируются).

## Граница пакета

`@itphx/synth-shared` — контракты и межупаковочная инфраструктура для всех пакетов,
**без бизнес-логики движка** (сессии, LLM, MCP, permissions — в core).
- Содержит: типы, интерфейсы, Zod-схемы, протоколы, i18n-словарь, конфиг-лоадер и общие утилиты.
- Рантайм здесь только инфраструктурный: `atomicWrite`, `AsyncLock`, `generateId`,
  `pickLocalized` (`src/utils/index.ts`); `loadConfig`/`ensureDataDir` (`src/config/`).
  Бизнес-правила сюда не переезжают.
- Зависимости минимальны и осознанны: `zod`, `js-yaml`; `node:*` — только в
  `src/config/` (см. «Публичная поверхность»).

## Публичная поверхность

Публикуется 9 subpath-export'ами (`package.json`): `.`, `./version`, `./types`,
`./interfaces`, `./schemas`, `./protocols`, `./utils`, `./config`, `./i18n`.
- Новый публичный модуль = subpath-export в `package.json` + (для root-части)
  экспорт из `src/index.ts`; внутренние `src/...` наружу не торчат.
- **Browser-safety**: `./config` тянет `node:fs`/`node:path` — только Node-потребители.
  UI импортирует ровно `.`, `./i18n`, `./version`; брать `./config` в UI нельзя.

## Конфигурация

`src/config/`: `types.ts` (Zod-схема + `SynthConfig`), `defaults.ts`
(`defaultConfig`), `merge.ts` (`deepMerge`), `loader.ts` (`loadConfig`, приоритет
defaults ← yaml ← overrides), `resolve.ts` (env-резолверы, `ensureDataDir`).
- **Добавление поля = `types.ts` + `defaults.ts` + тест** (`defaults.test.ts`).
- Читать только через `@itphx/synth-shared/config` (корневой инвариант 10).
- AD-046: секции `skills` (`paths`/`trustedProjectDirs`/`inlineShell`/`toolsets`) и
  `commands` (`paths`/`bundlesPath`/`conflict`/лимиты); типы команд/бандлов —
  `src/types/commands.ts`, Zod — `schemas` (`skillBundleSchema`, session/project/settings-skills).
- Скоп/уровни (AD-046 §4.5 / AD-071 §2.4): `ProjectSkillSettings`/`ProjectMcpSettings`
  (`enabled` — hard-gate, `defaultOn` — сид новых сессий), `SessionSettings.skillsDefaultOn`/
  `mcpDefaultOn` (снапшот-дефолты), `McpRegistryEntry.enabled` (мастер hard-gate) +
  `enabledByDefault` (дефолт новых проектов); Zod — `skillsSystemSettingsSchema`
  (`disabled`/`disabledForNewProjects`/`policy`), `projectSkillUpdateSchema`/`sessionSkillUpdateSchema`.
- AD-076: `security.secretKey` (мастер-ключ секретов at-rest; env `SYNTH_SECRET_KEY`,
  резолвер `resolveSecretKey`, пусто — файл `{dataDir}/secrets/master.key`); типы
  `GitRepoConfig` (реестр, `path` обязателен) и `SSHKey`/`SSHKeyMeta` (`agentIds: string[]`),
  `gitRepoConfigSchema`/`normalizeGitRepoConfig` (legacy `repos`) и `sshKeyCreate/UpdateSchema`;
  i18n-ключ `sshkey.env_failed` (сбой подготовки SSH-окружения/askpass).
- AD-079: `resolveHome(explicitHome?, env?)` (env `SYNTH_HOME`); home-параметр
  (`home?`) у резолверов путей (`resolveDataDir`, `resolveWorkspacesRoot`,
  `resolveDefaultWorkspace`, `findConfigPath`, `defaultConfigPath`, `ensureFirstRun`)
  и новые `resolveProfilesPath`/`resolveCredentialsPath`; `loader.home` — при home
  конфиг читается строго из `<home>/config.yaml` (без отката к XDG).

## i18n-контракт

`src/i18n/index.ts` — словарь-контракт без текста: `ENGINE_MESSAGE_KEYS`,
`ENGINE_MESSAGE_PARAMS` (плейсхолдеры), `extractParams`; синхронизируется с core
`engine/system-messages.ts` (en) и ui `lib/i18n/messages/ru.ts` (ru).
- AD-078: ключи `tool.binary_missing` (`{tool}`/`{binary}`) и
  `permission.dep_unavailable` (`{binary}`) — тул недоступен, т.к. в окружении нет
  внешней программы (`git`/`rg`/`sh`).
- AD-046: `skill.scope_disabled` (`{name}`/`{reason}`) — скилл недоступен по scope
  (причина `system`/`project`/`session`).

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest), сборка — `tsc`.
- После правки публичной поверхности — `pnpm --filter @itphx/synth-shared build`,
  иначе typecheck зависимых пакетов не увидит типы (см. корневой «GitVerse CI»).
