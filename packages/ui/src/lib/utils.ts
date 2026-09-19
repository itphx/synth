import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function resolveColor(cssVar: string | null): string | undefined {
  if (!cssVar) return undefined
  if (cssVar.startsWith('--')) {
    return `var(${cssVar})`
  }
  return cssVar
}

/**
 * AD-070 §2.6: детерминированный цвет пользователя по имени.
 * У авторов нет сохранённого цвета, поэтому цвет закрепляется за именем
 * простым хешем (сумма кодов символов % 5) — палитра `--chart-1..5`
 * (`styles/design-system.css`). Для одного имени значение стабильно.
 */
export function userColor(name: string): string {
  let sum = 0
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i)
  }
  const index = (sum % 5) + 1
  return `var(--chart-${index})`
}
