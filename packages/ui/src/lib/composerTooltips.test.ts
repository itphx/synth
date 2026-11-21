import { describe, it, expect } from 'vitest'
import {
  agentTooltipParts,
  agentTooltipText,
  modelTooltipParts,
  modelTooltipText,
} from './composerTooltips'

describe('modelTooltipText / agentTooltipText — готовый текст для `title`', () => {
  it('модель: три строки, пустые не попадают', () => {
    expect(
      modelTooltipText({
        providerName: 'itphx',
        modelName: 'omn.qwen3.8:27b',
        contextWindow: 262144,
        contextLabel: 'Контекстное окно',
      }),
    ).toBe(`itphx\nomn.qwen3.8:27b\nКонтекстное окно: ${(262144).toLocaleString()}`)
    expect(
      modelTooltipText({ providerName: 'deepseek', modelName: 'deepseek-flash', contextLabel: 'Контекстное окно' }),
    ).toBe('deepseek\ndeepseek-flash')
  })

  it('агент: имя и описание через перевод строки', () => {
    expect(agentTooltipText({ displayName: 'Ассистент', description: 'Универсальный ассистент' })).toBe(
      'Ассистент\nУниверсальный ассистент',
    )
    expect(agentTooltipText({ displayName: 'Лидер' })).toBe('Лидер')
  })
})

describe('modelTooltipParts — подсказка кнопки выбора модели', () => {
  it('отдаёт провайдера, модель и окно контекста, когда оно задано', () => {
    expect(
      modelTooltipParts({
        providerName: 'itphx',
        modelName: 'omn.qwen3.8:27b',
        contextWindow: 262144,
        contextLabel: 'Контекстное окно',
      }),
    ).toEqual({
      provider: 'itphx',
      model: 'omn.qwen3.8:27b',
      context: `Контекстное окно: ${(262144).toLocaleString()}`,
    })
  })

  it('не показывает строку окна, если оно не задано (0, null, undefined)', () => {
    for (const contextWindow of [0, null, undefined, Number.NaN]) {
      const parts = modelTooltipParts({
        providerName: 'deepseek',
        modelName: 'deepseek-flash',
        contextWindow,
        contextLabel: 'Контекстное окно',
      })
      expect(parts).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
    }
  })

  it('не оставляет пустых частей при отсутствии данных', () => {
    expect(modelTooltipParts({ contextLabel: 'Контекстное окно' })).toEqual({})
    expect(
      modelTooltipParts({ providerName: '  ', modelName: ' ', contextLabel: 'Контекстное окно' }),
    ).toEqual({})
  })
})

describe('agentTooltipParts — подсказка кнопки выбора агента', () => {
  it('отдаёт имя и описание', () => {
    expect(
      agentTooltipParts({
        displayName: 'Ассистент',
        description: 'Универсальный ассистент для любых задач',
      }),
    ).toEqual({ name: 'Ассистент', description: 'Универсальный ассистент для любых задач' })
  })

  it('падает на id, если отображаемое имя пустое', () => {
    expect(agentTooltipParts({ displayName: null, fallbackName: 'assistant' })).toEqual({
      name: 'assistant',
    })
  })

  it('не показывает пустое описание и обрезает пробелы', () => {
    expect(agentTooltipParts({ displayName: 'Лидер', description: '   ' })).toEqual({
      name: 'Лидер',
    })
    expect(agentTooltipParts({ displayName: 'Лидер', description: '  ведёт команду  ' })).toEqual({
      name: 'Лидер',
      description: 'ведёт команду',
    })
  })
})
