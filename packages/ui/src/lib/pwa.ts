export function isPwaStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) {
    return true
  }
  return (navigator as { standalone?: boolean }).standalone === true
}
