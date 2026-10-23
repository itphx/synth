/**
 * ADR-086 §5 / ADR-090: единый манифест расширения `synth.pack`.
 *
 * Манифест — файл `synth.pack` (JSON) в корне репозитория расширения. Формат
 * **общий** для всех классов расширений: Plugin (ADR-090), Gateway (ADR-087),
 * Add-on (эталон — `synth-media`), контент-пак (PROP-068) и драйвер слоя
 * хранения (`kind: 'storage'`, ADR-097).
 *
 * Здесь только контракт (типы + zod-схемы): загрузка, установка и активация
 * расширений — в core (ADR-090 отложен до 2026-10-19). Модуль browser-safe
 * (`zod` + локальные типы), в UI-бандл `node:*` не попадает.
 */
import { z } from 'zod';

import type { AgentMode } from './agent.js';
import {
  authorityActionSchema,
  authorityRoleSchema,
  authorityTargetDeclarationSchema,
  isAuthorityMutatingAction,
  validateAuthorityContent,
} from './authority.js';
import { pipelineDefinitionSchema } from './pipeline.js';
import { SEMVER_RANGE_REGEX, isSemverRange, satisfiesSemverRange } from './semver.js';
import { CATALOG_TRUST_LEVELS, catalogTrustLevelSchema, trustLevelRank } from './trust.js';
import { ToolCapability } from './tools.js';

// --- Реестры классов и типов расширений ---

/**
 * Классы расширений (ADR-086 §5):
 * - `plugin` — код в процессе ядра (ADR-090);
 * - `gateway` — внешний транспорт «внешний мир ↔ Synth» (ADR-087);
 * - `addon` — внешний сервис-надстройка (эталон — `synth-media`);
 * - `pack` — контент-пак;
 * - `storage` — драйвер слоя хранения (ADR-097).
 */
export const PACK_KINDS = ['plugin', 'gateway', 'addon', 'pack', 'storage'] as const;
export type PackKind = (typeof PACK_KINDS)[number];
export const packKindSchema = z.enum(PACK_KINDS);

/**
 * Типы контент-пака (`kind: 'pack'`) — ADR-086 §5 / PROP-068.
 *
 * `packType` описывает **основной** вид вклада пака; фактический состав задаёт
 * `provides`. Решение владельца: «контент-пак» = **набор `provides`**, поэтому
 * `provides` у любого класса (в т.ч. у `addon` — у `synth-media` свой
 * сервис-receiver, `kind` остаётся `addon`) может включать `agents` и
 * `pipelines`; `packType` — только для `kind: 'pack'`.
 */
export const PACK_TYPES = [
  'skills',
  'agents',
  'mcp',
  'themes',
  'i18n',
  'providers',
  'prompts',
  'automation',
  'policies',
  'memory',
  'ui',
] as const;
export type PackType = (typeof PACK_TYPES)[number];
export const packTypeSchema = z.enum(PACK_TYPES);

// --- Имя, версия, диапазон версий host ---

/**
 * Имя расширения: slug (`synth-media`) либо npm-имя со scope
 * (`@itphx/synth-gateway-telegram`).
 */
export const PACK_NAME_REGEX = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const packNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(
    PACK_NAME_REGEX,
    'имя расширения: slug или npm-имя со scope (строчные латинские буквы/цифры, разделитель — дефис)',
  );

/** Semver версии расширения (`MAJOR.MINOR.PATCH`, с пре-релизом/сборкой). */
export const PACK_VERSION_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const packVersionSchema = z
  .string()
  .min(1)
  .regex(PACK_VERSION_REGEX, 'версия расширения: semver (MAJOR.MINOR.PATCH)');

/**
 * Диапазон версий host-приложения — semver-range, как `engines` в package.json
 * (`^0.9.0`, `~1.2.3`, `>=1.0.0 <2.0.0`, `1.x`).
 *
 * Грамматика — единая для `host` и `contracts` манифеста (ADR-090):
 * реализация и матчер — в `types/semver.ts`.
 */
export const PACK_HOST_RANGE_REGEX = SEMVER_RANGE_REGEX;

/** Проверяет, что значение — корректный semver-диапазон (host-версия). */
export function isPackHostRange(value: string): boolean {
  return isSemverRange(value);
}

export const packHostSchema = z
  .string()
  .min(1)
  .refine(isPackHostRange, 'диапазон версий host: semver-range (например, ^0.9.0)');

// --- Вклады (`provides`) ---

/**
 * MCP-предоставление: MCP-сервер, который расширение регистрирует в инстансе
 * (ADR-071). `transport: 'http'` — сервер в контуре расширения (адрес собирается
 * из `url`/`port`+`path`), `transport: 'stdio'` — локальный процесс.
 */
export const packMcpProvideSchema = z.object({
  /** Имя MCP-сервера (как в реестре MCP). */
  name: z.string().min(1),
  transport: z.enum(['http', 'stdio']),
  /** Порт HTTP-сервера. */
  port: z.number().int().positive().optional(),
  /** Путь HTTP-сервера (может быть шаблоном, напр. `/mcp/{tenant}`). */
  path: z.string().min(1).optional(),
  /** Полный URL HTTP-сервера. */
  url: z.string().min(1).optional(),
  /** Человекочитаемое описание. */
  description: z.string().optional(),
  /** Заголовки HTTP-сервера (без секретов — инвариант 13). */
  headers: z.record(z.string(), z.string()).optional(),
});
export type PackMcpProvide = z.infer<typeof packMcpProvideSchema>;

/**
 * Метаданные скилла в манифесте. Блок `metadata.synth` (ADR-046 §6.2:
 * `agents`/`requires_capabilities`/`scope`/`trigger`/`groups`) произвольный по
 * составу — схема его не детализирует, но и не отбрасывает.
 */
export const packSkillMetadataSchema = z
  .object({ synth: z.record(z.string(), z.unknown()).optional() })
  .catchall(z.unknown());

