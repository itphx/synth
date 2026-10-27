/**
 * Размер файла в человекочитаемом виде — для карточек вложений.
 *
 * Единицы: байты, килобайты, мегабайты (основание 1024). Ноль и
 * нечисловые значения дают пустую строку — «размер неизвестен».
 */
export function formatFileSize(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
