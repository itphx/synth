/**
 * ADR-101/ADR-051: capability пайплайнов и расписаний у дефолтных агентов.
 *
 * Capability `pipeline`/`schedule` — **отключаемые админом** доменные
 * возможности (ADR-071 §2.3.1): выдавать их нужно осознанно.
 *
 * - получают capability: `assistant`, `devops`, `admin`, `leader` — агенты,
 *   которые ведут автоматизацию инстанса и проекта, а также лидер (получает
 *   все capability, кроме `user`, — включая авторство пайплайнов и расписаний);
 * - не получают: `fixer`/`tester` (у них другой инструментарий),
 *   `researcher` (read-only исследователь), `security-auditor` (read-only аудит
 *   безопасности), `explore`/`general` (сабагенты без домена проекта), `title`
 *   (системный генератор заголовков, без инструментов вовсе).
 */

import { describe, it, expect } from 'vitest';
import { ToolCapability } from '@itphx/synth-shared';
import { loadSystemAgentDefinitions } from './index.js';
import {
  processListTool,
  processLogsTool,
  processStopTool,
  processDeleteTool,
} from '../tools/processes.js';
import { listModelsTool } from '../tools/list-models.js';
import { todoWriteTool, todoListTool, todoAddTool, todoUpdateTool, todoDeleteTool } from '../tools/todo.js';
import { projectCreateTool } from '../tools/project-manage.js';
import { synthInfoTool, synthMcpListTool, synthMcpTestTool } from '../tools/instance.js';
import { computeToolAvailability } from '../permission/availability.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { INSTANCE_WRITE_TOOLS, getToolGroups } from '../permission/groups.js';

/**
 * Агенты, которым нужны capability пайплайнов и расписаний: авторство и запуск
 * автоматизации инстанса/проекта.
 * `leader` получает полный набор capability (всё, кроме `user`) — значит и
 * пайплайны с расписаниями; `fixer`/`tester` пайплайны и расписания не ведут —
 * у них другой инструментарий.
 */
const WITH_AUTOMATION = ['assistant', 'devops', 'admin', 'leader'];
/**
 * Вопрос пользователю и реестр фоновых прогонов — шире автоматизации: нужны и
 * оркестратору, и исполнителям (спросить человека, посмотреть свою фоновую работу).
 */
const WITH_AUTOMATION_AND_EXECUTORS = [...WITH_AUTOMATION, 'fixer', 'tester'];
/** Агенты, которым capability пайплайнов/расписаний не выдаётся. */
const WITHOUT_AUTOMATION = [
  'fixer', 'tester', 'researcher', 'security-auditor', 'explore', 'general', 'title',
];
/** Агенты, которым не выдаётся ни `question`, ни `process`. */
const WITHOUT_AUTOMATION_AND_EXECUTORS = [
  'researcher', 'security-auditor', 'explore', 'general', 'title',
];

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
 * Capability получают агенты, которые ведут работу (в т.ч. оркестратор) и могут
 * уточнять требования у человека — включая исполнителей (`fixer`/`tester`).
 * Read-only агенты (`researcher`, `security-auditor`), сабагенты (`explore`,
 * `general`) и генератор заголовков (`title`) — нет: вопрос задаёт человек,
 * а не агент.
 */
describe('Дефолтные агенты — capability question (этап 1 roadmap 0.13)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  it.each(WITH_AUTOMATION_AND_EXECUTORS)('%s имеет capability question', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).toContain(ToolCapability.QUESTION);
  });

  it.each(WITHOUT_AUTOMATION_AND_EXECUTORS)('%s не имеет capability question', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).not.toContain(ToolCapability.QUESTION);
  });
});

/**
 * Этап 1 roadmap 0.13 (блок 17): capability `process` — реестр фоновых
 * прогонов (ADR-111/PROP-097).
 *
 * Capability получают те же агенты, что и `question`: реестр фоновой работы —
 * часть работы в проекте (агент должен уметь посмотреть, что запустил, и
 * прочитать лог фонового процесса).
 *
 * Проверка идёт **через доступность тула** (`computeToolAvailability`), а не
 * только через список capability: так тест ловит и « capability есть, но тул
 * отсеивается по capability» (роль), и «тул отдаётся агенту без capability».
 */
