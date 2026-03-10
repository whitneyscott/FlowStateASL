import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { fetchCourseSettings } from '../lib/course-settings';
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
  const [loading, setLoading] = useState(true);
  const [playlistTotal, setPlaylistTotal] = useState<number | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  const teacher = context && isTeacher(context.roles);
  const hasLti = context && context.courseId && context.userId !== 'standalone';

  const displayPlaylists = assessmentPlaylistsVisible
    ? allPlaylists
    : allPlaylists.filter((p) => !hasAssessmentTerm(p.title));

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

  const loadPlaylists = useCallback(async (curriculaInput: string[], unitsInput: string[], showBlacklisted = false) => {
    const curriculaCsv = encodeCsv(curriculaInput);
    const unitsCsv = encodeCsv(unitsInput);
    const blacklistedParam = showBlacklisted ? '&showBlacklisted=1' : '';
    const res = await fetch(
      `/api/flashcard/teacher-playlists?curricula=${curriculaCsv}&units=${unitsCsv}${blacklistedParam}`,
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
        const cs = await fetchCourseSettings({
          setLastFunction,
          setLastApiResult,
          setLastApiError,
        });
        if (cancelled) return;
        if (cs === null) return;
        setLastCourseSettings({
          selectedCurriculums: cs.selectedCurriculums,
          selectedUnits: cs.selectedUnits,
          _debug: cs._debug,
        });
        setSelectedCurriculums(cs.selectedCurriculums);
        setSelectedUnits(cs.selectedUnits);
        if (cancelled) return;
        setLastFunction('GET /api/flashcard/curricula');
        const curriculaBlacklistParam = assessmentPlaylistsVisible ? '?showBlacklisted=1' : '';
        const curriculaRes = await fetch(`/api/flashcard/curricula${curriculaBlacklistParam}`, { credentials: 'include' });
        if (cancelled) return;
        const curriculaList = await curriculaRes.json().catch(() => []);
        if (!curriculaRes.ok) {
          setError(`HTTP ${curriculaRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setCurricula(Array.isArray(curriculaList) ? curriculaList.map(String) : []);
        await loadUnits(cs.selectedCurriculums);
        if (cancelled) return;
        await loadPlaylists(cs.selectedCurriculums, cs.selectedUnits, assessmentPlaylistsVisible);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teacher, hasLti, retryCount, assessmentPlaylistsVisible, loadPlaylists, loadUnits]);

  useEffect(() => {
    if (!teacher || !hasLti) return;
    loadUnits(selectedCurriculums).catch(() => {
      setAllUnits([]);
    });
  }, [teacher, hasLti, selectedCurriculums, loadUnits]);

  useEffect(() => {
    if (!teacher || !hasLti) return;
    loadPlaylists(selectedCurriculums, selectedUnits, assessmentPlaylistsVisible).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load playlists');
    });
  }, [teacher, hasLti, selectedCurriculums, selectedUnits, assessmentPlaylistsVisible, loadPlaylists]);

  useEffect(() => {
    onFilteredPlaylists?.(filtered);
  }, [selectedCurriculums, selectedUnits, filtered, assessmentPlaylistsVisible, onFilteredPlaylists]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setSavedFeedback(false);
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
        try { const j = JSON.parse(resBody); errMsg = j?.message ?? errMsg; } catch { errMsg = resBody?.slice(0, 80) ?? errMsg; }
        setLastApiError('PUT /api/course-settings', res.status, errMsg);
      }
      onConfigChange?.();
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setLastApiError('PUT /api/course-settings', 0, msg);
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
      <div className="teacher-settings-toggle-wrap">
        <span className="teacher-settings-toggle-label">Assessment &amp; Blacklisted Playlists</span>
        <button
          type="button"
          className="teacher-settings-btn"
          onClick={() => setAssessmentPlaylistsVisible(!assessmentPlaylistsVisible)}
        >
          {assessmentPlaylistsVisible ? 'Hide' : 'Show'}
        </button>
      </div>
      <hr className="teacher-settings-divider" />
      <div className="teacher-settings-row teacher-settings-multiselect-column">
        <div className="teacher-settings-curriculum-block">
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
        <div className="teacher-settings-unit-block">
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
        <div className="teacher-settings-actions">
          <button
            type="button"
            className="teacher-settings-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {savedFeedback && <span className="teacher-settings-saved">Saved!</span>}
        </div>
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
        <p className="teacher-settings-footer">{allPlaylists.length} playlists loaded</p>
      )}
    </div>
  );
}
