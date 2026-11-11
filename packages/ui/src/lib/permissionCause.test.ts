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

  /**
   * Реальный доступ вне периметра (`workingDir` + `project.workspace`):
   * ядро присылает `askKind: 'external'` и первый внешний путь в `params.path`.
   * Причина — не «не удалось проверить путь», а «доступ вне рабочего каталога»:
   * решение принимает правило `permission.rules.external_directory`.
   */
  it('ask-external-directory: доступ вне рабочего каталога, токен — внешний путь', () => {
    const cause = describePermissionCause({
      messageId: 'ask-external-directory',
      params: { path: '/etc' },
      matchedRule: 'external_directory.default',
      askKind: 'external',
    })
    expect(cause!.key).toBe('permission.bar.cause.external')
    expect(cause!.params).toEqual({ path: '/etc' })
    expect(cause!.token).toBe('/etc')
  })

  it('askKind: external без messageId (старый сервер) — та же причина', () => {
    const cause = describePermissionCause({
      params: { path: '/etc' },
      matchedRule: 'external_directory.default',
      askKind: 'external',
    })
    expect(cause!.key).toBe('permission.bar.cause.external')
    expect(cause!.params).toEqual({ path: '/etc' })
    expect(cause!.token).toBe('/etc')
  })
})
