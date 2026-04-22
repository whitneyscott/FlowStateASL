export type CanvasAssignmentBrief = {
  id: string;
  name: string;
  /** Present when loaded via course assignment list with import fields. */
  description?: string;
  linkedRubricId?: string;
  pointsPossible?: number;
  allowedAttempts?: number;
  assignmentGroupId?: string;
};

export type ResolveAssignmentIdResult =
  | { status: 'matched'; newId: string }
  | { status: 'conflict'; candidates: CanvasAssignmentBrief[] }
  | { status: 'unmatched' };

export function resolveAssignmentIdByName(
  name: string,
  targetCourseAssignments: CanvasAssignmentBrief[],
): ResolveAssignmentIdResult {
  const n = name.trim().toLowerCase();
  if (!n) return { status: 'unmatched' };
  const matches = targetCourseAssignments.filter((a) => a.name.trim().toLowerCase() === n);
  if (matches.length === 1) return { status: 'matched', newId: matches[0].id };
  if (matches.length > 1) return { status: 'conflict', candidates: matches };
  return { status: 'unmatched' };
}
