import { describe, it, expect } from 'vitest'
import type { MessageData } from '@/stores/chatStore'
import { toQueuedMessage } from './ChatTab'

/**
 * D3: очередь адресуется по серверному id — `toQueuedMessage` обязан сохранить
 * его из `pending_messages[].id` (иначе UI снова начнёт адресовать по индексу).
 */
describe('toQueuedMessage — id pending-сообщения', () => {
  it('сохраняет серверный id и поля строки очереди', () => {
    const queued = toQueuedMessage({
      id: 'msg-1',
      content: 'привет',
      agent_role: 'fixer',
      parts: [],
    } as unknown as MessageData)

    expect(queued.id).toBe('msg-1')
    expect(queued.content).toBe('привет')
    expect(queued.agentRole).toBe('fixer')
    expect(queued.attachmentCount).toBe(0)
  })
})
