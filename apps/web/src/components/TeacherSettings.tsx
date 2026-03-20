import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { ManualTokenModal } from './ManualTokenModal';
import './TeacherSettings.css';

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

const ASSESSMENT_TERMS = ['exam', 'quiz', 'test'];

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  const lower = roles.toLowerCase();
  return TEACHER_PATTERNS.some((p) => lower.includes(p));
}

function segments(title: string): string[] {
  return title.split('.').map((p) => p.trim()).filter(Boolean);
}

function hasAssessmentTerm(title: string): boolean {
  const lower = title.toLowerCase();
  return ASSESSMENT_TERMS.some((t) => lower.includes(t));
}

interface TeacherSettingsProps {
  context: LtiContext | null;
  onConfigChange?: () => void;
  onFilteredPlaylists?: (playlists: Array<{ id: string; title: string }>) => void;
}

export function TeacherSettings({ context, onConfigChange, onFilteredPlaylists }: TeacherSettingsProps) {
  const { setSproutVideo, setLastFunction, setLastApiResult, setLastApiError, setLastCourseSettings } = useDebug();
  const [allPlaylists, setAllPlaylists] = useState<Array<{ id: string; title: string }>>([]);
  const [curricula, setCurricula] = useState<string[]>([]);
  const [allUnits, setAllUnits] = useState<string[]>([]);
  const [selectedCurriculums, setSelectedCurriculums] = useState<string[]>([]);
  const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
  const [assessmentPlaylistsVisible, setAssessmentPlaylistsVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playlistTotal, setPlaylistTotal] = useState<number | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [announcementMissing, setAnnouncementMissing] = useState(false);
  const [showRecreateAnnouncementModal, setShowRecreateAnnouncementModal] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [recreateAnnouncementError, setRecreateAnnouncementError] = useState<string | null>(null);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);

  const teacher = context && isTeacher(context.roles);
  const hasLti = context && context.courseId && context.userId !== 'standalone';

  const displayPlaylists = assessmentPlaylistsVisible
    ? allPlaylists
    : allPlaylists.filter((p) => !hasAssessmentTerm(p.title));

  const [hasCanvasToken, setHasCanvasToken] = useState(false);
  const filtered = displayPlaylists;

  const encodeCsv = (values: string[]): string =>
    values
      .map((v) => v.trim())
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(',');

  const loadUnits = useCallback(async (curriculaInput: string[]) => {
    const csv = encodeCsv(curriculaInput);
    const res = await fetch(`/api/flashcard/units?curricula=${csv}`, { credentials: 'include' });
    const data = await res.json().catch(() => []);
    const units = Array.isArray(data) ? data.map(String) : [];
    setAllUnits(units);
  }, []);

  const loadPlaylists = useCallback(async (curriculaInput: string[], unitsInput: string[]) => {
    const curriculaCsv = encodeCsv(curriculaInput);
    const unitsCsv = encodeCsv(unitsInput);
    const res = await fetch(
      `/api/flashcard/teacher-playlists?curricula=${curriculaCsv}&units=${unitsCsv}`,
      { credentials: 'include' },
    );
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    const list = await res.json().catch(() => []);
    const rows = Array.isArray(list) ? list : [];
    setAllPlaylists(rows);
    setSproutVideo(true, rows.length);
    setError(null);
  }, [setSproutVideo]);

  const toggleCurriculum = useCallback((c: string) => {
    setSelectedCurriculums((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
  }, []);

  const toggleUnit = useCallback((u: string) => {
    setSelectedUnits((prev) =>
      prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!teacher || !hasLti) {
        setLoading(false);
        return;
      }
      try {
        setLastFunction('GET /api/flashcard/playlist-count');
        setError(null);
        setPlaylistTotal(null);
        const countRes = await fetch('/api/flashcard/playlist-count', { credentials: 'include' });
        if (!cancelled) {
          const countData = await countRes.json().catch(() => ({}));
          if (typeof countData.total === 'number' && countData.total > 0) {
            setPlaylistTotal(countData.total);
          }
        }
        if (cancelled) return;
        setLastFunction('GET /api/course-settings');
        const csRes = await fetch('/api/course-settings', { credentials: 'include' });
        if (cancelled) return;
        const csRaw = await csRes.text().catch(() => '');
        const cs = (() => { try { return JSON.parse(csRaw); } catch { return null; } })();
        setLastApiResult('GET /api/course-settings', csRes.status, csRes.ok);
        if (csRes.status === 401 && cs?.redirectToOAuth) {
          const returnTo = encodeURIComponent(window.location.href);
          window.location.href = `/api/oauth/canvas?returnTo=${returnTo}`;
          return;
        }
        if (csRes.status === 401 && cs?.needsManualToken) {
          setShowManualTokenModal(true);
          if (!cancelled) setLoading(false);
          return;
        }
        if (!csRes.ok) {
          let errMsg = String(csRes.status);
          try { const j = JSON.parse(csRaw); errMsg = j?.message ?? errMsg; } catch { errMsg = csRaw?.slice(0, 80) ?? errMsg; }
          setLastApiError('GET /api/course-settings', csRes.status, errMsg);
        }
        const savedCurriculums = Array.isArray(cs?.selectedCurriculums) ? cs.selectedCurriculums : [];
        const savedUnits = Array.isArray(cs?.selectedUnits) ? cs.selectedUnits : [];
        setLastCourseSettings({
          selectedCurriculums: savedCurriculums,
          selectedUnits: savedUnits,
          _debug: cs?._debug,
        });
        setSelectedCurriculums(savedCurriculums);
        setSelectedUnits(savedUnits);
        if (cancelled) return;
        setLastFunction('GET /api/flashcard/curricula');
        const curriculaRes = await fetch('/api/flashcard/curricula', { credentials: 'include' });
        if (cancelled) return;
        const curriculaList = await curriculaRes.json().catch(() => []);
        if (!curriculaRes.ok) {
          setError(`HTTP ${curriculaRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setCurricula(Array.isArray(curriculaList) ? curriculaList.map(String) : []);
        await loadUnits(savedCurriculums);
        if (cancelled) return;
        await loadPlaylists(savedCurriculums, savedUnits);
        setHasCanvasToken(!!cs?.hasCanvasToken);
        if (cancelled) return;
        setLastFunction('GET /api/course-settings/announcement-status');
        const annRes = await fetch('/api/course-settings/announcement-status', { credentials: 'include' });
        if (cancelled) return;
        const annData = await annRes.json().catch(() => ({}));
        if (annRes.ok && annData?.exists === false) {
          setAnnouncementMissing(true);
          setShowRecreateAnnouncementModal(true);
        } else {
          setAnnouncementMissing(false);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teacher, hasLti, retryCount, loadPlaylists, loadUnits]);

  useEffect(() => {
    if (!teacher || !hasLti) return;
    loadUnits(selectedCurriculums).catch(() => {
      setAllUnits([]);
    });
  }, [teacher, hasLti, selectedCurriculums, loadUnits]);

  useEffect(() => {
    if (!teacher || !hasLti) return;
    loadPlaylists(selectedCurriculums, selectedUnits).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load playlists');
    });
  }, [teacher, hasLti, selectedCurriculums, selectedUnits, loadPlaylists]);

  useEffect(() => {
    onFilteredPlaylists?.(filtered);
  }, [selectedCurriculums, selectedUnits, filtered, assessmentPlaylistsVisible, onFilteredPlaylists]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setSavedFeedback(false);
    setSaveError(null);
    setShowSaveModal(true);
    setLastFunction('PUT /api/course-settings');
    try {
      const body: { selectedCurriculums: string[]; selectedUnits: string[] } = {
        selectedCurriculums,
        selectedUnits,
      };
      const res = await fetch('/api/course-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const resBody = await res.text().catch(() => '');
      setLastApiResult('PUT /api/course-settings', res.status, res.ok);
      if (!res.ok) {
        let errMsg = String(res.status);
        try {
          const j = JSON.parse(resBody) as { message?: string | string[] };
          errMsg = Array.isArray(j?.message) ? j.message.join(', ') : (j?.message ?? errMsg);
        } catch {
          errMsg = resBody?.slice(0, 200) ?? errMsg;
        }
        setLastApiError('PUT /api/course-settings', res.status, errMsg);
        setSaveError(errMsg);
        return;
      }
      onConfigChange?.();
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setLastApiError('PUT /api/course-settings', 0, msg);
      setSaveError(msg);
    } finally {
      setSaving(false);
      setShowSaveModal(false);
    }
  };

  if (!teacher || !hasLti) return null;
  if (loading && allPlaylists.length === 0 && !error) {
    const loadingText = playlistTotal != null && playlistTotal > 0
      ? `Loading playlists... (0 of ${playlistTotal})`
      : 'Loading playlists...';
    return (
      <div className="teacher-settings-loading">
        <div className="teacher-settings-loading-inner">
          <div className="teacher-settings-spinner" />
          <p>{loadingText}</p>
        </div>
      </div>
    );
  }
  if (error && allPlaylists.length === 0) {
    return (
      <div className="teacher-settings-error">
        <p>Failed to load: {error}</p>
        <button
          type="button"
          className="teacher-settings-retry"
          onClick={() => { setError(null); setLoading(true); setRetryCount((r) => r + 1); }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="teacher-settings">
      <h2>Curriculum Settings</h2>
      <div className="teacher-settings-toggle-wrap" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
        <span className="teacher-settings-toggle-label">Assessment Decks</span>
        <button
          type="button"
          className="teacher-settings-btn"
          onClick={() => setAssessmentPlaylistsVisible(!assessmentPlaylistsVisible)}
        >
          {assessmentPlaylistsVisible ? 'Hide' : 'Show'}
        </button>
      </div>
      <hr
        className="teacher-settings-divider"
        style={{
          width: '100%',
          border: 'none',
          borderTop: '4px solid #52525b',
          margin: '20px 0',
        }}
      />
      <div className="teacher-settings-row teacher-settings-multiselect-row">
        <div className="teacher-settings-checkbox-group">
          <span className="teacher-settings-label">Curriculum</span>
          <div className="teacher-settings-checkbox-list">
            {curricula.map((c) => (
              <label key={c} className="teacher-settings-checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedCurriculums.includes(c)}
                  onChange={() => toggleCurriculum(c)}
                />
                {c}
              </label>
            ))}
          </div>
        </div>
        <div className="teacher-settings-checkbox-group">
          <span className="teacher-settings-label">Units</span>
          <div className="teacher-settings-checkbox-list">
            {allUnits.map((u) => (
              <label key={u} className="teacher-settings-checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedUnits.includes(u)}
                  onChange={() => toggleUnit(u)}
                />
                {u}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="teacher-settings-actions" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="teacher-settings-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {savedFeedback && <span className="teacher-settings-saved">Saved!</span>}
        {saveError && (
          <p className="teacher-settings-error" style={{ marginTop: 8 }}>
            Save failed: {saveError}
          </p>
        )}
      </div>
      {showSaveModal && saving && (
        <div className="teacher-settings-overlay teacher-settings-save-modal">
          <div className="teacher-settings-save-modal-content">
            <div className="teacher-settings-spinner" />
            <p>Configuring decks for best student experience...</p>
            <p className="teacher-settings-save-modal-note">This may take 30–60 seconds.</p>
          </div>
        </div>
      )}
      {allPlaylists.length > 0 && (
        <p className="teacher-settings-footer">{allPlaylists.length} decks loaded</p>
      )}
      {showRecreateAnnouncementModal && announcementMissing && (
        <div className="teacher-settings-overlay teacher-settings-save-modal">
          <div className="teacher-settings-save-modal-content">
            <p>The ASL Express Flashcard Settings announcement was deleted or is missing. Would you like to recreate it?</p>
            {recreateAnnouncementError && (
              <p className="teacher-settings-error" style={{ marginTop: 12 }}>
                {recreateAnnouncementError}
              </p>
            )}
            <div className="teacher-settings-actions" style={{ marginTop: 16, justifyContent: 'center' }}>
              <button
                type="button"
                className="teacher-settings-btn"
                onClick={async () => {
                  setRecreateAnnouncementError(null);
                  setRecreating(true);
                  try {
                    const res = await fetch('/api/course-settings/recreate-announcement', {
                      method: 'POST',
                      credentials: 'include',
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                      setShowRecreateAnnouncementModal(false);
                      setAnnouncementMissing(false);
                      setRecreateAnnouncementError(null);
                    } else {
                      const msg =
                        (data as { message?: string; error?: string }).message ??
                        (data as { error?: string }).error ??
                        `Could not recreate announcement (HTTP ${res.status}).`;
                      setRecreateAnnouncementError(msg);
                    }
                  } catch (e) {
                    setRecreateAnnouncementError(e instanceof Error ? e.message : 'Request failed');
                  } finally {
                    setRecreating(false);
                  }
                }}
                disabled={recreating}
              >
                {recreating ? 'Recreating...' : 'Recreate'}
              </button>
              <button
                type="button"
                className="teacher-settings-btn"
                onClick={() => {
                  setShowRecreateAnnouncementModal(false);
                }}
                disabled={recreating}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {showManualTokenModal && (
        <ManualTokenModal
          message="LTI 1.1 does not support OAuth. Enter your Canvas API token to configure course settings."
          onSuccess={() => {
            setShowManualTokenModal(false);
            setRetryCount((r) => r + 1);
          }}
          onDismiss={() => setShowManualTokenModal(false)}
        />
      )}
    </div>
  );
}