/** Скилл-предоставление (ADR-046): каталог скилла внутри пака. */
export const packSkillProvideSchema = z.object({
  /** Имя скилла (совпадает с `SKILL_NAME_REGEX` конвенцией ADR-046 §3.2). */
  name: z.string().min(1),
  /** Путь к каталогу скилла относительно корня расширения. */
  path: z.string().min(1),
  metadata: packSkillMetadataSchema.optional(),
});
export type PackSkillProvide = z.infer<typeof packSkillProvideSchema>;

/** Режимы агента — зеркалят `AgentMode` (`types/agent.ts`). */
export const PACK_AGENT_MODES = [
  'primary',
  'subagent',
  'system',
] as const satisfies readonly AgentMode[];
export type PackAgentMode = (typeof PACK_AGENT_MODES)[number];

/**
 * Агент-предоставление (PROP-068: agent-паки). Поля повторяют
 * `AgentDefinition` (`types/agent.ts`), но без runtime-полей (`enabled`,
 * `isOverridden`): манифест объявляет **предоставление**, а не состояние.
 *
 * `capabilities` — строки; принадлежность известному набору `ToolCapability`
 * проверяет `validatePackManifest` (схема намеренно терпима: новые capability
 * не должны ломать чтение манифеста).
 */
export const packAgentProvideSchema = z.object({
  /** Идентификатор агента (уникален в пределах пака). */
  id: z.string().min(1),
  /** Путь к файлу/каталогу определения агента. */
  path: z.string().min(1).optional(),
  /** Ролевой промпт агента: файл (`path`) или inline-текст (`content`). */
  rolePrompt: z
    .object({
      path: z.string().min(1).optional(),
      content: z.string().optional(),
    })
    .optional(),
  /** Отображаемое имя. */
  displayName: z.string().optional(),
  /** Краткое описание. */
  description: z.string().optional(),
  /** Группы инструментов (capability), см. `validatePackManifest`. */
  capabilities: z.array(z.string()).optional(),
  /** Режим агента (один или несколько). */
  agentMode: z.union([z.enum(PACK_AGENT_MODES), z.array(z.enum(PACK_AGENT_MODES))]).optional(),
  /** Иконка агента (ключ/эмодзи). */
  icon: z.string().optional(),
  /** Цвет агента (ключ палитры). */
  color: z.string().optional(),
  /** Провайдер по умолчанию. */
  provider: z.string().optional(),
  /** Модель по умолчанию. */
  model: z.string().optional(),
  /** Группы агентов (ADR-046 §6.2: привязка скиллов к агентам). */
  groups: z.array(z.string()).optional(),
  /** Лимит шагов агента (`0` — без ограничений). */
  maxSteps: z.number().int().min(0).optional(),
});
export type PackAgentProvide = z.infer<typeof packAgentProvideSchema>;

/**
 * Пайплайн-предоставление (ADR-051/ADR-100): описание автомата. Либо файл
 * (`path`), либо inline-определение (`definition` — тот же контракт, что и
 * `pipelineDefinitionSchema`).
 */
export const packPipelineProvideSchema = z.object({
  /** Идентификатор пайплайна (уникален в пределах пака). */
  id: z.string().min(1),
  /** Путь к файлу определения пайплайна. */
  path: z.string().min(1).optional(),
  /** Inline-определение пайплайна. */
  definition: pipelineDefinitionSchema.optional(),
});
export type PackPipelineProvide = z.infer<typeof packPipelineProvideSchema>;

/**
 * `provides.mcp` — массив MCP-серверов **или** одиночный объект.
 *
 * Объектная форма — обратная совместимость: уже выпущенные манифесты
 * (`synth-media`, `synth-gateway-telegram`) объявляют `provides.mcp` объектом.
 * Форма нормализуется в массив, чтобы один пак мог регистрировать несколько
 * MCP-серверов; `normalizePackProvides` делает то же для сырого JSON.
 */
export const packMcpProvidesSchema = z
  .union([z.array(packMcpProvideSchema), packMcpProvideSchema])
  .transform((value) => (Array.isArray(value) ? value : [value]));

// --- Вклады плагина (ADR-090) ---

/**
 * ADR-090: режим исполнения плагина — `inline` (код в процессе core) или
 * `remote` (отдельный процесс), `both` — оба транспорта.
 *
 * Поле допустимо **только** для `kind: 'plugin'` (у остальных классов режим
 * исполнения не задаётся — см. `validatePackManifest`).
 */
export const PACK_PLUGIN_MODES = ['inline', 'remote', 'both'] as const;
export type PackPluginMode = (typeof PACK_PLUGIN_MODES)[number];
export const packPluginModeSchema = z.enum(PACK_PLUGIN_MODES);

/**
 * ADR-090: заявленные расширением доступы (`permissions`).
 *
 * - `network` — хосты, к которым плагин обращается (проверяются по
 *   egress-политике, ADR-099);
 * - `secrets` — имена секретов, которые плагин запрашивает через API
 *   (at-rest по модели ADR-076; значение секрета в манифесте не хранится);
 * - `tools` — имена встроенных тулов, которые плагин использует;
 * - `hooks` — имена хуков, на которые плагин подписывается.
 *
 * Заявление прав — **не** само разрешение: фактический доступ определяется
 * permission-слоем (ADR-025/ADR-028/ADR-029) и egress-политикой.
 */
export const packPermissionsSchema = z.object({
  network: z.array(z.string().min(1)).default([]),
  secrets: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  hooks: z.array(z.string().min(1)).default([]),
});
export type PackPermissions = z.infer<typeof packPermissionsSchema>;

/**
 * ADR-090: заявленный автором уровень/источник доверия.
 *
 * **Заявленный уровень — только верхняя граница:** фактический trust
 * резолвится по источнику/реестру (PROP-068 §4.1), манифест не может его
 * повысить. Для `kind: 'plugin'` уровень не должен быть выше `trusted`
 * (trust-floor плагина, ADR-090) — проверяется в `validatePackManifest`.
 */
export const packTrustSchema = z.object({
  level: catalogTrustLevelSchema.optional(),
  source: z.string().min(1).optional(),
});
export type PackTrust = z.infer<typeof packTrustSchema>;

