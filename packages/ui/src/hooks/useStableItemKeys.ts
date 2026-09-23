import { useRef } from 'react'

let seq = 0
const nextKey = (): string => `stable-key-${++seq}`

/**
 * Стабильные ключи элементов контролируемого списка (не индексы): id заводятся
 * по мере роста длины и сохраняются между рендерами. Используется в
 * редактируемых списках, где `key={index}` ломает переиспользование DOM-узлов.
 */
export function useStableItemKeys(length: number): string[] {
  const keysRef = useRef<string[]>([])
  while (keysRef.current.length < length) keysRef.current.push(nextKey())
  if (keysRef.current.length > length) keysRef.current.length = length
  return keysRef.current
}