describe('Дефолтные агенты — capability process (этап 1 roadmap 0.13, блок 17)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  const PROCESS_TOOLS = [processListTool, processLogsTool, processStopTool, processDeleteTool];

  it.each(WITH_AUTOMATION_AND_EXECUTORS)('%s имеет capability process', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).toContain(ToolCapability.PROCESS);
  });

  it.each(WITHOUT_AUTOMATION_AND_EXECUTORS)('%s не имеет capability process', (id) => {
    const agent = byId.get(id);
    expect(agent, `агент ${id} не найден`).toBeDefined();
    expect(agent!.capabilities, id).not.toContain(ToolCapability.PROCESS);
  });

  it.each(WITH_AUTOMATION_AND_EXECUTORS)('%s видит process_list/process_logs', (id) => {
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

/**
 * ADR-039: capability `todo` — операционный список задач сессии
 * (`session.todos`, не `project.plan`). Выдаётся всем встроенным агентам,
 * кроме `title` (у него нет инструментов вовсе), **в дополнение** к `runtime`
 * (совместимость с существующими/кастомными агентами).
 *
 * Проверка идёт через доступность тулов: read-only агенты должны видеть
 * `todo_*`, но по-прежнему не видеть `project_create` (нет capability `runtime`).
 */
describe('Дефолтные агенты — capability todo (ADR-039)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));

  const TODO_TOOLS = [todoWriteTool, todoListTool, todoAddTool, todoUpdateTool, todoDeleteTool];
  const WITH_TODO = agents.filter((a) => a.id !== 'title').map((a) => a.id);
  const READ_ONLY = ['researcher', 'security-auditor', 'explore', 'general'];

  it('набор агентов с todo покрыт тестом целиком', () => {
    expect([...WITH_TODO, 'title'].sort()).toEqual(agents.map((a) => a.id).sort());
  });

  it.each(WITH_TODO)('%s имеет capability todo и видит todo_*', (id) => {
    const agent = byId.get(id)!;
    expect(agent.capabilities, id).toContain(ToolCapability.TODO);
    for (const tool of TODO_TOOLS) {
      const availability = computeToolAvailability(
        tool.name,
        tool.capabilities,
        { agentCapabilities: agent.capabilities, sessionMode: 'act' },
      );
      expect(availability.available, `${id} → ${tool.name}`).toBe(true);
    }
  });

  it('title (без инструментов) не имеет capability todo', () => {
    const title = byId.get('title')!;
    expect(title.capabilities).not.toContain(ToolCapability.TODO);
    const availability = computeToolAvailability(
      todoWriteTool.name,
      todoWriteTool.capabilities,
      { agentCapabilities: title.capabilities, sessionMode: 'act' },
    );
    expect(availability).toEqual({ available: false, reason: 'role' });
  });

  it.each(READ_ONLY)('%s: todo_* доступны, project_create — unavailable(role)', (id) => {
    const agent = byId.get(id)!;
    for (const tool of TODO_TOOLS) {
      const availability = computeToolAvailability(
        tool.name,
        tool.capabilities,
        { agentCapabilities: agent.capabilities, sessionMode: 'act' },
      );
      expect(availability.available, `${id} → ${tool.name}`).toBe(true);
    }
    const project = computeToolAvailability(
      projectCreateTool.name,
      projectCreateTool.capabilities,
      { agentCapabilities: agent.capabilities, sessionMode: 'act' },
    );
    expect(project).toEqual({ available: false, reason: 'role' });
  });
});

/**
 * Workstream A1: capability `instance` — read-only инстанс/MCP
 * (`synth_info`, `synth_mcp_list`, `synth_mcp_test`).
 *
 * Получают агенты, которые ведут инфраструктуру/автоматизацию инстанса:
 * `assistant`, `admin`, `devops`, `leader`. Read-only аудит безопасности
 * (`security-auditor`), исполнители и researcher — нет.
 */
describe('Дефолтные агенты — capability instance (Workstream A1)', () => {
  const agents = loadSystemAgentDefinitions();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const WITH_INSTANCE = ['assistant', 'admin', 'devops', 'leader'];
  const WITHOUT_INSTANCE = ['security-auditor', 'tester', 'researcher', 'fixer', 'explore', 'general', 'title'];
  const INSTANCE_TOOLS_LIST = [synthInfoTool, synthMcpListTool, synthMcpTestTool];

  it.each(WITH_INSTANCE)('%s имеет capability instance и видит read-тулы', (id) => {
    const agent = byId.get(id)!;
    expect(agent.capabilities, id).toContain(ToolCapability.INSTANCE);
    for (const tool of INSTANCE_TOOLS_LIST) {
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        agentCapabilities: agent.capabilities,
        sessionMode: 'act',
      });
      expect(availability.available, `${id} → ${tool.name}`).toBe(true);
    }
  });

  it.each(WITHOUT_INSTANCE)('%s не имеет capability instance', (id) => {
    const agent = byId.get(id)!;
    expect(agent.capabilities, id).not.toContain(ToolCapability.INSTANCE);
  });

  it('read-тулы доступны в plan-режиме, write-тулы — блокируются', () => {
    expect(INSTANCE_WRITE_TOOLS.length).toBeGreaterThan(0);
    for (const tool of INSTANCE_TOOLS_LIST) {
      expect(isPlanBlockedTool(tool.name, tool.capabilities), tool.name).toBe(false);
      expect(getToolGroups(tool.name, tool.capabilities)).toContain('instance');
    }
    for (const name of INSTANCE_WRITE_TOOLS) {
      expect(isPlanBlockedTool(name), name).toBe(true);
    }
  });
});
