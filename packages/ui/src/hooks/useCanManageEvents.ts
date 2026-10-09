import { useAuthStore } from '@/stores/authStore'

/**
 * AD-089: право управлять внешними событиями (биндинги/правила/ключи) — LEAD/ADMIN.
 * UI лишь прячет мутации; enforcement — на сервере (guard'ы роутов).
 */
export function useCanManageEvents(): boolean {
  const user = useAuthStore((s) => s.user)
  const roles = user?.roles ?? []
  return roles.includes('ADMIN') || roles.includes('LEAD')
}
