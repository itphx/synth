import type { PermissionTrigger } from '@/stores/permissionStore'

/**
 * Человекочитаемое объяснение ask'а по структурному триггеру.
 *
 * `trigger` — машиночитаемый «виновник» из ядра (`ApprovalRequest.trigger`):
 * id security-сообщения, вид ask'а и параметры подстановки. Текст причины
 * (`reason`) адресован модели («не повторяй вызов, выбери другой способ…») и
 * человеку бесполезен — здесь он заменяется понятной фразой про то, что
 * именно вызвало вопрос.
 *
 * Без триггера (старый сервер) — `null`: UI показывает прежний текст причины.
 */
export interface PermissionCause {
  /** Ключ i18n человекочитаемого объяснения. */
  key: string
  /** Параметры подстановки в шаблон. */
  params: Record<string, string>
  /** Токен-виновник (путь/код/команда), если он есть. */
  token?: string
}

export function describePermissionCause(trigger: PermissionTrigger | undefined): PermissionCause | null {
  if (!trigger) return null

  const params = trigger.params ?? {}
  const path = params.path ?? ''
  const code = params.code ?? ''

  switch (trigger.messageId) {
    case 'ask-external-directory':
      // Реальный доступ вне периметра (`workingDir` + `project.workspace`):
      // решение принимает правило `permission.rules.external_directory`
      // (дефолт — вопрос, в plan/strict — запрет), грант выдаётся каталогом.
      return { key: 'permission.bar.cause.external', params: { path }, token: path }
    case 'ask-protected-path': {
      // Вид ask'а: protected (путь из approvalPaths) / dynamic (glob не удалось
      // раскрыть) / mutation (мутация вне периметра) / cwd (неразрешённый cd).
      if (trigger.askKind === 'dynamic') {
        return { key: 'permission.bar.cause.dynamicPath', params: { path }, token: path }
      }
      if (trigger.askKind === 'mutation') {
        return { key: 'permission.bar.cause.mutation', params: { path }, token: path }
      }
      if (trigger.askKind === 'cwd') {
        return { key: 'permission.bar.cause.cwd', params: { path }, token: path }
      }
      return { key: 'permission.bar.cause.protected', params: { path }, token: path }
    }
    default:
      break
  }

  // Старый сервер: `askKind: 'external'` без id сообщения — та же причина,
  // если известен внешний путь (первый из `askPaths`).
  if (trigger.askKind === 'external' && path) {
    return { key: 'permission.bar.cause.external', params: { path }, token: path }
  }

  if (trigger.matchedRule) {
    // Правило сработало без id сообщения: называем правило. «Виновником»
    // считаем путь/код — команда целиком (для shell-правил) не годится:
    // подсветить её в значении `command` нечего.
    const token = path || code || undefined
    return { key: 'permission.bar.cause.rule', params: { rule: trigger.matchedRule }, token }
  }

  return { key: 'permission.bar.cause.generic', params: {} }
}
