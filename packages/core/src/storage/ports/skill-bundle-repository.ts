import type { SkillBundle } from '@itphx/synth-shared';

/**
 * Порт instance-хранилища bundles слэш-команд
 * (ADR-046 §7.3/§8.3, реализация — `SkillBundleStore`).
 *
 * Методы-пути (`root`/`file`) — деталь файловой реализации, в порт не входят
 * (домен работает через `list`/`get`/`exists`/`set`/`remove`).
 * @future-backend — bundles в БД/объектном хранилище.
 */
export interface SkillBundleRepository {
  exists(name: string): Promise<boolean>;
  get(name: string): Promise<SkillBundle | undefined>;
  list(): Promise<SkillBundle[]>;
  set(bundle: SkillBundle): Promise<void>;
  remove(name: string): Promise<boolean>;
}
