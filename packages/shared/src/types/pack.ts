/**
 * ADR-086 §5 / PROP-090 §3: единый манифест расширения `synth.pack`.
 *
 * Манифест — файл `synth.pack` (JSON) в корне репозитория расширения. Формат
 * **общий** для всех классов расширений: Plugin (PROP-090), Gateway (ADR-087),
 * Add-on (эталон — `synth-media`), контент-пак (PROP-068) и драйвер слоя
 * хранения (`kind: 'storage'`, ADR-097).
 *
 * Здесь только контракт (типы + zod-схемы): загрузка, установка и активация
 * расширений — в core (PROP-090 отложен до 2026-10-19). Модуль browser-safe
 * (`zod` + локальные типы), в UI-бандл `node:*` не попадает.
 */
import { z } from 'zod';

import type { AgentMode } from './agent.js';
import { pipelineDefinitionSchema } from './pipeline.js';
import { ToolCapability } from './tools.js';

// --- Реестры классов и типов расширений ---

/**
 * Классы расширений (ADR-086 §5):
 * - `plugin` — код в процессе ядра (PROP-090);
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
 */
export const PACK_HOST_RANGE_REGEX =
  /^(?:\^|~|>=|<=|>|<|=)?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Проверяет, что значение — корректный semver-диапазон (host-версия). */
export function isPackHostRange(value: string): boolean {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => PACK_HOST_RANGE_REGEX.test(part));
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
 * Пайплайн-предоставление (ADR-051/PROP-059): описание автомата. Либо файл
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

/**
 * Набор вкладов расширения. Списки нормализованы (отсутствующий список —
 * пустой массив), неизвестные ключи сохраняются: виды вкладов расширяются
 * без изменения формата манифеста.
 */
export const packProvidesSchema = z
  .object({
    mcp: packMcpProvidesSchema.default([]),
    skills: z.array(packSkillProvideSchema).default([]),
    agents: z.array(packAgentProvideSchema).default([]),
    pipelines: z.array(packPipelineProvideSchema).default([]),
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
    /** Версии контрактов, которые расширение использует (напр. `apiV2: '^2'`). */
    contracts: z.record(z.string(), z.string()).optional(),
    /** Краткое описание (инспекция/каталог). */
    description: z.string().min(1),
    /** Что расширение регистрирует. */
    provides: packProvidesSchema,
    /** Тип контент-пака — только для `kind: 'pack'`. */
    packType: packTypeSchema.optional(),
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
 * 11. `agents[].capabilities` — строки из известного набора `ToolCapability`.
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

  for (const key of ['skills', 'agents', 'pipelines'] as const) {
    const value = rawProvides[key];
    if (value !== undefined && !Array.isArray(value)) {
      problems.push(`provides.${key}: ожидается массив`);
    }
  }
  const rawMcp = rawProvides.mcp;
  if (rawMcp !== undefined && !Array.isArray(rawMcp) && !isRecord(rawMcp)) {
    problems.push('provides.mcp: ожидается объект или массив объектов');
  }

  const provides = normalizePackProvides(rawProvides);
  const declared = provides.mcp.length + provides.skills.length + provides.agents.length + provides.pipelines.length;
  if (declared === 0) {
    problems.push('provides: не заявлен ни один вклад (mcp/skills/agents/pipelines)');
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

  return problems;
}
