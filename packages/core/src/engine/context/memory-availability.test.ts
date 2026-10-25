import { describe, expect, it } from 'vitest';
import type { Project } from '@itphx/synth-shared';
import { isMemoryPromptAvailable } from './memory-availability.js';

const project = (enabled?: boolean): Project =>
  ({ memory: enabled === undefined ? undefined : { enabled } } as unknown as Project);

const tool = (name = 'plugin_synth_plugin_memory_memory_search') => ({
  name,
  capabilities: ['memory'],
});

describe('isMemoryPromptAvailable', () => {
  it('доступна: проект не выключил память, capability memory, есть включённый тул', () => {
    expect(
      isMemoryPromptAvailable({
        project: project(),
        agentCapabilities: ['memory'],
        tools: [tool()],
      }),
    ).toBe(true);
    expect(
      isMemoryPromptAvailable({
        project: project(true),
        agentCapabilities: ['file_read', 'memory'],
        tools: [tool()],
      }),
    ).toBe(true);
  });

  it('проект выключил память → недоступна', () => {
    expect(
      isMemoryPromptAvailable({
        project: project(false),
        agentCapabilities: ['memory'],
        tools: [tool()],
      }),
    ).toBe(false);
  });

  it('у агента нет capability memory → недоступна', () => {
    expect(
      isMemoryPromptAvailable({
        project: null,
        agentCapabilities: ['file_read'],
        tools: [tool()],
      }),
    ).toBe(false);
    expect(
      isMemoryPromptAvailable({ project: null, tools: [tool()] }),
    ).toBe(false);
  });

  it('тулы памяти отключены админом → недоступна', () => {
    expect(
      isMemoryPromptAvailable({
        project: null,
        agentCapabilities: ['memory'],
        tools: [tool()],
        isAdminDisabled: () => true,
      }),
    ).toBe(false);
  });

  it('нет ни одного тула памяти → недоступна (плагин не активен)', () => {
    expect(
      isMemoryPromptAvailable({
        project: null,
        agentCapabilities: ['memory'],
        tools: [],
      }),
    ).toBe(false);
  });

  it('сессия без проекта: память доступна, если есть capability и тулы', () => {
    expect(
      isMemoryPromptAvailable({
        project: null,
        agentCapabilities: ['memory'],
        tools: [tool()],
      }),
    ).toBe(true);
  });
});
