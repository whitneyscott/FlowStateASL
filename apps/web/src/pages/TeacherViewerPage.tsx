import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import * as promptApi from '../api/prompt.api';
import './PrompterPage.css';

interface FeedbackEntry {
  id: number;
  time: number;
  text: string;
}

function parseTimestampedFeedback(comments: Array<{ id: number; comment: string }>): FeedbackEntry[] {
  if (!comments?.length) return [];
  const out: FeedbackEntry[] = [];
  const re = /^\[(\d+):(\d+)\]\s*(.*)$/s;
  for (const c of comments) {
    const txt = (c.comment ?? '').trim();
    const m = re.exec(txt);
    if (m) {
      const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      out.push({ id: c.id, time: sec, text: (m[3] ?? '').trim() });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Deck submissions: real boundaries from the student recorder (seconds from recording start). */
interface DeckTimelineEntry {
  title: string;
  startSec: number;
}

function deckTimelineFromParsedJson(parsed: { deckTimeline?: unknown }): DeckTimelineEntry[] {
  const raw = parsed.deckTimeline;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: DeckTimelineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { title?: unknown; startSec?: unknown };
    const title = String(o.title ?? '');
    const startSec = Number(o.startSec);
    if (!Number.isFinite(startSec)) continue;
    out.push({ title, startSec });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

/** Legacy: deck timeline sometimes lived only in submission body JSON (before video overwrote body). */
function parseDeckTimelineFromBody(body: string | undefined): DeckTimelineEntry[] {
  if (!body?.trim()) return [];
  try {
    return deckTimelineFromParsedJson(JSON.parse(body) as { deckTimeline?: unknown });
  } catch {
    return [];
  }
}

/**
 * Current flow: after video upload, prompt + deckTimeline are often only in a JSON submission comment
 * (same payload as promptSnapshotHtml), because Canvas replaces online_text_entry body on upload.
 */
function parseDeckTimelineFromSubmissionComments(
  comments: Array<{ comment?: string }> | undefined,
): DeckTimelineEntry[] {
  if (!comments?.length) return [];
  for (const c of comments) {
    const txt = (c.comment ?? '').trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt) as { deckTimeline?: unknown };
      const rows = deckTimelineFromParsedJson(parsed);
      if (rows.length > 0) return rows;
    } catch {
      // not JSON — skip
    }
  }
  return [];
}

function resolveDeckTimeline(
  body: string | undefined,
  comments: Array<{ comment?: string }> | undefined,
): DeckTimelineEntry[] {
  const fromBody = parseDeckTimelineFromBody(body);
  if (fromBody.length > 0) return fromBody;
  return parseDeckTimelineFromSubmissionComments(comments);
}

function activeDeckPromptAt(t: number, segments: DeckTimelineEntry[]): DeckTimelineEntry | null {
  if (segments.length === 0) return null;
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].startSec;
    const nextStart = i + 1 < segments.length ? segments[i + 1].startSec : Infinity;
    if (t >= start && t < nextStart) return segments[i];
  }
  return null;
}

function rubricCriterionDeckIndex(
  criterion: RubricCriterion,
  criterionIdx: number,
  rubricLength: number,
  deckLength: number,
): number | null {
  if (deckLength <= 0) return null;
  const desc = String(criterion.description ?? '').trim();
  const cardMatch = /\b(?:card|prompt|item)\s*(\d{1,3})\b/i.exec(desc);
  if (cardMatch) {
    const n = Number.parseInt(cardMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= deckLength) return n - 1;
  }
  const leadingMatch = /^\s*(\d{1,3})\s*[\)\].:-]/.exec(desc);
  if (leadingMatch) {
    const n = Number.parseInt(leadingMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= deckLength) return n - 1;
  }
  if (rubricLength === deckLength && criterionIdx >= 0 && criterionIdx < deckLength) {
    return criterionIdx;
  }
  return null;
}

function getPromptFromComments(
  body: string | undefined,
  comments: Array<{ comment: string }> | undefined,
  promptHtml?: string
): string {
  if (promptHtml?.trim()) return promptHtml;
  if (body?.trim()) {
    try {
      const parsed = JSON.parse(body) as { promptSnapshotHtml?: string };
      if (parsed.promptSnapshotHtml) return parsed.promptSnapshotHtml;
    } catch {
      return body;
    }
  }
  if (!comments?.length) return 'No prompt recorded.';
  for (const c of comments) {
    const txt = (c.comment ?? '').trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt) as { promptSnapshotHtml?: string };
      if (parsed.promptSnapshotHtml?.trim()) return parsed.promptSnapshotHtml.trim();
    } catch {
      // not JSON — try next comment or fall through to legacy heuristics
    }
  }
  let lastIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    const txt = (comments[i].comment ?? '').trim();
    const isLegacy = /^Prompt used:/i.test(txt);
    const hasMarkup = txt.includes('<') && txt.includes('>');
    if (isLegacy || hasMarkup) lastIdx = i;
  }
  if (lastIdx >= 0) {
    const raw = (comments[lastIdx].comment ?? '').trim();
    return /^Prompt used:/i.test(raw) ? raw.replace(/^Prompt used:\s*/i, '').trim() : raw;
  }
  return 'No prompt recorded.';
}

const TEACHER_PATTERNS = [
  'instructor',
  'administrator',
  'faculty',
  'teacher',
  'staff',
  'contentdeveloper',
  'teachingassistant',
  'ta',
];

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  return TEACHER_PATTERNS.some((p) => roles.toLowerCase().includes(p));
}

