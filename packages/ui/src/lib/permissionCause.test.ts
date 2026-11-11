import { describe, it, expect } from 'vitest'
import { describePermissionCause } from './permissionCause'
import type { PermissionTrigger } from '@/stores/permissionStore'

/**
 * Человекочитаемая причина ask'а по структурному триггеру.
 *
 * Проверяем, что код, переданный интерпретатору через stdin (heredoc/herestring),
 * описывается отдельной фразой — а не «Не удалось проверить путь <<».
 */
describe('describePermissionCause', () => {
  it('ask-stdin-code: отдельная формулировка без пути и токена', () => {
    const trigger: PermissionTrigger = {
      messageId: 'ask-stdin-code',
      params: {},
      matchedRule: 'shell-policy.approve',
      askKind: 'dynamic',
    }

    const cause = describePermissionCause(trigger)
    expect(cause).not.toBeNull()
    expect(cause!.key).toBe('permission.bar.cause.stdinCode')
    expect(cause!.params).toEqual({})
    // Токена-пути нет — подсвечивать в тексте нечего.
    expect(cause!.token).toBeUndefined()
  })

  it('ask-protected-path (dynamic) по-прежнему говорит про путь', () => {
    const cause = describePermissionCause({
      messageId: 'ask-protected-path',
      params: { path: '$HOME/.ssh/config' },
      askKind: 'dynamic',
    })
    expect(cause!.key).toBe('permission.bar.cause.dynamicPath')
    expect(cause!.token).toBe('$HOME/.ssh/config')
  })
})