/**
 * ADR-090: `provides.tools[]` — имена тулов, которые регистрирует
 * плагин (имя тула — `tool.name` в `ToolRegistry.register`).
 *
 * Имена уникальны в пределах манифеста; фактические регистрации обязаны
 * совпадать с этим списком (сверка — `diffPackProvides`).
 */
export const packToolsProvideSchema = z
  .array(z.string().min(1, 'имя тула: непустая строка'))
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `дубликат имени тула «${name}»`,
          path: [index],
        });
      }
      seen.add(name);
    });
  });
export type PackToolsProvide = z.infer<typeof packToolsProvideSchema>;

/**
 * ADR-090: `provides.promptBlocks[]` — описание плагинных блоков
 * системного промпта.
 *
 * - `key` — ключ блока (для плагина — `plugin.<pluginName>.<slot>`);
 * - `tier` — тир блока: **только** `context`/`volatile`; `stable` запрещён
 *   (граница prompt-cache, ADR-070);
 * - `order` — порядок внутри тира (число);
 * - `title`/`provenance` — подпись для манифеста промпта и источник
 *   (`provenance` для плагинного блока — `plugin:<name>`).
 *
 * Схема **строгая** (`.strict()`): неизвестное поле — ошибка, а не молчаливое
 * проигнорирование (иначе опечатка в манифесте проходит незамеченной).
 */
export const packPromptBlockProvideSchema = z
  .object({
    key: z.string().min(1),
    tier: z.enum(['context', 'volatile']),
    order: z.number().int(),
    title: z.string().min(1).optional(),
    provenance: z.string().min(1).optional(),
  })
  .strict();
export type PackPromptBlockProvide = z.infer<typeof packPromptBlockProvideSchema>;

/**
 * ADR-090: `provides.llmFilters[]` — описание фильтров LLM-вызовов.
 *
 * - `id` — идентификатор фильтра (`plugin:<pluginName>:<filterName>`);
 * - `phase` — фаза: `pre_request` / `post_response` / `embedding`
 *   (третья фаза — решение владельца 2026-10-22);
 * - `failMode` — поведение при сбое/таймауте фильтра (`open` — пропустить,
 *   `closed` — заблокировать); не задан — по классу фильтра (блокирующий —
 *   `closed`, наблюдательный — `open`);
 * - `timeoutMs` — бюджет времени на вызов фильтра (мс).
 */
