import { Icon, type IconName } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

export interface ProviderIconProps {
  icon: string
  baseUrl?: string
  size?: number
  className?: string
  title?: string
}

function getFaviconUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  try {
    return `${new URL(baseUrl).origin}/favicon.ico`
  } catch {
    return undefined
  }
}

export type ProviderIconKind = 'none' | 'remixicon' | 'brand' | 'image' | 'url' | 'unknown'

/**
 * Классифицирует значение иконки провайдера (единая точка знания о форматах).
 * `value`: remixicon/brand — имя без префикса, url — host, image — MIME, иначе ''.
 */
export function describeProviderIcon(icon: string): { kind: ProviderIconKind; value: string } {
  if (!icon) return { kind: 'none', value: '' }
  if (icon.startsWith('ri:')) return { kind: 'remixicon', value: icon.slice(3) }
  if (icon.startsWith('brand:')) return { kind: 'brand', value: icon.slice(6) }
  if (icon.startsWith('data:image/')) {
    const mime = icon.slice(5)
    const semicolon = mime.indexOf(';')
    return { kind: 'image', value: semicolon === -1 ? mime : mime.slice(0, semicolon) }
  }
  if (icon.startsWith('http')) {
    try {
      return { kind: 'url', value: new URL(icon).host }
    } catch {
      return { kind: 'url', value: icon }
    }
  }
  return { kind: 'unknown', value: icon }
}

export function ProviderIcon({ icon, baseUrl, size = 20, className, title }: ProviderIconProps) {
  // Авто-определение (пустая строка) — favicon с домена
  if (!icon) {
    const faviconUrl = getFaviconUrl(baseUrl)
    if (faviconUrl) {
      return (
        <img
          src={faviconUrl}
          width={size}
          height={size}
          className={cn('rounded', className)}
          alt=""
        />
      )
    }
    return <span title={title}><Icon name="cpu" className={cn('text-muted-foreground', className)} style={{ width: size, height: size }} /></span>
  }

  // Remixicon
  if (icon.startsWith('ri:')) {
    const riName = icon.slice(3)
    return <span title={title}><Icon name={riName as IconName} className={cn('text-foreground', className)} style={{ width: size, height: size }} /></span>
  }

  // Брендовая SVG
  if (icon.startsWith('brand:')) {
    const brand = icon.slice(6)
    return (
      <img
        src={`/assets/providers/${brand}.svg`}
        width={size}
        height={size}
        className={cn('rounded', className)}
        alt={brand}
      />
    )
  }

  // data:image/... (favicon в base64)
  if (icon.startsWith('data:image/')) {
    return (
      <img
        src={icon}
        width={size}
        height={size}
        className={cn('rounded', className)}
        alt=""
      />
    )
  }

  // URL favicon
  if (icon.startsWith('http')) {
    return (
      <img
        src={icon}
        width={size}
        height={size}
        className={cn('rounded', className)}
        alt=""
      />
    )
  }

  return <Icon name="cpu" className={cn('text-muted-foreground', className)} style={{ width: size, height: size }} />
}

export const PROVIDER_RI_ICONS: IconName[] = [
  'cpu',
  'robot-2',
  'server',
  'global',
  'brain',
  'flask',
  'rocket',
  'lightbulb',
  'code-box',
  'database-2',
]

export const PROVIDER_BRAND_NAMES = [
  'openai',
  'anthropic',
  'ollama',
  'google',
  'mistral',
  'deepseek',
  'minimax',
  'meta',
  'openrouter',
  'huggingface',
  'lmstudio',
  'openwebui',
  'routerai',
]
