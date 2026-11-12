/**
 * PROP-135 Ф6a: binding профиля исполнения (сессия → агент → проект → дефолт).
 *
 * ## Зачем
 *
 * До Ф6a профиль исполнения выбирался **только** сессией
 * (`session.settings.executorProfile`), иначе роутер брал
 * `execution.remote.defaultProfile`. Теперь профиль — наследуемая настройка
 * области: сессия → определение агента → проект → профиль инстанса.
 *
 * ## Приоритет и потолки
 *
 * Кандидаты перебираются в порядке `session → agent → project`; первый
 * непустой, **разрешённый** потолком кандидат становится эффективным
 * профилем. Если разрешённых кандидатов нет — берётся `defaultProfile`
 * (fail-closed: запрещённый профиль не выбирается никогда).
 *
 * Потолки (`allowedProfiles` проекта и агента):
 * - массив **задан и непуст** — профиль обязан в него входить;
 * - `undefined`/пустой массив — без ограничения (обратная совместимость:
 *   старые проекты/агенты поля не имеют).
 *
 * `defaultProfile` — профиль инстанса (`execution.remote.defaultProfile`); он
 * не проверяется потолком области: это единственная безопасная точка отката
 * (иначе инстанс без разрешённых профилей не смог бы исполнять команды).
 *
 * ## Чего модуль НЕ делает
 *
 * - не знает конфигурации/K8s: каталог профилей приходит снимком
 *   (`ExecutionProfileCatalog`), его собирает роутер (`executionProfileCatalog`);
 * - не проверяет существование профиля в каталоге — это делает роутер при
 *   `portFor` (неизвестный профиль → `defaultProfile`); `task` проверяет
 *   явный `executor_profile` по каталогу до создания дочерней сессии.
 */

/** Источник эффективного профиля (для аудита/диагностики). */
export type ExecutionProfileSource = 'session' | 'agent' | 'project' | 'default';

/**
 * Каталог профилей исполнения — снимок `execution.remote` на старте процесса
 * (инвариант 24: `execution.*` — параметр запуска, не runtime-настройка).
 */
export interface ExecutionProfileCatalog {
  /** Имена известных профилей (включая профиль по умолчанию). */
  profiles: readonly string[];
  /** Профиль по умолчанию (`execution.remote.defaultProfile`). */
  defaultProfile: string;
}

/**
 * Вход резолвера профиля: сырые значения источников (каждое — из своей области).
 */
export interface ExecutionProfileBindingInput {
  /** `session.settings.executorProfile`. */
  sessionProfile?: string;
  /** `agentDefinition.executorProfile` (по эффективной роли агента). */
  agentProfile?: string;
  /** `agentDefinition.allowedProfiles` — потолок агента. */
  agentAllowed?: readonly string[];
  /** `project.executor.profile`. */
  projectProfile?: string;
  /** `project.executor.allowedProfiles` — потолок проекта. */
  projectAllowed?: readonly string[];
  /** `execution.remote.defaultProfile` — профиль инстанса. */
  defaultProfile: string;
  /**
   * Имена профилей каталога инстанса (`execution.remote.profiles` +
   * `defaultProfile`). Задан и непуст — неизвестное имя не выбирается
   * (откат на следующий кандидат/`defaultProfile` с предупреждением).
   * Не задан — существование не проверяется (каталог неизвестен:
   * inline/instance-пул).
   */
  knownProfiles?: readonly string[];
}

/** Результат резолвера: эффективный профиль, источник и причина отказа. */
export interface ExecutionProfileResolution {
  /** Эффективный профиль (всегда непустой, если `defaultProfile` непуст). */
  profile: string;
  /** Кто дал эффективный профиль. */
  source: ExecutionProfileSource;
  /**
   * Причина отказа от кандидата: `catalog` — профиля нет в каталоге инстанса,
   * `project`/`agent` — профиль вне потолка области.
   */
  deniedBy?: 'catalog' | 'project' | 'agent';
  /** Готовое предупреждение для журнала инстанса (без секретов). */
  warning?: string;
}

