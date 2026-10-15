/**
 * ADR-089 (standalone): единая точка **нормализации владельца локального
 * пользователя при чтении**.
 *
 * Standalone-инстанс однопользовательский: человек-владелец один — литерал
 * `local` (паритет с `resolveUserId` роутов и WS-подпиской). Однако до фикса
 * резолвера внешней идентичности сопознанный отправитель (claim-flow) становился
 * владельцем сессии под id **профиля** (`ProfileData.id` — генерируемый UUID), а
 * не под `local`. Такие legacy-сессии уже лежат в `{dataDir}/sessions/*.json` с
 * `ownerId`/`userId` = UUID профиля `local` и выпадают из списков
 * (`listSessions({ userId: 'local' })`), `GET /:id` (403) и WS-подписки.
 *
 * Нормализация — **только на чтение** (нулевая запись в файлы сессий): набор id,
 * которые трактуются как локальный владелец (`local` + id профиля `local`),
 * используется решениями о видимости/доступе/подписке. Не-локальные UUID
 * (реальные пользователи managed, чужие профили) не затрагиваются.
 */
export interface LocalOwnerResolver {
  /**
   * Эффективные id локального владельца: `local` + id профиля `local`
   * (если профиль существует). Вычисляется на каждом вызове из `FileProfileStore`
   * (чтение, без создания профиля), fail-safe при ошибке.
   */
  resolveLocalOwnerIds(): Promise<ReadonlySet<string>>;
  /** Является ли переданный владелец локальным (с учётом legacy-UUID профиля). */
  isLocalOwner(owner: string | undefined): Promise<boolean>;
  /**
   * Владелец сессии, приведённый к локальному пользователю (`local`), если он
   * фактически локальный; иначе — без изменений. `undefined` остаётся `undefined`.
   */
  normalizeOwner(owner: string | undefined): Promise<string | undefined>;
  /**
   * Синхронная проверка по уже разрешённому набору id — для sync-путей
   * (напр. `subscribeToNewSession`). До первого `resolveLocalOwnerIds()` кэш пуст
   * → `false` (fail-safe: видимость не расширяется).
   */
  isLocalOwnerCached(owner: string | undefined): boolean;
}

/** Литерал локального пользователя standalone-инстанса. */
export const LOCAL_USER_ID = 'local';

export interface CreateLocalOwnerResolverOptions {
  /** Литерал локального пользователя (standalone — `local`). */
  localUserId?: string;
  /**
   * id профиля локального пользователя (`ProfileData.id`) или `null`, если
   * профиль ещё не создан. Не задан — нормализуются только `localUserId`
   * (managed: реальные id пользователей, поведение не меняется).
   */
  resolveLocalProfileId?: () => Promise<string | null>;
}

/**
 * Создать резолвер локального владельца. Резолвер создаётся один раз на инстанс
 * и передаётся во все места, принимающие решения о владельце (списки, доступ по
 * id, подписка хаба, видимость).
 *
 * Профиль `local` создаётся лениво (claim-flow); если он найден — id кэшируется
 * (id профиля неизменен для инстанса). Пока профиль не найден, возвращается
 * только литерал `local` без кэширования — иначе позднее созданный профиль не
 * был бы учтён. Профиль не создаём: нормализация — read-only.
 */
export function createLocalOwnerResolver(
  options: CreateLocalOwnerResolverOptions = {},
): LocalOwnerResolver {
  const localUserId = options.localUserId ?? LOCAL_USER_ID;
  let cachedProfileId: string | null = null;

  const resolveLocalOwnerIds = async (): Promise<ReadonlySet<string>> => {
    const ids = new Set<string>([localUserId]);
    if (!options.resolveLocalProfileId) return ids;
    let profileId = cachedProfileId;
    if (profileId === null) {
      try {
        profileId = await options.resolveLocalProfileId();
      } catch {
        // fail-safe: профиль недоступен → трактуем только литерал `local`
        profileId = null;
      }
      if (profileId) cachedProfileId = profileId;
    }
    if (profileId && profileId !== localUserId) ids.add(profileId);
    return ids;
  };

  const isLocalOwner = async (owner: string | undefined): Promise<boolean> => {
    if (!owner) return false;
    return (await resolveLocalOwnerIds()).has(owner);
  };

  return {
    resolveLocalOwnerIds,
    isLocalOwner,
    normalizeOwner: async (owner) =>
      owner && (await isLocalOwner(owner)) ? localUserId : owner,
    isLocalOwnerCached: (owner) =>
      !!owner && (owner === localUserId || owner === cachedProfileId),
  };
}