export const packLlmFilterProvideSchema = z
  .object({
    id: z.string().min(1),
    phase: z.enum(['pre_request', 'post_response', 'embedding']),
    failMode: z.enum(['open', 'closed']).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type PackLlmFilterProvide = z.infer<typeof packLlmFilterProvideSchema>;

/**
 * ADR-106 §«Доменная нейтральность и доставка контентом»: агент, которому
 * пакет поставляет роли и потолок.
 *
 * `roles[]` — роли агента (id из `provides.authority.roles[]`), `ceiling[]` —
 * потолок агента (id действий из `provides.authority.actions[]`). Оба списка
 * проверяются на объявленность — неизвестная роль/действие → отказ установки.
 */
export const packAuthorityAgentProvideSchema = z
  .object({
    /** Идентификатор агента (уникален в пределах пака). */
    id: z.string().min(1).max(128),
    /** Роли агента (id из `provides.authority.roles[]`). */
    roles: z.array(z.string().min(1).max(128)).default([]),
    /** Потолок агента — идентификаторы действий. */
    ceiling: z.array(z.string().min(1).max(64)).default([]),
  })
  .strict();
export type PackAuthorityAgentProvide = z.infer<typeof packAuthorityAgentProvideSchema>;

/**
 * ADR-106: `provides.authority` — **контент** полномочий: роли, действия,
 * цели и агенты с ролями.
 *
 * Схема **строгая** (`.strict()`): неизвестное поле — ошибка, а не молчаливое
 * игнорирование. Кросс-ссылки проверяются на разборе: грант на
 * необъявленное действие, агент на необъявленную роль, шаблон цели на
 * неизвестный вид цели → **отказ** (ADR-106 §«Валидация, а не каст»).
 *
 * Пакет **не выдаёт права сам себе**: объявленные роли становятся активными
 * только после одобрения ADMIN и пересечения с политикой инстанса
 * (ADR-106 §«Пересечение, не дарование»).
 */
export const packAuthorityProvidesSchema = z
  .object({
    /** Роли (именованные наборы грантов). */
    roles: z.array(authorityRoleSchema).default([]),
    /** Объявленные доменные действия. */
    actions: z.array(authorityActionSchema).default([]),
    /** Виды целей, которые пакет вводит (доменные). */
    targets: z.array(authorityTargetDeclarationSchema).default([]),
    /** Агенты с ролями и потолком. */
    agents: z.array(packAuthorityAgentProvideSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const problems = validateAuthorityContent({
      actions: value.actions,
      roles: value.roles,
      targets: value.targets,
      agents: value.agents,
    });
    for (const problem of problems) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }
  });
export type PackAuthorityProvides = z.infer<typeof packAuthorityProvidesSchema>;

/**
 * ADR-106 Ф5: сводка контента полномочий пакета (`provides.authority`) —
 * «**что именно** пакет приносит инстанцу».
 *
 * Сводка — **данные**, а не текст: показывает администратору состав пакета
 * (`pending_approval` по существу — не только факт «есть capabilities»), и из
 * неё же считается, что пакет добавит в политику инстанса. Мутирующие
 * гранты помечены отдельно — по ним виден trust-floor (мутирующие роли
 * активируются только при trust ≥ `trusted`).
 */

/** Роль пакета в сводке. */
export interface PackAuthoritySummaryRole {
  /** id роли (уникален в пределах пакета). */
  id: string;
  /** Отображаемое имя роли (если объявлено). */
  displayName?: string;
  /** Домен роли (`domain`). */
  domain: string;
  /** Число грантов роли. */
  grants: number;
  /** Число **мутирующих** грантов роли (действие меняет состояние). */
  mutatingGrants: number;
}

/** Действие пакета в сводке. */
export interface PackAuthoritySummaryAction {
  /** id доменного действия. */
  id: string;
  /** Заявленный признак мутирующего действия (информационный). */
  mutating: boolean;
}

/** Вид цели пакета в сводке. */
export interface PackAuthoritySummaryTarget {
  /** Вид цели (`kind`). */
  kind: string;
  /** Имя резолвера цели (если объявлен). */
  resolver?: string;
}

/** Агент пакета в сводке (роли + потолок). */
export interface PackAuthoritySummaryAgent {
  /** id агента. */
  id: string;
  /** Роли агента (id из `provides.authority.roles[]`). */
  roles: string[];
  /** Потолок агента (id действий из `provides.authority.actions[]`). */
  ceiling: string[];
}

/** Сводка контента полномочий пакета. */
export interface PackAuthoritySummary {
  /** Роли, которые пакет приносит. */
  roles: PackAuthoritySummaryRole[];
  /** Доменные действия, которые пакет объявляет. */
  actions: PackAuthoritySummaryAction[];
  /** Виды целей, которые пакет вводит. */
  targets: PackAuthoritySummaryTarget[];
  /** Агенты с ролями и потолком. */
  agents: PackAuthoritySummaryAgent[];
  /** Итоги — «сколько чего приносит пакет». */
  totals: {
    roles: number;
    actions: number;
    targets: number;
    agents: number;
    grants: number;
    mutatingGrants: number;
  };
}

/** true — значение — объект (не массив, не null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Список строк из «сырого» значения (только строки). */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Сводка контента полномочий пакета (`provides.authority`).
 *
 * Принимает **сырой** `provides` (как в сохранённом манифесте) — разбор
 * defensive: неизвестные/битые элементы пропускаются, а не роняют ответ.
 * Пустой контент → пустая сводка (нулевые итоги).
 */
export function summarizePackAuthority(provides: unknown): PackAuthoritySummary {
  const authority = isPlainObject(provides) && isPlainObject(provides.authority)
    ? provides.authority
    : {};

  const rawRoles = Array.isArray(authority.roles) ? authority.roles : [];
  const roles: PackAuthoritySummaryRole[] = [];
  for (const raw of rawRoles) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) continue;
    const grants = Array.isArray(raw.grants) ? raw.grants : [];
    const mutatingGrants = grants.filter((grant) => {
      if (!isPlainObject(grant)) return false;
      const action = typeof grant.action === 'string' ? grant.action : '';
      return action !== '' && isAuthorityMutatingAction(action);
    }).length;
    roles.push({
      id,
      ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
      domain: typeof raw.domain === 'string' ? raw.domain : '',
      grants: grants.length,
      mutatingGrants,
    });
  }

  const rawActions = Array.isArray(authority.actions) ? authority.actions : [];
  const actions: PackAuthoritySummaryAction[] = [];
  for (const raw of rawActions) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) continue;
    actions.push({ id, mutating: raw.mutating === true });
  }

  const rawTargets = Array.isArray(authority.targets) ? authority.targets : [];
  const targets: PackAuthoritySummaryTarget[] = [];
  for (const raw of rawTargets) {
    if (!isPlainObject(raw)) continue;
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    if (!kind) continue;
    targets.push({
      kind,
      ...(typeof raw.resolver === 'string' ? { resolver: raw.resolver } : {}),
    });
  }

  const rawAgents = Array.isArray(authority.agents) ? authority.agents : [];
  const agents: PackAuthoritySummaryAgent[] = [];
  for (const raw of rawAgents) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) continue;
    agents.push({
      id,
      roles: stringList(raw.roles),
      ceiling: stringList(raw.ceiling),
    });
  }

  const grants = roles.reduce((sum, role) => sum + role.grants, 0);
  const mutatingGrants = roles.reduce((sum, role) => sum + role.mutatingGrants, 0);

  return {
    roles,
    actions,
    targets,
    agents,
    totals: {
      roles: roles.length,
      actions: actions.length,
      targets: targets.length,
      agents: agents.length,
      grants,
      mutatingGrants,
    },
  };
}

/** Контент полномочий пакета непустой? (пустой контент — нечего активировать). */
export function hasPackAuthorityContent(provides: unknown): boolean {
  const summary = summarizePackAuthority(provides);
  return (
    summary.totals.roles > 0 ||
    summary.totals.actions > 0 ||
    summary.totals.targets > 0 ||
    summary.totals.agents > 0
  );
}

/**
 * Набор вкладов расширения. Списки нормализованы (отсутствующий список —
 * пустой массив), неизвестные ключи сохраняются: виды вкладов расширяются
 * без изменения формата манифеста.
 *
 * Ключи `tools`/`promptBlocks`/`llmFilters` (ADR-090) описаны **явными**
 * схемами — без `.passthrough()`: иначе опечатка в манифесте (пустое имя тула,
 * дубль, тир `stable`, неизвестная фаза фильтра) проходит молча, и правило
 * «фактические регистрации обязаны совпадать с `provides`» нечем проверять.
 *
 * `authority` (ADR-106) — тоже **явная** схема: контент полномочий не
 * проходит «как есть» (неизвестное действие/цель/роль → отказ разбора).
 */
export const packProvidesSchema = z
  .object({
    mcp: packMcpProvidesSchema.default([]),
    skills: z.array(packSkillProvideSchema).default([]),
    agents: z.array(packAgentProvideSchema).default([]),
    pipelines: z.array(packPipelineProvideSchema).default([]),
    tools: packToolsProvideSchema.default([]),
    promptBlocks: z.array(packPromptBlockProvideSchema).default([]),
    llmFilters: z.array(packLlmFilterProvideSchema).default([]),
    authority: packAuthorityProvidesSchema.default({}),
  })
  .passthrough();
export type PackProvides = z.infer<typeof packProvidesSchema>;

// --- Манифест ---

/**
 * Инвариант `packType` — общий для манифеста (`packManifestSchema`) и карточки
 * каталога расширений (`catalogEntrySchema`, PROP-068 §12):
 * - `kind: 'pack'` **требует** `packType`;
 * - `packType` запрещён у остальных `kind` (`addon`/`gateway`/`plugin`/
 *   `storage` — это классы кода/сервиса, а не контент-паки).
 */
