/**
 * Treats unsubstituted Canvas variable strings (e.g. $Canvas.assignment.id) as empty.
 * Canvas sends these literals when there is no context (e.g. course navigation has no assignment).
 * Any value starting with $Canvas. (case-insensitive) should be treated as null/empty.
 */
export function resolveLtiContextValue(val: string | undefined | null): string {
  if (val == null || typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('$canvas.')) return '';
  return trimmed;
}

/**
 * Sanitizes LTI context fields that may contain unsubstituted Canvas variables.
 * Returns a copy with assignmentId, moduleId, etc. resolved (empty if $Canvas.*).
 */
export function sanitizeLtiContext<T>(ctx: T | null | undefined): T {
  if (!ctx || typeof ctx !== 'object') return ctx as T;
  const out = { ...ctx } as Record<string, unknown>;
  const keys = ['assignmentId', 'moduleId', 'courseId', 'resourceLinkId'] as const;
  for (const k of keys) {
    if (k in out && typeof out[k] === 'string') {
      out[k] = resolveLtiContextValue(out[k] as string);
    }
  }
  if ('canvasUserId' in out && typeof out.canvasUserId === 'string') {
    const v = resolveLtiContextValue(out.canvasUserId);
    out.canvasUserId = v || undefined;
  }
  return out as T;
}
