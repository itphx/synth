/**
 * AD-089 (этап 5): эффективные роли внешнего отправителя события.
 *
 * Правила:
 * - **База — роли профиля Synth** (`ProfileData.roles`): отправитель действует
 *   ровно с теми правами, что есть у его учётной записи.
 * - **`identity.roles` могут только сузить** базу (пересечение). Роль из
 *   allowlist внешнего источника — «потолок», а не дарование прав: источник не
 *   может повысить отправителя выше его профиля.
 * - **Неизвестный отправитель** (нет профиля/идентичности) → ролей нет
 *   (fail-closed): транспортное участие (сессия/чат) возможно, привилегированные
 *   операции — нет.
 *
 * Роли в проекте каноничны в ВЕРХНЕМ регистре (`ADMIN`/`USER`/`LEAD`/`AUDITOR`;
 * OIDC нормализует `extractKnownRoles`, шлюз — `parseAllowlist`), поэтому и вход,
 * и результат нормализуются к верхнему регистру с дедупликацией.
 */

/** Результат резолвинга эффективных ролей внешнего отправителя. */
export interface EffectiveRoles {
  /** Эффективные роли (нормализованы к верхнему регистру, без дублей). */
  roles: string[];
  /**
   * Отправитель сопознан с пользователем инстанса (профиль/override), а не
   * аноним. `false` — fail-closed: прав Synth нет (роли всегда `[]`).
   */
  linked: boolean;
}

/** Нормализация роли к каноническому виду: trim + верхний регистр. */
export function normalizeRole(role: string): string {
  return role.trim().toUpperCase();
}

/** Дедупликация с сохранением порядка. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Вычисляет эффективные роли внешнего отправителя.
 *
 * @param profileRoles роли профиля (`null` — профиль/идентичность не найдены);
 * @param identityRoles роли из `EventIdentity.roles` (потолок; заданы — сужают).
 */
export function resolveEffectiveRoles(
  profileRoles: string[] | null,
  identityRoles: string[] | undefined,
): EffectiveRoles {
  if (profileRoles === null) return { roles: [], linked: false };

  const base = dedupe(profileRoles.map(normalizeRole).filter(Boolean));
  const requested = dedupe((identityRoles ?? []).map(normalizeRole).filter(Boolean));

  // Роли не запрошены — действует база профиля целиком.
  if (requested.length === 0) return { roles: base, linked: true };

  // Сужение: разрешено только то, что есть в профиле (потолок не поднимается).
  const allowed = new Set(base);
  return { roles: requested.filter((role) => allowed.has(role)), linked: true };
}
