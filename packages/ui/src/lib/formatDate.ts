export function parseISODate(isoString: string): Date {
  if (isoString.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(isoString)) {
    return new Date(isoString)
  }
  return new Date(isoString + 'Z')
}

export function formatRelativeTime(isoString: string): string {
  const date = parseISODate(isoString)
  const now = new Date()

  const diff = Math.max(0, now.getTime() - date.getTime())
  const minute = 60_000
  const hour = 60 * minute

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (diff < minute) {
    return 'только что'
  }

  if (diff < hour) {
    const mins = Math.floor(diff / minute)
    return `${mins} мин`
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, now)) {
    const hours = Math.floor(diff / hour)
    return `${hours} ч`
  }
  if (isSameDay(date, yesterday)) {
    return 'Вчера'
  }

  const months = [
    'янв', 'фев', 'мар', 'апр', 'май', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
  ]
  const day = date.getDate()
  const month = months[date.getMonth()]
  const year = date.getFullYear()
  const currentYear = now.getFullYear()

  if (year === currentYear) {
    return `${day} ${month}`
  }
  return `${day} ${month} ${year}`
}

export function formatRelativeTimeEn(isoString: string): string {
  const date = parseISODate(isoString)
  const now = new Date()

  const diff = Math.max(0, now.getTime() - date.getTime())
  const minute = 60_000
  const hour = 60 * minute

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (diff < minute) {
    return 'just now'
  }

  if (diff < hour) {
    const mins = Math.floor(diff / minute)
    return `${mins}min`
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, now)) {
    const hours = Math.floor(diff / hour)
    return `${hours}h`
  }
  if (isSameDay(date, yesterday)) {
    return 'Yesterday'
  }

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  const day = date.getDate()
  const month = months[date.getMonth()]
  const year = date.getFullYear()
  const currentYear = now.getFullYear()

  if (year === currentYear) {
    return `${day} ${month}`
  }
  return `${day} ${month} ${year}`
}