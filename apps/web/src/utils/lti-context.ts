/**
 * Treats unsubstituted Canvas variable strings (e.g. $Canvas.assignment.id) as empty.
 * Use when reading context.assignmentId, context.moduleId, etc. for defense-in-depth.
 * (API already sanitizes at source; this guards against any alternate context sources.)
 */
export function resolveLtiContextValue(val: string | undefined | null): string {
  if (val == null || typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('$canvas.')) return '';
  return trimmed;
}
