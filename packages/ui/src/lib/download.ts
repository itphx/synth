/**
 * Скачивание blob'а браузером: `URL.createObjectURL` → `<a download>` → `click()`.
 *
 * Ошибки (`URL.createObjectURL` недоступен, отказ браузера на `click()`) наружу
 * не пробрасываются — рендер ломаться не должен: возвращается `false`, решение
 * (показать ли обратную связь) остаётся за вызывающим.
 *
 * `URL.revokeObjectURL` вызывается всегда (в `finally`), но в следующей
 * макротаске — как в `AnalyticsModal`: браузер должен успеть начать загрузку по
 * выданному URL, иначе ссылка станет недействительной до её чтения.
 */
export function downloadBlob(blob: Blob, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false
  if (typeof URL.createObjectURL !== 'function') return false

  let url: string
  try {
    url = URL.createObjectURL(blob)
  } catch {
    return false
  }

  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    link.style.display = 'none'
    // jsdom (и часть браузеров) «кликает» только по узлу, который есть в документе.
    document.body.appendChild(link)
    try {
      link.click()
    } finally {
      link.remove()
    }
    return true
  } catch {
    return false
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Отзыв не критичен: объект всё равно освободит сборка мусора.
      }
    }, 0)
  }
}