export function refinePackType(
  value: { kind: PackKind; packType?: PackType },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'pack' && value.packType === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'packType обязателен для kind «pack»',
      path: ['packType'],
    });
  }
  if (value.kind !== 'pack' && value.packType !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `packType допустим только для kind «pack» (kind: «${value.kind}»)`,
      path: ['packType'],
    });
  }
}

/**
 * Единый манифест расширения `synth.pack` (ADR-086 §5).
 *
 * Инварианты, зашитые в схему:
 * - `kind: 'pack'` **требует** `packType`;
 * - `packType` запрещён у остальных `kind` (`addon`/`gateway`/`plugin`/
 *   `storage` — это классы кода/сервиса, а не контент-паки).
 *
 * Поля `mode`/`permissions`/`trust` (ADR-090) — опциональные и
 * **явные**: `z.object` выбрасывает неизвестные ключи, поэтому без них
 * эти поля молча терялись при разборе манифеста.
 */
export const packManifestSchema = z
  .object({
    /** Имя расширения (slug или npm-имя со scope). */
    name: packNameSchema,
    /** Semver версии расширения. */
    version: packVersionSchema,
    /** Класс расширения. */
    kind: packKindSchema,
    /** Диапазон версий host-приложения (semver-range). */
    host: packHostSchema.optional(),
    /**
     * Версии контрактов, которые расширение использует (напр. `apiV2: '^2'`).
     * Значения — semver-диапазоны (та же грамматика, что у `host`).
     */
    contracts: z
      .record(z.string(), z.string())
      .optional()
      .refine(
        (contracts) => Object.values(contracts ?? {}).every((range) => isSemverRange(range)),
        'contracts: значения — semver-диапазоны (например, "^1")',
      ),
    /** Краткое описание (инспекция/каталог). */
    description: z.string().min(1),
    /** Что расширение регистрирует. */
    provides: packProvidesSchema,
    /** Тип контент-пака — только для `kind: 'pack'`. */
    packType: packTypeSchema.optional(),
    /** ADR-090: режим исполнения — только для `kind: 'plugin'`. */
    mode: packPluginModeSchema.optional(),
    /** ADR-090: заявленные расширением доступы. */
    permissions: packPermissionsSchema.optional(),
    /** ADR-090: заявленный уровень/источник доверия (верхняя граница). */
    trust: packTrustSchema.optional(),
  })
  .superRefine(refinePackType);

export type PackManifest = z.infer<typeof packManifestSchema>;

// --- Нормализация и проверка целостности ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Одиночный объект → массив из одного элемента; массив — как есть. */
function toMcpList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return [value];
  return [];
}

/** Только массив; всё прочее (в т.ч. объект) → пустой список. */
function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Нормализация `provides` из сырого JSON: `mcp`-объект → массив, отсутствующие
 * списки → пустые массивы, прочие (пока неизвестные) виды вкладов сохраняются.
 *
 * Зачем отдельная функция: манифесты `synth-media` и `synth-gateway-telegram`
 * (выпущены и работают) объявляют `provides.mcp` **объектом**. Переход на
 * массив не должен ломать их — потребитель (загрузчик расширений в core)
 * всегда работает с нормализованной формой и не знает про legacy-объект.
 *
 * Нормализация отвечает только за **форму** (списки вместо объекта/пустоты);
 * содержимое элементов остаётся ответственностью `packProvidesSchema`
 * (валидация) — здесь элементы не проверяются и не отбрасываются.
 */
export function normalizePackProvides(provides: unknown): PackProvides {
  const source = isRecord(provides) ? provides : {};
  return {
    ...source,
    mcp: toMcpList(source.mcp) as PackMcpProvide[],
    skills: toList(source.skills) as PackSkillProvide[],
    agents: toList(source.agents) as PackAgentProvide[],
    pipelines: toList(source.pipelines) as PackPipelineProvide[],
    tools: toList(source.tools) as string[],
    promptBlocks: toList(source.promptBlocks) as PackPromptBlockProvide[],
    llmFilters: toList(source.llmFilters) as PackLlmFilterProvide[],
    // ADR-106: контент полномочий нормализуется так же (списки вместо
    // отсутствия). Содержимое проверяет `packAuthorityProvidesSchema`.
    authority: {
      roles: toList((source.authority as Record<string, unknown> | undefined)?.roles) as PackAuthorityProvides['roles'],
      actions: toList((source.authority as Record<string, unknown> | undefined)?.actions) as PackAuthorityProvides['actions'],
      targets: toList((source.authority as Record<string, unknown> | undefined)?.targets) as PackAuthorityProvides['targets'],
      agents: toList((source.authority as Record<string, unknown> | undefined)?.agents) as PackAuthorityProvides['agents'],
    },
  } as PackProvides;
}

/**
 * Проверка целостности манифеста — **список проблем строками**, без throw.
 *
 * Функция принимает «сырое» значение (например, разобранный JSON): в отличие
 * от `packManifestSchema` она не отбрасывает манифест целиком, а перечисляет
 * все проблемы (неизвестный `kind`/`packType`, пустой `provides`, дубликаты,
 * записи без обязательных полей, неизвестные capability).
 *
 * Разделение ответственности: `packManifestSchema` — **структура** (формат
 * полей, semver, инвариант `packType`), `validatePackManifest` — **семантика**
 * (смысловые правила целостности, перечисленные ниже).
 *
 * Проверяются правила:
 * 1. неизвестный `kind`;
 * 2. неизвестный `packType`;
 * 3. `provides` без единого элемента;
 * 4. `kind: 'pack'` без `packType`;
 * 5. `packType` у другого `kind`;
 * 6. дубликаты `name`/`id` внутри `provides`;
 * 7. агент без `id`;
 * 8. MCP без `name`/`transport`;
 * 9. скилл без `name`/`path`;
 * 10. пайплайн без `id`;
 * 11. `agents[].capabilities` — строки из известного набора `ToolCapability`;
 * 12. вклады плагина (`provides.tools`/`promptBlocks`/`llmFilters`) — по
 *     явным схемам ADR-090;
 * 13. `mode` — только для `kind: 'plugin'`;
 * 14. `trust.level` плагина — не выше `trusted` (trust-floor, ADR-090);
 * 15. контент полномочий (`provides.authority`) — строгая схема + кросс-ссылки
 *     (ADR-106 §«Валидация, а не каст»): неизвестное действие/цель/роль —
 *     проблема, а не молчаливый проход.
 */
