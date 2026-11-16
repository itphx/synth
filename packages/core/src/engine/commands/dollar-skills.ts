/**
 * ADR-126 §3: пользовательский вызов скилла через `$name`.
 *
 * `$name` — **единственный** пользовательский вызов скилла (ADR-126 §3/§7):
 * `/skill-name` удалён, скиллы в `/`-каталоге отсутствуют. Токен ищется в
 * тексте сообщения, а не в начале, поэтому вызов не конкурирует с `/`-командами.
 *
 * Правила (ADR-126 §3):
 *
 * - в контекст попадает **тело скилла** (`<skill_content>` + base dir +
 *   supporting-файлы), а не вызов инструмента: модель дальше сама вызывает
 *   тулы по permissions (ADR-025/ADR-029);
 * - учитываются trust/scope/capabilities: недоверенный проектный скилл,
 *   отключённый scope или нехватка capabilities → скилл **не грузится**
 *   (имя попадает в `unavailable`);
 * - несколько `$` в сообщении допускаются, дубликаты схлопываются, порядок
 *   сохраняется;
 * - `$` внутри code-блоков не распознаётся — это делает общий лексер
 *   (`engine/input-surface/parser.ts`), тела скиллов **не** разбираются
 *   (рекурсии нет).
 *
 * Исходный текст сообщения не меняется: резолвер возвращает отдельный
 * `prompt`, который вызывающий добавляет к сообщению.
 */

import type { PermissionConfig } from '@itphx/synth-shared';
import { parseInput } from '../input-surface/parser.js';
import { buildSkillContentBlock } from '../skills/loader.js';
import { matchesBinding, missingCapabilities, resolveSkillAvailability } from '../skills/scope.js';
import type { SkillRuntime, SkillScopeOptions } from '../skills/types.js';
import { resolveSkillRule } from '../permission/evaluator.js';

/** Причина, по которой скилл не загружен при `$`-вызове. */
export type DollarSkillUnavailableReason =
  /** Скилл не найден в реестре. */
  | 'unknown'
  /** Проектный скилл недоверенного каталога (ADR-126 §9). */
  | 'untrusted'
  /** Отключён scope-гейтом (система/проект/сессия) — ADR-126 §11. */
  | 'scope'
  /** Скилл не привязан к текущему агенту (ADR-126 §9). */
  | 'binding'
  /** Скилл не вызывается пользователем (`user-invocable: false`). */
  | 'invocation'
  /** Правило `permission.rules.skill` запрещает скилл (ADR-126 §10). */
  | 'permission'
  /** Агенту не хватает требуемых capabilities (ADR-126 §10). */
  | 'capabilities';

/** Вход резолвера `$`-скиллов. */
export interface DollarSkillsInput {
  /** Исходный текст сообщения пользователя. */
  text: string;
  /** Рабочий каталог проекта (источник project-скиллов и trust-статуса). */
  projectWorkspace?: string;
  /** Capabilities текущего агента. */
  capabilities?: readonly string[];
  /** Привязка агента (`id` + `groups`). */
  agent?: { id?: string; groups?: string[] };
  /** Per-session явное включение имён (ADR-126 §11). */
  sessionEnabled?: string[];
  /** Per-session opt-out имён/категорий/групп (ADR-126 §11). */
  sessionDisabled?: string[];
  /** Permission-конфиг сессии (deny скрывает скилл, ADR-126 §10). */
  permissionConfig?: PermissionConfig;
  /** Рантайм скиллов (discovery + загрузка тела). */
  skillRuntime: SkillRuntime;
  /**
   * Scope-гейты скиллов (система/проект/сессия) — тот же объект, что у
   * каталога промпта и тула `skill`.
   */
  scope?: SkillScopeOptions;
  /**
   * `config.skills.toolsets` — экспансия `requires_toolsets` (ADR-126 §13).
   * Используется, если рантайм не умеет сам считать недостающие capability.
   */
  toolsets?: Record<string, readonly string[]>;
}

