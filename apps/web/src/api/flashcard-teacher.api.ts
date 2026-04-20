/**
 * Teacher flashcard catalog (curricula / units / decks) for Prompt Manager deck picker.
 * Calls existing GET /api/flashcard/* endpoints with Bearer auth token in memory.
 */
import { ltiTokenHeaders } from './lti-token';
import { NeedsManualTokenError } from './prompt.api';

function encodeCsv(values: string[]): string {
  return values
    .map((v) => v.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join(',');
}

function flashcardInit(): RequestInit {
  return { credentials: 'include' as RequestCredentials, headers: ltiTokenHeaders() };
}

async function fetchFlashcardJson<T>(url: string): Promise<T> {
  const res = await fetch(url, flashcardInit());
  const data = await res.json().catch(() => ({}));
  const body = data as { redirectToOAuth?: boolean; needsManualToken?: boolean; message?: string };
  if (res.status === 401 && body.redirectToOAuth) {
    window.location.href = `/api/oauth/canvas?returnTo=${encodeURIComponent(window.location.href)}`;
    throw new Error('Redirecting to Canvas OAuth');
  }
  if (res.status === 401 && body.needsManualToken) {
    throw new NeedsManualTokenError(body.message);
  }
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return data as T;
}

/** Distinct curriculum names (teacher). */
export async function getFlashcardCurricula(): Promise<string[]> {
  const data = await fetchFlashcardJson<unknown>('/api/flashcard/curricula');
  return Array.isArray(data) ? data.map(String) : [];
}

/** Distinct units, optionally scoped by selected curricula (empty = all units). */
export async function getFlashcardUnitsForCurricula(curricula: string[]): Promise<string[]> {
  const csv = encodeCsv(curricula);
  const url = `/api/flashcard/units?curricula=${csv}`;
  const data = await fetchFlashcardJson<unknown>(url);
  return Array.isArray(data) ? data.map(String) : [];
}

/** Decks matching curriculum + unit filters (empty filters = all decks, subject to server rules). */
export async function getFlashcardTeacherPlaylists(
  curricula: string[],
  units: string[],
): Promise<Array<{ id: string; title: string }>> {
  const curriculaCsv = encodeCsv(curricula);
  const unitsCsv = encodeCsv(units);
  const url = `/api/flashcard/teacher-playlists?curricula=${curriculaCsv}&units=${unitsCsv}`;
  const data = await fetchFlashcardJson<unknown>(url);
  const list = Array.isArray(data) ? data : [];
  return list.map((row: unknown) => {
    const r = row as { id?: string; title?: string };
    return { id: String(r.id ?? ''), title: String(r.title ?? '') };
  });
}

export type PlaylistHierarchyRow = {
  id: string;
  title: string;
  curriculum: string;
  unit: string;
  section: string;
};

/**
 * Same hierarchy payload as Flashcards hub. showAllCatalog=true → showHidden=1 (full catalog for teacher deck picker).
 */
export async function getStudentPlaylistsBatchForDeckPicker(showAllCatalog: boolean): Promise<{
  playlists: PlaylistHierarchyRow[];
  error?: string;
}> {
  const q = showAllCatalog ? '?showHidden=1' : '?showHidden=0';
  const data = await fetchFlashcardJson<{
    playlists?: unknown[];
    error?: string;
  }>(`/api/flashcard/student-playlists-batch${q}`);
  const raw = Array.isArray(data.playlists) ? data.playlists : [];
  const playlists = raw.map((row: unknown) => {
    const p = row as { id?: string; title?: string; curriculum?: string; unit?: string; section?: string };
    return {
      id: String(p.id ?? ''),
      title: String(p.title ?? ''),
      curriculum: String(p.curriculum ?? ''),
      unit: String(p.unit ?? ''),
      section: String(p.section ?? ''),
    };
  });
  return { playlists, error: data.error };
}

async function fetchFlashcardJsonPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    ...flashcardInit(),
    method: 'POST',
    headers: { ...flashcardInit().headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  const b = data as { redirectToOAuth?: boolean; needsManualToken?: boolean; message?: string };
  if (res.status === 401 && b.redirectToOAuth) {
    window.location.href = `/api/oauth/canvas?returnTo=${encodeURIComponent(window.location.href)}`;
    throw new Error('Redirecting to Canvas OAuth');
  }
  if (res.status === 401 && b.needsManualToken) {
    throw new NeedsManualTokenError(b.message);
  }
  if (!res.ok) throw new Error(b.message ?? `HTTP ${res.status}`);
  return data as T;
}

export async function exportFlashcardSettingsBlob(): Promise<{
  v?: number;
  selectedCurriculums: string[];
  selectedUnits: string[];
  updatedAt?: string;
}> {
  return fetchFlashcardJson('/api/course-settings/settings-blob/export');
}

export async function importFlashcardSettingsBlob(body: {
  mode: 'merge' | 'replace_selected';
  blob?: { v?: number; selectedCurriculums?: string[]; selectedUnits?: string[] };
  sourceCourseId?: string;
  dryRun?: boolean;
}): Promise<{ dryRun?: true; preview: unknown } | { ok: true }> {
  return fetchFlashcardJsonPost('/api/course-settings/settings-blob/import', body);
}