interface TeacherViewerPageProps {
  context: LtiContext | null;
}

type RubricCriterion = {
  id?: string;
  description?: string;
  points?: number;
  ratings?: Array<{ id?: string; description?: string; points?: number }>;
};

type RubricCriterionDraft = {
  rating_id?: string;
  points?: number;
  comments?: string;
};

function parseRubricAssessmentToDraft(
  raw: Record<string, unknown> | undefined,
  rubricList: RubricCriterion[],
): Record<string, RubricCriterionDraft> {
  const out: Record<string, RubricCriterionDraft> = {};
  rubricList.forEach((c, idx) => {
    const critId = String(c.id ?? idx);
    const v = raw?.[critId] ?? raw?.[String(c.id)];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const rid = o.rating_id;
      const pts = o.points;
      const com = o.comments;
      const entry: RubricCriterionDraft = {
        rating_id: rid != null ? String(rid) : undefined,
        points: pts != null ? Number(pts) : undefined,
      };
      if (typeof com === 'string') entry.comments = com;
      else if (com != null) entry.comments = String(com);
      out[critId] = entry;
    } else {
      out[critId] = {};
    }
  });
  return out;
}

/**
 * Build Canvas rubric_assessment payload.
 * Include `comments` when the draft has a `comments` property (including empty string) so clearing the UI sends "" to Canvas.
 */
function buildRubricAssessmentPayload(
  rubricList: RubricCriterion[],
  draft: Record<string, RubricCriterionDraft>,
): Record<string, Record<string, unknown>> {
  const payload: Record<string, Record<string, unknown>> = {};
  rubricList.forEach((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    if (!d) return;
    const row: Record<string, unknown> = {};
    if (d.rating_id != null && d.points != null) {
      row.rating_id = d.rating_id;
      row.points = d.points;
    }
    if ('comments' in d) {
      row.comments = typeof d.comments === 'string' ? d.comments.trim() : '';
    }
    if (Object.keys(row).length > 0) payload[critId] = row;
  });
  return payload;
}
function rubricDraftHasPayload(rubricList: RubricCriterion[], draft: Record<string, RubricCriterionDraft>): boolean {
  return rubricList.some((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    if (!d) return false;
    if (d.rating_id != null && d.points != null) return true;
    return 'comments' in d;
  });
}

function rubricDraftHasAnyRating(rubricList: RubricCriterion[], draft: Record<string, RubricCriterionDraft>): boolean {
  return rubricList.some((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    return d?.rating_id != null && d.points != null;
  });
}