export function validatePackManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(manifest)) {
    return ['манифест: ожидается объект'];
  }

  // 1. Класс расширения.
  const kind = manifest.kind;
  if (typeof kind !== 'string' || kind.trim() === '') {
    problems.push('kind: обязательное поле (класс расширения)');
  } else if (!(PACK_KINDS as readonly string[]).includes(kind)) {
    problems.push(
      `kind: неизвестный класс расширения «${kind}» (допустимо: ${PACK_KINDS.join('|')})`,
    );
  }

  // 2/4/5. Тип контент-пака.
  const packType = manifest.packType;
  if (kind === 'pack') {
    if (packType === undefined || packType === null) {
      problems.push('packType: обязателен для kind «pack»');
    } else if (typeof packType !== 'string' || !(PACK_TYPES as readonly string[]).includes(packType)) {
      problems.push(
        `packType: неизвестный тип контент-пака «${String(packType)}» (допустимо: ${PACK_TYPES.join('|')})`,
      );
    }
  } else if (packType !== undefined && packType !== null) {
    problems.push(`packType: допустим только для kind «pack» (текущий kind — «${String(kind)}»)`);
  }

  // 3/6/7/8/9/10/11. Вклады.
  const rawProvides = manifest.provides;
  if (!isRecord(rawProvides)) {
    problems.push('provides: ожидается объект с объявлениями вкладов');
    return problems;
  }

  for (const key of ['skills', 'agents', 'pipelines', 'tools', 'promptBlocks', 'llmFilters'] as const) {
    const value = rawProvides[key];
    if (value !== undefined && !Array.isArray(value)) {
      problems.push(`provides.${key}: ожидается массив`);
    }
  }
  const rawMcp = rawProvides.mcp;
  if (rawMcp !== undefined && !Array.isArray(rawMcp) && !isRecord(rawMcp)) {
    problems.push('provides.mcp: ожидается объект или массив объектов');
  }
  const rawAuthority = rawProvides.authority;
  if (rawAuthority !== undefined && !isRecord(rawAuthority)) {
    problems.push('provides.authority: ожидается объект { roles[], actions[], targets[], agents[] }');
  }

  const provides = normalizePackProvides(rawProvides);
  const authorityCount =
    provides.authority.roles.length
    + provides.authority.actions.length
    + provides.authority.targets.length
    + provides.authority.agents.length;
  const declared =
    provides.mcp.length
    + provides.skills.length
    + provides.agents.length
    + provides.pipelines.length
    + provides.tools.length
    + provides.promptBlocks.length
    + provides.llmFilters.length
    + authorityCount;
  if (declared === 0) {
    problems.push(
      'provides: не заявлен ни один вклад (mcp/skills/agents/pipelines/tools/promptBlocks/llmFilters/authority)',
    );
  }

  // MCP: имя + транспорт, дубликаты имён.
  const mcpNames = new Set<string>();
  provides.mcp.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`provides.mcp[${index}]: ожидается объект`);
      return;
    }
    const name = item.name;
    if (typeof name !== 'string' || name.trim() === '') {
      problems.push(`provides.mcp[${index}]: MCP без поля «name»`);
    } else if (mcpNames.has(name)) {
      problems.push(`provides.mcp[${index}]: дубликат имени MCP «${name}»`);
    } else {
      mcpNames.add(name);
    }
    const transport = item.transport;
    if (typeof transport !== 'string' || transport.trim() === '') {
      problems.push(`provides.mcp[${index}]: MCP без поля «transport»`);
    } else if (transport !== 'http' && transport !== 'stdio') {
      problems.push(
        `provides.mcp[${index}]: неизвестный транспорт MCP «${transport}» (допустимо: http|stdio)`,
      );
    }
  });

  // Скиллы: имя + путь, дубликаты имён.
  const skillNames = new Set<string>();
  provides.skills.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`provides.skills[${index}]: ожидается объект`);
      return;
    }
    const name = item.name;
    if (typeof name !== 'string' || name.trim() === '') {
      problems.push(`provides.skills[${index}]: скилл без поля «name»`);
    } else if (skillNames.has(name)) {
      problems.push(`provides.skills[${index}]: дубликат имени скилла «${name}»`);
    } else {
      skillNames.add(name);
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      problems.push(`provides.skills[${index}]: скилл без поля «path»`);
    }
  });

  // Агенты: id, дубликаты id, известные capability.
  const agentIds = new Set<string>();
  provides.agents.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`provides.agents[${index}]: ожидается объект`);
      return;
    }
    const id = item.id;
    if (typeof id !== 'string' || id.trim() === '') {
      problems.push(`provides.agents[${index}]: агент без поля «id»`);
    } else if (agentIds.has(id)) {
      problems.push(`provides.agents[${index}]: дубликат id агента «${id}»`);
    } else {
      agentIds.add(id);
    }
    const capabilities = item.capabilities;
    if (capabilities === undefined) return;
    if (!Array.isArray(capabilities)) {
      problems.push(`provides.agents[${index}].capabilities: ожидается массив строк`);
      return;
    }
    const known = Object.values(ToolCapability) as readonly string[];
    capabilities.forEach((capability, capIndex) => {
      if (typeof capability !== 'string' || !known.includes(capability)) {
        problems.push(
          `provides.agents[${index}].capabilities[${capIndex}]: неизвестная capability «${String(capability)}» (допустимо: ${known.join('|')})`,
        );
      }
    });
  });

  // Пайплайны: id + дубликаты id.
  const pipelineIds = new Set<string>();
  provides.pipelines.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`provides.pipelines[${index}]: ожидается объект`);
      return;
    }
    const id = item.id;
    if (typeof id !== 'string' || id.trim() === '') {
      problems.push(`provides.pipelines[${index}]: пайплайн без поля «id»`);
    } else if (pipelineIds.has(id)) {
      problems.push(`provides.pipelines[${index}]: дубликат id пайплайна «${id}»`);
    } else {
      pipelineIds.add(id);
    }
  });

  // 12. Вклады плагина (ADR-090): проверяются явными схемами — неизвестное
  // поле, невалидный тир/фаза, пустое имя и дубль — проблема, а не молчаливый
  // проход (иначе правило «регистрации обязаны совпадать с provides» нечем
  // проверять).
  problems.push(...validatePluginProvides(provides));

  // 15. Контент полномочий (ADR-106): та же строгая схема + кросс-ссылки —
  // неизвестное действие/цель/роль → отказ (не passthrough).
  problems.push(...validateAuthorityProvides(provides));

  // 13. `mode` — режим исполнения, допустим только для плагина.
  const mode = manifest.mode;
  if (mode !== undefined && mode !== null) {
    if (kind !== 'plugin') {
      problems.push(`mode: допустим только для kind «plugin» (текущий kind — «${String(kind)}»)`);
    } else if (typeof mode !== 'string' || !(PACK_PLUGIN_MODES as readonly string[]).includes(mode)) {
      problems.push(
        `mode: неизвестный режим исполнения «${String(mode)}» (допустимо: ${PACK_PLUGIN_MODES.join('|')})`,
      );
    }
  }

  // 14. `trust.level` — верхняя граница; для плагина — не выше trust-floor.
  problems.push(...validateManifestTrust(manifest, kind));

  return problems;
}

