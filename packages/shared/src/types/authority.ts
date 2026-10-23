/**
 * PROP-108 Ф0: модель Authority-слоя — полномочия как контент.
 *
 * Модель **доменно-нейтральна**: «действие», «цель» и «роль» — данные, а не код
 * ядра (PROP-108 §«Доменная нейтральность»). Ядро знает только форму записи и
 * правила решения; конкретные глаголы (`sign`, `commit`), цели (`record:*`,
 * `invoice:*`) и роли (`clinician`, `treasurer`) приезжают контентом
 * (`provides.authority` пакета, ADR-086/PROP-090) и включаются политикой
 * инстанса (PROP-108 §«Правила безопасности контента»).
 *
 * Ключевые инварианты (PROP-108 §«Инварианты модели»):
 * 1. **Нет гранта — нет права.** `allow` не выводится из отсутствия запрета;
 *    неизвестное действие/цель — `deny` (fail-closed).
 * 2. **Грант — всегда «действие × цель».** Цель — типизированный ресурс; текст
 *    команды, промпт и имя тула целью не являются.
 * 3. **Права только сужаются** (пересечение осей, не объединение).
 *
 * Схемы — **строгие** (`.strict()`): неизвестное поле, неизвестное действие,
 * неизвестная цель или неизвестная роль — ошибка разбора, а не «проскочивший»
 * passthrough. Кросс-ссылки (грант → объявленное действие, агент → объявленная
 * роль) проверяет `validateAuthorityContent`.
 *
 * Модуль browser-safe (`zod` + локальные типы + `utils/glob`): используется и в
 * ядре, и (в будущем) в UI.
 */
import { z } from 'zod';

import { globMatch } from '../utils/glob.js';

// --- Виды принципалов ---

/**
 * Кто действует (PROP-108 §«Модель»): пользователь, агент, service-key,
 * шедулер или внешний источник события.
 */
export const AUTHORITY_PRINCIPAL_KINDS = ['user', 'agent', 'service', 'scheduler', 'event'] as const;
export type AuthorityPrincipalKind = (typeof AUTHORITY_PRINCIPAL_KINDS)[number];
export const authorityPrincipalKindSchema = z.enum(AUTHORITY_PRINCIPAL_KINDS);

/**
 * Идентификатор принципала: `user:<id>`, `agent:<id>`, `service:<keyId>`,
 * `scheduler`, `event:<source>` (PROP-108 §«Многопользовательская сессия»).
 */
export const AUTHORITY_PRINCIPAL_ID_REGEX = /^[a-z][a-z0-9._-]*:[^\s]+$/;
export const authorityPrincipalRefSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(AUTHORITY_PRINCIPAL_ID_REGEX, 'принципал: "<вид>:<идентификатор>" (например, user:local)');

// --- Виды целей ---

/**
 * Виды целей, известные **ядру** (PROP-108 §«Модель»): проект, путь, сессия,
 * MCP-сервер, внешний ресурс, рабочая область.
 *
 * ⚠️ Доменная нейтральность требует и других видов (`record:<patientId>`,
 * `invoice:<id>`, `report:<period>` — PROP-108 §«Доменная нейтральность»), поэтому
 * `kind` — идентификатор строки, а не закрытое перечисление: доменные виды
 * **объявляются контентом** (`provides.authority.targets[]`) и становятся
 * известными только после установки и одобрения пакета. Ядро знает базовый
 * набор (`AUTHORITY_CORE_TARGET_KINDS`) и не более.
 */
export const AUTHORITY_CORE_TARGET_KINDS = [
  'project',
  'path',
  'session',
  'mcp',
  'external',
  'workspace',
] as const;
export type AuthorityCoreTargetKind = (typeof AUTHORITY_CORE_TARGET_KINDS)[number];

/** Идентификатор вида цели (ядро + доменные, объявленные контентом). */
export const AUTHORITY_TARGET_KIND_REGEX = /^[a-z][a-z0-9._-]*$/;
export const authorityTargetKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(AUTHORITY_TARGET_KIND_REGEX, 'вид цели: строчные латинские буквы/цифры (a-z0-9._-)');

/** true — вид цели известен ядру (без контента). */
export function isCoreTargetKind(kind: string): kind is AuthorityCoreTargetKind {
  return (AUTHORITY_CORE_TARGET_KINDS as readonly string[]).includes(kind);
}

// --- Действия ---

/**
 * Идентификатор доменного действия: `read`/`write`/`execute`/`publish`/
 * `approve`/`sign`/`delegate`/`commit` — **данные**, а не перечисление ядра.
 */
export const AUTHORITY_ACTION_ID_REGEX = /^[a-z][a-z0-9._-]*$/;
export const authorityActionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(AUTHORITY_ACTION_ID_REGEX, 'действие: строчные латинские буквы/цифры (a-z0-9._-)');

