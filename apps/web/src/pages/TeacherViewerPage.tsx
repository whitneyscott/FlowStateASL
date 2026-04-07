import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function parseDeckTimelineFromBody(body: string | undefined): DeckTimelineEntry[] {
  if (!body?.trim()) return [];
  try {
    const parsed = JSON.parse(body) as { deckTimeline?: unknown };
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
  } catch {
    return [];
  }
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

/** Build SproutVideo embed HTML the same way as FlashcardsPage (iframe with sproutvideo-player class). */
function buildSproutVideoEmbedHtml(embedUrl: string): string {
  const src = embedUrl.replace(/"/g, '&quot;');
  return `<iframe src="${src}" class="sproutvideo-player" width="640" height="360" frameborder="0" allowfullscreen></iframe>`;
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
  const [selectedRubric, setSelectedRubric] = useState<Record<string, { ratingId: string; points: number }>>({});
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const rightSidebarRef = useRef<HTMLDivElement>(null);

  const isDev = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const teacher = context && isTeacher(context.roles);
  /* Teachers with assignmentId are treated as grading mode even without grading=1 (e.g. Config "Open for Grading" or direct link). */
  const gradingMode = teacher && (gradingFromUrl || !!assignmentId);
  const current = gradingMode ? submissions[index] : mySubmission;
  const pointsPossible = assignment?.pointsPossible ?? 100;
  const rubric = (assignment?.rubric ?? []) as RubricCriterion[];
  const currentAttempt = current?.attempt ?? 1;
  const rubricAssessment = (current?.rubricAssessment ?? {}) as Record<string, { rating_id?: string; points?: number }>;

  const syncFeedbackFromCurrent = useCallback(() => {
    if (!current?.submissionComments) return;
    setFeedbackEntries(parseTimestampedFeedback(current.submissionComments));
  }, [current?.submissionComments]);

  useEffect(() => { syncFeedbackFromCurrent(); }, [syncFeedbackFromCurrent]);

  useEffect(() => {
    setVideoLoadFailed(false);
  }, [current?.userId]);

  useEffect(() => {
    if (isDev && current?.userId && (current as promptApi.PromptSubmission).fallbackVideoUrl) {
      console.log('[TeacherViewer] Showing SproutVideo fallback for this submission', {
        userId: current.userId,
        userName: current.userName,
        fallbackVideoUrlPreview: ((current as promptApi.PromptSubmission).fallbackVideoUrl ?? '').slice(0, 70) + '...',
      });
    }
  }, [current?.userId, (current as promptApi.PromptSubmission | undefined)?.fallbackVideoUrl]);

  useEffect(() => {
    if (!current) return;
    const raw = current?.rubricAssessment ?? {};
    const assess: Record<string, { ratingId: string; points: number }> = {};
    for (const [critId, v] of Object.entries(raw)) {
      const rid = (v as { rating_id?: string })?.rating_id;
      const pts = (v as { points?: number })?.points;
      if (rid != null && pts != null) assess[String(critId)] = { ratingId: String(rid), points: Number(pts) };
    }
    setSelectedRubric(assess);
  }, [current?.userId, current?.rubricAssessment]);

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
        const withFallback = subsList.filter((s) => (s as { fallbackVideoUrl?: string }).fallbackVideoUrl);
        console.log('[TeacherViewer] getSubmissions result', {
          total: subsList.length,
          withSproutVideoFallback: withFallback.length,
          fallbackByUser: withFallback.map((s) => ({ userId: s.userId, userName: s.userName, hasFallback: !!(s as { fallbackVideoUrl?: string }).fallbackVideoUrl })),
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
      const prev = selectedRubric[criterionId];
      const wasSelected = prev?.ratingId === ratingId;
      const nextSelected = { ...selectedRubric };
      if (wasSelected) {
        delete nextSelected[criterionId];
      } else {
        nextSelected[criterionId] = { ratingId, points };
      }
      setSelectedRubric(nextSelected);
      const assessment: Record<string, { rating_id: string; points: number }> = {};
      for (const [k, v] of Object.entries(nextSelected)) {
        if (v?.ratingId != null && v?.points != null) assessment[k] = { rating_id: v.ratingId, points: v.points };
      }
      if (Object.keys(assessment).length === 0) return;
      (async () => {
        setSaving(true);
        setRubricSaveStatus('');
        try {
          setLastFunction('POST /api/prompt/grade');
          await promptApi.submitGrade(
            { userId: current.userId, score: 0, scoreMaximum: pointsPossible, rubricAssessment: assessment },
            assignmentId
          );
          setRubricSaveStatus('Saved.');
          setTimeout(() => setRubricSaveStatus(''), 2000);
          const rubricUpdate = Object.fromEntries(
            Object.entries(assessment).map(([k, v]) => [k, { rating_id: v.rating_id, points: v.points }])
          );
          setSubmissions((prev) =>
            prev.map((s, i) =>
              i === index ? { ...s, rubricAssessment: rubricUpdate } : s
            )
          );
        } catch {
          setRubricSaveStatus('Failed');
        } finally {
          setSaving(false);
        }
      })();
    },
    [teacher, selectedRubric, current, assignmentId, pointsPossible, index, setLastFunction]
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

  // Log selected submission video state to Bridge Debug Log (dev only)
  useEffect(() => {
    if (!isDev || !gradingMode) return;
    const sub = current as promptApi.PromptSubmission | undefined;
    if (!sub) return;
    const hasVideoUrl = !!sub.videoUrl;
    const hasFallback = !!sub.fallbackVideoUrl;
    const noVideoButHasSubmission = sub && !sub.videoUrl;
    const showSprout =
      hasFallback && (isDev || videoLoadFailed || !sub.videoUrl);
    const displayPath = showSprout
      ? 'SproutVideo iframe'
      : hasVideoUrl
        ? 'video'
        : hasFallback
          ? 'SproutVideo iframe'
          : noVideoButHasSubmission
            ? 'processing'
            : 'no video';
    const message = `selected submission userId=${sub.userId} userName=${sub.userName ?? '(none)'} videoUrl=${hasVideoUrl ? 'yes' : 'no'} fallbackVideoUrl=${hasFallback ? 'yes' : 'no'} display=${displayPath}`;
    fetch('/api/debug/lti-log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).catch(() => {});
  }, [gradingMode, current, videoLoadFailed]);

  const activeFeedback = feedbackEntries.filter((f) => Math.abs(currentTime - f.time) <= 2);
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const deckTimeline = useMemo(() => parseDeckTimelineFromBody(current?.body), [current?.body]);
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

  useEffect(() => {
    const layout = document.getElementById('viewer-layout');
    const leftSidebar = leftSidebarRef.current;
    const rightSidebar = rightSidebarRef.current;
    const handleLeft = document.getElementById('resize-handle-left');
    const handleRight = document.getElementById('resize-handle-right');
    if (!layout || !leftSidebar || !rightSidebar || !handleLeft || !handleRight) return;
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
      if (sr) {
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
    setupHandle(handleRight, rightSidebar, setRight, true);
  }, [loading]);

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
          <div className="prompter-viewer-prompt-label">Prompt</div>
          <div
            className="prompter-viewer-prompt-content-block"
            dangerouslySetInnerHTML={{ __html: promptUsed }}
          />
          {rubric.length > 0 && (
            <div className="prompter-viewer-rubric-container">
              <div className="prompter-viewer-feedback-title">Rubric</div>
              {rubric.map((c) => {
                const critId = String(c.id ?? '');
                const assess = rubricAssessment[critId] ?? rubricAssessment[String(c.id)];
                const selectedRatingId = assess?.rating_id;
                return (
                  <div key={critId} className="prompter-viewer-rubric-criterion" data-criterion-id={critId}>
                    <div className="prompter-viewer-rubric-criterion-title">
                      {c.description ?? 'Criterion'} ({c.points ?? 0} pts)
                    </div>
                    {c.ratings?.length ? (
                      <div className="prompter-viewer-rubric-ratings">
                        {c.ratings.map((r) => {
                          const rid = String(r.id ?? '');
                          const pts = r.points ?? 0;
                          const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                          return (
                            <button
                              key={rid}
                              type="button"
                              className={`prompter-viewer-rubric-rating ${isSelected ? 'selected' : ''}`}
                              data-criterion-id={critId}
                              data-rating-id={rid}
                              data-points={pts}
                              disabled={!teacher}
                              onClick={() => teacher && handleRubricRatingClick(critId, rid, pts)}
                            >
                              {r.description ?? ''} ({pts} pts)
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
            ) : (current?.videoUrl || current?.fallbackVideoUrl) ? (
              /* In dev, prefer SproutVideo when available so teacher can view even if in-memory is gone. */
              (isDev && current.fallbackVideoUrl) || (videoLoadFailed && current.fallbackVideoUrl) || (!current?.videoUrl && current?.fallbackVideoUrl) ? (
                current?.fallbackVideoUrl ? (
                  <>
                    {isDev && current.fallbackVideoUrl && (
                      <p className="prompter-viewer-dev-badge" aria-hidden>Dev: SproutVideo submission</p>
                    )}
                    <div className="prompter-viewer-sprout-wrap" title="Submission video (SproutVideo)">
                      <div
                        className="prompter-viewer-sprout-inner"
                        dangerouslySetInnerHTML={{ __html: buildSproutVideoEmbedHtml(current.fallbackVideoUrl) }}
                      />
                    </div>
                  </>
                ) : (
                  current?.videoUrl ? (
                    <video
                      ref={videoRef}
                      src={current.videoUrl}
                      controls
                      onError={() => setVideoLoadFailed(true)}
                    />
                  ) : (
                    <p className="prompter-viewer-no-video">No video</p>
                  )
                )
              ) : (
                <video
                  ref={videoRef}
                  src={current.videoUrl!}
                  controls
                  onError={() => setVideoLoadFailed(true)}
                />
              )
            ) : hasSubmissionNoVideo ? (
              <div className="prompter-viewer-processing">
                <p>Your submission is being processed. Video will appear shortly. Refresh the page to check.</p>
              </div>
            ) : (
              <p className="prompter-viewer-no-video">No video</p>
            )}
          </div>
          {activeDeckPrompt && deckTimeline.length > 0 && (
            <div className="prompter-viewer-now-playing prompter-viewer-now-playing-below">
              <span>
                <strong>{formatTime(Math.floor(activeDeckPrompt.startSec))}</strong>
                {' — '}
              </span>
              <span dangerouslySetInnerHTML={{ __html: activeDeckPrompt.title || '—' }} />
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
        <div className="prompter-viewer-resize-handle" id="resize-handle-right" title="Drag to resize" />
        <aside
          ref={rightSidebarRef}
          className="prompter-viewer-sidebar prompter-viewer-sidebar-right"
          id="viewer-sidebar-right"
        >
          {deckTimeline.length > 0 && (
            <>
              <div className="prompter-viewer-feedback-title">Prompt cards</div>
              <ul className="prompter-viewer-feedback-list">
                {deckTimeline.map((seg, i) => (
                  <li
                    key={`deck-${i}-${seg.startSec}`}
                    role="button"
                    tabIndex={0}
                    className={i === activeDeckIndex ? 'active' : ''}
                    onClick={() => handleDeckTimelineClick(seg.startSec)}
                    onKeyDown={(e) => e.key === 'Enter' && handleDeckTimelineClick(seg.startSec)}
                  >
                    <div className="prompter-viewer-feedback-item">
                      <div className="prompter-viewer-feedback-content">
                        <div className="prompter-viewer-feedback-time">{formatTime(Math.floor(seg.startSec))}</div>
                        <div
                          className="prompter-viewer-feedback-text"
                          dangerouslySetInnerHTML={{ __html: seg.title || '—' }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="prompter-viewer-feedback-title">Feedback</div>
          <ul className="prompter-viewer-feedback-list">
            {feedbackEntries.length === 0 && (
              <li className="prompter-viewer-feedback-empty">No timestamped feedback.</li>
            )}
            {feedbackEntries.map((f, i) => {
              const isActive = Math.abs(currentTime - f.time) <= 2;
              return (
                <li
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  className={isActive ? 'active' : ''}
                  onClick={() => handleFeedbackClick(f.time)}
                  onKeyDown={(e) => e.key === 'Enter' && handleFeedbackClick(f.time)}
                >
                  <div className="prompter-viewer-feedback-item">
                    <div className="prompter-viewer-feedback-content">
                      <div className="prompter-viewer-feedback-time">{formatTime(f.time)}</div>
                      <div className="prompter-viewer-feedback-text">{f.text || '—'}</div>
                    </div>
                    {teacher && f.id && (
                      <div className="prompter-viewer-comment-actions">
                        <button
                          type="button"
                          className="prompter-viewer-comment-action-btn"
                          title="Edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditComment(f);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="prompter-viewer-comment-action-btn danger"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteComment(f);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {activeFeedback.length > 0 && (
            <div className="prompter-viewer-now-playing">
              {activeFeedback.map((f) => (
                <div key={f.id}>
                  <strong>{formatTime(f.time)}</strong>: {f.text}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
