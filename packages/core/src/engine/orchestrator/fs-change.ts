/**
 * ADR-095 (шаг 6a): публикация события `fs.changed` после мутирующих тулов.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегацию `_publishFsChange`.
 */
import type { Session } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import { resolveFsChange } from '../fs-change.js';

/**
 * fs.changed: после успешного мутирующего тула публикуем событие для UI
 * (дерево Files, открытые редакторы, Git-вкладка). Read-only тулы и
 * неуспешные операции событий не дают (`resolveFsChange` → null).
 */
export function publishFsChange(
  session: Session,
  toolName: string,
  toolResult: { isError?: boolean; metadata?: Record<string, unknown> },
  workingDir: string,
  eventBus: EventBus,
  args?: Record<string, unknown>,
): void {
  if (toolResult.isError) return;
  const change = resolveFsChange(toolName, toolResult.metadata, workingDir, args);
  if (!change) return;
  eventBus.publish(session.id, 'fs.changed', {
    session_id: session.id,
    project_id: session.projectId ?? null,
    scope: change.scope,
    ...(change.paths ? { paths: change.paths } : {}),
    ...(change.op ? { op: change.op } : {}),
    ...(change.from ? { from: change.from } : {}),
    ...(change.to ? { to: change.to } : {}),
    ...(change.workspaceChanged ? { workspace_changed: true } : {}),
    tool: toolName,
  });
}