/**
 * Проверка вкладов плагина (`provides.tools`/`promptBlocks`/`llmFilters`) по
 * явным схемам ADR-090. Проблемы — строками (как остальные правила).
 */
function validatePluginProvides(provides: PackProvides): string[] {
  const problems: string[] = [];

  // Тулы: непустое имя, без дублей.
  const toolNames = new Set<string>();
  provides.tools.forEach((name, index) => {
    if (typeof name !== 'string' || name.trim() === '') {
      problems.push(`provides.tools[${index}]: пустое имя тула`);
      return;
    }
    if (toolNames.has(name)) {
      problems.push(`provides.tools[${index}]: дубликат имени тула «${name}»`);
      return;
    }
    toolNames.add(name);
  });

  // Промпт-блоки: ключ/тир/порядок; тир `stable` запрещён (ADR-070).
  const blockKeys = new Set<string>();
  provides.promptBlocks.forEach((item, index) => {
    const parsed = packPromptBlockProvideSchema.safeParse(item);
    if (!parsed.success) {
      problems.push(
        `provides.promptBlocks[${index}]: ${describeZodIssues(parsed.error)}`,
      );
      return;
    }
    const key = parsed.data.key;
    if (blockKeys.has(key)) {
      problems.push(`provides.promptBlocks[${index}]: дубликат ключа блока «${key}»`);
      return;
    }
    blockKeys.add(key);
  });

  // LLM-фильтры: id/фаза; id уникален.
  const filterIds = new Set<string>();
  provides.llmFilters.forEach((item, index) => {
    const parsed = packLlmFilterProvideSchema.safeParse(item);
    if (!parsed.success) {
      problems.push(`provides.llmFilters[${index}]: ${describeZodIssues(parsed.error)}`);
      return;
    }
    const id = parsed.data.id;
    if (filterIds.has(id)) {
      problems.push(`provides.llmFilters[${index}]: дубликат id фильтра «${id}»`);
      return;
    }
    filterIds.add(id);
  });

  return problems;
}

/** Человекочитаемая сводка проблем zod-валидации (для списка проблем). */
function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Проверка контента полномочий (`provides.authority`, ADR-106).
 *
 * Схема строгая (`.strict()`) — неизвестное поле, неизвестное действие,
 * неизвестная цель или неизвестная роль дают проблему, а не «проскочивший»
 * passthrough. Проблемы — строками (как остальные правила манифеста).
 */
function validateAuthorityProvides(provides: PackProvides): string[] {
  const problems: string[] = [];
  const authority = provides.authority;
  const parsed = packAuthorityProvidesSchema.safeParse(authority);
  if (!parsed.success) {
    problems.push(`provides.authority: ${describeZodIssues(parsed.error)}`);
    return problems;
  }
  return validateAuthorityContent({
    actions: parsed.data.actions,
    roles: parsed.data.roles,
    targets: parsed.data.targets,
    agents: parsed.data.agents,
  });
}

/**
 * Проверка заявленного доверия (ADR-090).
 *
 * Заявленный уровень — **верхняя граница**: фактический trust резолвится по
 * источнику/реестру, манифест не может его повысить. Для `kind: 'plugin'`
 * уровень не должен быть выше `trusted` — trust-floor плагина и «право вето
 * только у доверенных» (ADR-090).
 */
function validateManifestTrust(manifest: Record<string, unknown>, kind: unknown): string[] {
  const problems: string[] = [];
  const trust = manifest.trust;
  if (trust === undefined || trust === null) return problems;
  if (!isRecord(trust)) {
    problems.push('trust: ожидается объект { level?, source? }');
    return problems;
  }
  const level = trust.level;
  if (level === undefined || level === null) return problems;
  if (typeof level !== 'string' || !(CATALOG_TRUST_LEVELS as readonly string[]).includes(level)) {
    problems.push(
      `trust.level: неизвестный уровень доверия «${String(level)}» (допустимо: ${CATALOG_TRUST_LEVELS.join('|')})`,
    );
    return problems;
  }
  if (kind !== 'plugin') return problems;
  const floor = 'trusted';
  if (trustLevelRank(level as (typeof CATALOG_TRUST_LEVELS)[number]) < trustLevelRank(floor)) {
    problems.push(
      `trust.level: «${level}» выше trust-floor плагина «${floor}» (право вето — только у доверенных)`,
    );
  }
  return problems;
}