// --- Цели и шаблоны целей ---

/**
 * Шаблон цели гранта: `<вид>:<шаблон-ссылки>` (PROP-108 §«Модель»).
 * Примеры: `path:src/**`, `path:*.env`, `mcp:git/*`, `record:*`,
 * `external:registry/*`.
 *
 * Вид обязателен: цель — типизированный ресурс, а не «просто строка».
 */
export const AUTHORITY_TARGET_PATTERN_REGEX = /^[a-z][a-z0-9._-]*:.+$/;
export const authorityTargetPatternSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(AUTHORITY_TARGET_PATTERN_REGEX, 'шаблон цели: "<вид>:<шаблон>" (например, path:src/**)');

// --- Эффекты и ограничения гранта ---

/** Эффект гранта: разрешить / спросить / запретить. */
export const AUTHORITY_GRANT_EFFECTS = ['allow', 'ask', 'deny'] as const;
export type AuthorityGrantEffect = (typeof AUTHORITY_GRANT_EFFECTS)[number];
export const authorityGrantEffectSchema = z.enum(AUTHORITY_GRANT_EFFECTS);

/**
 * Ограничения гранта (PROP-108 §«Модель»): `once` (одноразовость),
 * `ttlMs` (срок жизни), `maxCount` (лимит применений), `requireConfirm`
 * (требовать подтверждения даже при `allow`).
 */
export const authorityGrantConstraintsSchema = z
  .object({
    /** Грант одноразовый: повторное применение — `deny`. */
    once: z.boolean().optional(),
    /** Срок жизни гранта, мс. */
    ttlMs: z.number().int().positive().max(31_536_000_000).optional(),
    /** Предел числа применений гранта. */
    maxCount: z.number().int().positive().max(1_000_000).optional(),
    /** Даже `allow` требует подтверждения носителем гранта. */
    requireConfirm: z.boolean().optional(),
  })
  .strict();
export type AuthorityGrantConstraints = z.infer<typeof authorityGrantConstraintsSchema>;

// --- Сущности модели ---

/**
 * Принципал — тот, от чьего имени исполняется ход (PROP-108 §«Модель»).
 * `roles[]` — роли, которые носитель принципала предъявляет (содержательные
 * роли приезжают контентом; глобальные роли инстанса — отдельная ось).
 */
