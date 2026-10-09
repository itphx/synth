import type { ProfileData } from '@itphx/synth-shared';

/**
 * Онбординг-интервью пройдено. Проверка по отдельному полю профиля
 * `ProfileData.interviewCompleted` (legacy-метка `[ИНТЕРВЬЮ]` в `notes`
 * бэкфиллится в `FileProfileStore` при чтении). Используется
 * `ContextBuilder` для гейта блока `[INTERVIEW]`.
 */
export function isInterviewCompleted(profile: ProfileData | null | undefined): boolean {
  return !!profile?.interviewCompleted;
}
