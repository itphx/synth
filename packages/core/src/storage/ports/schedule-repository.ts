import type { Schedule, ScheduleInput } from '@itphx/synth-shared';
import type { ScheduleRunUpdate } from '../schedule-store.js';

/**
 * Порт реестра расписаний планировщика (ADR-051/ADR-089, реализация — `ScheduleStore`).
 */
export interface ScheduleRepository {
  list(): Promise<Schedule[]>;
  /**
   * Есть ли включённое расписание, нацеленное на сессию (не `ephemeral`).
   * @future-backend — `EXISTS`-подзапрос по индексу `target.sessionId`.
   */
  hasEnabledTargetFor(sessionId: string): Promise<boolean>;
  get(id: string): Promise<Schedule | null>;
  create(input: ScheduleInput): Promise<Schedule>;
  /**
   * Частичное обновление: отсутствие поля в патче — «не менять».
   *
   * **Пара триггеров заменяется целиком.** Если в патче есть собственный ключ
   * `cron` или `every` (`Object.hasOwn`), набор триггеров заменяется: переданное
   * значение сохраняется, отсутствующее/`undefined` — очищается. Например,
   * `{ every: '15m' }` поверх `{ cron: '…' }` снимает `cron` (и наоборот), в том
   * числе лечит повреждённую запись с обоими полями. Патч без этих ключей
   * (`{ name }`) триггер не трогает.
   *
   * `undefined` для nullable-полей (`prompt`/`payload`/`catchUp`) очищает поле;
   * `ownerId` — исключение (владение не чистится пользовательским патчем).
   */
  update(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null>;
  remove(id: string): Promise<boolean>;
  /** Фиксация результата запуска (`lastRunAt`/`lastStatus`/`lastError`/`nextRunAt`). */
  markRun(id: string, run: ScheduleRunUpdate): Promise<Schedule | null>;
  /** Обновление только `nextRunAt` (служебное поле сервиса). */
  setNextRun(id: string, nextRunAt: string | undefined): Promise<Schedule | null>;
  /**
   * PROP-141: бэкфилл `projectId` у легаси-расписаний (идемпотентно).
   *
   * Проект выводится из цели (`pipeline` → `target.projectId`, `ephemeral` →
   * `target.project`, `bound`/`queue` → проект сессии-цели); вывести нельзя —
   * запись остаётся в реестре, но отключается (`lastError =
   * 'project_required'`) и не срабатывает.
   *
   * Не задан — бэкфилла нет: в памяти записей не бывает, а PostgreSQL
   * выполняет его миграцией схемы.
   */
  backfillProjectIds?(): Promise<{ backfilled: number; disabled: number }>;
}
