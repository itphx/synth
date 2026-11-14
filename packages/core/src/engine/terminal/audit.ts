/**
 * Аудит терминалов (ADR-136, PROP-136) — **только метаданные**.
 *
 * ## Почему отдельный шов
 *
 * Журнал исполнений команд (`CommandAuditLog`, `engine/security/command-audit.ts`)
 * умеет писать произвольные записи; его тип `CommandAuditEntry.tool`
 * ограничен списком `COMMAND_AUDIT_TOOLS` (`execute_shell`/`sandbox_exec` **и**
 * терминальные действия `terminal.open`/`terminal.input`/`terminal.close` —
 * список расширен в Ф3б).
 *
 * Поэтому сервис зависит от узкого интерфейса `TerminalAuditSink`, а
 * адаптер `createCommandAuditTerminalSink` пишет в существующий журнал.
 *
 * ## Что попадает в журнал
 *
 * **Только метаданные**: идентификатор терминала, проект/сессия, актор,
 * рабочий каталог, оболочка, длина кадра ввода, признак `Enter`, код/сигнал
 * выхода, причина закрытия.
 *
 * **Никакого содержимого**: ни введённый текст, ни вывод терминала в журнал
 * не попадает (дизайн §3). Секреты, которые человек напечатал в терминале,
 * не утекают в журнал аудита.
 */
import type { CommandAuditEntry } from '@itphx/synth-shared';
import { CommandAuditLog, sha256Hex } from '../security/command-audit.js';

/** Действие терминала, попадающее в аудит. */
export type TerminalAuditAction = 'terminal.open' | 'terminal.input' | 'terminal.close';

/** Причина закрытия терминала (для аудита и события `terminal.deleted`). */
export type TerminalCloseReason = 'user' | 'idle' | 'disabled' | 'exited';

/** Запись аудита терминала — только метаданные. */
export interface TerminalAuditEntry {
  /** Действие. */
  action: TerminalAuditAction;
  /** Идентификатор терминала. */
  terminalId: string;
  /** Проект-владелец. */
  projectId: string;
  /** Привязанная сессия (если есть). */
  sessionId?: string;
  /** Кто действовал (пользователь/агент). */
  actorId?: string;
  /** Рабочий каталог терминала. */
  cwd: string;
  /** Оболочка терминала. */
  shell: string;
  /** Длина кадра ввода, байт (для `terminal.input`). */
  bytes?: number;
  /** Есть ли `Enter` в кадре ввода (для `terminal.input`). */
  enter?: boolean;
  /** Код завершения (для `terminal.close`). */
  exitCode?: number;
  /** Сигнал завершения (для `terminal.close`). */
  signal?: string;
  /** Причина закрытия (для `terminal.close`). */
  reason?: TerminalCloseReason;
  /** Время записи, ISO-8601. */
  ts: string;
}

/**
 * Приёмник аудита терминалов.
 *
 * Узкий интерфейс вместо `CommandAuditLog`: сервис не должен знать формат
 * журнала (его может сменить Ф3б), а тесты — подменять журнал моком.
 */
export interface TerminalAuditSink {
  /** Записать событие аудита (содержимое не передаётся — только метаданные). */
  record: (entry: TerminalAuditEntry) => void | Promise<void>;
}

/**
 * Описание действия для поля `command` журнала.
 *
 * Это **метаданные**, а не команда: текст ввода пользователя сюда не
 * попадает (только длина и признак `Enter`).
 */
function describeEntry(entry: TerminalAuditEntry): string {
  switch (entry.action) {
    case 'terminal.open':
      return `terminal.open shell=${entry.shell}`;
    case 'terminal.input':
      return `terminal.input bytes=${entry.bytes ?? 0} enter=${entry.enter === true}`;
    case 'terminal.close': {
      const parts = [`terminal.close reason=${entry.reason ?? 'unknown'}`];
      if (entry.exitCode !== undefined) parts.push(`exit=${entry.exitCode}`);
      if (entry.signal) parts.push(`signal=${entry.signal}`);
      return parts.join(' ');
    }
    default:
      return 'terminal.unknown';
  }
}

/**
 * Адаптер: запись аудита терминалов в существующий журнал исполнений команд.
 *
 * `tool` заполняется именем терминального действия: тип `CommandAuditTool`
 * в `shared` перечисляет шелл-тулы **и** терминальные действия
 * (`terminal.open`/`terminal.input`/`terminal.close`) — каст не нужен.
 */
export function createCommandAuditTerminalSink(log: CommandAuditLog): TerminalAuditSink {
  return {
    record(entry: TerminalAuditEntry): void {
      const description = describeEntry(entry);
      const auditEntry: CommandAuditEntry = {
        id: entry.terminalId,
        ts: entry.ts,
        ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
        ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
        ...(entry.actorId !== undefined ? { actor: entry.actorId } : {}),
        tool: entry.action,
        command: description,
        commandHash: sha256Hex(description),
        cwd: entry.cwd,
        background: false,
        decision: 'allow',
        decidedBy: 'permission',
        phase: entry.action === 'terminal.close' ? 'finished' : 'started',
      };
      const result = log.append(auditEntry);
      // Ошибка записи аудита не должна ронять терминал (в отличие от
      // исполнения шелл-команды, где журнал — условие запуска, PROP-136).
      if (result instanceof Promise) {
        result.catch(() => {
          // best-effort: ошибка журнала не влияет на работу терминала.
        });
      }
    },
  };
}

/** Приёмник-заглушка: ничего не пишет (удобно в тестах и при выключенном аудите). */
export function createNoopTerminalAuditSink(): TerminalAuditSink {
  return {
    record(): void {
      // no-op
    },
  };
}