// --- Сверка объявленных вкладов с фактическими регистрациями ---

/** Вид вклада, по которому сверяются объявление и регистрация. */
export type PackProvidesKind = 'tool' | 'promptBlock' | 'llmFilter';

/**
 * Расхождение между объявленным в манифесте вкладом и фактической
 * регистрацией расширения.
 *
 * - `missing` — объявлено в `provides`, но не зарегистрировано;
 * - `unexpected` — зарегистрировано, но не объявлено.
 */
export interface PackProvidesMismatch {
  kind: PackProvidesKind;
  /** Имя вклада (имя тула / ключ блока / id фильтра). */
  name: string;
  issue: 'missing' | 'unexpected';
}

/** Объявленные в манифесте вклады (из `provides`). */
export interface DeclaredPackProvides {
  tools?: readonly string[];
  promptBlocks?: readonly { key: string }[];
  llmFilters?: readonly { id: string }[];
}

/** Фактически зарегистрированные расширением вклады. */
export interface RegisteredPackProvides {
  tools?: readonly string[];
  promptBlocks?: readonly string[];
  llmFilters?: readonly string[];
}

/**
 * ADR-090: сверка объявленных в манифесте вкладов с фактическими
 * регистрациями расширения.
 *
 * Правило: «фактические регистрации обязаны совпадать с `provides`» —
 * расхождение (объявлено, но не зарегистрировано — и наоборот) означает
 * несогласованную сборку и должно вести к отказу активации (Ф1/Ф3).
 *
 * Функция возвращает **список расхождений** (пустой — совпадение) и не
 * бросает исключений: вызывающий (загрузчик `PluginHost`) сам решает, что
 * с ними делать.
 */
export function diffPackProvides(
  declared: DeclaredPackProvides,
  registered: RegisteredPackProvides,
): PackProvidesMismatch[] {
  const mismatches: PackProvidesMismatch[] = [];

  const diff = (
    kind: PackProvidesKind,
    declaredNames: readonly string[],
    registeredNames: readonly string[],
  ): void => {
    const registeredSet = new Set(registeredNames);
    const declaredSet = new Set(declaredNames);
    for (const name of declaredNames) {
      if (!registeredSet.has(name)) mismatches.push({ kind, name, issue: 'missing' });
    }
    for (const name of registeredNames) {
      if (!declaredSet.has(name)) mismatches.push({ kind, name, issue: 'unexpected' });
    }
  };

  diff('tool', declared.tools ?? [], registered.tools ?? []);
  diff(
    'promptBlock',
    (declared.promptBlocks ?? []).map((block) => block.key),
    registered.promptBlocks ?? [],
  );
  diff(
    'llmFilter',
    (declared.llmFilters ?? []).map((filter) => filter.id),
    registered.llmFilters ?? [],
  );

  return mismatches;
}

// --- Семвер-гейт расширения (ADR-090, шаг 3) ---

/** Причина отказа семвер-гейта. */
export type ExtensionCompatibilityReason = 'contract_mismatch' | 'host_mismatch';

/**
 * Машиночитаемый вердикт семвер-гейта: расширение совместимо с хостом или
 * нет (и почему).
 */
export interface ExtensionCompatibilityVerdict {
  ok: boolean;
  /** Причина отказа (нет при `ok: true`). */
  reason?: ExtensionCompatibilityReason;
  /** Ожидаемое значение (диапазон контракта/host). */
  expected?: string;
  /** Фактическое значение (версия контракта/host). */
  actual?: string;
}

/** Имя контракта Extension API по умолчанию (ADR-090). */
export const DEFAULT_EXTENSION_CONTRACT = 'extensionApi';

/**
 * ADR-090 (шаг 3): семвер-гейт расширения против хоста.
 *
 * Проверяются два объявления манифеста:
 * - `contracts.extensionApi` — semver-диапазон версии контракта точки
 *   расширения, которую предоставляет хост (сейчас — мажор `1`);
 * - `host` — semver-диапазон версий Synth, совместимых с расширением.
 *
 * Порядок проверок — как в пайплайне активации: сначала контракт, потом
 * host. Точные исключения (`exactHostExceptions`) — список версий Synth,
 * совместимых **вопреки** диапазону `host` (формат файла исключений —
 * открытый вопрос ADR-090; здесь — сам список).
 *
 * Вердикт — машиночитаемый: `{ ok, reason, expected, actual }`; загрузчик
 * `PluginHost` (Ф1) переиспользует функцию как есть.
 */
export function checkExtensionCompatibility(input: {
  /** Объявленные контракты расширения (`contracts` манифеста). */
  contracts?: Record<string, string>;
  /** Диапазон версий Synth (`host` манифеста). */
  host?: string;
  /** Версия Synth (хоста). */
  hostVersion: string;
  /** Версия контракта Extension API, который предоставляет хост (напр. `1`). */
  contractVersion: string;
  /** Ключ контракта в `contracts` (по умолчанию — `extensionApi`). */
  contractName?: string;
  /** Точные исключения семвер-гейта (версии host в обход диапазона `host`). */
  exactHostExceptions?: readonly string[];
}): ExtensionCompatibilityVerdict {
  const contractName = input.contractName ?? DEFAULT_EXTENSION_CONTRACT;
  const contractRange = input.contracts?.[contractName];
  if (contractRange !== undefined) {
    if (!satisfiesSemverRange(input.contractVersion, contractRange)) {
      return {
        ok: false,
        reason: 'contract_mismatch',
        expected: contractRange,
        actual: input.contractVersion,
      };
    }
  }

  const hostRange = input.host;
  if (hostRange !== undefined) {
    const excepted = (input.exactHostExceptions ?? []).includes(input.hostVersion);
    if (!excepted && !satisfiesSemverRange(input.hostVersion, hostRange)) {
      return {
        ok: false,
        reason: 'host_mismatch',
        expected: hostRange,
        actual: input.hostVersion,
      };
    }
  }

  return { ok: true };
}
