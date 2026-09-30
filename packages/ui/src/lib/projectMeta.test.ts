import { describe, it, expect } from 'vitest'
import { PROJECT_ICON_KEYS } from '@itphx/synth-shared/types'
import { isIconName } from '@/components/icon/Icon'
import { PROJECT_ICONS, PROJECT_ICON_MAP } from './projectMeta'

describe('projectMeta — реестр иконок синхронен с shared', () => {
  it('состав и порядок ключей PROJECT_ICONS совпадают с PROJECT_ICON_KEYS', () => {
    expect(PROJECT_ICONS.map((i) => i.key)).toEqual([...PROJECT_ICON_KEYS])
  })

  it('длины совпадают, ключи уникальны (нет «дырок» в пикере)', () => {
    expect(PROJECT_ICONS).toHaveLength(PROJECT_ICON_KEYS.length)
    expect(new Set(PROJECT_ICONS.map((i) => i.key)).size).toBe(PROJECT_ICONS.length)
  })

  it('каждый маппинг — валидный IconName из реестра Icon', () => {
    for (const { key, icon } of PROJECT_ICONS) {
      expect(isIconName(icon), `key "${key}" → icon "${icon}"`).toBe(true)
    }
  })

  it('PROJECT_ICON_MAP определён для каждого канонического ключа', () => {
    for (const key of PROJECT_ICON_KEYS) {
      expect(PROJECT_ICON_MAP[key], `PROJECT_ICON_MAP["${key}"]`).toBeDefined()
    }
  })

  it('дефолтные иконки (folder/chat/cpu) доступны для явного выбора', () => {
    expect(PROJECT_ICON_MAP.folder).toBe('folder-3')
    expect(PROJECT_ICON_MAP.chat).toBe('chat-new')
    expect(PROJECT_ICON_MAP.cpu).toBe('cpu')
  })
})
