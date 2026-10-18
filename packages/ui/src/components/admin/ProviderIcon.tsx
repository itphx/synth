import { useEffect, useState } from 'react'
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
  // Классификация формата — в `describeProviderIcon` (единая точка знания).
  const { kind, value } = describeProviderIcon(icon)

  switch (kind) {
    // Авто-определение (пустая строка) — favicon с домена
    case 'none': {
      const faviconUrl = getFaviconUrl(baseUrl)
      if (faviconUrl) {
        return <ProviderImage src={faviconUrl} size={size} className={className} />
      }
      return <span title={title}><Icon name="cpu" className={cn('text-muted-foreground', className)} style={{ width: size, height: size }} /></span>
    }

    // Remixicon
    case 'remixicon':
      return <span title={title}><Icon name={value as IconName} className={cn('text-foreground', className)} style={{ width: size, height: size }} /></span>

    // Брендовая SVG
    case 'brand':
      return (
        <ProviderImage
          src={`/assets/providers/${value}.svg`}
          size={size}
          className={className}
          alt={value}
        />
      )

    // data:image/... (favicon в base64) и URL favicon
    case 'image':
    case 'url':
      return <ProviderImage src={icon} size={size} className={className} alt="" />

    default:
      return <Icon name="cpu" className={cn('text-muted-foreground', className)} style={{ width: size, height: size }} />
  }
}

/**
 * `<img>` иконки провайдера с фоллбеком на `cpu`: битый favicon/URL/бренд
 * не должен оставлять в интерфейсе «сломанную картинку».
 */
function ProviderImage({ src, size, className, alt }: { src: string; size: number; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false)

  // Новый src — снова пробуем загрузить (иначе фоллбек «залипнет»).
  useEffect(() => {
    setFailed(false)
  }, [src])

  if (failed) {
    return (
      <Icon
        name="cpu"
        data-testid="provider-icon-fallback"
        className={cn('text-muted-foreground', className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      className={cn('rounded', className)}
      alt={alt ?? ''}
      onError={() => setFailed(true)}
    />
  )
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
