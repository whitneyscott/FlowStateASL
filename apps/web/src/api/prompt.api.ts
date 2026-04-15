/**
 * Prompt Manager API client.
 * Sends Authorization Bearer from in-memory auth token.
 */
import { ltiTokenHeaders } from './lti-token';
import { appendBridgeLog } from '../utils/bridge-log';

const base = '/api/prompt';
export const DEFAULT_UPLOAD_MAX_BYTES = 80 * 1024 * 1024;

function apiInit(init?: RequestInit): RequestInit {
  const headers = { ...ltiTokenHeaders(), ...(init?.headers as Record<string, string>) };
  return { ...init, credentials: 'include' as RequestCredentials, headers };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, apiInit(init));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 503) {
      throw new Error('Server temporarily unavailable, please try again shortly.');
    }
    throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

async function getErrorMessage(res: Response): Promise<string> {
  if (res.status === 429) return 'Server is busy with other uploads. Please wait about 30 seconds and try again.';
  if (res.status === 503) return 'Server temporarily unavailable, please try again shortly.';
  if (res.status === 504) return 'Upload timed out. Please try again in a moment.';
  if (res.status === 413) return `Video is too large. Please keep it under ${Math.round(DEFAULT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    const msg = (data as { message?: string; error?: string }).message ?? (data as { error?: string }).error;
    if (msg) return msg;
  } else {
    const text = await res.text().catch(() => '');
    if (text) return text.slice(0, 300);
  }
  return `HTTP ${res.status}`;
}

/** Error thrown when LTI 1.1 user needs to enter manual token (no OAuth support). */
export class NeedsManualTokenError extends Error {
  constructor(message?: string) {
    super(message ?? 'Canvas API token required. LTI 1.1 does not support OAuth.');
    this.name = 'NeedsManualTokenError';
  }
}

/** Same as fetchJson but redirects to Canvas OAuth when API returns 401 + redirectToOAuth (token expired). */
async function fetchJsonWithOAuthRedirect<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, apiInit(init));
  const data = await res.json().catch(() => ({}));
  const body = data as { redirectToOAuth?: boolean; needsManualToken?: boolean; message?: string };
  if (res.status === 401 && body.redirectToOAuth) {
    window.location.href = `/api/oauth/canvas?returnTo=${encodeURIComponent(window.location.href)}`;
    throw new Error('Redirecting to Canvas OAuth');
  }
  if (res.status === 401 && body.needsManualToken) {
    throw new NeedsManualTokenError(body.message);
  }
  if (!res.ok) {
    if (res.status === 503) {
      throw new Error('Server temporarily unavailable, please try again shortly.');
    }
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export interface DeckConfig {
  id: string;
  title: string;
}

export interface VideoPromptConfig {
  selectedDecks: DeckConfig[];
  totalCards: number;
  storedPromptBanks?: Array<Array<{ title: string; videoId?: string; duration: number }>>;
  staticFallbackPrompts?: string[];
}

export interface YoutubePromptConfig {
  videoId: string;
  label?: string;
  clipStartSec: number;
  clipEndSec: number;
}

/** Client → PUT /config for youtube mode (server normalizes urlOrId/videoId to persisted YoutubePromptConfig). */
export interface YoutubePromptConfigInput {
  urlOrId?: string;
  videoId?: string;
  label?: string;
  clipStartSec?: number;
  clipEndSec?: number;
  /** @deprecated Server maps to clip window from clipStartSec. */
  durationSec?: number;
}

export interface PromptConfig {
  /** From GET /config: submission target after server resolution from Prompt Manager Settings. */
  resolvedAssignmentId?: string;
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
  promptMode?: 'text' | 'decks' | 'youtube';
  videoPromptConfig?: VideoPromptConfig;
  youtubePromptConfig?: YoutubePromptConfig;
}

export interface DeckPromptItem {
  title: string;
  videoId?: string;
  duration: number;
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

export async function putPromptConfig(
  config: Omit<Partial<PromptConfig>, 'youtubePromptConfig'> & { youtubePromptConfig?: YoutubePromptConfigInput },
  assignmentId?: string | null
): Promise<void> {
  const res = await fetch(withAssignmentId(base + '/config', assignmentId), apiInit({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }));
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
}

export async function verifyAccess(
  accessCode: string,
  fingerprint: string,
  assignmentId?: string | null
): Promise<{
  success: boolean;
  blocked?: boolean;
  attemptCount?: number;
}> {
  return fetchJson(withAssignmentId(base + '/verify-access', assignmentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode, fingerprint }),
    credentials: 'include',
  });
}

/** Deck submissions: prompt card boundaries in seconds from start of recording (actual MediaRecorder timeline). */
export interface DeckTimelineEntry {
  title: string;
  startSec: number;
  /** Sprout source video id for this prompt card (when deck mode used Sprout-backed items). */
  videoId?: string;
}

export async function savePrompt(promptText: string, assignmentId?: string | null): Promise<void> {
  const res = await fetch(withAssignmentId(base + '/save-prompt', assignmentId), apiInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptText }),
  }));
  if (!res.ok) throw new Error(await getErrorMessage(res));
}

export async function submitPrompt(
  promptSnapshotHtml: string | undefined,
  assignmentId?: string | null,
  deckTimeline?: DeckTimelineEntry[],
  options?: { idempotencyKey?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};
  const snap = promptSnapshotHtml?.trim();
  if (snap) body.promptSnapshotHtml = snap;
  if (deckTimeline?.length) {
    body.deckTimeline = deckTimeline;
  }
  // #region agent log
  appendBridgeLog('agent-debug', 'submitPrompt: outgoing POST /submit JSON keys', {
    hypothesisId: 'H1',
    keys: Object.keys(body),
    hasBoth: !!(body.promptSnapshotHtml && body.deckTimeline),
    deckLen: Array.isArray(body.deckTimeline) ? body.deckTimeline.length : 0,
  });
  // #endregion
  const res = await fetch(withAssignmentId(base + '/submit', assignmentId), apiInit({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(await getErrorMessage(res));
}

/** Canvas upload pipeline audit (same request as Bridge log when single API instance). */
export type PromptUploadVideoVerify = {
  submissionFetched: boolean;
  workflow_state?: string;
  submission_type?: string;
  attachmentCount: number;
  hasPlaybackUrl: boolean;
};

export type PromptUploadVideoResult = {
  status?: string;
  fileId: string;
  courseId?: string;
  assignmentId?: string;
  studentUserId?: string;
  studentIdSource?: string;
  verify?: PromptUploadVideoVerify;
};

/** Stored on submission after upload (JSON comment) for grading replay. */
export type MediaStimulusPayload =
  | { kind: 'youtube'; videoId: string; clipStartSec: number; clipEndSec: number; label?: string };

export async function uploadVideo(
  blob: Blob,
  filename: string,
  assignmentId?: string | null,
  options?: {
    deckTimeline?: DeckTimelineEntry[];
    /** Text/HTML prompt snapshot for non-deck uploads; stored in post-upload submission comment JSON. */
    promptSnapshotHtml?: string;
    /** Pre-recording stimulus (e.g. YouTube clip) shown in TeacherViewer. */
    mediaStimulus?: MediaStimulusPayload;
    idempotencyKey?: string;
    /** Client-measured recording length (seconds); omitted if unknown. */
    durationSeconds?: number;
    captureProfile?: {
      profileId?: string;
      requestedWidth?: number;
      requestedHeight?: number;
      requestedFps?: number;
      actualWidth?: number;
      actualHeight?: number;
      actualFps?: number;
      mimeType?: string;
      videoBitsPerSecond?: number;
      audioBitsPerSecond?: number;
    };
  },
): Promise<PromptUploadVideoResult> {
  const form = new FormData();
  form.append('video', blob, filename);
  if (options?.deckTimeline?.length) {
    form.append('deckTimeline', JSON.stringify(options.deckTimeline));
  }
  if (options?.promptSnapshotHtml?.trim()) {
    form.append('promptSnapshotHtml', options.promptSnapshotHtml.trim());
  }
  if (options?.mediaStimulus) {
    form.append('mediaStimulus', JSON.stringify(options.mediaStimulus));
  }
  if (options?.captureProfile) {
    form.append('captureProfile', JSON.stringify(options.captureProfile));
  }
  if (options?.durationSeconds != null && Number.isFinite(options.durationSeconds)) {
    form.append('durationSeconds', String(options.durationSeconds));
  }
  const res = await fetch(withAssignmentId(base + '/upload-video', assignmentId), apiInit({
    method: 'POST',
    headers: options?.idempotencyKey ? { 'x-idempotency-key': options.idempotencyKey } : undefined,
    body: form,
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallbackMessage = (data as { message?: string }).message ?? (await getErrorMessage(res));
    throw new Error(fallbackMessage || `HTTP ${res.status}`);
  }
  return data as PromptUploadVideoResult;
}

/**
 * Deep Linking (homework_submission): POST video and get HTML form that auto-posts
 * to Canvas deep_link_return_url. Caller should render the HTML (e.g. document.write)
 * so the form submits and Canvas attaches the file.
 */
/** In dev the API may return { html, dev: { message, delayMs, contentItemTitle?, videoTitle? } } for console logging and redirect delay. */
export type SubmitDeepLinkResult =
  | string
  | {
      html: string;
      dev: {
        message: string;
        delayMs: number;
        contentItemTitle?: string | null;
        videoTitle?: string | null;
      };
    };

export async function submitDeepLink(
  blob: Blob,
  filename: string,
  assignmentId?: string | null
): Promise<SubmitDeepLinkResult> {
  const form = new FormData();
  form.append('video', blob, filename);
  const res = await fetch(withAssignmentId(base + '/submit-deep-link', assignmentId), apiInit({ method: 'POST', body: form }));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('application/json')) {
    return JSON.parse(text) as SubmitDeepLinkResult;
  }
  return text;
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
  /** Prompt HTML resolved from submission comments/body. */
  promptHtml?: string;
  /** From submission comment JSON, prompt-config fallback, or unknown. */
  videoDurationSeconds?: number | null;
  durationSource?: 'submission' | 'prompts' | 'unknown';
  /** Canvas assignment allowed_attempts when returned with my-submission (-1 = unlimited). */
  allowedAttempts?: number;
}

export async function getSubmissionCount(assignmentId?: string | null): Promise<number> {
  const data = await fetchJson<{ count: number }>(withAssignmentId(base + '/submission-count', assignmentId));
  return data?.count ?? 0;
}

export async function getSubmissions(assignmentId?: string | null): Promise<PromptSubmission[]> {
  return fetchJson<PromptSubmission[]>(withAssignmentId(base + '/submissions', assignmentId));
}

export type SubmitGradeResponse = { ok?: boolean; score?: number; grade?: string };

export async function submitGrade(
  dto: {
    userId: string;
    score: number;
    scoreMaximum?: number;
    resultContent?: string;
    rubricAssessment?: Record<string, unknown>;
  },
  assignmentId?: string | null
): Promise<SubmitGradeResponse> {
  const url = withAssignmentId(base + '/grade', assignmentId);
  return fetchJson<SubmitGradeResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
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
  await fetch(withAssignmentId(base + '/comment/edit', assignmentId), apiInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId, time, text }),
  }));
}

export async function deleteComment(
  userId: string,
  commentId: string,
  assignmentId?: string | null
): Promise<void> {
  await fetch(withAssignmentId(base + '/comment/delete', assignmentId), apiInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, commentId }),
  }));
}

export async function resetAttempt(userId: string, assignmentId?: string | null): Promise<void> {
  await fetch(withAssignmentId(base + '/reset-attempt', assignmentId), apiInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  }));
}

export async function getAssignment(assignmentId?: string | null): Promise<{
  name?: string;
  pointsPossible?: number;
  rubric?: Array<unknown>;
  sproutAccountId?: string;
  allowedAttempts?: number;
  promptMode?: 'text' | 'decks' | 'youtube';
  textPrompts?: string[];
  youtubeLabel?: string;
} | null> {
  return fetchJson(withAssignmentId(base + '/assignment', assignmentId));
}

export async function getAssignmentForViewer(assignmentId?: string | null): Promise<{
  name?: string;
  pointsPossible?: number;
  rubric?: Array<unknown>;
  sproutAccountId?: string;
  allowedAttempts?: number;
  promptMode?: 'text' | 'decks' | 'youtube';
  textPrompts?: string[];
  youtubeLabel?: string;
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

export async function deleteConfiguredAssignment(assignmentId: string): Promise<void> {
  const res = await fetch(`${base}/configured-assignments/${encodeURIComponent(assignmentId)}`, apiInit({
    method: 'DELETE',
  }));
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
}

export async function buildDeckPrompts(
  selectedDecks: DeckConfig[],
  totalCards: number,
  assignmentId?: string | null
): Promise<{ prompts: DeckPromptItem[]; warning?: string }> {
  const res = await fetch(withAssignmentId(base + '/build-deck-prompts', assignmentId), apiInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedDecks, totalCards }),
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as { prompts: DeckPromptItem[]; warning?: string };
}
