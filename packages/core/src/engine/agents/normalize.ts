import type { AgentMode } from '@itphx/synth-shared';

/**
 * Нормализует классы агента (primary/subagent/system) в массив уникальных
 * валидных значений. Значения 'all' в системе не существует — старые файлы
 * с 'all' читаются как ['primary','subagent'] (обратная совместимость).
 * null/undefined/невалидное/пустой массив → ['primary'] (дефолт).
 */
export function normalizeAgentModes(mode?: string | string[] | null): AgentMode[] {
  const VALID: AgentMode[] = ['primary', 'subagent', 'system'];
  if (mode == null) return ['primary'];
  const values = Array.isArray(mode) ? mode : [mode];
  if (values.length === 0) return ['primary'];
  const normalized: AgentMode[] = values.flatMap((v) => {
    if (v === 'all') return ['primary', 'subagent'];
    return VALID.includes(v as AgentMode) ? [v as AgentMode] : [];
  });
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : ['primary'];
}
