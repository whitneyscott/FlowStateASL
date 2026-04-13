/**
 * Canvas submission `rubric_assessment` mixes metadata with per-criterion objects.
 * Criterion entries are plain objects with points / rating_id / comments (or description).
 */
const RUBRIC_ASSESSMENT_META_KEYS = new Set([
  'id',
  'grader_id',
  'grader',
  'rubric_id',
  'rubric_association_id',
  'artifact_attempt_id',
  'artifact_type',
  'artifact_id',
  'assessment_type',
  'user_id',
  'completed_at',
  'created_at',
  'updated_at',
  'links',
  'rubric_association',
  'assessor',
  'artifact',
  'score',
]);

function isCriterionAssessmentValue(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'points' in o || 'rating_id' in o || typeof o.comments === 'string';
}

/** Keep only per-criterion rows; duplicate keys without leading `_` when Canvas uses `_<id>`. */
export function normalizeCanvasRubricAssessment(
  raw: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (RUBRIC_ASSESSMENT_META_KEYS.has(k)) continue;
    if (!isCriterionAssessmentValue(v)) continue;
    out[k] = v;
    if (k.startsWith('_')) {
      const stripped = k.slice(1);
      if (stripped && !(stripped in out)) out[stripped] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
