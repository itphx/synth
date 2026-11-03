import { useEffect } from 'react'
import { useProvidersStore } from '@/stores/providersStore'

/**
 * Догружает метаданные моделей, которых нет на загруженной странице каталога.
 *
 * Каталог моделей постраничный (`GET /models` → страница), поэтому модель,
 * выбранная в сессии или в настройках, может лежать на другой странице. Без
 * догрузки её окно контекста неизвестно, а селекты выглядели бы пустыми.
 *
 * Ссылка на модель — `provider/model` либо просто имя модели.
 */
export function useEnsureModelsLoaded(refs: Array<string | null | undefined>): void {
  const ensureModelLoaded = useProvidersStore((s) => s.ensureModelLoaded)
  // Ключ — состав ссылок: эффект перезапускается только при его изменении.
  const key = refs.filter((r): r is string => !!r).join('|')

  useEffect(() => {
    for (const ref of refs) {
      if (!ref) continue
      void ensureModelLoaded(ref)
    }
  }, [key, ensureModelLoaded])
}
