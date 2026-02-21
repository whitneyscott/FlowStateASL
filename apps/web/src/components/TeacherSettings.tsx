import { useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';

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
  const lower = roles.toLowerCase();
  return TEACHER_PATTERNS.some((p) => lower.includes(p));
}

function segments(title: string): string[] {
  return title.split('.').map((p) => p.trim()).filter(Boolean);
}

interface TeacherSettingsProps {
  context: LtiContext | null;
  onConfigChange?: () => void;
  onFilteredPlaylists?: (playlists: Array<{ id: string; title: string }>) => void;
}

const SELECT_STYLE =
  'w-full min-w-[140px] py-3 px-4 pr-10 bg-zinc-800 border border-zinc-600 rounded-lg text-white cursor-pointer appearance-none hover:border-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 [&>option]:bg-zinc-800';

export function TeacherSettings({ context, onConfigChange, onFilteredPlaylists }: TeacherSettingsProps) {
  const { setSproutVideo, setLastFunction } = useDebug();
  const [allPlaylists, setAllPlaylists] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedCurriculum, setSelectedCurriculum] = useState('');
  const [selectedUnit, setSelectedUnit] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [loading, setLoading] = useState(true);

  const teacher = context && isTeacher(context.roles);
  const hasLti = context && context.courseId && context.userId !== 'standalone';

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

  const curricula = [...new Set(allPlaylists.map((p) => segments(p.title)[0]).filter(Boolean))].sort();
  const byCurriculum = allPlaylists.filter((p) => segments(p.title)[0] === selectedCurriculum);
  const units = [...new Set(byCurriculum.map((p) => segments(p.title)[1]).filter(Boolean))].sort();
  const byUnit = byCurriculum.filter((p) => segments(p.title)[1] === selectedUnit);
  const sections = [...new Set(byUnit.map((p) => segments(p.title)[2]).filter(Boolean))].sort();
  const filtered = allPlaylists.filter(
    (p) => {
      const [c, u, s] = segments(p.title);
      if (selectedCurriculum && c !== selectedCurriculum) return false;
      if (selectedUnit && u !== selectedUnit) return false;
      if (selectedSection && s !== selectedSection) return false;
      return true;
    },
  );

  useEffect(() => {
    const list = selectedCurriculum ? filtered : [];
    onFilteredPlaylists?.(list);
  }, [selectedCurriculum, selectedUnit, selectedSection, allPlaylists, onFilteredPlaylists]);

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
    return (
      <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-zinc-600">
        <p className="text-zinc-400">Loading playlists...</p>
      </div>
    );
  }
  if (error && allPlaylists.length === 0) {
    return (
      <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-red-600">
        <p className="text-red-400">Failed to load: {error}</p>
        <button
          type="button"
          onClick={() => { setError(null); setLoading(true); setRetryCount((r) => r + 1); }}
          className="mt-3 px-3 py-1 bg-zinc-600 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-zinc-600">
      <h2 className="text-lg font-semibold text-emerald-400 mb-4">Curriculum Settings</h2>
      <div className="flex flex-wrap gap-4 items-end">
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Curriculum</span>
          <div className="relative">
            <select
              value={selectedCurriculum}
              onChange={(e) => setSelectedCurriculum(e.target.value)}
              className={SELECT_STYLE}
            >
              <option value="">— Select —</option>
              {curricula.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Unit</span>
          <div className="relative">
            <select
              value={selectedUnit}
              onChange={(e) => setSelectedUnit(e.target.value)}
              className={SELECT_STYLE}
              disabled={!selectedCurriculum}
            >
              <option value="">— Select —</option>
              {units.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Section</span>
          <div className="relative">
            <select
              value={selectedSection}
              onChange={(e) => setSelectedSection(e.target.value)}
              className={SELECT_STYLE}
              disabled={!selectedUnit}
            >
              <option value="">— Select —</option>
              {sections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !selectedCurriculum}
            className="px-4 py-3 bg-emerald-600 rounded-lg font-semibold hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {savedFeedback && <span className="text-emerald-400 text-sm font-medium py-2">Saved!</span>}
        </div>
      </div>
      {allPlaylists.length > 0 && (
        <p className="text-sm text-zinc-500 mt-3">{allPlaylists.length} playlists loaded</p>
      )}
    </div>
  );
}
