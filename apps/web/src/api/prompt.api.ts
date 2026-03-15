/**
 * Prompt Manager API client. Uses fetch with credentials: 'include' (same as TeacherSettings, FlashcardsPage).
 */
const base = '/api/prompt';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as T;
}

/** Same as fetchJson but redirects to Canvas OAuth when API returns 401 + redirectToOAuth (token expired). */
async function fetchJsonWithOAuthRedirect<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && (data as { redirectToOAuth?: boolean }).redirectToOAuth) {
    window.location.href = `/api/oauth/canvas?returnTo=${encodeURIComponent(window.location.href)}`;
    throw new Error('Redirecting to Canvas OAuth');
  }
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface PromptConfig {
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  assignmentGroupId?: string;
  newGroupName?: string;
  moduleId?: string;
  pointsPossible?: number;
  rubricId?: string;
  instructions?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
}

export interface CanvasAssignmentGroup {
  id: number;
  name: string;
}

export interface CanvasRubric {
  id: number;
  title: string;
  pointsPossible: number;
}

export interface ConfiguredAssignment {
  id: string;
  name: string;
  submissionCount: number;
  ungradedCount: number;
}

export interface CanvasModule {
  id: number;
  name: string;
  position: number;
}

function withAssignmentId(url: string, assignmentId?: string | null): string {
  const aid = assignmentId?.trim();
  if (!aid) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}assignmentId=${encodeURIComponent(aid)}`;
}

export async function getPromptConfig(assignmentId?: string | null): Promise<PromptConfig | null> {
  return fetchJsonWithOAuthRedirect<PromptConfig | null>(withAssignmentId(base + '/config', assignmentId));
}

export async function putPromptConfig(config: Partial<PromptConfig>, assignmentId?: string | null): Promise<void> {
  const res = await fetch(withAssignmentId(base + '/config', assignmentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && (data as { redirectToOAuth?: boolean }).redirectToOAuth) {
    window.location.href = `/api/oauth/canvas?returnTo=${encodeURIComponent(window.location.href)}`;
    throw new Error('Redirecting to Canvas OAuth');
  }
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
}

export async function verifyAccess(accessCode: string, fingerprint: string): Promise<{
  success: boolean;
  blocked?: boolean;
  attemptCount?: number;
}> {
  return fetchJson(base + '/verify-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode, fingerprint }),
    credentials: 'include',
  });
}

export async function savePrompt(promptText: string): Promise<void> {
  await fetch(base + '/save-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptText }),
    credentials: 'include',
  });
}

export async function submitPrompt(promptSnapshotHtml: string): Promise<void> {
  await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptSnapshotHtml }),
    credentials: 'include',
  });
}

export async function uploadVideo(blob: Blob, filename: string): Promise<{ fileId: string }> {
  const form = new FormData();
  form.append('video', blob, filename);
  const res = await fetch(base + '/upload-video', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as { fileId: string };
}

/**
 * Deep Linking (homework_submission): POST video and get HTML form that auto-posts
 * to Canvas deep_link_return_url. Caller should render the HTML (e.g. document.write)
 * so the form submits and Canvas attaches the file.
 */
export async function submitDeepLink(blob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append('video', blob, filename);
  const res = await fetch(base + '/submit-deep-link', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  return res.text();
}

export interface PromptSubmission {
  userId: string;
  userName?: string;
  body?: string;
  score?: number;
  grade?: string;
  submissionComments?: Array<{ id: number; comment: string }>;
  videoUrl?: string;
  attempt?: number;
  rubricAssessment?: Record<string, unknown>;
  /** Prompt from quiz storage (preferred when present). */
  promptHtml?: string;
}

export async function getSubmissionCount(assignmentId?: string | null): Promise<number> {
  const data = await fetchJson<{ count: number }>(withAssignmentId(base + '/submission-count', assignmentId));
  return data?.count ?? 0;
}

export async function getSubmissions(assignmentId?: string | null): Promise<PromptSubmission[]> {
  return fetchJson<PromptSubmission[]>(withAssignmentId(base + '/submissions', assignmentId));
}

export async function submitGrade(
  dto: {
    userId: string;
    score: number;
    scoreMaximum?: number;
    resultContent?: string;
    rubricAssessment?: Record<string, unknown>;
  },
  assignmentId?: string | null
): Promise<void> {
  const url = withAssignmentId(base + '/grade', assignmentId);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
    credentials: 'include',
  });
}

export async function addComment(
  userId: string,
  time: number,
  text: string,
  attempt?: number,
  assignmentId?: string | null
): Promise<{ commentId?: number }> {
  return fetchJson(withAssignmentId(base + '/comment/add', assignmentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, time, text, attempt }),
    credentials: 'include',
  });
}

export async function editComment(
  userId: string,
  commentId: string,
  time: number,
  text: string,
  assignmentId?: string | null
): Promise<void> {
  await fetch(withAssignmentId(base + '/comment/edit', assignmentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId, time, text }),
    credentials: 'include',
  });
}

export async function deleteComment(
  userId: string,
  commentId: string,
  assignmentId?: string | null
): Promise<void> {
  await fetch(withAssignmentId(base + '/comment/delete', assignmentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId }),
    credentials: 'include',
  });
}

export async function resetAttempt(userId: string, assignmentId?: string | null): Promise<void> {
  await fetch(withAssignmentId(base + '/reset-attempt', assignmentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
    credentials: 'include',
  });
}

export async function getAssignment(assignmentId?: string | null): Promise<{
  pointsPossible?: number;
  rubric?: Array<unknown>;
} | null> {
  return fetchJson(withAssignmentId(base + '/assignment', assignmentId));
}

export async function getAssignmentForViewer(assignmentId?: string | null): Promise<{
  pointsPossible?: number;
  rubric?: Array<unknown>;
} | null> {
  return fetchJson(withAssignmentId(base + '/assignment-for-viewer', assignmentId));
}

export async function getMySubmission(assignmentId?: string | null): Promise<PromptSubmission | null> {
  return fetchJson(withAssignmentId(base + '/my-submission', assignmentId));
}

export async function getConfiguredAssignments(): Promise<ConfiguredAssignment[]> {
  return fetchJsonWithOAuthRedirect<ConfiguredAssignment[]>(base + '/configured-assignments');
}

export async function getAssignmentGroups(): Promise<CanvasAssignmentGroup[]> {
  return fetchJsonWithOAuthRedirect<CanvasAssignmentGroup[]>(base + '/assignment-groups');
}

export async function getRubrics(): Promise<CanvasRubric[]> {
  return fetchJsonWithOAuthRedirect<CanvasRubric[]>(base + '/rubrics');
}

export async function createAssignmentGroup(name: string): Promise<CanvasAssignmentGroup> {
  return fetchJsonWithOAuthRedirect<CanvasAssignmentGroup>(base + '/assignment-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    credentials: 'include',
  });
}

export async function getModules(): Promise<CanvasModule[]> {
  return fetchJsonWithOAuthRedirect<CanvasModule[]>(base + '/modules');
}

export async function createModule(
  name: string,
  position?: number
): Promise<CanvasModule> {
  return fetchJsonWithOAuthRedirect<CanvasModule>(base + '/modules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() || 'New Module', position }),
    credentials: 'include',
  });
}

export async function createAssignment(
  name: string,
  options?: { assignmentGroupId?: string; newGroupName?: string }
): Promise<{ assignmentId: string }> {
  const body: { name: string; assignmentGroupId?: string; newGroupName?: string } = { name };
  if (options?.assignmentGroupId != null) body.assignmentGroupId = options.assignmentGroupId;
  if (options?.newGroupName != null) body.newGroupName = options.newGroupName;
  return fetchJsonWithOAuthRedirect<{ assignmentId: string }>(base + '/create-assignment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
}
