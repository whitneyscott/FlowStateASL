const SPEEDGRADER_HINT =
  'Use Canvas SpeedGrader for the full rubric, video context, and any attachment details.';

/** Plain-text / light HTML submission body for Canvas (forward path — no machine JSON). */
export function buildHumanReadableSubmissionBodyText(args: {
  deckTimeline?: Array<{ title: string; startSec: number; videoId?: string }>;
  promptSnapshotHtml?: string;
}): string {
  const deck = args.deckTimeline?.filter((r) => (r.title ?? '').trim().length > 0) ?? [];
  if (deck.length > 0) {
    const lines = deck.map((r, i) => `${i + 1}. ${(r.title ?? '').trim()}`);
    return `Prompt (deck checklist):\n${lines.join('\n')}\n\n— ${SPEEDGRADER_HINT}`;
  }
  const snap = (args.promptSnapshotHtml ?? '').trim();
  if (snap) {
    const plain = plainTextFromPromptSnapshotHtml(snap);
    if (plain) return `${plain}\n\n— ${SPEEDGRADER_HINT}`;
  }
  return `Recording submitted.\n\n— ${SPEEDGRADER_HINT}`;
}

/** Escape and format non-JSON submission body for grading HTML fallbacks. */
export function humanSubmissionBodyToPromptHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const esc = trimmed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function plainTextFromPromptSnapshotHtml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) return '';
  let t = trimmed
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
