/** ADR-102 §5: вкладки модального окна аналитики (состояние внутри окна, не роут). */
export type AnalyticsTab = 'usage' | 'activity' | 'decision' | 'prompt'

export const ANALYTICS_TABS: readonly AnalyticsTab[] = ['usage', 'activity', 'decision', 'prompt']
