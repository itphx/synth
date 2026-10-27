/**
 * ADR-101/ADR-051: capability пайплайнов и расписаний у дефолтных агентов.
 *
 * Capability `pipeline`/`schedule` — **отключаемые админом** доменные
 * возможности (ADR-071 §2.3.1): выдавать их нужно осознанно.
 *
 * - получают capability: `assistant`, `developer`, `devops`, `admin`, `pm`, `qa`,
 *   `analyst` — агенты, которые ведут работу в проекте;
 * - не получают: `explore` (read-only исследователь), `general` (сабагент без
 *   домена проекта), `auditor` (read-only аудит безопасности), `title`
 *   (системный генератор заголовков, без инструментов вовсе).
 */

import { describe, it, expect } from 'vitest';
import { ToolCapability } from '@itphx/synth-shared';
import { loadSystemAgentDefinitions } from './index.js';
import { processListTool, processLogsTool } from '../tools/processes.js';
import { listModelsTool } from '../tools/list-models.js';
import { computeToolAvailability } from '../permission/availability.js';

/** Агенты, которым нужны capability пайплайнов и расписаний. */
const WITH_AUTOMATION = ['assistant', 'developer', 'devops', 'admin', 'pm', 'qa', 'analyst'];
/** Агенты, которым capability пайплайнов/расписаний не выдаётся. */
const WITHOUT_AUTOMATION = ['explore', 'general', 'auditor', 'title'];

describe('Дефолтные агенты — capability pipeline/schedule (ADR-101/ADR-051)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  it.each(WITH_AUTOMATION)('%s имеет capability pipeline и schedule', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).toContain(ToolCapability.PIPELINE);
    expect(agent!.capabilities, id).toContain(ToolCapability.SCHEDULE);
  });

  it.each(WITHOUT_AUTOMATION)('%s не имеет capability pipeline и schedule', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).not.toContain(ToolCapability.PIPELINE);
    expect(agent!.capabilities, id).not.toContain(ToolCapability.SCHEDULE);
  });

  it('набор агентов покрыт тестом целиком', () => {
    expect([...WITH_AUTOMATION, ...WITHOUT_AUTOMATION].sort()).toEqual(
      agents.map((a) => a.id).sort(),
    );
  });
});

/**
 * Этап 1 roadmap 0.13 (блок 3): capability `question` — вопрос пользователю
 * посреди хода.
 *
 * Capability получают те же агенты, что и `pipeline`/`schedule` (агенты,
 * которые ведут работу в проекте и могут уточнять требования у человека).
 * Read-only агенты (`explore`, `auditor`), сабагент (`general`) и
 * генератор заголовков (`title`) — нет: вопрос задаёт человек, а не агент.
 */
describe('Дефолтные агенты — capability question (этап 1 roadmap 0.13)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  it.each(WITH_AUTOMATION)('%s имеет capability question', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).toContain(ToolCapability.QUESTION);
  });

  it.each(WITHOUT_AUTOMATION)('%s не имеет capability question', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).not.toContain(ToolCapability.QUESTION);
  });
});

/**
 * Этап 1 roadmap 0.13 (блок 17): capability `process` — реестр фоновых
 * прогонов (ADR-111/PROP-097).
 *
 * Capability получают те же агенты, что и `pipeline`/`schedule`/`question`:
 * реестр фоновой работы — часть работы в проекте (агент должен уметь
 * посмотреть, что запустил, и прочитать лог фонового процесса).
 *
 * Проверка идёт **через доступность тула** (`computeToolAvailability`), а не
 * только через список capability: так тест ловит и « capability есть, но тул
 * отсеивается по capability» (роль), и «тул отдаётся агенту без capability».
 */
describe('Дефолтные агенты — capability process (этап 1 roadmap 0.13, блок 17)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  const PROCESS_TOOLS = [processListTool, processLogsTool];

  it.each(WITH_AUTOMATION)('%s имеет capability process', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).toContain(ToolCapability.PROCESS);
  });

  it.each(WITHOUT_AUTOMATION)('%s не имеет capability process', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).not.toContain(ToolCapability.PROCESS);
  });

  it.each(WITH_AUTOMATION)('%s видит process_list/process_logs', (id) => {
    const agent = byId.get(id)!;
    for (const tool of PROCESS_TOOLS) {
      const availability = computeToolAvailability(
        tool.name,
        tool.capabilities,
        { agentCapabilities: agent.capabilities, sessionMode: 'act' },
      );
      expect(availability.available, `${id} → ${tool.name}`).toBe(true);
    }
  });

  it.each(['explore', 'general'])('%s не видит process_list/process_logs', (id) => {
    const agent = byId.get(id)!;
    for (const tool of PROCESS_TOOLS) {
      const availability = computeToolAvailability(
        tool.name,
        tool.capabilities,
        { agentCapabilities: agent.capabilities, sessionMode: 'act' },
      );
      expect(availability.available, `${id} → ${tool.name}`).toBe(false);
      expect(availability.reason, `${id} → ${tool.name}`).toBe('role');
    }
  });
});

/**
 * ADR-115: capability `models` — каталог моделей инстанса для агента
 * (тул `list_models`: модальности, текущая пара, назначения aux-моделей).
 *
 * Тул только читает каталог и не привязан к рабочему каталогу проекта, поэтому
 * capability выдают **все** агенты, у которых вообще есть инструменты: иначе
 * агент не смог бы предложить модель под вложение или выбрать модель
 * саб-агенту (`task({provider, model})`). Исключение — `title` (генератор
 * заголовков без инструментов вовсе).
 */
describe('Дефолтные агенты — capability models (ADR-115)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  it('каждый агент с инструментами видит list_models', () => {
    for (const agent of agents) {
      if (agent.capabilities.length === 0) continue;
      expect(agent.capabilities, agent.id).toContain(ToolCapability.MODELS);
      const availability = computeToolAvailability(
        listModelsTool.name,
        listModelsTool.capabilities,
        { agentCapabilities: agent.capabilities, sessionMode: 'act' },
      );
      expect(availability.available, `${agent.id} → ${listModelsTool.name}`).toBe(true);
    }
  });

  it('title (без инструментов) не видит list_models', () => {
    const title = byId.get('title');
    expect(title, 'агент title не найден').toBeDefined();
    expect(title!.capabilities).not.toContain(ToolCapability.MODELS);
    const availability = computeToolAvailability(
      listModelsTool.name,
      listModelsTool.capabilities,
      { agentCapabilities: title!.capabilities, sessionMode: 'act' },
    );
    expect(availability).toEqual({ available: false, reason: 'role' });
  });
});
