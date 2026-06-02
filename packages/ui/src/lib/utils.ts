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