import type { AgentDefinition, ReasoningLevel } from '@itphx/synth-shared';
import type { DocumentRepository } from '../../storage/ports/document-repository.js';
import { loadSystemAgentDefinitions } from './index.js';

/**
 * Алиасы ролей прежнего набора агентов (до замены `pm`/`developer`/`qa`/
 * `analyst`/`auditor` на `leader`/`fixer`/`tester`/`researcher`/
 * `security-auditor`).
 *
 * Нужны в двух местах:
 *  - миграция stored-агентов (`migrateLegacyStoredAgents`) — запись с id
 *    прежней роли переносится в запись целевой;
 *  - runtime-резолвинг роли (`ChatOrchestrator._resolveEffectiveAgentRole`):
 *    у старых сессий `settings.agentRole` ещё хранит `pm`, и роль должна
 *    работать как `leader`, а не падать в фоллбек `assistant`.
 */
export const LEGACY_AGENT_ROLE_ALIASES = {
  pm: 'leader',
  developer: 'fixer',
  qa: 'tester',
  analyst: 'researcher',
  auditor: 'security-auditor',
} as const;

const ALIASES: Readonly<Record<string, string>> = LEGACY_AGENT_ROLE_ALIASES;

/** Алиас прежней роли (`pm` → `leader`); не прежняя роль — `undefined`. */
export function resolveAgentRoleAlias(role: string | undefined): string | undefined {
  if (!role) return undefined;
  return ALIASES[role];
}

/** Допустимые уровни размышлений — значение из стора переносим только узнаваемое. */
const REASONING_LEVELS: readonly ReasoningLevel[] = ['default', 'none', 'low', 'medium', 'high'];

/** Пользовательская настройка из устаревшей записи: переносится, только если задана. */
function copyNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Собирает целевую запись из встроенного определения + **пользовательских**
 * настроек устаревшей записи.
 *
 * Идентичность, права, промпт и лимиты берутся у встроенного агента: именно
 * в них был дефект (у `pm` оставались PM-описание, старые capabilities с
 * `file_write`/`git_write` и `maxSteps: 0`, при подменённом на LEADER
 * `contextFile`). Переносим только то, что пользователь реально настраивал:
 * включённость, модель/провайдер, сэмплинг, уровень размышлений и группы.
 */
function buildMigratedAgent(
  builtin: AgentDefinition,
  legacy: AgentDefinition,
): AgentDefinition {
  const migrated: AgentDefinition = { ...builtin, isOverridden: true };

  if (typeof legacy.enabled === 'boolean') migrated.enabled = legacy.enabled;
  if (typeof legacy.provider === 'string') migrated.provider = legacy.provider;
  if (typeof legacy.model === 'string') migrated.model = legacy.model;

  const temperature = copyNumber(legacy.temperature);
  if (temperature !== undefined) migrated.temperature = temperature;
  const topP = copyNumber(legacy.topP);
  if (topP !== undefined) migrated.topP = topP;
  const topK = copyNumber(legacy.topK);
  if (topK !== undefined) migrated.topK = topK;

  if (legacy.reasoningLevel && REASONING_LEVELS.includes(legacy.reasoningLevel)) {
    migrated.reasoningLevel = legacy.reasoningLevel;
  }
  if (Array.isArray(legacy.groups)) {
    migrated.groups = legacy.groups.filter((g): g is string => typeof g === 'string' && g !== '');
  }

  return migrated;
}

/**
 * Миграция stored-агентов с id прежнего набора ролей (ADR-096: стор агентов —
 * не обязательно файлы, при `storage.backend=postgres` это таблица документов).
 *
 * Зачем: после замены набора ролей в сторе остаются полные копии прежних
 * встроенных агентов (`pm` и т.п.). В списке агентов оказывались две роли
 * сразу, а старая несла подменённый `contextFile` (пользователь поставил
 * `LEADER.ru.md`) при PM-идентичности, PM-описании и старых правах — агент
 * получал роль LEADER в промпте с правами PM. Плюс сессии с
 * `settings.agentRole='pm'` после удаления записи уходили в фоллбек `assistant`.
 *
 * Правила:
 *  - мигрируют только записи, чей id есть в `LEGACY_AGENT_ROLE_ALIASES`, и
 *    только если целевой встроенный агент существует;
 *  - пользовательские настройки (`enabled`, `provider`, `model`, `temperature`,
 *    `topP`, `topK`, `reasoningLevel`, `groups`) переносятся в целевую запись;
 *  - целевая запись, **уже существующая** в сторе, не перетирается — она
 *    остаётся как есть, устаревшая запись всё равно удаляется;
 *  - целевая запись сохраняется с `isOverridden: true`, устаревшая удаляется;
 *  - возвращает список переносов (`pm→leader`) для лога; повторный вызов
 *    идемпотентен (устаревших записей уже нет — пустой список);
 *  - битые записи и записи без `id` пропускаются; ошибки стора не бросаются
 *    (миграция — best-effort при старте, запись повторится в следующий раз).
 */
export async function migrateLegacyStoredAgents(
  store: DocumentRepository<AgentDefinition>,
): Promise<string[]> {
  const migrated: string[] = [];
  if (!store) return migrated;

  let stored: AgentDefinition[];
  try {
    stored = await store.list();
  } catch {
    return migrated;
  }
  if (!Array.isArray(stored)) return migrated;

  const builtinById = new Map(loadSystemAgentDefinitions().map((a) => [a.id, a]));

  for (const legacy of stored) {
    if (!legacy || typeof legacy !== 'object') continue;
    const id = (legacy as AgentDefinition).id;
    if (typeof id !== 'string' || !id) continue;

    const targetId = resolveAgentRoleAlias(id);
    if (!targetId) continue;
    const builtin = builtinById.get(targetId);
    if (!builtin) continue;

    try {
      // Существующую целевую запись не трогаем: пользователь мог настроить её
      // сам, а миграция не должна перетирать живые данные.
      if (!(await store.exists(targetId))) {
        await store.save(targetId, buildMigratedAgent(builtin, legacy));
      }
      await store.delete(id);
    } catch {
      // Запись не мигрировала — оставляем как есть, повторим при следующем старте.
      continue;
    }
    migrated.push(`${id}→${targetId}`);
  }

  return migrated;
}
