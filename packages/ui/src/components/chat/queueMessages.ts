// Строка очереди из pending-сообщения сессии.
//
// Вынесено из `ChatTab`, потому что преобразование нужно и загрузке сессии
// (первичная подгрузка `pending_messages`), и общему контроллеру композера
// (`useSessionComposer` → перечитывание очереди у API). Модуль отдельный —
// чтобы не было циклического импорта «композер → ChatTab → композер».

import type { MessageData, QueuedMessage } from '@/stores/chatStore'
import { mediaPartsOf } from './attachments/MessageAttachments'

/**
 * `pending_messages` сессии → строка очереди (`QueuedMessage`).
 * ADR-115: число вложений считаем по медиа-частям сообщения.
 */
export function toQueuedMessage(pm: MessageData): QueuedMessage {
  return {
    id: pm.id,
    content: pm.content,
    agentRole: pm.agent_role || null,
    attachmentCount: mediaPartsOf(pm.parts).length,
  }
}
