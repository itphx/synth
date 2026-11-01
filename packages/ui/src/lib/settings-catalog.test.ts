import { describe, expect, it } from 'vitest'

import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import {
  SETTINGS_CATALOG,
  SETTINGS_CATEGORIES,
  normalizeSettingsQuery,
  searchSettings,
} from './settings-catalog'

const t = (key: string) => (enDict as Record<string, string>)[key] ?? key
const tRu = (key: string) => (ruDict as Record<string, string>)[key] ?? key

describe('settings-catalog — группы категорий', () => {
  it('«Память», «Мультимодальный ввод» и «Управление контекстом» — в AI, не в эксплуатации', () => {
    const byId = new Map(SETTINGS_CATEGORIES.map((category) => [category.id, category]))
    expect(byId.get('memory')?.group).toBe('adminAi')
    expect(byId.get('attachments')?.group).toBe('adminAi')
    expect(byId.get('contextManagement')?.group).toBe('adminAi')
  })
})

describe('settings-catalog — «Управление контекстом»', () => {
  it('админская категория в группе AI, скрыта за «Расширенными»', () => {
    const category = SETTINGS_CATEGORIES.find((cat) => cat.id === 'contextManagement')
    expect(category).toBeDefined()
    expect(category?.group).toBe('adminAi')
    expect(category?.roles).toEqual(['ADMIN'])
    expect(category?.advanced).toBe(true)
    expect(category?.labelKey).toBe('settings.category.contextManagement')
  })

  it('находится по названию и синонимам (ru/en)', () => {
    expect(searchSettings(t, 'context management').categories.map((cat) => cat.id)).toContain(
      'contextManagement',
    )
    expect(searchSettings(t, 'summarization').categories.map((cat) => cat.id)).toContain(
      'contextManagement',
    )
    expect(searchSettings(tRu, 'управление контекстом').categories.map((cat) => cat.id)).toContain(
      'contextManagement',
    )
    expect(searchSettings(tRu, 'скользящее окно').categories.map((cat) => cat.id)).toContain(
      'contextManagement',
    )
    expect(searchSettings(tRu, 'политика').categories.map((cat) => cat.id)).toContain(
      'contextManagement',
    )
  })

  it('секции привязаны к якорям панели (дефолты, политика и подсказки)', () => {
    const entries = SETTINGS_CATALOG.filter((entry) => entry.categoryId === 'contextManagement')
    expect(entries.length).toBeGreaterThan(0)
    const sectionIds = entries.map((entry) => entry.sectionId)
    expect(sectionIds).toContain('context-defaults')
    expect(sectionIds).toContain('context-window-policy')
    expect(sectionIds).toContain('context-window-hints')
  })
})