/** Потолки профилей области. */
export interface ExecutionProfileCeilings {
  projectAllowed?: readonly string[];
  agentAllowed?: readonly string[];
}

/**
 * Профиль разрешён потолками?
 *
 * Пустой/отсутствующий массив = без ограничения (обратная совместимость —
 * `true`). Массив непустой — профиль обязан в него входить.
 */
export function isProfileAllowed(
  profile: string,
  { projectAllowed, agentAllowed }: ExecutionProfileCeilings,
): boolean {
  const name = profile.trim();
  if (name === '') return false;
  const within = (allowed: readonly string[] | undefined): boolean =>
    allowed === undefined || allowed.length === 0 || allowed.includes(name);
  return within(projectAllowed) && within(agentAllowed);
}

/** Первый отклонённый потолок (для диагностики): проект важнее агента. */
function deniedBy(profile: string, input: ExecutionProfileBindingInput): 'project' | 'agent' | undefined {
  const name = profile.trim();
  const projectAllowed = input.projectAllowed;
  if (projectAllowed && projectAllowed.length > 0 && !projectAllowed.includes(name)) return 'project';
  const agentAllowed = input.agentAllowed;
  if (agentAllowed && agentAllowed.length > 0 && !agentAllowed.includes(name)) return 'agent';
  return undefined;
}

/** Причина отказа от кандидата (для диагностики). */
type DenialReason = 'catalog' | 'project' | 'agent';

/** Первая причина отказа кандидата: каталог → проект → агент. */
function denialReason(
  profile: string,
  input: ExecutionProfileBindingInput,
): DenialReason | undefined {
  const name = profile.trim();
  const known = input.knownProfiles;
  if (known && known.length > 0 && !known.includes(name)) return 'catalog';
  return deniedBy(profile, input);
}

/**
 * Резолвер эффективного профиля исполнения (PROP-135 Ф6a).
 *
 * Порядок: `sessionProfile` → `agentProfile` → `projectProfile` →
 * `defaultProfile`. Пустые значения источников пропускаются. Кандидат,
 * отклонённый каталогом (`knownProfiles`) или потолком
 * (`projectAllowed`/`agentAllowed`), **не выбирается**: резолвер идёт к
 * следующему кандидату, в конце — `defaultProfile` (fail-closed) с
 * предупреждением.
 */
export function resolveExecutionProfile(
  input: ExecutionProfileBindingInput,
): ExecutionProfileResolution {
  const candidates: Array<{ value: string | undefined; source: ExecutionProfileSource }> = [
    { value: input.sessionProfile, source: 'session' },
    { value: input.agentProfile, source: 'agent' },
    { value: input.projectProfile, source: 'project' },
  ];
  const denials: Array<{
    profile: string;
    source: ExecutionProfileSource;
    by: DenialReason;
  }> = [];
  for (const candidate of candidates) {
    const name = (candidate.value ?? '').trim();
    if (name === '') continue;
    const by = denialReason(name, input);
    if (by) {
      denials.push({ profile: name, source: candidate.source, by });
      continue;
    }
    return {
      profile: name,
      source: candidate.source,
      ...(denials.length > 0
        ? { warning: buildDeniedWarning(denials, input.defaultProfile) }
        : {}),
    };
  }
  const fallback = (input.defaultProfile ?? '').trim();
  if (denials.length === 0) {
    return { profile: fallback, source: 'default' };
  }
  return {
    profile: fallback,
    source: 'default',
    deniedBy: denials[0]!.by,
    warning: buildDeniedWarning(denials, fallback),
  };
}

/** Текст предупреждения: кандидат отклонён, выбран следующий/дефолт. */
function buildDeniedWarning(
  denials: ReadonlyArray<{ profile: string; source: ExecutionProfileSource; by: DenialReason }>,
  fallback: string,
): string {
  const list = denials
    .map((entry) => `"${entry.profile}" (source: ${entry.source}, denied by ${entry.by})`)
    .join(', ');
  return `Execution profile ${list} is not allowed; falling back to "${fallback}"`;
}
