import { describe, expect, it } from 'vitest'

import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { normalizeSettingsQuery, searchSettings } from './settings-catalog'

const t = (key: string) => (enDict as Record<string, string>)[key] ?? key
const tRu = (key: string) => (ruDict as Record<string, string>)[key] ?? key

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
})
