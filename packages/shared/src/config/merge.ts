// Глубокий мерж объекта b в a (мутирует новый объект)
export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    const aVal = result[key];
    const bVal = b[key];
    if (
      bVal !== null &&
      typeof bVal === 'object' &&
      !Array.isArray(bVal) &&
      aVal !== null &&
      typeof aVal === 'object' &&
      !Array.isArray(aVal)
    ) {
      result[key] = deepMerge(aVal as Record<string, unknown>, bVal as Record<string, unknown>);
    } else {
      result[key] = bVal;
    }
  }
  return result;
}
