import { useMediaQuery } from './useMediaQuery'
import { BREAKPOINTS, type DeviceType } from '@/lib/device'

export interface DeviceInfo {
  deviceType: DeviceType
  /** Сенсорный ввод без точного указателя (совпадает с html.pointer-coarse). */
  isTouch: boolean
}

/** Актуальная device-зона для компонентов (классы на <html> выставляет initDeviceClasses). */
export function useDevice(): DeviceInfo {
  const isPhone = useMediaQuery(`(max-width: ${BREAKPOINTS.phoneMax}px)`)
  const isTablet = useMediaQuery(
    `(min-width: ${BREAKPOINTS.phoneMax + 1}px) and (max-width: ${BREAKPOINTS.tabletMax}px)`
  )
  const coarse = useMediaQuery('(pointer: coarse)')
  const anyFine = useMediaQuery('(any-pointer: fine)')

  const deviceType: DeviceType = isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop'

  return { deviceType, isTouch: coarse && !anyFine }
}
