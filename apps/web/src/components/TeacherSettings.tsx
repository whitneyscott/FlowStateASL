import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
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
  const { setSproutVideo, setLastFunction } = useDebug();
  const [allPlaylists, setAllPlaylists] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedCurriculums, setSelectedCurriculums] = useState<string[]>([]);
  const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
  const [assessmentPlaylistsVisible, setAssessmentPlaylistsVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playlistTotal, setPlaylistTotal] = useState<number | null>(null);

  const teacher = context && isTeacher(context.roles);
  const hasLti = context && context.courseId && context.userId !== 'standalone';

  const displayPlaylists = assessmentPlaylistsVisible
    ? allPlaylists
    : allPlaylists.filter((p) => !hasAssessmentTerm(p.title));

  const curricula = [...new Set(displayPlaylists.map((p) => segments(p.title)[0]).filter(Boolean))].sort();
  const allUnits = [...new Set(
    displayPlaylists
      .filter((p) => selectedCurriculums.length === 0 || selectedCurriculums.includes(segments(p.title)[0] ?? ''))
      .map((p) => segments(p.title)[1])
      .filter(Boolean)
  )].sort();

  const filtered = displayPlaylists.filter((p) => {
    const [c, u] = segments(p.title);
    if (selectedCurriculums.length > 0 && (!c || !selectedCurriculums.includes(c))) return false;
    if (selectedUnits.length > 0 && (!u || !selectedUnits.includes(u))) return false;
    return true;
  });

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
        setLastFunction('GET /api/flashcard/all-playlists');
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
        const [pRes, csRes] = await Promise.all([
          fetch('/api/flashcard/all-playlists', { credentials: 'include' }),
          fetch('/api/course-settings', { credentials: 'include' }),
        ]);
        if (cancelled) return;
        const list = await pRes.json().catch(() => []);
        const cs = await csRes.json().catch(() => null);
        if (!pRes.ok) {
          setError(`HTTP ${pRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setAllPlaylists(Array.isArray(list) ? list : []);
        setSproutVideo(true, Array.isArray(list) ? list.length : 0);
        if (cs?.selectedCurriculums) {
          setSelectedCurriculums(Array.isArray(cs.selectedCurriculums) ? cs.selectedCurriculums : []);
        }
        if (cs?.selectedUnits) {
          setSelectedUnits(Array.isArray(cs.selectedUnits) ? cs.selectedUnits : []);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teacher, hasLti, retryCount]);

  useEffect(() => {
    onFilteredPlaylists?.(filtered);
  }, [selectedCurriculums, selectedUnits, filtered, assessmentPlaylistsVisible, onFilteredPlaylists]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setSavedFeedback(false);
    try {
      await fetch('/api/course-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          selectedCurriculums,
          selectedUnits,
        }),
      });
      onConfigChange?.();
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } finally {
      setSaving(false);
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
        <span className="teacher-settings-toggle-label">Assessment Playlists</span>
        <button
          type="button"
          className="teacher-settings-btn"
          onClick={() => setAssessmentPlaylistsVisible(!assessmentPlaylistsVisible)}
        >
          {assessmentPlaylistsVisible ? 'Hide' : 'Show'}
        </button>
      </div>
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
          <span className="teacher-settings-label">Unit</span>
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
      {saving && (
        <div className="teacher-settings-overlay">
          <div className="teacher-settings-spinner" />
        </div>
      )}
      {allPlaylists.length > 0 && (
        <p className="teacher-settings-footer">{allPlaylists.length} playlists loaded</p>
      )}
    </div>
  );
}
