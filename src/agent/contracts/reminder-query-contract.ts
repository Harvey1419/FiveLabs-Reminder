/** Literal content search only. PostgREST aliases * to %, so reject it fail-closed. */
export function normalizeReminderQuery(query: unknown, language = 'es') {
  if (query === undefined) return { valid: true, value: undefined };
  const value = typeof query === 'string' ? query.trim() : '';
  if (!value || value.length > 200 || value.includes('*') || value.includes('\0')) {
    return {
      valid: false,
      errorCode: 'INVALID_QUERY',
      error: language === 'en'
        ? 'Use reminder search text of 1–200 characters after trimming, without * or NUL characters.'
        : 'Usa un texto de búsqueda de recordatorios de 1–200 caracteres sin espacios extremos, sin * ni caracteres NUL.',
    };
  }
  return {
    valid: true,
    value,
    pattern: '%' + value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%',
  };
}