describe('settings-catalog — searchSettings', () => {
  it('пустой запрос не возвращает результатов', () => {
    expect(searchSettings(t, '')).toEqual({ categories: [], entries: [] })
    expect(searchSettings(t, '   ')).toEqual({ categories: [], entries: [] })
  })

  it('нормализует регистр и ё → е', () => {
    expect(normalizeSettingsQuery('  ТЁМНАЯ Тема ')).toBe('темная тема')

    const result = searchSettings(t, '  ТЕМНАЯ ТЕМА ')
    expect(result.categories.map((category) => category.id)).toContain('appearance')
  })

  it('находит секцию по заголовку', () => {
    const result = searchSettings(t, 'theme mode')
    expect(result.entries.map((entry) => entry.id)).toContain('appearance.themeMode')
  })

  it('находит и категорию, и секцию по одному запросу', () => {
    const result = searchSettings(t, 'proxy')
    expect(result.categories.map((category) => category.id)).toContain('network')

    const proxyEntry = result.entries.find((entry) => entry.id === 'network.proxy')
    expect(proxyEntry).toBeDefined()
    expect(proxyEntry?.categoryId).toBe('network')
    expect(proxyEntry?.sectionId).toBe('network-proxy')
  })

  it('ищет по синонимам (keywords)', () => {
    const result = searchSettings(t, 'вебхуки')
    expect(result.categories.map((category) => category.id)).toContain('webhooks')
  })

  it('«тема» находит «Тема»/«Режим темы», но не «Включён на уровне системы»', () => {
    const result = searchSettings(tRu, 'тема')
    const entryIds = result.entries.map((entry) => entry.id)

    expect(entryIds).toContain('appearance.theme')
    expect(entryIds).toContain('appearance.themeMode')
    expect(entryIds).not.toContain('mcpAdmin.masterEnabled')
  })

  it('«масштаб чата» находит секцию масштаба области чата', () => {
    const result = searchSettings(tRu, 'масштаб чата')
    const entry = result.entries.find((e) => e.id === 'appearance.chatScale')

    expect(entry).toBeDefined()
    expect(entry?.categoryId).toBe('appearance')
    expect(entry?.sectionId).toBe('appearance-chat-scale')

    const byEnglish = searchSettings(t, 'chat scale')
    expect(byEnglish.entries.map((e) => e.id)).toContain('appearance.chatScale')
  })

  it('«отлад» находит «Отладка» по префиксу слова', () => {
    const result = searchSettings(tRu, 'отлад')
    expect(result.categories.map((category) => category.id)).toContain('debug')
  })

  it('«webhook» находит Webhooks', () => {
    const result = searchSettings(t, 'webhook')
    expect(result.categories.map((category) => category.id)).toContain('webhooks')
  })

  it('не матчит подстроку в середине слова', () => {
    // «система» больше не должна находиться запросом «тема».
    const result = searchSettings(tRu, 'тема')
    const entryIds = result.entries.map((entry) => entry.id)
    expect(entryIds).not.toContain('notifications.system')
  })

  it('находит админ-раздел «Аддоны» по названию и синонимам', () => {
    const byName = searchSettings(t, 'addons')
    expect(byName.categories.map((category) => category.id)).toContain('addons')

    const bySynonym = searchSettings(tRu, 'пакеты')
    expect(bySynonym.categories.map((category) => category.id)).toContain('addons')

    const byPipeline = searchSettings(tRu, 'пайплайны')
    expect(byPipeline.entries.map((entry) => entry.id)).toContain('addons.pipelines')
  })

  it('находит админ-раздел «Плагины» по названию и синонимам', () => {
    // ADR-090 Ф6: категория и записи слоя плагинов участвуют в поиске.
    expect(searchSettings(t, 'plugins').categories.map((category) => category.id)).toContain(
      'plugins',
    )

    const bySynonym = searchSettings(tRu, 'плагины')
    expect(bySynonym.categories.map((category) => category.id)).toContain('plugins')

    expect(searchSettings(tRu, 'порог доверия').entries.map((entry) => entry.id)).toContain(
      'plugins.policy.trustFloor',
    )
    expect(searchSettings(t, 'install').entries.map((entry) => entry.id)).toContain(
      'plugins.install',
    )
  })

  it('находит раздел «Мультимодальный ввод» по названию и синонимам', () => {
    // ADR-115: категория runtime-настроек вложений участвует в поиске.
    expect(searchSettings(t, 'multimodal').categories.map((category) => category.id)).toContain(
      'attachments',
    )
    expect(searchSettings(tRu, 'вложения').categories.map((category) => category.id)).toContain(
      'attachments',
    )
    expect(searchSettings(tRu, 'белый список').entries.map((entry) => entry.id)).toContain(
      'attachments.mime',
    )
    expect(searchSettings(tRu, 'модальности').entries.map((entry) => entry.id)).toContain(
      'attachments.modalities',
    )
  })

  it('находит раздел «Полномочия» по названию и синонимам', () => {    // ADR-106 §11: категория и записи раздела участвуют в поиске.
    expect(searchSettings(t, 'authority').categories.map((category) => category.id)).toContain(
      'authority',
    )
    expect(searchSettings(tRu, 'полномочия').categories.map((category) => category.id)).toContain(
      'authority',
    )
    expect(searchSettings(tRu, 'гранты').entries.map((entry) => entry.id)).toContain(
      'authority.roles',
    )
  })
})
