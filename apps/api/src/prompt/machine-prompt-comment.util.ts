/**
 * Detect Canvas submission comments that store machine-readable prompt payloads
 * (legacy JSON). Never matches `[mm:ss]` teacher feedback (does not start with `{`).
 */
export function isMachinePromptJsonComment(text: string): boolean {
  const t = text.trim();
  if (!t || t[0] !== '{') return false;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (o.fsaslKind != null) return true;
    if (Array.isArray(o.deckTimeline) && o.deckTimeline.length > 0) return true;
    if (typeof o.promptSnapshotHtml === 'string' && o.promptSnapshotHtml.trim().length > 0) return true;
    if (o.mediaStimulus != null && typeof o.mediaStimulus === 'object') return true;
    if (o.durationSeconds != null && typeof o.submittedAt === 'string') return true;
    return false;
  } catch {
    return false;
  }
}