/** Результат резолвера `$`-скиллов. */
export interface DollarSkillsResult {
  /** Текст для добавления в сообщение (тела доступных скиллов). */
  prompt?: string;
  /** Имена загруженных скиллов — в порядке вызова. */
  skills: string[];
  /** Имена недоступных скиллов — в порядке вызова. */
  unavailable: string[];
  /** Причина недоступности по имени скилла (диагностика/лог). */
  reasons?: Record<string, DollarSkillUnavailableReason>;
}

/** Заголовок блока скилла в промпте (ADR-126 §3). */
const SKILL_BLOCK_HEADER = '[skills requested by user:';

/**
 * ADR-126 §3: резолвит `$`-скиллы в тексте сообщения.
 *
 * Возвращает `prompt` (тела доступных скиллов) и списки загруженных/
 * недоступных скиллов. Текст сообщения не меняется — вызывающий сам решает,
 * как добавить `prompt` (оркестратор добавляет его к user-сообщению).
 */
export async function resolveDollarSkills(
  input: DollarSkillsInput,
): Promise<DollarSkillsResult> {
  const text = input.text ?? '';
  const mentions = parseInput(text).skills;
  if (mentions.length === 0) return { skills: [], unavailable: [] };

  // Дедуп по id, порядок появления сохраняется (ADR-126 §3).
  const names: string[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const id = mention.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id);
  }

  const skills: string[] = [];
  const unavailable: string[] = [];
  const reasons: Record<string, DollarSkillUnavailableReason> = {};
  const blocks: Array<{ name: string; content: string }> = [];

  for (const name of names) {
    const loaded = await loadDollarSkill(name, input);
    if ('reason' in loaded) {
      unavailable.push(name);
      reasons[name] = loaded.reason;
      continue;
    }
    skills.push(name);
    blocks.push({ name, content: loaded.content });
  }

  if (blocks.length === 0) return { skills, unavailable, reasons };

  const prompt = blocks
    .map((b) => `${SKILL_BLOCK_HEADER} ${b.name}]\n\n${b.content}`)
    .join('\n\n');
  return { prompt, skills, unavailable, reasons };
}

/**
 * Загружает тело одного скилла. Ошибка загрузки/недоступность → причина
 * (скилл в промпт не попадает).
 */
async function loadDollarSkill(
  name: string,
  input: DollarSkillsInput,
): Promise<{ content: string } | { reason: DollarSkillUnavailableReason }> {
  const { skillRuntime, projectWorkspace } = input;
  const discovered = await skillRuntime.get(name, { projectWorkspace });
  if (!discovered) return { reason: 'unknown' };

  // ADR-126 §9: недоверенный проектный скилл виден, но не грузится.
  if (!discovered.trusted) return { reason: 'untrusted' };

  // ADR-126 §3: `$` — явный вызов пользователя; скилл, запрещённый к
  // пользовательскому вызову, недоступен.
  if (!discovered.meta.userInvocable) return { reason: 'invocation' };

  // ADR-126 §11: scope-гейты (система/проект/сессия).
  const availability = resolveSkillAvailability(discovered.meta, input.scope);
  if (!availability.enabled) return { reason: 'scope' };

  // ADR-126 §9: привязка к агенту (`agents`/`groups`).
  if (!matchesBinding(discovered.meta, input.agent)) return { reason: 'binding' };

  // ADR-126 §10: per-skill права (`permission.rules.skill`).
  if (resolveSkillRule(input.permissionConfig, name)?.action === 'deny') {
    return { reason: 'permission' };
  }

  // ADR-126 §10: capability-aware (с экспансией `requires_toolsets`).
  const missing = skillRuntime.missingCapabilities
    ? skillRuntime.missingCapabilities(discovered.meta, input.capabilities)
    : missingCapabilities(discovered.meta, input.capabilities, input.toolsets);
  if (missing.length > 0) return { reason: 'capabilities' };

  const loaded = await skillRuntime.load(name, {
    projectWorkspace,
    capabilities: input.capabilities,
  });
  if (!loaded) return { reason: 'unknown' };

  return { content: buildSkillContentBlock(loaded.summary, loaded.body, loaded.dir, loaded.files) };
}