export const authorityPrincipalSchema = z
  .object({
    kind: authorityPrincipalKindSchema,
    id: z.string().min(1).max(256),
    roles: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict();
export type AuthorityPrincipal = z.infer<typeof authorityPrincipalSchema>;

/**
 * Действие — доменный глагол. `mutating` — признак изменения состояния;
 * `requires[]` — действия, которые нужны перед этим (например, `sign`
 * требует `write`).
 */
export const authorityActionSchema = z
  .object({
    id: authorityActionIdSchema,
    mutating: z.boolean(),
    requires: z.array(authorityActionIdSchema).default([]),
  })
  .strict();
export type AuthorityAction = z.infer<typeof authorityActionSchema>;

/** Цель — типизированный ресурс. */
export const authorityTargetSchema = z
  .object({
    kind: authorityTargetKindSchema,
    ref: z.string().min(1).max(512),
    /** Область действия (например, проект/схема), необязательна. */
    scope: z.string().min(1).max(256).optional(),
  })
  .strict();
export type AuthorityTarget = z.infer<typeof authorityTargetSchema>;

/**
 * Грант — разрешение «действие × цель» с эффектом и опциональными
 * ограничениями. `deny` в гранте сильнее `allow` (PROP-108 §«Резолвинг и
 * решение»).
 */
export const authorityGrantSchema = z
  .object({
    action: authorityActionIdSchema,
    targetPattern: authorityTargetPatternSchema,
    effect: authorityGrantEffectSchema,
    constraints: authorityGrantConstraintsSchema.optional(),
  })
  .strict();
export type AuthorityGrant = z.infer<typeof authorityGrantSchema>;

/** Роль — именованный набор грантов (поставляется контентом). */
export const authorityRoleSchema = z
  .object({
    id: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256).optional(),
    domain: z.string().min(1).max(128),
    grants: z.array(authorityGrantSchema).default([]),
  })
  .strict();
export type AuthorityRole = z.infer<typeof authorityRoleSchema>;

/** Источники потолка (верхней границы активных прав). */
export const AUTHORITY_CEILING_SOURCES = ['user', 'session', 'pack', 'instance'] as const;
export type AuthorityCeilingSource = (typeof AUTHORITY_CEILING_SOURCES)[number];
export const authorityCeilingSourceSchema = z.enum(AUTHORITY_CEILING_SOURCES);

/**
 * Потолок — верхняя граница активных прав. Потолок с пустым списком грантов
 * **задаёт** запрет на всё (ось применима, грантов нет → «нет гранта — нет
 * права»); отсутствие потолка означает, что ось не применима.
 */
export const authorityCeilingSchema = z
  .object({
    grants: z.array(authorityGrantSchema).default([]),
    source: authorityCeilingSourceSchema,
  })
  .strict();
export type AuthorityCeiling = z.infer<typeof authorityCeilingSchema>;

/**
 * Ход — единица исполнения. Принципал фиксируется **при приёме ввода**
 * (PROP-108 §«Инварианты модели», п. 4) — в Ф4; в Ф0–Ф1 это просто контракт.
 */
export const authorityTurnSchema = z
  .object({
    id: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    principal: authorityPrincipalSchema,
    /** Агент хода (если ход исполняет агент). */
    agentId: z.string().min(1).max(128).optional(),
    /** Потолки хода (сессия/пакет/инстанс). */
    ceiling: z.array(authorityCeilingSchema).default([]),
    startedAt: z.string().min(1),
  })
  .strict();
export type AuthorityTurn = z.infer<typeof authorityTurnSchema>;

/**
 * Подтверждение — запрос на действие, привязанный к
 * `(principal, turn, action, target, digest)`; одноразовый (`once`).
 */
export const authorityApprovalSchema = z
  .object({
    id: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    principal: authorityPrincipalSchema,
    action: authorityActionIdSchema,
    target: authorityTargetSchema,
    /** Отпечаток запроса (действие + цель + ход) — защита от подмены. */
    digest: z.string().min(1).max(256),
    once: z.boolean(),
    expiresAt: z.string().min(1).optional(),
  })
  .strict();
export type AuthorityApproval = z.infer<typeof authorityApprovalSchema>;

/**
 * Объявление вида цели контентом: `kind` + имя резолвера (резолверы целей
 * регистрирует ядро или плагин — PROP-108 §«Декларация, не код»).
 */
export const authorityTargetDeclarationSchema = z
  .object({
    kind: authorityTargetKindSchema,
    resolver: z.string().min(1).max(128).optional(),
  })
  .strict();
export type AuthorityTargetDeclaration = z.infer<typeof authorityTargetDeclarationSchema>;

/**
 * Политика полномочий инстанса — верхняя граница (PROP-108 §«Точки
 * принуждения», уровень 4). Хранится через порт `AuthorityPolicyRepository`
 * (ADR-096).
 */
export const authorityPolicySchema = z
  .object({
    /** Объявленные действия (доменные глаголы). */
    actions: z.array(authorityActionSchema).default([]),
    /** Объявленные роли. */
    roles: z.array(authorityRoleSchema).default([]),
    /** Виды целей, известные инстансу (ядро + объявленные контентом). */
    targets: z.array(authorityTargetDeclarationSchema).default([]),
    /** Потолок инстанса. */
    ceilings: z.array(authorityCeilingSchema).default([]),
  })
  .strict();
export type AuthorityPolicy = z.infer<typeof authorityPolicySchema>;

// --- Запись журнала решений ---

/**
 * Запись append-only журнала решений Authority-слоя (PROP-108 §«Инварианты
 * модели», п. 8): `principal`/`action`/`target`/`effect`/`source` — **без
 * секретов и без сырых путей** (путь нормализуется до относительного внутри
 * workspace, инвариант 25/ADR-094).
 */
export const authorityDecisionEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    ts: z.string().min(1),
    /** Принципал в виде `<вид>:<идентификатор>`. */
    principal: z.string().min(1).max(256),
    action: z.string().min(1).max(64),
    /** Цель в виде `<вид>:<ссылка>` (нормализованная). */
    target: z.string().min(1).max(512),
    effect: authorityGrantEffectSchema,
    /** Ось, давшая решение (`user`/`agent`/`session`/`pack`/`instance`). */
    source: z.string().min(1).max(32),
    /** Причина: `unknown`/`explicit`/`no_grant`/null. */
    reason: z.string().min(1).max(64).nullable(),
    /** Режим: `shadow` — решение посчитано, но не применено (Ф1). */
    mode: z.enum(['shadow', 'enforced']).default('shadow'),
    /**
     * PROP-108 Ф1: решение permission-слоя на момент shadow-записи. Нужно для
     * разбора расхождений миграции («shadow-решение не совпало с текущим —
     * это дефект миграции»). В enforced-режиме поле отсутствует.
     */
    permissionEffect: z.enum(['allow', 'ask', 'deny']).optional(),
  })
  .strict();
export type AuthorityDecisionEntry = z.infer<typeof authorityDecisionEntrySchema>;

// --- Кросс-валидация контента ---

/**
 * Контент Authority-слоя: роли/действия/цели/агенты (PROP-108 §«Доменная
 * нейтральность»). Та же форма, что в `provides.authority` пакета.
 */
