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
