import type {
  ProtectedPathsOverride,
  ProtectedPathsPolicy,
} from '../../engine/security/protected-paths.js';
import type { ProtectedPathsRaw } from '../../engine/security/protected-paths-store.js';

/**
 * Порт редактируемого списка защищённых путей и запрещённых команд
 * (реализация — `ProtectedPathsStore`).
 *
 * Схема «системный base + override (add/remove)». Геттеры синхронные (горячий
 * путь permission-слоя). @future-backend — как `SecretPatternRepository`:
 * синхронный кэш над хранилищем.
 */
export interface ProtectedPathsRepository {
  hasOverride(): boolean;
  getBase(): ProtectedPathsPolicy;
  getPolicy(): ProtectedPathsPolicy;
  getEffective(): ProtectedPathsPolicy;
  getRaw(): ProtectedPathsRaw;
  getOverride(): ProtectedPathsOverride | null;
  savePolicy(effective: ProtectedPathsPolicy): Promise<boolean>;
  saveRawOverride(raw: Partial<ProtectedPathsOverride>): Promise<boolean>;
  reset(): Promise<boolean>;
}