export interface AuthorityContent {
  actions: readonly AuthorityAction[];
  roles: readonly AuthorityRole[];
  targets: readonly AuthorityTargetDeclaration[];
  agents?: readonly { id: string; roles: readonly string[]; ceiling?: readonly string[] }[];
}

/**
 * Проверка целостности контента — **список проблем строками** (как
 * `validatePackManifest`), без throw.
 *
 * Проверяется:
 * 1. дубликаты id действий и ролей;
 * 2. грант ссылается на **объявленное** действие (неизвестное действие — отказ);
 * 3. `action.requires[]` ссылается на объявленные действия;
 * 4. вид цели в шаблоне гранта — известен ядру или объявлен в `targets[]`
 *    (неизвестная цель — отказ);
 * 5. агент ссылается на объявленные роли и на объявленные действия в потолке.
 */
export function validateAuthorityContent(content: AuthorityContent): string[] {
  const problems: string[] = [];

  const actionIds = new Set<string>();
  content.actions.forEach((action, index) => {
    if (actionIds.has(action.id)) {
      problems.push(`actions[${index}]: дубликат id действия «${action.id}»`);
      return;
    }
    actionIds.add(action.id);
  });

  const roleIds = new Set<string>();
  content.roles.forEach((role, index) => {
    if (roleIds.has(role.id)) {
      problems.push(`roles[${index}]: дубликат id роли «${role.id}»`);
      return;
    }
    roleIds.add(role.id);
  });

  const targetKinds = new Set<string>(AUTHORITY_CORE_TARGET_KINDS);
  content.targets.forEach((target, index) => {
    if (targetKinds.has(target.kind)) {
      problems.push(`targets[${index}]: вид цели «${target.kind}» уже известен ядру`);
      return;
    }
    targetKinds.add(target.kind);
  });

  content.actions.forEach((action, index) => {
    action.requires.forEach((required, reqIndex) => {
      if (!actionIds.has(required)) {
        problems.push(
          `actions[${index}].requires[${reqIndex}]: неизвестное действие «${required}»`,
        );
      }
    });
  });

  content.roles.forEach((role, index) => {
    role.grants.forEach((grant, grantIndex) => {
      if (!actionIds.has(grant.action)) {
        problems.push(
          `roles[${index}].grants[${grantIndex}]: неизвестное действие «${grant.action}»`,
        );
      }
      const kind = targetKindOfPattern(grant.targetPattern);
      if (kind !== undefined && !targetKinds.has(kind)) {
        problems.push(
          `roles[${index}].grants[${grantIndex}]: неизвестный вид цели «${kind}»`,
        );
      }
    });
  });

  (content.agents ?? []).forEach((agent, index) => {
    agent.roles.forEach((roleId, roleIndex) => {
      if (!roleIds.has(roleId)) {
        problems.push(`agents[${index}].roles[${roleIndex}]: неизвестная роль «${roleId}»`);
      }
    });
    (agent.ceiling ?? []).forEach((actionId, actionIndex) => {
      if (!actionIds.has(actionId)) {
        problems.push(
          `agents[${index}].ceiling[${actionIndex}]: неизвестное действие «${actionId}»`,
        );
      }
    });
  });

  return problems;
}

/** Вид цели из шаблона (`path:src/**` → `path`); `undefined` — шаблон без вида. */
export function targetKindOfPattern(pattern: string): string | undefined {
  const idx = pattern.indexOf(':');
  if (idx <= 0) return undefined;
  return pattern.slice(0, idx);
}

// --- Матчинг целей ---

/** Строковое представление цели: `<вид>:<ссылка>`. */
export function formatAuthorityTarget(target: AuthorityTarget): string {
  return `${target.kind}:${target.ref}`;
}

/**
 * Совпадает ли шаблон гранта с целью.
 *
 * Шаблон разбирается на вид и шаблон ссылки: вид обязан совпасть, ссылка
 * сравнивается glob'ом (`*` — сегмент, `**` — путь, ADR-029). Дополнительные
 * формы ссылки (`altRefs`) проверяются тоже — так же, как permission-слой
 * применяет файловый паттерн и к абсолютному, и к относительному пути.
 *
 * Несовпадение вида → `false` (fail-closed): грант на `path:*` не покрывает
 * цель `session:*`.
 */
export function matchAuthorityTargetPattern(
  pattern: string,
  target: AuthorityTarget,
  altRefs?: readonly string[],
): boolean {
  const idx = pattern.indexOf(':');
  if (idx <= 0) return false;
  const kind = pattern.slice(0, idx);
  if (kind !== target.kind) return false;
  const refPattern = pattern.slice(idx + 1);
  if (refPattern === '' ) return false;
  if (globMatch(refPattern, target.ref)) return true;
  for (const alt of altRefs ?? []) {
    if (globMatch(refPattern, alt)) return true;
  }
  return false;
}
