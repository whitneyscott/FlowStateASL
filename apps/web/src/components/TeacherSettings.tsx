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
        const [hRes, cRes] = await Promise.all([
          fetch('/api/flashcard/curriculum-hierarchy', { credentials: 'include' }),
          fetch('/api/flashcard/config', { credentials: 'include' }),
        ]);
        setLastFunction('GET /api/flashcard/config');
        if (cancelled) return;
        const h = await hRes.json().catch(() => ({}));
        const c = await cRes.json().catch(() => null);
        if (!hRes.ok) {
          setHierarchyError((h as { message?: string })?.message ?? `HTTP ${hRes.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        setHierarchy(h as Hierarchy);
        setPlaylistsRetrieved(h?.playlistsRetrieved ?? null);
        setSproutVideo(true, h?.playlistsRetrieved ?? null);
        setConfig(c);
        if (c) {
          setCurriculum(c.curriculum);
          setUnit(c.unit);
          setSection(c.section);
        } else if (h?.curricula?.length) {
          setCurriculum(h.curricula[0]);
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
  }, [teacher, hasLti, retryCount]);

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
    try {
      await fetch('/api/flashcard/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ curriculum, unit, section }),
      });
      onConfigChange?.();
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
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-400">Curriculum</span>
          <select
            value={curriculum}
            onChange={(e) => setCurriculum(e.target.value)}
            className="bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-white min-w-[120px]"
          >
            <option value="">Select...</option>
            {curricula.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-400">Unit</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-white min-w-[120px]"
            disabled={!curriculum}
          >
            <option value="">Select...</option>
            {units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-400">Module</span>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value)}
            className="bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-white min-w-[120px]"
            disabled={!unit}
          >
            <option value="">Select...</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-emerald-600 rounded font-semibold hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {playlistsRetrieved != null && (
        <p className="text-sm text-zinc-500 mt-3">
          SproutVideo API: accessed, {playlistsRetrieved} playlists retrieved
        </p>
      )}
    </div>
  );
}