export default function TeacherViewerPage({ context }: TeacherViewerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [searchParams, setSearchParams] = useSearchParams();
  const assignmentIdFromUrl = searchParams.get('assignmentId') ?? '';
  const gradingFromUrl = searchParams.get('grading') === '1';
  const ctxAssignmentId = resolveLtiContextValue(context?.assignmentId);
  const assignmentId = (ctxAssignmentId || assignmentIdFromUrl.trim()) || null;

  const [submissions, setSubmissions] = useState<promptApi.PromptSubmission[]>([]);
  const [submissionCount, setSubmissionCount] = useState<number | null>(null);
  const [assignment, setAssignment] = useState<{ pointsPossible?: number; rubric?: Array<unknown> } | null>(null);
  const [mySubmission, setMySubmission] = useState<promptApi.PromptSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [gradeValue, setGradeValue] = useState('');
  const [gradeSaveStatus, setGradeSaveStatus] = useState('');
  const [rubricSaveStatus, setRubricSaveStatus] = useState('');
  const [resetStatus, setResetStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [rubricDraft, setRubricDraft] = useState<Record<string, RubricCriterionDraft>>({});
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const rightSidebarRef = useRef<HTMLDivElement>(null);
  const [textPromptVisible, setTextPromptVisible] = useState(false);

  const isDev = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const teacher = context && isTeacher(context.roles);
  /* Teachers with assignmentId are treated as grading mode even without grading=1 (e.g. Config "Open for Grading" or direct link). */
  const gradingMode = teacher && (gradingFromUrl || !!assignmentId);
  const current = gradingMode ? submissions[index] : mySubmission;
  const pointsPossible = assignment?.pointsPossible ?? 100;
  const rubric = useMemo(() => (assignment?.rubric ?? []) as RubricCriterion[], [assignment?.rubric]);
  const currentAttempt = current?.attempt ?? 1;
  const rubricAssessment = (current?.rubricAssessment ?? {}) as Record<string, { rating_id?: string; points?: number; comments?: string }>;

  const syncFeedbackFromCurrent = useCallback(() => {
    if (!current?.submissionComments) {
      setFeedbackEntries([]);
      return;
    }
    setFeedbackEntries(parseTimestampedFeedback(current.submissionComments));
  }, [current?.submissionComments]);

  useEffect(() => { syncFeedbackFromCurrent(); }, [syncFeedbackFromCurrent]);

  useEffect(() => {
    setVideoLoadFailed(false);
  }, [current?.userId]);

  useEffect(() => {
    if (!current) return;
    setRubricDraft(parseRubricAssessmentToDraft(current.rubricAssessment as Record<string, unknown> | undefined, rubric));
  }, [current?.userId, current?.rubricAssessment, rubric]);

  const loadTeacher = useCallback(async () => {
    if (!teacher || !assignmentId) return;
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/submissions');
      const [subs, assign, count] = await Promise.all([
        promptApi.getSubmissions(assignmentId),
        promptApi.getAssignment(assignmentId),
        promptApi.getSubmissionCount(assignmentId),
      ]);
      setLastApiResult('GET /api/prompt/submissions', 200, true);
      const subsList = Array.isArray(subs) ? subs : [];
      setSubmissions(subsList);
      if (isDev && subsList.length > 0) {
        console.log('[TeacherViewer] getSubmissions result', {
          total: subsList.length,
          withVideoUrl: subsList.filter((s) => !!s.videoUrl).length,
        });
      }
      setAssignment(assign ?? null);
      setSubmissionCount(count ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/submissions', 0, String(e));
    } finally {
      setLoading(false);
    }
  }, [teacher, assignmentId, setLastFunction, setLastApiResult, setLastApiError]);

  const loadStudent = useCallback(async () => {
    if (!assignmentId || !context) return;
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/my-submission');
      const [sub, assign] = await Promise.all([
        promptApi.getMySubmission(assignmentId),
        promptApi.getAssignmentForViewer(assignmentId),
      ]);
      setLastApiResult('GET /api/prompt/my-submission', 200, true);
      setMySubmission(sub ?? null);
      setAssignment(assign ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/my-submission', 0, String(e));
    } finally {
      setLoading(false);
    }
  }, [assignmentId, context, setLastFunction, setLastApiResult, setLastApiError]);

  const loadConfiguredAssignments = useCallback(async () => {
    if (!teacher || !context?.courseId) {
      console.log('[TeacherViewer] loadConfiguredAssignments SKIPPED', { teacher: !!teacher, courseId: context?.courseId });
      return;
    }
    console.log('[TeacherViewer] loadConfiguredAssignments CALLING /api/prompt/configured-assignments');
    setLoadingAssignments(true);
    try {
      setLastFunction('GET /api/prompt/configured-assignments');
      const list = await promptApi.getConfiguredAssignments();
      setLastApiResult('GET /api/prompt/configured-assignments', 200, true);
      setConfiguredAssignments(list ?? []);
    } catch {
      setConfiguredAssignments([]);
    } finally {
      setLoadingAssignments(false);
    }
  }, [teacher, context?.courseId, setLastFunction, setLastApiResult]);

  useEffect(() => {
    if (teacher && !assignmentId) loadConfiguredAssignments();
  }, [teacher, assignmentId, loadConfiguredAssignments]);

  useEffect(() => {
    if (gradingMode) loadTeacher();
    else if (assignmentId && context) loadStudent();
    else setLoading(false);
  }, [gradingMode, assignmentId, context, loadTeacher, loadStudent]);

  useEffect(() => {
    if (current?.grade != null) setGradeValue(String(current.grade));
    else if (current?.score != null) setGradeValue(String(current.score));
    else setGradeValue('');
  }, [current]);

  const reloadCurrent = useCallback(async () => {
    if (gradingMode) await loadTeacher();
    else await loadStudent();
  }, [gradingMode, loadTeacher, loadStudent]);

  const persistRubricAssessment = useCallback(
    async (draft: Record<string, RubricCriterionDraft>) => {
      if (!teacher || !current || !assignmentId) return;
      const payload = buildRubricAssessmentPayload(rubric, draft);
      if (Object.keys(payload).length === 0) return;
      setSaving(true);
      setRubricSaveStatus('');
      try {
        setLastFunction('POST /api/prompt/grade');
        await promptApi.submitGrade(
          { userId: current.userId, score: 0, scoreMaximum: pointsPossible, rubricAssessment: payload },
          assignmentId
        );
        setLastApiResult('POST /api/prompt/grade', 200, true);
        setRubricSaveStatus('Saved.');
        setTimeout(() => setRubricSaveStatus(''), 2000);
        setSubmissions((prev) =>
          prev.map((s, i) => {
            if (i !== index) return s;
            const prevRa = (s.rubricAssessment ?? {}) as Record<string, Record<string, unknown>>;
            const merged: Record<string, unknown> = { ...prevRa };
            for (const [critId, row] of Object.entries(payload)) {
              merged[critId] = { ...(typeof merged[critId] === 'object' && merged[critId] ? (merged[critId] as object) : {}), ...row };
            }
            return { ...s, rubricAssessment: merged };
          })
        );
      } catch {
        setRubricSaveStatus('Failed');
      } finally {
        setSaving(false);
      }
    },
    [teacher, current, assignmentId, pointsPossible, index, rubric, setLastFunction, setLastApiResult]
  );

  const handleGrade = async () => {
    if (!current || !assignmentId) return;
    const score = parseFloat(gradeValue);
    if (Number.isNaN(score)) return;
    setSaving(true);
    setGradeSaveStatus('');
    setError(null);
    try {
      setLastFunction('POST /api/prompt/grade');
      await promptApi.submitGrade(
        { userId: current.userId, score, scoreMaximum: pointsPossible },
        assignmentId
      );
      setLastApiResult('POST /api/prompt/grade', 200, true);
      setGradeSaveStatus('Saved.');
      setTimeout(() => setGradeSaveStatus(''), 2000);
      setSubmissions((prev) =>
        prev.map((s, i) => (i === index ? { ...s, score, grade: gradeValue } : s))
      );
    } catch (e) {
      setGradeSaveStatus('Failed');
      setError(e instanceof Error ? e.message : 'Grade failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRubricRatingClick = useCallback(
    (criterionId: string, ratingId: string, points: number) => {
      if (!teacher || !current || !assignmentId) return;
      setRubricDraft((prev) => {
        const prior = prev[criterionId] ?? {};
        const wasSelected = prior.rating_id === ratingId;
        const nextEntry: RubricCriterionDraft = wasSelected
          ? { ...prior, rating_id: undefined, points: undefined }
          : { ...prior, rating_id: ratingId, points };
        const nextDraft = { ...prev, [criterionId]: nextEntry };
        if (rubricDraftHasAnyRating(rubric, nextDraft)) {
          void persistRubricAssessment(nextDraft);
        }
        return nextDraft;
      });
    },
    [teacher, current, assignmentId, rubric, persistRubricAssessment]
  );

  const handleSaveRubricCriterionComment = useCallback(
    (criterionId: string, comments: string) => {
      if (!teacher || !current || !assignmentId) return;
      setRubricDraft((prev) => {
        const nextDraft = { ...prev, [criterionId]: { ...(prev[criterionId] ?? {}), comments } };
        if (rubricDraftHasPayload(rubric, nextDraft)) {
          void persistRubricAssessment(nextDraft);
        }
        return nextDraft;
      });
    },
    [teacher, current, assignmentId, rubric, persistRubricAssessment]
  );

  const handleReset = async () => {
    if (!current || !assignmentId) return;
    if (!window.confirm("Reset this student's attempt? They will need to enter the access code again and can submit a new attempt.")) return;
    setSaving(true);
    setResetStatus('');
    setError(null);
    try {
      setLastFunction('POST /api/prompt/reset-attempt');
      await promptApi.resetAttempt(current.userId, assignmentId);
      setLastApiResult('POST /api/prompt/reset-attempt', 200, true);
      setResetStatus("Reset. Student must use access code to try again.");
    } catch (e) {
      setResetStatus('Failed');
    } finally {
      setSaving(false);
    }
  };

  const handleAddComment = useCallback(async () => {
    const text = commentText.trim();
    if (!text || !current || !assignmentId || !videoRef.current) return;
    const timeSec = Math.floor(videoRef.current.currentTime);
    setSaving(true);
    try {
      setLastFunction('POST /api/prompt/comment/add');
      const res = await promptApi.addComment(current.userId, timeSec, text, currentAttempt, assignmentId);
      setLastApiResult('POST /api/prompt/comment/add', 200, true);
      setCommentText('');
      const newEntry = { id: res?.commentId ?? 0, time: timeSec, text };
      setFeedbackEntries((prev) => {
        const next = [...prev, newEntry];
        next.sort((a, b) => a.time - b.time);
        return next;
      });
      const newComment = { id: res?.commentId ?? 0, comment: `[${Math.floor(timeSec / 60)}:${timeSec % 60 < 10 ? '0' : ''}${timeSec % 60}] ${text}` };
      setSubmissions((prev) =>
        prev.map((s, i) =>
          i === index
            ? { ...s, submissionComments: [...(s.submissionComments ?? []), newComment] }
            : s
        )
      );
      videoRef.current.play().catch(() => {});
    } catch {
      setError('Failed to add comment');
    } finally {
      setSaving(false);
    }
  }, [commentText, current, assignmentId, currentAttempt, index, setLastFunction, setLastApiResult]);

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const v = videoRef.current;
      if (v && !v.paused) v.pause();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAddComment();
      }
    },
    [handleAddComment]
  );

  const handleFeedbackClick = useCallback((time: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = time;
      v.play().catch(() => {});
    }
  }, []);

  const handleDeckTimelineClick = useCallback((startSec: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = startSec;
      v.play().catch(() => {});
    }
  }, []);

  const handleEditComment = useCallback(
    async (entry: FeedbackEntry) => {
      const newText = window.prompt('Edit comment:', entry.text);
      if (newText == null || newText.trim() === '') return;
      if (!current || !assignmentId) return;
      try {
        await promptApi.editComment(current.userId, String(entry.id), entry.time, newText.trim(), assignmentId);
        setFeedbackEntries((prev) =>
          prev.map((f) => (f.id === entry.id ? { ...f, text: newText.trim() } : f)).sort((a, b) => a.time - b.time)
        );
        const timeLabel = `[${Math.floor(entry.time / 60)}:${entry.time % 60 < 10 ? '0' : ''}${entry.time % 60}] `;
        setSubmissions((prev) =>
          prev.map((s, i) =>
            i === index
              ? {
                  ...s,
                  submissionComments: (s.submissionComments ?? []).map((c) =>
                    c.id === entry.id ? { ...c, comment: timeLabel + newText.trim() } : c
                  ),
                }
              : s
          )
        );
      } catch {
        setError('Failed to edit comment');
      }
    },
    [current, assignmentId, index]
  );

  const handleDeleteComment = useCallback(
    async (entry: FeedbackEntry) => {
      if (!window.confirm('Delete this comment?')) return;
      if (!current || !assignmentId) return;
      try {
        await promptApi.deleteComment(current.userId, String(entry.id), assignmentId);
        setFeedbackEntries((prev) => prev.filter((f) => f.id !== entry.id));
        setSubmissions((prev) =>
          prev.map((s, i) =>
            i === index
              ? { ...s, submissionComments: (s.submissionComments ?? []).filter((c) => c.id !== entry.id) }
              : s
          )
        );
      } catch {
        setError('Failed to delete comment');
      }
    },
    [current, assignmentId, index]
  );

  const handleStudentSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const uid = e.target.value;
    if (!uid) return;
    const idx = submissions.findIndex((s) => s.userId === uid);
    if (idx >= 0) setIndex(idx);
  };

  const [currentTime, setCurrentTime] = useState(0);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    v.addEventListener('timeupdate', onTimeUpdate);
    return () => v.removeEventListener('timeupdate', onTimeUpdate);
  }, [current]);

  const activeFeedback = feedbackEntries.filter((f) => Math.abs(currentTime - f.time) <= 2);
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const deckTimeline = useMemo(
    () => resolveDeckTimeline(current?.body, current?.submissionComments),
    [current?.body, current?.submissionComments],
  );
  const isDeckPromptMode = deckTimeline.length > 0;
  const isTextPromptMode = !isDeckPromptMode;
  const activeDeckPrompt = useMemo(
    () => activeDeckPromptAt(currentTime, deckTimeline),
    [currentTime, deckTimeline],
  );
  const activeDeckIndex = useMemo(() => {
    if (!activeDeckPrompt) return -1;
    return deckTimeline.findIndex(
      (s) => s.startSec === activeDeckPrompt.startSec && s.title === activeDeckPrompt.title,
    );
  }, [activeDeckPrompt, deckTimeline]);

  const rubricPromptIndexMap = useMemo(
    () =>
      rubric.map((criterion, idx) =>
        rubricCriterionDeckIndex(criterion, idx, rubric.length, deckTimeline.length),
      ),
    [rubric, deckTimeline],
  );

  const resolvedRubricDeckIndexMap = useMemo(
    () =>
      rubricPromptIndexMap.map((mapped, idx) => {
        if (mapped != null && mapped >= 0 && mapped < deckTimeline.length) return mapped;
        if (idx >= 0 && idx < deckTimeline.length) return idx;
        return null;
      }),
    [rubricPromptIndexMap, deckTimeline.length],
  );

  const feedbackByDeckRubricRow = useMemo(() => {
    const byDeckIndex = new Map<number, FeedbackEntry[]>();
    for (const entry of feedbackEntries) {
      for (let i = 0; i < deckTimeline.length; i++) {
        const start = deckTimeline[i].startSec;
        const nextStart = i + 1 < deckTimeline.length ? deckTimeline[i + 1].startSec : Infinity;
        if (entry.time >= start && entry.time < nextStart) {
          const list = byDeckIndex.get(i) ?? [];
          list.push(entry);
          byDeckIndex.set(i, list);
          break;
        }
      }
    }
    const out = new Map<number, FeedbackEntry[]>();
    resolvedRubricDeckIndexMap.forEach((deckIdx, rowIdx) => {
      if (deckIdx == null) {
        out.set(rowIdx, []);
        return;
      }
      out.set(rowIdx, [...(byDeckIndex.get(deckIdx) ?? [])].sort((a, b) => a.time - b.time));
    });
    return out;
  }, [feedbackEntries, deckTimeline, resolvedRubricDeckIndexMap]);

  const activeDeckRubricRowIndex = useMemo(() => {
    if (activeDeckIndex < 0) return -1;
    return resolvedRubricDeckIndexMap.findIndex((idx) => idx === activeDeckIndex);
  }, [activeDeckIndex, resolvedRubricDeckIndexMap]);

  useEffect(() => {
    if (isDeckPromptMode) setTextPromptVisible(false);
  }, [isDeckPromptMode]);

  useEffect(() => {
    const layout = document.getElementById('viewer-layout');
    const leftSidebar = leftSidebarRef.current;
    const rightSidebar = rightSidebarRef.current;
    const handleLeft = document.getElementById('resize-handle-left');
    const handleRight = document.getElementById('resize-handle-right');
    if (!layout || !leftSidebar || !handleLeft) return;
    const minW = 160;
    const maxW = 400;
    const keyL = 'aslexpress_viewer_left_width';
    const keyR = 'aslexpress_viewer_right_width';
    const setLeft = (w: number) => {
      const ww = Math.max(minW, Math.min(maxW, w));
      leftSidebar.style.flex = `0 0 ${ww}px`;
      try {
        localStorage.setItem(keyL, String(ww));
      } catch {
        //
      }
    };
    const setRight = (w: number) => {
      if (!rightSidebar) return;
      const ww = Math.max(minW, Math.min(maxW, w));
      rightSidebar.style.flex = `0 0 ${ww}px`;
      try {
        localStorage.setItem(keyR, String(ww));
      } catch {
        //
      }
    };
    try {
      const sl = localStorage.getItem(keyL);
      const sr = localStorage.getItem(keyR);
      if (sl) {
        const w = parseFloat(sl);
        if (!Number.isNaN(w)) setLeft(w);
      }
      if (sr && rightSidebar) {
        const w = parseFloat(sr);
        if (!Number.isNaN(w)) setRight(w);
      }
    } catch {
      //
    }
    const setupHandle = (
      handle: HTMLElement,
      col: HTMLElement,
      setW: (w: number) => void,
      invert: boolean
    ) => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = col.offsetWidth;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        const onMove = (ev: MouseEvent) => {
          const dx = invert ? startX - ev.clientX : ev.clientX - startX;
          setW(startW + dx);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    };
    setupHandle(handleLeft, leftSidebar, setLeft, false);
    if (handleRight && rightSidebar) {
      setupHandle(handleRight, rightSidebar, setRight, true);
    }
  }, [loading, textPromptVisible]);

  if (!context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Launch from Canvas to continue.</p>
        </div>
      </div>
    );
  }

  if (!assignmentId) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>{teacher ? 'Grade Submissions' : 'Video Viewer'}</h1>
          {teacher ? (
            <>
              <p className="prompter-info-message prompter-viewer-select-prompt">Select an assignment to grade submissions.</p>
              {loadingAssignments ? (
                <p className="prompter-info-message">Loading assignments...</p>
              ) : configuredAssignments.length === 0 ? (
                <p className="prompter-info-message">No configured assignments in this course.</p>
              ) : (
                <div className="prompter-viewer-dropdown-row prompter-viewer-assignment-select-wrap">
                  <label htmlFor="assignment-select">Assignment:</label>
                  <select
                    id="assignment-select"
                    onChange={(e) => {
                      const id = e.target.value?.trim();
                      if (id) setSearchParams({ assignmentId: id, grading: '1' });
                    }}
                    defaultValue=""
                  >
                    <option value="">— Select assignment —</option>
                    {configuredAssignments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.submissionCount} submissions)
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ) : (
            <p className="prompter-info-message">Open this page with ?assignmentId=... in the assignment comments.</p>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading...</p>
        </div>
      </div>
    );
  }

  if (!gradingMode && !mySubmission) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>View Submission</h1>
          <p className="prompter-info-message">No submission found for this assignment.</p>
        </div>
      </div>
    );
  }

  const promptUsed = getPromptFromComments(current?.body, current?.submissionComments, current?.promptHtml);
  const hasSubmissionNoVideo = current && !current.videoUrl;
  const noSubmissionsInGradingMode = gradingMode && submissions.length === 0;

  return (
    <div className="prompter-page prompter-page--viewer">
      <div className="prompter-viewer-layout" id="viewer-layout">
        <aside
          ref={leftSidebarRef}
          className="prompter-viewer-sidebar"
          id="viewer-sidebar-left"
        >
          {rubric.length > 0 && (
            <div className="prompter-viewer-rubric-container">
              <div className="prompter-viewer-feedback-title">Rubric</div>
              {isDeckPromptMode ? (
                <table className="prompter-viewer-rubric-table">
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Prompt</th>
                        <th>Rating</th>
                        <th>Feedback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rubric.map((c, rowIdx) => {
                        const critId = String(c.id ?? rowIdx);
                        const assess = rubricAssessment[critId] ?? rubricAssessment[String(c.id)];
                        const mappedDeckIdx = resolvedRubricDeckIndexMap[rowIdx];
                        const mappedDeckPrompt = mappedDeckIdx != null ? deckTimeline[mappedDeckIdx] : undefined;
                        const mappedDeckActive = mappedDeckIdx != null && mappedDeckIdx === activeDeckIndex;
                        const rowFeedback = feedbackByDeckRubricRow.get(rowIdx) ?? [];
                        const selectedRatingId = rubricDraft[critId]?.rating_id ?? assess?.rating_id;
                        return (
                          <Fragment key={critId}>
                            <tr
                              className={`prompter-viewer-rubric-row ${mappedDeckPrompt ? 'clickable' : ''} ${mappedDeckActive ? 'active' : ''}`}
                              onClick={() => mappedDeckPrompt && handleDeckTimelineClick(mappedDeckPrompt.startSec)}
                              onKeyDown={(e) => {
                                if (mappedDeckPrompt && e.key === 'Enter') handleDeckTimelineClick(mappedDeckPrompt.startSec);
                              }}
                              tabIndex={mappedDeckPrompt ? 0 : undefined}
                            >
                              <td>{mappedDeckPrompt ? formatTime(Math.floor(mappedDeckPrompt.startSec)) : '—'}</td>
                              <td>
                                <div
                                  className="prompter-viewer-rubric-card-prompt-text"
                                  dangerouslySetInnerHTML={{ __html: mappedDeckPrompt?.title || (c.description ?? 'Criterion') }}
                                />
                              </td>
                              <td>
                                <div className="prompter-viewer-rubric-ratings">
                                  {c.ratings?.map((r) => {
                                    const rid = String(r.id ?? '');
                                    const pts = r.points ?? 0;
                                    const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                                    return (
                                      <button
                                        key={rid}
                                        type="button"
                                        className={`prompter-viewer-rubric-rating ${isSelected ? 'selected' : ''}`}
                                        disabled={!teacher}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          teacher && handleRubricRatingClick(critId, rid, pts);
                                        }}
                                      >
                                        {r.description ?? ''} ({pts} pts)
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                              <td>{rowFeedback.length === 0 ? <span className="prompter-viewer-feedback-empty-inline">No feedback</span> : null}</td>
                            </tr>
                            {rowFeedback.map((f) => (
                              <tr key={`deck-fb-${critId}-${f.id}`} className="prompter-viewer-rubric-feedback-row">
                                <td colSpan={3} />
                                <td>
                                  <span className="prompter-viewer-feedback-time-label">{formatTime(f.time)}</span>{' '}
                                  <button type="button" className="prompter-viewer-feedback-seek-btn" onClick={() => handleFeedbackClick(f.time)}>
                                    {f.text || '—'}
                                  </button>
                                  {teacher && (
                                    <div className="prompter-viewer-comment-actions">
                                      <button type="button" className="prompter-viewer-comment-action-btn" onClick={() => handleEditComment(f)}>
                                        Edit
                                      </button>
                                      <button type="button" className="prompter-viewer-comment-action-btn danger" onClick={() => handleDeleteComment(f)}>
                                        Delete
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                </table>
              ) : (
                <div className="prompter-viewer-text-left-split">
                    <div className="prompter-viewer-text-rubric-col">
                      <table className="prompter-viewer-rubric-table prompter-viewer-rubric-table--text-canvas">
                        <thead>
                          <tr>
                            <th>Criterion</th>
                            <th>Rating &amp; comment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rubric.map((c, rowIdx) => {
                            const critId = String(c.id ?? rowIdx);
                            const assess = rubricAssessment[critId] ?? rubricAssessment[String(c.id)];
                            const selectedRatingId = rubricDraft[critId]?.rating_id ?? assess?.rating_id;
                            const commentVal = rubricDraft[critId]?.comments ?? '';
                            return (
                              <tr key={`text-${critId}`} className="prompter-viewer-rubric-row">
                                <td>
                                  <div className="prompter-viewer-canvas-criterion-desc">
                                    {c.description ?? 'Criterion'}{' '}
                                    <span className="prompter-viewer-criterion-pts">({c.points ?? 0} pts)</span>
                                  </div>
                                </td>
                                <td>
                                  <div className="prompter-viewer-rubric-ratings">
                                    {c.ratings?.map((r) => {
                                      const rid = String(r.id ?? '');
                                      const pts = r.points ?? 0;
                                      const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                                      return (
                                        <button
                                          key={rid}
                                          type="button"
                                          className={`prompter-viewer-rubric-rating ${isSelected ? 'selected' : ''}`}
                                          disabled={!teacher}
                                          onClick={() => teacher && handleRubricRatingClick(critId, rid, pts)}
                                        >
                                          {r.description ?? ''} ({pts} pts)
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <div className="prompter-viewer-criterion-comment-wrap">
                                    <label className="prompter-viewer-criterion-comment-label" htmlFor={`rubric-comment-${critId}`}>
                                      Criterion comment
                                    </label>
                                    <textarea
                                      id={`rubric-comment-${critId}`}
                                      className="prompter-viewer-criterion-comment-textarea"
                                      rows={2}
                                      value={commentVal}
                                      onChange={(e) =>
                                        setRubricDraft((prev) => ({
                                          ...prev,
                                          [critId]: { ...(prev[critId] ?? {}), comments: e.target.value },
                                        }))
                                      }
                                      disabled={!teacher}
                                      placeholder="Optional — saved to Canvas rubric for this row"
                                    />
                                    {teacher && (
                                      <button
                                        type="button"
                                        className="prompter-viewer-criterion-comment-save prompter-viewer-grade-btn"
                                        onClick={() => handleSaveRubricCriterionComment(critId, rubricDraft[critId]?.comments ?? '')}
                                      >
                                        Save comment
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="prompter-viewer-text-timestamped-col">
                      <div className="prompter-viewer-feedback-title">Timestamped feedback</div>
                      <table className="prompter-viewer-timestamped-feedback-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Feedback</th>
                          </tr>
                        </thead>
                        <tbody>
                          {feedbackEntries.length === 0 ? (
                            <tr>
                              <td colSpan={2}>
                                <span className="prompter-viewer-feedback-empty-inline">No timestamped feedback</span>
                              </td>
                            </tr>
                          ) : (
                            feedbackEntries.map((f) => (
                              <tr key={`ts-${f.id}`}>
                                <td className="prompter-viewer-timestamped-time-cell">{formatTime(f.time)}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="prompter-viewer-feedback-seek-btn"
                                    onClick={() => handleFeedbackClick(f.time)}
                                  >
                                    {f.text || '—'}
                                  </button>
                                  {teacher && (
                                    <div className="prompter-viewer-comment-actions">
                                      <button
                                        type="button"
                                        className="prompter-viewer-comment-action-btn"
                                        onClick={() => handleEditComment(f)}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        className="prompter-viewer-comment-action-btn danger"
                                        onClick={() => handleDeleteComment(f)}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
              )}
              {teacher && rubricSaveStatus && (
                <span className="prompter-viewer-rubric-save-status">{rubricSaveStatus}</span>
              )}
            </div>
          )}
        </aside>
        <div className="prompter-viewer-resize-handle" id="resize-handle-left" title="Drag to resize" />
        <main className="prompter-viewer-center" id="viewer-center">
          {error && <div className="prompter-viewer-error-box">{error}</div>}
          {noSubmissionsInGradingMode && (
            <div className="prompter-viewer-no-submissions">
              <p className="prompter-info-message">No submissions yet for this assignment.</p>
              <button
                type="button"
                className="prompter-viewer-grade-btn"
                onClick={() => setSearchParams({ grading: '1' })}
              >
                Change assignment
              </button>
            </div>
          )}
          {gradingMode && submissions.length > 0 && (
            <>
              <div className="prompter-viewer-dropdown-row">
                <label htmlFor="submission-select">Submission:</label>
                <select
                  id="submission-select"
                  value={current?.userId ?? ''}
                  onChange={handleStudentSelect}
                >
                  <option value="">— Select student —</option>
                  {submissions.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.userName ?? s.userId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="prompter-viewer-nav-row">
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index <= 0}
                  className={`prompter-viewer-nav-btn ${index <= 0 ? 'disabled' : ''}`}
                >
                  ← Previous
                </button>
                <span className="prompter-viewer-nav-index">
                  {index + 1} of {submissions.length}
                </span>
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.min(submissions.length - 1, i + 1))}
                  disabled={index >= submissions.length - 1}
                  className={`prompter-viewer-nav-btn ${index >= submissions.length - 1 ? 'disabled' : ''}`}
                >
                  Next →
                </button>
              </div>
            </>
          )}
          {gradingMode && current && pointsPossible != null && (
            <div className="prompter-viewer-grade-row-full">
              <label htmlFor="grade-input">Grade:</label>
              <input
                id="grade-input"
                type="number"
                min={0}
                max={pointsPossible > 0 ? pointsPossible : undefined}
                step="any"
                value={gradeValue}
                onChange={(e) => setGradeValue(e.target.value)}
                placeholder="0"
              />
              <span className="prompter-viewer-points-label">/ {Math.round(pointsPossible)} pts</span>
              <button type="button" onClick={handleGrade} disabled={saving} className="prompter-viewer-grade-btn">
                Save grade
              </button>
              {gradeSaveStatus && <span className="prompter-viewer-save-status">{gradeSaveStatus}</span>}
            </div>
          )}
          {gradingMode && current && (
            <div className="prompter-viewer-reset-row">
              <button
                type="button"
                onClick={handleReset}
                disabled={saving}
                className="prompter-viewer-reset-btn"
              >
                Reset student&apos;s attempt
              </button>
              {resetStatus && <span className="prompter-viewer-reset-status">{resetStatus}</span>}
            </div>
          )}
          <div className="prompter-viewer-video-wrap">
            {noSubmissionsInGradingMode ? (
              <p className="prompter-viewer-no-video">No submissions for this assignment.</p>
            ) : current?.videoUrl ? (
              <video
                ref={videoRef}
                src={current.videoUrl}
                controls
                onError={() => setVideoLoadFailed(true)}
              />
            ) : hasSubmissionNoVideo ? (
              <div className="prompter-viewer-processing">
                <p>Your submission is being processed. Video will appear shortly. Refresh the page to check.</p>
              </div>
            ) : (
              <p className="prompter-viewer-no-video">No video</p>
            )}
          </div>
          {isDeckPromptMode && activeDeckPrompt && (
            <div className="prompter-viewer-now-playing prompter-viewer-now-playing-below">
              <span>
                <strong>{formatTime(Math.floor(activeDeckPrompt.startSec))}</strong>
                {' — '}
              </span>
              <span dangerouslySetInnerHTML={{ __html: activeDeckPrompt.title || '—' }} />
            </div>
          )}
          {isDeckPromptMode && activeDeckRubricRowIndex >= 0 && rubric[activeDeckRubricRowIndex] && (
            <div className="prompter-viewer-center-rubric-controls">
              <div className="prompter-viewer-feedback-title">Active rubric scoring</div>
              <div className="prompter-viewer-rubric-ratings">
                {rubric[activeDeckRubricRowIndex].ratings?.map((r) => {
                  const c = rubric[activeDeckRubricRowIndex];
                  const critId = String(c.id ?? activeDeckRubricRowIndex);
                  const selectedRatingId =
                    rubricDraft[critId]?.rating_id ?? (rubricAssessment[critId] ?? rubricAssessment[String(c.id)])?.rating_id;
                  const rid = String(r.id ?? '');
                  const pts = r.points ?? 0;
                  const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                  return (
                    <button
                      key={`active-${rid}`}
                      type="button"
                      className={`prompter-viewer-rubric-rating ${isSelected ? 'selected' : ''}`}
                      disabled={!teacher}
                      onClick={() => teacher && handleRubricRatingClick(critId, rid, pts)}
                    >
                      {r.description ?? ''} ({pts} pts)
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {isTextPromptMode && (
            <div className="prompter-viewer-text-toggle-row">
              <button
                type="button"
                className="prompter-viewer-grade-btn"
                onClick={() => setTextPromptVisible((v) => !v)}
              >
                {textPromptVisible ? 'Hide Prompt' : 'Show Prompt'}
              </button>
            </div>
          )}
          {activeFeedback.length > 0 && (
            <div className="prompter-viewer-now-playing prompter-viewer-now-playing-below">
              {activeFeedback.map((f) => (
                <span key={f.id}>
                  <strong>{formatTime(f.time)}</strong>: {f.text}{' '}
                </span>
              ))}
            </div>
          )}
          {teacher && !noSubmissionsInGradingMode && (
            <div className="prompter-viewer-textarea-wrap">
              <textarea
                id="comment"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={handleCommentKeyDown}
                placeholder="Type feedback and press Enter to add at current time..."
              />
            </div>
          )}
        </main>
        {isTextPromptMode && textPromptVisible && (
          <>
            <div className="prompter-viewer-resize-handle" id="resize-handle-right" title="Drag to resize" />
            <aside
              ref={rightSidebarRef}
              className="prompter-viewer-sidebar prompter-viewer-sidebar-right"
              id="viewer-sidebar-right"
            >
              <div className="prompter-viewer-right-prompt-sticky">
                <div className="prompter-viewer-prompt-label">Prompt</div>
                <div
                  className="prompter-viewer-prompt-content-block"
                  dangerouslySetInnerHTML={{ __html: promptUsed }}
                />
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
