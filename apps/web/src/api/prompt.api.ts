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

export interface PromptConfig {
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  pointsPossible?: number;
  rubricId?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
  shadowAssignmentId?: string;
}

export async function getPromptConfig(): Promise<PromptConfig | null> {
  return fetchJson<PromptConfig | null>(base + '/config');
}

export async function putPromptConfig(config: Partial<PromptConfig>): Promise<void> {
  const res = await fetch(base + '/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
    credentials: 'include',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  }
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

export interface PromptSubmission {
  userId: string;
  userName?: string;
  body?: string;
  score?: number;
  grade?: string;
  submissionComments?: Array<{ id: number; comment: string }>;
  videoUrl?: string;
}

export async function getSubmissions(): Promise<PromptSubmission[]> {
  return fetchJson<PromptSubmission[]>(base + '/submissions');
}

export async function submitGrade(dto: {
  userId: string;
  score: number;
  scoreMaximum?: number;
  resultContent?: string;
  rubricAssessment?: Record<string, unknown>;
}): Promise<void> {
  await fetch(base + '/grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
    credentials: 'include',
  });
}

export async function addComment(userId: string, time: number, text: string, attempt?: number): Promise<{ commentId?: number }> {
  return fetchJson(base + '/comment/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, time, text, attempt }),
    credentials: 'include',
  });
}

export async function editComment(userId: string, commentId: string, time: number, text: string): Promise<void> {
  await fetch(base + '/comment/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId, time, text }),
    credentials: 'include',
  });
}

export async function deleteComment(userId: string, commentId: string): Promise<void> {
  await fetch(base + '/comment/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId }),
    credentials: 'include',
  });
}

export async function resetAttempt(userId: string): Promise<void> {
  await fetch(base + '/reset-attempt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
    credentials: 'include',
  });
}

export async function getAssignment(): Promise<{ pointsPossible?: number; rubric?: Array<unknown> } | null> {
  return fetchJson(base + '/assignment');
}
