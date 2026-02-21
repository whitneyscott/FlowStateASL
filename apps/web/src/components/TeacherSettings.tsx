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

interface Hierarchy {
  curricula: string[];
  unitsByCurriculum: Record<string, string[]>;
  sectionsByCurriculumUnit: Record<string, string[]>;
}

interface TeacherSettingsProps {
  context: LtiContext | null;
  onConfigChange?: () => void;
  onSelectionChange?: (curriculum: string, unit: string, section: string) => void;
}

const SELECT_STYLE =
  'w-full min-w-[140px] py-3 px-4 pr-10 bg-zinc-800 border border-zinc-600 rounded-lg text-white cursor-pointer appearance-none hover:border-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 [&>option]:bg-zinc-800';

export function TeacherSettings({ context, onConfigChange, onSelectionChange }: TeacherSettingsProps) {
  const { setSproutVideo, setLastFunction } = useDebug();
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [playlistsRetrieved, setPlaylistsRetrieved] = useState<number | null>(null);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [config, setConfig] = useState<{
    curriculum: string;
    unit: string;
    section: string;
  } | null>(null);
  const [curriculum, setCurriculum] = useState('');
  const [unit, setUnit] = useState('');
  const [section, setSection] = useState('');
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
        setLastFunction('GET /api/flashcard/curriculum-hierarchy');
        setHierarchyError(null);
        const [hRes, cRes, suggRes] = await Promise.all([
          fetch('/api/flashcard/curriculum-hierarchy', { credentials: 'include' }),
          fetch('/api/flashcard/config', { credentials: 'include' }),
          context?.moduleId
            ? fetch('/api/flashcard/module-suggestion', { credentials: 'include' })
            : Promise.resolve(null),
        ]);
        setLastFunction('GET /api/flashcard/config');
        if (cancelled) return;
        const h = await hRes.json().catch(() => ({}));
        const c = await cRes.json().catch(() => null);
        const sugg = suggRes ? await suggRes.json().catch(() => null) : null;
        if (!hRes.ok) {
          setHierarchyError((h as { message?: string })?.message ?? `HTTP ${hRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setHierarchy(h as Hierarchy);
        setPlaylistsRetrieved(h?.playlistsRetrieved ?? null);
        setSproutVideo(true, h?.playlistsRetrieved ?? null);
        setConfig(c);
        const curricula = (h as Hierarchy)?.curricula ?? [];
        if (c) {
          setCurriculum(c.curriculum);
          setUnit(c.unit);
          setSection(c.section);
        } else if (sugg?.curriculum && curricula.includes(sugg.curriculum) && (sugg.unit || sugg.section)) {
          setCurriculum(sugg.curriculum);
          setUnit(sugg.unit ?? '');
          setSection(sugg.section ?? '');
        } else {
          setCurriculum('');
          setUnit('');
          setSection('');
        }
      } catch (err) {
        if (!cancelled) {
          setHierarchy(null);
          setHierarchyError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teacher, hasLti, retryCount, context?.moduleId]);

  useEffect(() => {
    if (hierarchy && curriculum && !hierarchy.unitsByCurriculum?.[curriculum]?.includes(unit)) {
      setUnit('');
    }
  }, [curriculum, hierarchy, unit]);

  useEffect(() => {
    const key = curriculum && unit ? `${curriculum}|${unit}` : '';
    if (hierarchy && key && !hierarchy.sectionsByCurriculumUnit?.[key]?.includes(section)) {
      setSection('');
    }
  }, [curriculum, unit, hierarchy, section]);

  useEffect(() => {
    onSelectionChange?.(curriculum, unit, section);
  }, [curriculum, unit, section, onSelectionChange]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setSavedFeedback(false);
    try {
      await fetch('/api/flashcard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ curriculum, unit, section }),
      });
      onConfigChange?.();
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (!teacher || !hasLti) return null;
  if (loading && !hierarchy && !hierarchyError) {
    return (
      <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-zinc-600">
        <p className="text-zinc-400">Loading teacher settings (fetching SproutVideo playlists)...</p>
      </div>
    );
  }
  if (hierarchyError && !hierarchy) {
    return (
      <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-red-600">
        <p className="text-red-400">Failed to load curriculum: {hierarchyError}</p>
        <p className="text-zinc-500 text-sm mt-2">Check that SPROUT_KEY is set in Render.</p>
        <button
          type="button"
          onClick={() => { setHierarchyError(null); setLoading(true); setRetryCount((r) => r + 1); }}
          className="mt-3 px-3 py-1 bg-zinc-600 rounded text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!hierarchy) return null;

  const curricula = hierarchy.curricula ?? [];
  const units = hierarchy.unitsByCurriculum?.[curriculum] ?? [];
  const sections =
    (curriculum && unit
      ? hierarchy.sectionsByCurriculumUnit?.[`${curriculum}|${unit}`] ?? []
      : []) as string[];

  return (
    <div className="mb-6 p-4 bg-zinc-800 rounded-lg border border-zinc-600">
      <h2 className="text-lg font-semibold text-emerald-400 mb-4">
        Curriculum Settings
      </h2>
      <div className="flex flex-wrap gap-4 items-end">
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Curriculum</span>
          <div className="relative">
            <select
              value={curriculum}
              onChange={(e) => setCurriculum(e.target.value)}
              className={SELECT_STYLE}
            >
              <option value="">— Select —</option>
              {curricula.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Unit</span>
          <div className="relative">
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className={SELECT_STYLE}
              disabled={!curriculum}
            >
              <option value="">— Select —</option>
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <label className="flex flex-col gap-1.5 min-w-[140px]">
          <span className="text-sm text-zinc-400">Module</span>
          <div className="relative">
            <select
              value={section}
              onChange={(e) => setSection(e.target.value)}
              className={SELECT_STYLE}
              disabled={!unit}
            >
              <option value="">— Select —</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">▾</span>
          </div>
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !curriculum}
            className="px-4 py-3 bg-emerald-600 rounded-lg font-semibold hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {savedFeedback && (
            <span className="text-emerald-400 text-sm font-medium py-2">Saved!</span>
          )}
        </div>
      </div>
      {playlistsRetrieved != null && (
        <p className="text-sm text-zinc-500 mt-3">
          SproutVideo API: accessed, {playlistsRetrieved} playlists retrieved
        </p>
      )}
    </div>
  );
}
