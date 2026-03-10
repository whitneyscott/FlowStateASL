/**
 * Shared helper for fetching course settings (Flashcard Settings).
 * Both teacher and student use this - ONE function, same data source.
 */

export interface CourseSettingsResponse {
  selectedCurriculums: string[];
  selectedUnits: string[];
  sproutAccountId?: string;
  _debug?: {
    assignmentTitle: string;
    courseIdUsed: string;
    canvasDomainUsed: string;
    flashcardSettingsAssignmentId: string | null;
    findResult: string;
    requestFindByTitle: string;
    requestGetAssignment: string | null;
    tokenStatus?: string;
    canvasApiResponse?: string | null;
  };
}

export async function fetchCourseSettings(
  options?: {
    setLastFunction?: (fn: string) => void;
    setLastApiResult?: (endpoint: string, status: number, ok: boolean) => void;
    setLastApiError?: (endpoint: string, status: number, message: string) => void;
  },
): Promise<CourseSettingsResponse | null> {
  const endpoint = 'GET /api/course-settings';
  options?.setLastFunction?.(endpoint);

  const res = await fetch('/api/course-settings', { credentials: 'include' });
  const raw = await res.text().catch(() => '');
  const data = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  options?.setLastApiResult?.(endpoint, res.status, res.ok);

  if (!res.ok) {
    let errMsg = String(res.status);
    try {
      const j = data ?? JSON.parse(raw);
      errMsg = j?.message ?? errMsg;
    } catch {
      errMsg = raw?.slice(0, 80) ?? errMsg;
    }
    options?.setLastApiError?.(endpoint, res.status, errMsg);
    if (res.status === 401 && data?.reauthRequired) {
      const returnTo = encodeURIComponent(window.location.href);
      window.location.href = `/api/oauth/canvas?returnTo=${returnTo}`;
      return null;
    }
    return null;
  }

  const selectedCurriculums = Array.isArray(data?.selectedCurriculums) ? data.selectedCurriculums : [];
  const selectedUnits = Array.isArray(data?.selectedUnits) ? data.selectedUnits : [];

  return {
    selectedCurriculums,
    selectedUnits,
    sproutAccountId: data?.sproutAccountId,
    _debug: data?._debug,
  };
}
