import { ToolCapability } from '@itphx/synth-shared';

/**
 * ADR-025: применим ли переключатель Plan/Act/Yolo к агенту.
 *
 * Режимы (plan/act/yolo) имеют смысл только если агент может что-то менять:
 * выполнять shell-команды или записывать/редактировать файлы. Read-only агент
 * (нет ни одного из этих capabilities) не получит никакой разницы между
 * режимами — для него переключатель деактивируется. Capability `web`
 * (web_fetch/web_search — read-only тулы) правом на переключение режимов
 * не является.
 *
 * Если агент не найден или capabilities не заданы — считаем режим применимым (true).
 */
export function isModeApplicable(agent?: { capabilities?: readonly string[] } | null): boolean {
  if (!agent) return true;
  const caps = new Set(agent.capabilities ?? []);
  const canMutate = caps.has(ToolCapability.SHELL) || caps.has(ToolCapability.FILE_WRITE);
  return canMutate;
}
