import { useCallback, useEffect, useRef, useState } from 'react';
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

function parseBody(body: string | undefined): { promptSnapshotHtml?: string; submittedAt?: string } {
  if (!body?.trim()) return {};
  try {
    return JSON.parse(body) as { promptSnapshotHtml?: string; submittedAt?: string };
  } catch {
    return { promptSnapshotHtml: body };
  }
}

export default function TeacherViewerPage({ context }: TeacherViewerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [searchParams] = useSearchParams();
  const assignmentIdFromUrl = searchParams.get('assignmentId') ?? '';
  const ctxAssignmentId = resolveLtiContextValue(context?.assignmentId);
  const assignmentId = (ctxAssignmentId || assignmentIdFromUrl.trim()) || null;

  const [submissions, setSubmissions] = useState<promptApi.PromptSubmission[]>([]);
  const [submissionCount, setSubmissionCount] = useState<number | null>(null);
  const [assignment, setAssignment] = useState<{ pointsPossible?: number; rubric?: Array<unknown> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [gradeValue, setGradeValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFeedbackIndex, setActiveFeedbackIndex] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const teacher = context && isTeacher(context.roles);
  const current = submissions[index];
  const pointsPossible = assignment?.pointsPossible ?? 100;

  const load = useCallback(async () => {
    if (!teacher || !assignmentId) {
      setLoading(false);
      return;
    }
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
      setSubmissions(Array.isArray(subs) ? subs : []);
      setAssignment(assign ?? null);
      setSubmissionCount(count);
      setIndex((prev) => {
        const cur = submissions[prev];
        if (cur) {
          const idx = (Array.isArray(subs) ? subs : []).findIndex((s) => s.userId === cur.userId);
          if (idx >= 0) return idx;
        }
        return 0;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/submissions', 0, String(e));
    } finally {
      setLoading(false);
    }
  }, [teacher, assignmentId, setLastFunction, setLastApiResult, setLastApiError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (current?.grade != null) setGradeValue(String(current.grade));
    else if (current?.score != null) setGradeValue(String(current.score));
    else setGradeValue('');
  }, [current]);

  useEffect(() => {
    setActiveFeedbackIndex(null);
  }, [current?.userId]);

  const handleGrade = async () => {
    if (!current) return;
    const score = parseFloat(gradeValue);
    if (Number.isNaN(score)) return;
    setSaving(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/grade');
      await promptApi.submitGrade(
        {
          userId: current.userId,
          score,
          scoreMaximum: pointsPossible,
        },
        assignmentId
      );
      setLastApiResult('POST /api/prompt/grade', 200, true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grade failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/reset-attempt');
      await promptApi.resetAttempt(current.userId, assignmentId);
      setLastApiResult('POST /api/prompt/reset-attempt', 200, true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setSaving(false);
    }
  };

  const feedbackEntries = parseTimestampedFeedback(current?.submissionComments ?? []);
  const handleFeedbackClick = (time: number, idx: number) => {
    setActiveFeedbackIndex(idx);
    const v = videoRef.current;
    if (v) {
      v.currentTime = time;
      v.play().catch(() => {});
    }
  };

  const handleStudentSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const uid = e.target.value;
    if (!uid) return;
    const idx = submissions.findIndex((s) => s.userId === uid);
    if (idx >= 0) setIndex(idx);
  };

  if (!teacher || !context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Teacher access required.</p>
        </div>
      </div>
    );
  }

  if (!assignmentId) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>Grade Submissions</h1>
          <p className="prompter-info-message">Select an assignment from the config page, or open this page with ?assignmentId=...</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading submissions...</p>
        </div>
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>Grade Submissions</h1>
          <p className="prompter-info-message">No submissions yet.</p>
        </div>
      </div>
    );
  }

  const parsed = parseBody(current?.body);
  const rubric = (assignment?.rubric ?? []) as Array<{ id?: string; description?: string; points?: number; ratings?: Array<{ id?: string; description?: string; points?: number }> }>;

  return (
    <div className="prompter-page prompter-page--viewer">
      <div className="prompter-viewer-layout">
        <aside className="prompter-viewer-sidebar" id="viewer-sidebar-left">
          <div className="prompter-viewer-prompt-label">Prompt</div>
          <div
            className="prompter-viewer-prompt-content-block"
            dangerouslySetInnerHTML={{
              __html: parsed.promptSnapshotHtml ?? current?.body ?? '—',
            }}
          />
          {rubric.length > 0 && (
            <div className="prompter-viewer-rubric-container">
              <div className="prompter-viewer-feedback-title">Rubric</div>
              {rubric.map((c) => (
                <div key={c.id ?? ''} className="prompter-viewer-rubric-criterion">
                  <div className="prompter-viewer-rubric-criterion-title">
                    {c.description ?? 'Criterion'} ({c.points ?? 0} pts)
                  </div>
                  {c.ratings?.length ? (
                    <div className="prompter-viewer-rubric-ratings">
                      {c.ratings.map((r) => (
                        <button
                          key={r.id ?? ''}
                          type="button"
                          className="prompter-viewer-rubric-rating"
                        >
                          {r.description ?? ''} ({r.points ?? 0} pts)
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </aside>
        <main className="prompter-viewer-center" id="viewer-center">
          {error && <div className="prompter-viewer-error-box">{error}</div>}
          <div className="prompter-viewer-dropdown-row">
            <label htmlFor="submission-select">Submission:</label>
            <select
              id="submission-select"
              value={current?.userId ?? ''}
              onChange={handleStudentSelect}
            >
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
              Previous
            </button>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(submissions.length - 1, i + 1))}
              disabled={index >= submissions.length - 1}
              className={`prompter-viewer-nav-btn ${index >= submissions.length - 1 ? 'disabled' : ''}`}
            >
              Next
            </button>
            <span className="prompter-viewer-nav-index">
              {index + 1} / {submissions.length}
            </span>
          </div>
          <div className="prompter-viewer-grade-row-full">
            <label htmlFor="grade-input">Grade</label>
            <input
              id="grade-input"
              type="number"
              min={0}
              max={pointsPossible}
              step={0.01}
              value={gradeValue}
              onChange={(e) => setGradeValue(e.target.value)}
            />
            <span className="prompter-viewer-points-label">/ {pointsPossible} pts</span>
            <button type="button" onClick={handleGrade} disabled={saving} className="prompter-btn-ready">
              Save Grade
            </button>
            {saving && <span className="prompter-viewer-save-status">Saving…</span>}
          </div>
          <div className="prompter-viewer-reset-row">
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="prompter-viewer-reset-btn"
            >
              Reset Student
            </button>
          </div>
          <div className="prompter-viewer-video-wrap">
            {current?.videoUrl ? (
              <video
                ref={videoRef}
                src={current.videoUrl}
                controls
              />
            ) : (
              <p className="prompter-viewer-no-video">No video</p>
            )}
          </div>
          {current?.userName && (
            <div className="prompter-viewer-now-playing">
              Now viewing: {current.userName}
            </div>
          )}
        </main>
        <aside className="prompter-viewer-sidebar prompter-viewer-sidebar-right" id="viewer-sidebar-right">
          <div className="prompter-viewer-feedback-title">Feedback</div>
          <ul className="prompter-viewer-feedback-list">
            {feedbackEntries.length === 0 && <li className="prompter-viewer-feedback-empty">No timestamped feedback.</li>}
            {feedbackEntries.map((f, i) => {
              const m = Math.floor(f.time / 60);
              const s = Math.floor(f.time % 60);
              const ts = `${m}:${s < 10 ? '0' : ''}${s}`;
              return (
                <li
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  className={i === activeFeedbackIndex ? 'active' : ''}
                  onClick={() => handleFeedbackClick(f.time, i)}
                  onKeyDown={(e) => e.key === 'Enter' && handleFeedbackClick(f.time, i)}
                >
                  <div className="prompter-viewer-feedback-time">{ts}</div>
                  <div className="prompter-viewer-feedback-text">{f.text || '—'}</div>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}
