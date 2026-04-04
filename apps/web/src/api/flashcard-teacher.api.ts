/**
 * Teacher flashcard catalog (curricula / units / decks) for Prompt Manager deck picker.
 * Calls existing GET /api/flashcard/* endpoints with LTI token + OAuth/manual-token parity.
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
