/**
 * ADR-101/ADR-051: тесты маппинга тулов автоматизации на действие и вид цели
 * в Authority-слое (`authority/actions.ts`).
 *
 * Правила, которые здесь зафиксированы:
 * - чтение пайплайнов/расписаний — действие `read`;
 * - правка спецификации/расписания — `write`;
 * - публикация версии пайплайна — `publish` (необратимое действие);
 * - запуск/отмена прогона и форсированный запуск расписания — `execute`;
 * - возобновление HITL-прогона — `approve` (решение человека);
 * - вид цели у всех тулов пайплайнов и расписаний — `session` (проект — свойство
 *   сессии, ADR-014; отдельный вид «pipeline» не заводим).
 */

import { describe, it, expect } from 'vitest';
import { authorityActionForTool, authorityTargetKindForTool } from './actions.js';
import {
  PIPELINE_READ_TOOLS,
  PIPELINE_WRITE_TOOLS,
  SCHEDULE_READ_TOOLS,
  SCHEDULE_WRITE_TOOLS,
} from '../permission/groups.js';

/** Ожидаемое действие для каждого из 18 тулов автоматизации. */
const EXPECTED_ACTIONS: Record<string, string> = {
  // ADR-101: чтение.
  pipeline_list: 'read',
  pipeline_get: 'read',
  pipeline_run_status: 'read',
  pipeline_run_list: 'read',
  pipeline_templates: 'read',
  // ADR-101: правка и запуск.
  pipeline_save: 'write',
  pipeline_delete: 'write',
  pipeline_publish: 'publish',
  pipeline_run: 'execute',
  pipeline_run_cancel: 'execute',
  pipeline_instantiate: 'execute',
  pipeline_run_resume: 'approve',
  // ADR-051: расписания.
  schedule_list: 'read',
  schedule_get: 'read',
  schedule_jobs: 'read',
  schedule_save: 'write',
  schedule_delete: 'write',
  schedule_run: 'execute',
};

/** Все 18 имён тулов автоматизации. */
const AUTOMATION_TOOLS = [
  ...PIPELINE_READ_TOOLS,
  ...PIPELINE_WRITE_TOOLS,
  ...SCHEDULE_READ_TOOLS,
  ...SCHEDULE_WRITE_TOOLS,
];

describe('Authority — маппинг тулов автоматизации (ADR-101/ADR-051)', () => {
  it('набор имён совпадает с ожидаемыми 18 тулами', () => {
    expect(AUTOMATION_TOOLS).toHaveLength(18);
    expect(Object.keys(EXPECTED_ACTIONS).sort()).toEqual([...AUTOMATION_TOOLS].sort());
  });

  it.each(Object.entries(EXPECTED_ACTIONS))(
    '%s → действие %s',
    (toolName, action) => {
      expect(authorityActionForTool(toolName)).toBe(action);
    },
  );

  it.each(AUTOMATION_TOOLS)('%s → вид цели session', (toolName) => {
    expect(authorityTargetKindForTool(toolName)).toBe('session');
  });

  it('pipeline_run_resume — действие approve (решение человека)', () => {
    expect(authorityActionForTool('pipeline_run_resume')).toBe('approve');
    expect(authorityTargetKindForTool('pipeline_run_resume')).toBe('session');
  });

  it('capability pipeline/schedule — фоллбак для плагинных тулов', () => {
    expect(authorityActionForTool('plugin_x_pipeline_tool', ['pipeline'])).toBe('write');
    expect(authorityActionForTool('plugin_x_schedule_tool', ['schedule'])).toBe('write');
  });
});
