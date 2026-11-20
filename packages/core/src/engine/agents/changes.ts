/**
 * Сравнение определений агента «было / стало» — чтобы событие `agents.updated`
 * публиковалось только когда запись **действительно** изменилась.
 *
 * ## Зачем
 *
 * Запись агента идемпотентна: панель отправляет форму целиком, тул
 * `synth_agent_save` — тоже полный набор полей. Без сравнения повторное
 * сохранение без правок давало бы событие, а за ним — лишний
 * `GET /agents/all` в каждой открытой админке (шум вместо инвалидации).
 *
 * ## Почему отпечаток, а не `JSON.stringify` записи
 *
 * Порядок ключей у merge-результата (`body → existing → builtin`) и у записи
 * стора разный, а `undefined`-поля в JSON не сериализуются вовсе. Отпечаток
 * перечисляет **семантически значимые** поля в фиксированном порядке; массивы
 * сортируются (`capabilities`, `groups` — множества), а `undefined` и пустой
 * список у `allowedProfiles`/`allowedBrowserProfiles` различимы (ADR-135,
 * аддендум: пустой список — «профилей нет», не задан — потолка нет).
 */
import type { AgentDefinition } from '@itphx/synth-shared';
import { normalizeAgentModes } from './normalize.js';

/** Список-множество в отпечатке: `undefined` («не задано») ≠ `[]` («пусто»). */
function listKey(list: readonly string[] | undefined, sort: boolean): string {
  if (list === undefined) return '-';
  const items = sort ? [...list].sort() : list;
  return JSON.stringify(items);
}

/**
 * Канонический отпечаток определения агента. Равные отпечатки — «запись не
 * изменилась» (событие не публикуется).
 */
export function agentDefinitionKey(agent: AgentDefinition): string {
  return JSON.stringify([
    agent.displayName ?? null,
    agent.contextFile ?? null,
    // capabilities — множество прав: порядок в форме/импорте произвольный.
    listKey(agent.capabilities?.map(String), true),
    agent.enabled ?? null,
    agent.provider ?? null,
    agent.model ?? null,
    agent.temperature ?? null,
    agent.topP ?? null,
    agent.topK ?? null,
    agent.reasoningLevel ?? null,
    agent.effort ?? null,
    agent.icon ?? null,
    agent.color ?? null,
    agent.description ?? null,
    normalizeAgentModes(agent.agentMode).join(','),
    agent.maxSteps ?? null,
    listKey(agent.groups, true),
    agent.executorProfile ?? null,
    listKey(agent.allowedProfiles, false),
    agent.browserProfile ?? null,
    listKey(agent.allowedBrowserProfiles, false),
  ]);
}

/**
 * Изменилась ли запись агента: `before` не задан — создание (всегда изменение).
 *
 * `isOverridden` намеренно не сравнивается: он описывает способ получения
 * определения (store/builtin), а не состояние реестра.
 */
export function isAgentDefinitionChanged(
  before: AgentDefinition | undefined | null,
  after: AgentDefinition,
): boolean {
  if (!before) return true;
  return agentDefinitionKey(before) !== agentDefinitionKey(after);
}
