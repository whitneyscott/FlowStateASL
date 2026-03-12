import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import * as promptApi from '../api/prompt.api';
import './PrompterPage.css';

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
  const [submissions, setSubmissions] = useState<promptApi.PromptSubmission[]>([]);
  const [assignment, setAssignment] = useState<{ pointsPossible?: number; rubric?: Array<unknown> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [gradeValue, setGradeValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teacher = context && isTeacher(context.roles);
  const current = submissions[index];
  const pointsPossible = assignment?.pointsPossible ?? 100;

  const load = useCallback(async () => {
    if (!teacher) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/submissions');
      const [subs, assign] = await Promise.all([
        promptApi.getSubmissions(),
        promptApi.getAssignment(),
      ]);
      setLastApiResult('GET /api/prompt/submissions', 200, true);
      setSubmissions(Array.isArray(subs) ? subs : []);
      setAssignment(assign ?? null);
      setIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/submissions', 0, String(e));
    } finally {
      setLoading(false);
    }
  }, [teacher, setLastFunction, setLastApiResult, setLastApiError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (current?.grade != null) setGradeValue(String(current.grade));
    else if (current?.score != null) setGradeValue(String(current.score));
    else setGradeValue('');
  }, [current]);

  const handleGrade = async () => {
    if (!current) return;
    const score = parseFloat(gradeValue);
    if (Number.isNaN(score)) return;
    setSaving(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/grade');
      await promptApi.submitGrade({
        userId: current.userId,
        score,
        scoreMaximum: pointsPossible,
      });
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
      await promptApi.resetAttempt(current.userId);
      setLastApiResult('POST /api/prompt/reset-attempt', 200, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setSaving(false);
    }
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

  return (
    <div className="prompter-page">
      <div className="prompter-card">
        <h1>Grade Submissions</h1>
        {error && <div className="prompter-alert-error">{error}</div>}
        <div className="prompter-viewer-nav">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index <= 0}
            className="prompter-nav-btn"
          >
            Previous
          </button>
          <span className="prompter-viewer-nav-label">
            {index + 1} / {submissions.length} — {current?.userName ?? current?.userId}
          </span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(submissions.length - 1, i + 1))}
            disabled={index >= submissions.length - 1}
            className="prompter-nav-btn"
          >
            Next
          </button>
        </div>
        <div className="prompter-viewer-grid">
          <div className="prompter-viewer-section">
            <h2>Video</h2>
            {current?.videoUrl ? (
              <video src={current.videoUrl} controls className="prompter-viewer-video" />
            ) : (
              <p className="prompter-info-message">No video</p>
            )}
          </div>
          <div className="prompter-viewer-section">
            <h2>Prompt</h2>
            <div
              className="prompter-viewer-prompt-content"
              dangerouslySetInnerHTML={{
                __html: parsed.promptSnapshotHtml ?? current?.body ?? '—',
              }}
            />
          </div>
        </div>
        <div className="prompter-viewer-section">
          <h2>Comments</h2>
          <ul className="prompter-viewer-comments">
            {current?.submissionComments?.map((c) => (
              <li key={c.id}>{c.comment}</li>
            ))}
            {!current?.submissionComments?.length && <li>None</li>}
          </ul>
        </div>
        <div className="prompter-viewer-grade-row">
          <label className="prompter-viewer-grade-label">
            <span>Grade (/{pointsPossible})</span>
            <input
              type="text"
              value={gradeValue}
              onChange={(e) => setGradeValue(e.target.value)}
              className="prompter-settings-input prompter-settings-input-narrow"
            />
          </label>
          <button type="button" onClick={handleGrade} disabled={saving} className="prompter-btn-ready">
            Save Grade
          </button>
          <button type="button" onClick={handleReset} disabled={saving} className="prompter-btn-secondary">
            Reset Student
          </button>
        </div>
      </div>
    </div>
  );
}
