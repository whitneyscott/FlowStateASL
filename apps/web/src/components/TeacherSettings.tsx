import { useEffect, useState } from 'react';
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
  const [selectedCurriculum, setSelectedCurriculum] = useState('');
  const [selectedUnit, setSelectedUnit] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
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
        const [pRes, cRes, suggRes] = await Promise.all([
          fetch('/api/flashcard/all-playlists', { credentials: 'include' }),
          fetch('/api/flashcard/config', { credentials: 'include' }),
          context?.moduleId ? fetch('/api/flashcard/module-suggestion', { credentials: 'include' }) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const list = await pRes.json().catch(() => []);
        const c = await cRes.json().catch(() => null);
        const sugg = suggRes ? await suggRes.json().catch(() => null) : null;
        if (!pRes.ok) {
          setError(`HTTP ${pRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setAllPlaylists(Array.isArray(list) ? list : []);
        setSproutVideo(true, Array.isArray(list) ? list.length : 0);
        if (c) {
          setSelectedCurriculum(c.curriculum ?? '');
          setSelectedUnit(c.unit ?? '');
          setSelectedSection(c.section ?? '');
        } else if (sugg?.curriculum) {
          setSelectedCurriculum(sugg.curriculum ?? '');
          setSelectedUnit(sugg.unit ?? '');
          setSelectedSection(sugg.section ?? '');
        } else {
          setSelectedCurriculum('');
          setSelectedUnit('');
          setSelectedSection('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teacher, hasLti, retryCount, context?.moduleId]);

  useEffect(() => {
    if (!selectedCurriculum) {
      setSelectedUnit('');
      setSelectedSection('');
    } else if (!selectedUnit) {
      setSelectedSection('');
    }
  }, [selectedCurriculum, selectedUnit]);

  const curricula = [...new Set(displayPlaylists.map((p) => segments(p.title)[0]).filter(Boolean))].sort();
  const byCurriculum = displayPlaylists.filter((p) => segments(p.title)[0] === selectedCurriculum);
  const units = [...new Set(byCurriculum.map((p) => segments(p.title)[1]).filter(Boolean))].sort();
  const byUnit = byCurriculum.filter((p) => segments(p.title)[1] === selectedUnit);
  const sections = [...new Set(byUnit.map((p) => segments(p.title)[2]).filter(Boolean))].sort();
  const filtered = displayPlaylists.filter((p) => {
    const [c, u, s] = segments(p.title);
    if (selectedCurriculum && c !== selectedCurriculum) return false;
    if (selectedUnit && u !== selectedUnit) return false;
    if (selectedSection && s !== selectedSection) return false;
    return true;
  });

  useEffect(() => {
    const list = selectedCurriculum ? filtered : [];
    onFilteredPlaylists?.(list);
  }, [selectedCurriculum, selectedUnit, selectedSection, allPlaylists, assessmentPlaylistsVisible, onFilteredPlaylists]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setSavedFeedback(false);
    try {
      await fetch('/api/flashcard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          curriculum: selectedCurriculum,
          unit: selectedUnit,
          section: selectedSection,
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
      <div className="teacher-settings-row">
        <label className="teacher-settings-field">
          <span className="teacher-settings-label">Curriculum</span>
          <div className="teacher-settings-select-wrap">
            <select
              value={selectedCurriculum}
              onChange={(e) => setSelectedCurriculum(e.target.value)}
              className="teacher-settings-select"
            >
              <option value="">— Select —</option>
              {curricula.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <span className="teacher-settings-select-arrow">▾</span>
          </div>
        </label>
        <label className="teacher-settings-field">
          <span className="teacher-settings-label">Unit</span>
          <div className="teacher-settings-select-wrap">
            <select
              value={selectedUnit}
              onChange={(e) => setSelectedUnit(e.target.value)}
              className="teacher-settings-select"
              disabled={!selectedCurriculum}
            >
              <option value="">— Select —</option>
              {units.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <span className="teacher-settings-select-arrow">▾</span>
          </div>
        </label>
        <label className="teacher-settings-field">
          <span className="teacher-settings-label">Section</span>
          <div className="teacher-settings-select-wrap">
            <select
              value={selectedSection}
              onChange={(e) => setSelectedSection(e.target.value)}
              className="teacher-settings-select"
              disabled={!selectedUnit}
            >
              <option value="">— Select —</option>
              {sections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className="teacher-settings-select-arrow">▾</span>
          </div>
        </label>
        <div className="teacher-settings-actions">
          <button
            type="button"
            className="teacher-settings-btn"
            onClick={handleSave}
            disabled={saving || !selectedCurriculum}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {savedFeedback && <span className="teacher-settings-saved">Saved!</span>}
        </div>
      </div>
      {allPlaylists.length > 0 && (
        <p className="teacher-settings-footer">{allPlaylists.length} playlists loaded</p>
      )}
    </div>
  );
}
