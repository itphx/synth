import type { IconName } from '@/components/icon/icons'

/**
 * Иконка файла по имени (расширение). Прежнее поведение дерева Files,
 * вынесено в чистую функцию: её использует и Git-вкладка для списка изменений.
 */
export function fileIconName(name: string): IconName {
  if (/\.(tsx?|jsx?|py|rs|go|java|rb|php|swift|kt)$/i.test(name)) return 'file-code'
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)) return 'image'
  if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'file-music'
  return 'file-text'
}
