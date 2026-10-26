import { describe, it, expect } from 'vitest'
import {
  backgroundNoticeName,
  backgroundToolCall,
  extractBackgroundBody,
  isBackgroundSuccess,
  resolveBackgroundKind,
  resolveBackgroundState,
  stripBackgroundEnvelope,
} from './background-notice'

describe('background-notice: разбор уведомления фонового прогона', () => {
  it('stripBackgroundEnvelope снимает конверт процесса', () => {
    const content = [
      '<process processID="proc_1" state="exited" command="npm test">',
      '5 passed',
      '</process>',
    ].join('\n')
    expect(stripBackgroundEnvelope(content)).toBe('5 passed')
  })

  it('stripBackgroundEnvelope снимает конверт саб-агента', () => {
    const content = [
      '<subagent sessionID="child-1" state="failed" description="собрать отчёт">',
      'отчёт не собран',
      '</subagent>',
    ].join('\n')
    expect(stripBackgroundEnvelope(content)).toBe('отчёт не собран')
  })

  it('stripBackgroundEnvelope снимает конверт без закрывающего тега (обрезанный live-кадр)', () => {
    const content = '<process processID="proc_1" state="exited" command="npm test">\n5 passed'
    expect(stripBackgroundEnvelope(content)).toBe('5 passed')
  })

  it('stripBackgroundEnvelope без конверта возвращает текст как есть', () => {
    expect(stripBackgroundEnvelope('просто текст')).toBe('просто текст')
  })

  it('extractBackgroundBody снимает конверт и обёртку <summary>', () => {
    const content = [
      '<subagent sessionID="child-1" state="completed" description="собрать отчёт">',
      '<summary>',
      'отчёт готов',
      '</subagent>',
    ].join('\n')
    expect(extractBackgroundBody(content)).toBe('отчёт готов')
  })

  it('resolveBackgroundKind/resolveBackgroundState: известное значение и запасной вариант', () => {
    expect(resolveBackgroundKind({ kind: 'subagent' })).toBe('subagent')
    expect(resolveBackgroundKind({ kind: 'process' })).toBe('process')
    expect(resolveBackgroundKind({})).toBe('process')
    expect(resolveBackgroundState({ state: 'failed' })).toBe('failed')
    expect(resolveBackgroundState({ state: 'cancelled' })).toBe('cancelled')
    expect(resolveBackgroundState({ state: 'completed' })).toBe('completed')
    expect(resolveBackgroundState({})).toBe('completed')
    expect(isBackgroundSuccess('completed')).toBe(true)
    expect(isBackgroundSuccess('failed')).toBe(false)
    expect(isBackgroundSuccess('cancelled')).toBe(false)
  })

  it('backgroundNoticeName: команда/описание и обрезка длинного значения', () => {
    expect(backgroundNoticeName({ command: 'npm test' }, 'process')).toBe('npm test')
    expect(backgroundNoticeName({ description: 'собрать отчёт' }, 'subagent')).toBe('собрать отчёт')
    const long = 'x'.repeat(200)
    expect(backgroundNoticeName({ command: long }, 'process')).toHaveLength(80)
  })
})

describe('background-notice: данные карточки результата', () => {
  const processContent = [
    '<process processID="proc_1" state="exited" command="npm test">',
    '5 passed',
    '</process>',
  ].join('\n')

  it('процесс → карточка результата execute_shell (команда, cwd, тело без конверта)', () => {
    const call = backgroundToolCall(
      {
        kind: 'process',
        state: 'completed',
        command: 'npm test',
        cwd: '/work',
        started_at: '2026-10-20T10:00:00.000Z',
        finished_at: '2026-10-20T10:00:02.000Z',
      },
      processContent,
    )

    expect(call.name).toBe('execute_shell')
    expect(call.args).toEqual({ command: 'npm test', cwd: '/work' })
    expect(call.result.content).toBe('5 passed')
    expect(call.result.content).not.toContain('<process')
    expect(call.result.isError).toBe(false)
    expect(call.status).toBe('done')
    expect(call.startedAt).toBe('2026-10-20T10:00:00.000Z')
    expect(call.completedAt).toBe('2026-10-20T10:00:02.000Z')
  })

  it('процесс с ошибкой → isError', () => {
    const call = backgroundToolCall(
      { kind: 'process', state: 'failed', command: 'npm test' },
      '<process processID="proc_1" state="failed" command="npm test">\nboom\n</process>',
    )
    expect(call.result.isError).toBe(true)
  })

  it('саб-агент → карточка результата task (описание, итог без конверта)', () => {
    const call = backgroundToolCall(
      {
        kind: 'subagent',
        state: 'failed',
        description: 'собрать отчёт',
      },
      [
        '<subagent sessionID="child-1" state="failed" description="собрать отчёт">',
        '<summary>',
        'отчёт не собран',
        '</subagent>',
      ].join('\n'),
    )

    expect(call.name).toBe('task')
    expect(call.args).toEqual({ description: 'собрать отчёт' })
    expect(call.result.content).toBe('отчёт не собран')
    expect(call.result.content).not.toContain('<subagent')
    expect(call.result.content).not.toContain('<summary>')
    expect(call.result.isError).toBe(true)
  })

  it('без меток времени карточка собирается без startedAt/completedAt', () => {
    const call = backgroundToolCall({ kind: 'process', state: 'completed' }, 'тело')
    expect(call.startedAt).toBeUndefined()
    expect(call.completedAt).toBeUndefined()
    expect(call.result.content).toBe('тело')
  })
})
