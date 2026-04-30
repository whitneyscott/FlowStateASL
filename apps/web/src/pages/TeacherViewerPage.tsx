import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import * as promptApi from '../api/prompt.api';
import { appendBridgeLog } from '../utils/bridge-log';
import { GradingVideoPlayer } from '../components/GradingVideoPlayer';
import { GradingPlaybackBar } from '../components/GradingPlaybackBar';
import { SproutSourceCardModal } from '../components/SproutSourceCardModal';
import { buildSproutVideoEmbedUrl } from '../utils/sprout-embed';
import { YoutubeStimulusShell } from '../components/YoutubeStimulusShell';
import { YoutubeIframePlayer, type YoutubeIframePlayerHandle } from '../components/YoutubeIframePlayer';
import { AppBlockingLoader } from '../components/AppBlockingLoader';
import { CaptionsAccessibilityPanel } from '../components/CaptionsAccessibilityPanel';
import { TeacherFeedbackRichEditor } from '../components/TeacherFeedbackRichEditor';
import {
  feedbackEditorIsEmpty,
  sanitizeTeacherFeedbackHtml,
  sanitizeTeacherFeedbackHtmlForDisplay,
} from '../utils/teacher-feedback-html';
import './PrompterPage.css';

interface FeedbackEntry {
  id: number;
  time: number;
  text: string;
}

function parseTimestampedFeedback(comments: Array<{ id: number; comment: string }>): FeedbackEntry[] {
  if (!comments?.length) return [];
  const out: FeedbackEntry[] = [];
  const re = /^\[(\d+):(\d+)\]\s*(.*)$/s;
  for (const c of comments) {
    const txt = (c.comment ?? '').trim();
    const m = re.exec(txt);
    if (m) {
      const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      out.push({ id: c.id, time: sec, text: (m[3] ?? '').trim() });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function FeedbackHtmlSnippet({ html }: { html: string }) {
  const safe = sanitizeTeacherFeedbackHtmlForDisplay(html);
  if (!safe) return <span className="prompter-viewer-feedback-empty-inline">—</span>;
  return <span className="teacher-feedback-html-display" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function appendViewerBridgeLog(message: string, extra?: Record<string, unknown>): void {
  appendBridgeLog('viewer', message, extra);
}

/** Populated after getSubmissions (background warm, concurrency-limited). */
type PrefetchedGradingMedia = Pick<
  promptApi.PromptSubmission,
  'captionsVtt' | 'promptHtml' | 'videoDurationSeconds' | 'durationSource' | 'mediaStimulus' | 'deckTimeline'
>;

/** Deck submissions: real boundaries from the student recorder (seconds from recording start). */
interface DeckTimelineEntry {
  title: string;
  startSec: number;
  /** Sprout source video id for this prompt (optional on older submissions). */
  videoId?: string;
  /** Second Sprout embed path segment (optional on older submissions). */
  securityToken?: string;
}

function deckTimelineFromParsedJson(parsed: { deckTimeline?: unknown }): DeckTimelineEntry[] {
  const raw = parsed.deckTimeline;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: DeckTimelineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { title?: unknown; startSec?: unknown; videoId?: unknown; securityToken?: unknown };
    const title = String(o.title ?? '');
    const startSec = Number(o.startSec);
    if (!Number.isFinite(startSec)) continue;
    const vid = String(o.videoId ?? '').trim();
    const st = String((o as { securityToken?: unknown }).securityToken ?? '').trim();
    out.push({ title, startSec, ...(vid ? { videoId: vid } : {}), ...(st ? { securityToken: st } : {}) });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

/** Legacy: deck timeline sometimes lived only in submission body JSON (before video overwrote body). */
function parseDeckTimelineFromBody(body: string | undefined): DeckTimelineEntry[] {
  if (!body?.trim()) return [];
  try {
    return deckTimelineFromParsedJson(JSON.parse(body) as { deckTimeline?: unknown });
  } catch {
    return [];
  }
}

/**
 * After video upload, deckTimeline lives in JSON submission comments (Canvas replaces body).
 * Prefer the **latest** comment with a non-empty deckTimeline so multi-attempt submissions match the
 * current video; fall back to submission body only if no such comment exists (legacy).
 */
function parseDeckTimelineFromSubmissionComments(
  comments: Array<{ comment?: string }> | undefined,
): DeckTimelineEntry[] {
  if (!comments?.length) return [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const txt = (comments[i].comment ?? '').trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt) as { deckTimeline?: unknown };
      const rows = deckTimelineFromParsedJson(parsed);
      if (rows.length > 0) return rows;
    } catch {
      // not JSON — skip
    }
  }
  return [];
}

function resolveDeckTimeline(
  body: string | undefined,
  comments: Array<{ comment?: string }> | undefined,
): DeckTimelineEntry[] {
  const fromComments = parseDeckTimelineFromSubmissionComments(comments);
  if (fromComments.length > 0) return fromComments;
  return parseDeckTimelineFromBody(body);
}

function activeDeckPromptAt(t: number, segments: DeckTimelineEntry[]): DeckTimelineEntry | null {
  if (segments.length === 0) return null;
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].startSec;
    const nextStart = i + 1 < segments.length ? segments[i + 1].startSec : Infinity;
    if (t >= start && t < nextStart) return segments[i];
  }
  return null;
}

/**
 * Card segment index for playhead/feedback: deck uses [start, next start) (last extends to video end);
 * no deck = one virtual segment 0 (whole response).
 */
function playheadCardSegmentIndex(
  t: number,
  deckTimeline: DeckTimelineEntry[],
  videoDurationSec: number | null | undefined,
): number {
  if (deckTimeline.length === 0) return 0;
  const lastEnd =
    videoDurationSec != null && Number.isFinite(videoDurationSec) && videoDurationSec > 0
      ? videoDurationSec
      : Infinity;
  for (let i = 0; i < deckTimeline.length; i++) {
    const start = deckTimeline[i].startSec;
    const end = i + 1 < deckTimeline.length ? deckTimeline[i + 1].startSec : lastEnd;
    if (t >= start && t < end) return i;
  }
  if (t < deckTimeline[0].startSec) return -1;
  return deckTimeline.length - 1;
}

function rubricCriterionDeckIndex(
  criterion: RubricCriterion,
  criterionIdx: number,
  rubricLength: number,
  deckLength: number,
): number | null {
  if (deckLength <= 0) return null;
  const desc = String(criterion.description ?? '').trim();
  const cardMatch = /\b(?:card|prompt|item)\s*(\d{1,3})\b/i.exec(desc);
  if (cardMatch) {
    const n = Number.parseInt(cardMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= deckLength) return n - 1;
  }
  const leadingMatch = /^\s*(\d{1,3})\s*[\)\].:-]/.exec(desc);
  if (leadingMatch) {
    const n = Number.parseInt(leadingMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= deckLength) return n - 1;
  }
  if (rubricLength === deckLength && criterionIdx >= 0 && criterionIdx < deckLength) {
    return criterionIdx;
  }
  return null;
}

function htmlFromDeckTimelineRows(rows: DeckTimelineEntry[]): string {
  const parts = rows.map((r) => r.title.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join('<hr class="fsasl-deck-prompt-sep" />') : '';
}

function getPromptFromComments(
  body: string | undefined,
  comments: Array<{ comment: string }> | undefined,
  promptHtml?: string
): string {
  if (promptHtml?.trim()) return promptHtml;
  if (body?.trim()) {
    try {
      const parsed = JSON.parse(body) as { promptSnapshotHtml?: string; deckTimeline?: unknown };
      if (parsed.promptSnapshotHtml) return parsed.promptSnapshotHtml;
      const fromDeckBody = deckTimelineFromParsedJson(parsed);
      const joinedBody = htmlFromDeckTimelineRows(fromDeckBody);
      if (joinedBody) return joinedBody;
    } catch {
      return body;
    }
  }
  if (!comments?.length) return 'No prompt recorded.';
  for (const c of comments) {
    const txt = (c.comment ?? '').trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt) as { promptSnapshotHtml?: string; deckTimeline?: unknown };
      if (parsed.promptSnapshotHtml?.trim()) return parsed.promptSnapshotHtml.trim();
      const fromDeck = deckTimelineFromParsedJson(parsed);
      const joined = htmlFromDeckTimelineRows(fromDeck);
      if (joined) return joined;
    } catch {
      // not JSON — try next comment or fall through to legacy heuristics
    }
  }
  let lastIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    const txt = (comments[i].comment ?? '').trim();
    const isLegacy = /^Prompt used:/i.test(txt);
    const hasMarkup = txt.includes('<') && txt.includes('>');
    if (isLegacy || hasMarkup) lastIdx = i;
  }
  if (lastIdx >= 0) {
    const raw = (comments[lastIdx].comment ?? '').trim();
    return /^Prompt used:/i.test(raw) ? raw.replace(/^Prompt used:\s*/i, '').trim() : raw;
  }
  return 'No prompt recorded.';
}

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

const ENABLE_TEACHER_VIEWER_DEBUG_LOG =
  import.meta.env.DEV &&
  (new URLSearchParams(window.location.search).has('debugTeacherViewer') ||
    window.localStorage.getItem('fs_debug_teacher_viewer') === '1');

function teacherViewerDbg(...args: unknown[]): void {
  if (ENABLE_TEACHER_VIEWER_DEBUG_LOG) console.log(...args);
}

// TEMP DIAGNOSTIC FLAG: opt-in via debug gate above.
const ENABLE_RESIZE_DEBUG_LOG = ENABLE_TEACHER_VIEWER_DEBUG_LOG;

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  return TEACHER_PATTERNS.some((p) => roles.toLowerCase().includes(p));
}

interface TeacherViewerPageProps {
  context: LtiContext | null;
}

type RubricCriterion = {
  id?: string;
  description?: string;
  points?: number;
  ratings?: Array<{ id?: string; description?: string; points?: number }>;
};

type RubricCriterionDraft = {
  rating_id?: string;
  points?: number;
  comments?: string;
};

const CANVAS_RUBRIC_CRITERION_COMMENT_MAX_CHARS = 8192;
const RUBRIC_PROMPT_PREFIX = 'Prompt: ';

/** Context for stripping / composing Canvas rubric criterion `comments` with a leading Prompt: line. */
type RubricPromptEditorContext = {
  deckTimeline: DeckTimelineEntry[];
  resolvedDeckIndices: Array<number | null>;
  textPrompts?: string[];
  youtubeLabel?: string;
};

function stripHtmlToPlain(html: string): string {
  if (typeof document !== 'undefined') {
    const d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripPromptPrefixFromCanvasComment(full: string | undefined, expectedPromptPlain: string): string {
  const f = (full ?? '').trim();
  if (!f) return '';
  const exp = expectedPromptPlain.trim();
  if (!exp) return f;
  const head = `${RUBRIC_PROMPT_PREFIX}${exp}`;
  if (f.startsWith(head + '\n\n')) return f.slice(head.length + 2).trimStart();
  if (f.startsWith(head)) {
    const rest = f.slice(head.length).trimStart();
    if (rest.startsWith('\n\n')) return rest.slice(2).trimStart();
    return rest;
  }
  return f;
}

function clampRubricComment(s: string): string {
  if (s.length <= CANVAS_RUBRIC_CRITERION_COMMENT_MAX_CHARS) return s;
  return s.slice(0, CANVAS_RUBRIC_CRITERION_COMMENT_MAX_CHARS);
}

function composeCanvasCriterionComment(expectedPlain: string, teacherSuffix: string): string {
  const ev = expectedPlain.trim();
  const ts = teacherSuffix.trim();
  if (!ev) return clampRubricComment(ts);
  const prefixBody = `${RUBRIC_PROMPT_PREFIX}${ev}`;
  if (!ts) return clampRubricComment(prefixBody);
  return clampRubricComment(`${prefixBody}\n\n${ts}`);
}

function getCriterionExpectedPromptPlain(
  rowIdx: number,
  c: RubricCriterion,
  rubricList: RubricCriterion[],
  ctx: RubricPromptEditorContext,
): string {
  const dIdx = ctx.resolvedDeckIndices[rowIdx];
  if (dIdx != null && dIdx >= 0 && dIdx < ctx.deckTimeline.length) {
    return stripHtmlToPlain(ctx.deckTimeline[dIdx].title || '');
  }
  const yl = (ctx.youtubeLabel ?? '').trim();
  if (yl) return stripHtmlToPlain(yl);
  const tp = ctx.textPrompts;
  if (tp && tp.length === rubricList.length) {
    return stripHtmlToPlain(String(tp[rowIdx] ?? ''));
  }
  return stripHtmlToPlain(String(c.description ?? ''));
}

/** Canvas sometimes uses `_<criterionId>` keys in rubric_assessment. */
function pickRubricCriterionAssessment(
  raw: Record<string, unknown> | undefined,
  c: RubricCriterion,
  critId: string,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const keys = [
    ...new Set(
      [critId, String(c.id), c.id != null ? `_${String(c.id)}` : '', `_${critId}`].filter((k) => k.length > 0),
    ),
  ];
  for (const key of keys) {
    const v = raw[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return undefined;
}

function getRubricRowAssessment(
  assessMap: Record<string, { rating_id?: string; points?: number; comments?: string }>,
  c: RubricCriterion,
  critId: string,
): { rating_id?: string; points?: number; comments?: string } | undefined {
  const row = pickRubricCriterionAssessment(assessMap as Record<string, unknown>, c, critId);
  return row as { rating_id?: string; points?: number; comments?: string } | undefined;
}

function parseRubricAssessmentToDraft(
  raw: Record<string, unknown> | undefined,
  rubricList: RubricCriterion[],
  promptCtx?: RubricPromptEditorContext,
): Record<string, RubricCriterionDraft> {
  const out: Record<string, RubricCriterionDraft> = {};
  rubricList.forEach((c, idx) => {
    const critId = String(c.id ?? idx);
    const o = pickRubricCriterionAssessment(raw, c, critId);
    if (o) {
      const rid = o.rating_id;
      const pts = o.points;
      const com = o.comments;
      const entry: RubricCriterionDraft = {
        rating_id: rid != null ? String(rid) : undefined,
        points: pts != null ? Number(pts) : undefined,
      };
      if (typeof com === 'string') {
        const expected = promptCtx ? getCriterionExpectedPromptPlain(idx, c, rubricList, promptCtx) : '';
        entry.comments =
          promptCtx && expected.trim()
            ? stripPromptPrefixFromCanvasComment(com, expected)
            : com.trim();
      } else if (com != null) entry.comments = String(com);
      out[critId] = entry;
    } else {
      out[critId] = {};
    }
  });
  return out;
}

/** Sum earned points from draft (preferred) or loaded Canvas assessment when at least one criterion is rated. */
function sumRubricEarnedPoints(
  rubricList: RubricCriterion[],
  draft: Record<string, RubricCriterionDraft>,
  assess: Record<string, { rating_id?: string; points?: number }>,
): number | null {
  if (!rubricList.length) return null;
  let sum = 0;
  let anyRated = false;
  for (let idx = 0; idx < rubricList.length; idx++) {
    const c = rubricList[idx];
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    const a = getRubricRowAssessment(assess, c, critId);
    let pts: number | undefined;
    if (d?.rating_id != null && d.points != null && Number.isFinite(d.points)) pts = d.points;
    else if (a?.rating_id != null && a.points != null && Number.isFinite(Number(a.points))) pts = Number(a.points);
    if (pts != null) {
      anyRated = true;
      sum += pts;
    }
  }
  return anyRated ? sum : null;
}

/**
 * Build Canvas rubric_assessment payload.
 * Include `comments` when the draft has a `comments` property (including empty string) so clearing the UI sends "" to Canvas.
 */
function buildRubricAssessmentPayload(
  rubricList: RubricCriterion[],
  draft: Record<string, RubricCriterionDraft>,
  promptCtx?: RubricPromptEditorContext,
): Record<string, Record<string, unknown>> {
  const payload: Record<string, Record<string, unknown>> = {};
  rubricList.forEach((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    if (!d) return;
    const hasRating = d.rating_id != null && d.points != null && Number.isFinite(Number(d.points));
    const row: Record<string, unknown> = {};
    if (hasRating) {
      row.rating_id = d.rating_id;
      row.points = Number(d.points);
    }
    const teacherSuffix = 'comments' in d && typeof d.comments === 'string' ? d.comments : '';
    const expected =
      promptCtx != null ? getCriterionExpectedPromptPlain(idx, c, rubricList, promptCtx) : '';

    // Canvas only persists criterion comments when we send `comments` on the PUT. A rating click alone
    // must still ship `Prompt: <value>` (plus optional teacher suffix) so SpeedGrader / students see it.
    if (promptCtx != null && expected.trim().length > 0) {
      if (hasRating || 'comments' in d) {
        row.comments = composeCanvasCriterionComment(expected, teacherSuffix);
      }
    } else if ('comments' in d) {
      row.comments = teacherSuffix.trim();
    }
    if (Object.keys(row).length > 0) {
      const keyVariants = new Set<string>([
        critId,
        ...(c.id != null ? [String(c.id), `_${String(c.id)}`] : []),
        `_${critId}`,
      ]);
      keyVariants.forEach((k) => {
        if (k) payload[k] = { ...row };
      });
    }
  });
  return payload;
}
function rubricDraftHasPayload(rubricList: RubricCriterion[], draft: Record<string, RubricCriterionDraft>): boolean {
  return rubricList.some((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    if (!d) return false;
    if (d.rating_id != null && d.points != null) return true;
    return 'comments' in d;
  });
}

function rubricDraftHasAnyRating(rubricList: RubricCriterion[], draft: Record<string, RubricCriterionDraft>): boolean {
  return rubricList.some((c, idx) => {
    const critId = String(c.id ?? idx);
    const d = draft[critId];
    return d?.rating_id != null && d.points != null;
  });
}

function criterionRubricRowIsIncorrect(
  c: RubricCriterion,
  critId: string,
  draft: Record<string, RubricCriterionDraft>,
  assess: Record<string, { rating_id?: string; points?: number }>,
): boolean {
  const d = draft[critId];
  const a = getRubricRowAssessment(assess, c, critId);
  const maxPts = c.points != null ? Number(c.points) : NaN;
  if (!Number.isFinite(maxPts)) return false;
  const earned =
    d?.points != null && Number.isFinite(Number(d.points))
      ? Number(d.points)
      : a?.points != null && Number.isFinite(Number(a.points))
        ? Number(a.points)
        : undefined;
  if (earned == null) return false;
  const rated =
    (d?.rating_id != null && String(d.rating_id).trim() !== '') ||
    (a?.rating_id != null && String(a.rating_id).trim() !== '');
  if (!rated) return false;
  return earned < maxPts;
}

export default function TeacherViewerPage({ context }: TeacherViewerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [searchParams, setSearchParams] = useSearchParams();
  const assignmentIdFromUrl = searchParams.get('assignmentId') ?? '';
  const gradingFromUrl = searchParams.get('grading') === '1';
  const ctxAssignmentId = resolveLtiContextValue(context?.assignmentId);
  /** Deep links use `?assignmentId=`; prefer that over LTI context when both are set. */
  const assignmentId = (assignmentIdFromUrl.trim() || ctxAssignmentId) || null;

  const [submissions, setSubmissions] = useState<promptApi.PromptSubmission[]>([]);
  const [gradingPrefetchByUserId, setGradingPrefetchByUserId] = useState<Map<string, PrefetchedGradingMedia>>(
    () => new Map(),
  );
  const [submissionCount, setSubmissionCount] = useState<number | null>(null);
  const [assignment, setAssignment] = useState<{
    name?: string;
    pointsPossible?: number;
    rubric?: Array<unknown>;
    sproutAccountId?: string;
    allowedAttempts?: number;
    promptMode?: 'text' | 'decks' | 'youtube';
    textPrompts?: string[];
    youtubeLabel?: string;
    youtubePromptConfig?: {
      allowStudentCaptions: boolean;
      subtitleMask: { enabled: boolean; heightPercent: number };
    };
    signToVoiceRequired?: boolean;
  } | null>(null);
  const [mySubmission, setMySubmission] = useState<promptApi.PromptSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [gradeValue, setGradeValue] = useState('');
  const [gradeSaveStatus, setGradeSaveStatus] = useState('');
  const [rubricSaveStatus, setRubricSaveStatus] = useState('');
  const [resetStatus, setResetStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentEditorRef = useRef<HTMLDivElement | null>(null);
  const feedbackEditModalEditorRef = useRef<HTMLDivElement | null>(null);
  const [feedbackEditEntry, setFeedbackEditEntry] = useState<FeedbackEntry | null>(null);
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [rubricDraft, setRubricDraft] = useState<Record<string, RubricCriterionDraft>>({});
  const rubricPromptEditorCtxRef = useRef<RubricPromptEditorContext | undefined>(undefined);
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Snap free-form feedback to the same deck row as the center panel (activeDeckRubricRowIndex), not raw video.currentTime. */
  const deckFeedbackAnchorRef = useRef({
    isDeckPromptMode: false,
    deckTimeline: [] as DeckTimelineEntry[],
    activeDeckRubricRowIndex: -1,
    resolvedRubricDeckIndexMap: [] as Array<number | null>,
    activeDeckPrompt: null as DeckTimelineEntry | null,
    currentTime: 0,
  });
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const rightSidebarRef = useRef<HTMLDivElement>(null);
  const resizeDebugLastSentAtRef = useRef(0);
  const [textPromptVisible, setTextPromptVisible] = useState(false);
  const [captionHelpOpen, setCaptionHelpOpen] = useState(false);
  /** Student: side-by-side model video when the active deck card has a not–full-credit rubric score. */
  const [showIncorrectSourceBeside, setShowIncorrectSourceBeside] = useState(true);
  const [sourceCardPreview, setSourceCardPreview] = useState<{
    videoId: string;
    securityToken: string;
  } | null>(null);
  const ytStimulusRef = useRef<YoutubeIframePlayerHandle>(null);
  const [teacherStimulusCaptions, setTeacherStimulusCaptions] = useState(false);
  const [studentStimulusCaptions, setStudentStimulusCaptions] = useState(false);
  const [youtubeStimulusRuntimeError, setYoutubeStimulusRuntimeError] = useState<string | null>(null);

  const isDev = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const teacher = context && isTeacher(context.roles);
  /* Teachers with assignmentId are treated as grading mode even without grading=1 (e.g. Config "Open for Grading" or direct link). */
  const gradingMode = teacher && (gradingFromUrl || !!assignmentId);
  const current = gradingMode ? submissions[index] : mySubmission;
  const noSubmissionsInGradingMode = gradingMode && submissions.length === 0;

  const promptUsedResolved = useMemo(
    () => getPromptFromComments(current?.body, current?.submissionComments, current?.promptHtml),
    [current?.body, current?.submissionComments, current?.promptHtml],
  );

  useEffect(() => {
    if (!current?.userId) return;
    appendViewerBridgeLog('grading-display:sidebar_prompt_resolved', {
      userId: current.userId,
      resolvedChars: promptUsedResolved.length,
      isNoPromptRecorded: promptUsedResolved === 'No prompt recorded.',
    });
  }, [current?.userId, promptUsedResolved]);

  useEffect(() => {
    if (!gradingMode || submissions.length === 0) {
      setGradingPrefetchByUserId(new Map());
      return;
    }
    let cancelled = false;
    const concurrency = 4;
    const queue = submissions.slice();
    const worker = async () => {
      while (!cancelled) {
        const row = queue.shift();
        if (!row) break;
        const entry: PrefetchedGradingMedia = {
          captionsVtt: row.captionsVtt,
          promptHtml: row.promptHtml,
          videoDurationSeconds: row.videoDurationSeconds ?? null,
          durationSource: row.durationSource,
          mediaStimulus: row.mediaStimulus,
          deckTimeline: row.deckTimeline,
        };
        if (!cancelled) {
          setGradingPrefetchByUserId((prev) => {
            const next = new Map(prev);
            next.set(row.userId, entry);
            return next;
          });
        }
        await new Promise<void>((r) => queueMicrotask(r));
      }
    };
    void Promise.all(Array.from({ length: concurrency }, () => worker()));
    return () => {
      cancelled = true;
    };
  }, [gradingMode, submissions]);

  const submissionCaptionsVtt = useMemo(() => {
    if (!gradingMode || !current?.userId) return undefined;
    const pf = gradingPrefetchByUserId.get(current.userId);
    return pf?.captionsVtt ?? current.captionsVtt;
  }, [gradingMode, current?.userId, current?.captionsVtt, gradingPrefetchByUserId]);

  useEffect(() => {
    setCaptionHelpOpen(false);
  }, [current?.userId, assignmentId]);

  /** Trace: server-resolved prompt vs what the sidebar will render after `getPromptFromComments`. */
  useEffect(() => {
    if (!gradingMode || !current?.userId) return;
    appendViewerBridgeLog('grading-display:submission_row', {
      userId: current.userId,
      hasVideoUrl: !!current.videoUrl,
      promptHtmlFromApiChars: (current.promptHtml ?? '').length,
      hasMediaStimulus: !!current.mediaStimulus,
      deckTimelineLen: current.deckTimeline?.length ?? 0,
      videoDurationSeconds: current.videoDurationSeconds ?? null,
      durationSource: current.durationSource ?? null,
    });
  }, [
    gradingMode,
    current?.userId,
    current?.videoUrl,
    current?.promptHtml,
    current?.mediaStimulus,
    current?.deckTimeline,
    current?.videoDurationSeconds,
    current?.durationSource,
  ]);

  useEffect(() => {
    if (!gradingMode || !current?.videoUrl || !current.userId) return;
    const el = videoRef.current;
    if (!el) return;
    const onLoadedMeta = () => {
      appendViewerBridgeLog('grading-video:loadedmetadata', {
        userId: current.userId,
        mediaSeconds: Number.isFinite(el.duration) ? el.duration : null,
        videoReadyState: el.readyState,
        srcPrefix: (el.currentSrc || el.src || '').slice(0, 120),
      });
    };
    const onError = () => {
      appendViewerBridgeLog('grading-video:element_error', {
        userId: current.userId,
        errorCode: el.error?.code ?? null,
        message: el.error?.message ?? '',
      });
    };
    el.addEventListener('loadedmetadata', onLoadedMeta);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMeta);
      el.removeEventListener('error', onError);
    };
  }, [gradingMode, current?.userId, current?.videoUrl, index]);

  const youtubeStimulusForGrading = useMemo(() => {
    if (!gradingMode || !current?.userId) return current?.mediaStimulus ?? undefined;
    const pf = gradingPrefetchByUserId.get(current.userId);
    return pf?.mediaStimulus ?? current?.mediaStimulus;
  }, [gradingMode, current?.userId, current?.mediaStimulus, gradingPrefetchByUserId]);

  const youtubeDualLayout =
    !!youtubeStimulusForGrading && !!current?.videoUrl;

  const playbackYoutubeSync = useMemo(() => {
    if (!youtubeDualLayout || !youtubeStimulusForGrading) return undefined;
    return {
      youtubeRef: ytStimulusRef,
      clipStartSec: youtubeStimulusForGrading.clipStartSec,
      clipEndSec: youtubeStimulusForGrading.clipEndSec,
    };
  }, [
    youtubeDualLayout,
    youtubeStimulusForGrading?.clipEndSec,
    youtubeStimulusForGrading?.clipStartSec,
    youtubeStimulusForGrading?.videoId,
  ]);

  useEffect(() => {
    setTeacherStimulusCaptions(false);
    setStudentStimulusCaptions(false);
    setYoutubeStimulusRuntimeError(null);
  }, [index, current?.userId, youtubeStimulusForGrading?.videoId, gradingMode]);
  const pointsPossible = assignment?.pointsPossible ?? 100;
  const rubric = useMemo(() => (assignment?.rubric ?? []) as RubricCriterion[], [assignment?.rubric]);
  const currentAttempt = current?.attempt ?? 1;
  const rubricAssessment = (current?.rubricAssessment ?? {}) as Record<string, { rating_id?: string; points?: number; comments?: string }>;

  /** Criterion ids only — avoids re-running rubric draft sync when `rubric` array is a new reference with the same rows. */
  const rubricIdsKey = useMemo(
    () => rubric.map((c, idx) => String(c.id ?? idx)).join('|'),
    [rubric]
  );

  /** Re-sync local rubric draft from the server only when assessment *content* changes, not on every submission object clone. */
  const rubricAssessmentSyncSig = useMemo(() => {
    const ra = gradingMode ? submissions[index]?.rubricAssessment : mySubmission?.rubricAssessment;
    if (ra == null || typeof ra !== 'object') return '';
    try {
      return JSON.stringify(ra);
    } catch {
      return '';
    }
  }, [gradingMode, submissions, index, mySubmission]);

  const rubricDraftBootstrapKey = useMemo(() => {
    if (gradingMode) {
      const s = submissions[index];
      if (!s) return '';
      return `g:${index}:${String(s.userId ?? '')}:${String(s.attempt ?? 1)}`;
    }
    const s = mySubmission;
    if (!s) return '';
    return `s:${String(s.userId ?? '')}:${String(s.attempt ?? 1)}`;
  }, [gradingMode, submissions, index, mySubmission]);

  useEffect(() => {
    setSourceCardPreview(null);
  }, [rubricDraftBootstrapKey]);

  const currentRef = useRef(current);
  currentRef.current = current;
  const rubricRef = useRef(rubric);
  rubricRef.current = rubric;

  const syncFeedbackFromCurrent = useCallback(() => {
    if (!current?.submissionComments) {
      setFeedbackEntries([]);
      return;
    }
    setFeedbackEntries(parseTimestampedFeedback(current.submissionComments));
  }, [current?.submissionComments]);

  useEffect(() => { syncFeedbackFromCurrent(); }, [syncFeedbackFromCurrent]);

  const loadTeacher = useCallback(async () => {
    if (!teacher || !assignmentId) {
      setLoading(false);
      return;
    }
    appendViewerBridgeLog('loadTeacher:start', { assignmentId });
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/submissions');
      const [subs, assign, count] = await Promise.all([
        promptApi.getSubmissions(assignmentId),
        promptApi.getAssignment(assignmentId),
        promptApi.getSubmissionCount(assignmentId),
      ]);
      setLastApiResult('GET /api/prompt/submissions', 200, true);
      const subsList = Array.isArray(subs) ? subs : [];
      setSubmissions(subsList);
      if (ENABLE_TEACHER_VIEWER_DEBUG_LOG && subsList.length > 0) {
        teacherViewerDbg('[TeacherViewer] getSubmissions result', {
          total: subsList.length,
          withVideoUrl: subsList.filter((s) => !!s.videoUrl).length,
        });
      }
      setAssignment(assign ?? null);
      setSubmissionCount(count ?? 0);
      appendViewerBridgeLog('loadTeacher:success', {
        assignmentId,
        submissions: subsList.length,
        hasSproutAccountId: !!(assign?.sproutAccountId?.trim() ?? ''),
        rubricRows: Array.isArray(assign?.rubric) ? assign.rubric.length : 0,
      });
      if (subsList.length > 0) {
        appendViewerBridgeLog('loadTeacher:api_prompt_fields', {
          assignmentId,
          rows: subsList.slice(0, 24).map((s) => ({
            userId: s.userId,
            hasVideoUrl: !!s.videoUrl,
            promptHtmlChars: (s.promptHtml ?? '').length,
            hasMediaStimulus: !!s.mediaStimulus,
            deckTimelineLen: Array.isArray(s.deckTimeline) ? s.deckTimeline.length : 0,
          })),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/submissions', 0, String(e));
      appendViewerBridgeLog('loadTeacher:error', {
        assignmentId,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [teacher, assignmentId, setLastFunction, setLastApiResult, setLastApiError]);

  const loadStudent = useCallback(async () => {
    if (!assignmentId || !context) {
      setLoading(false);
      return;
    }
    appendViewerBridgeLog('loadStudent:start', { assignmentId });
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/my-submission');
      const [sub, assign] = await Promise.all([
        promptApi.getMySubmission(assignmentId),
        promptApi.getAssignmentForViewer(assignmentId),
      ]);
      setLastApiResult('GET /api/prompt/my-submission', 200, true);
      setMySubmission(sub ?? null);
      setAssignment(assign ?? null);
      appendViewerBridgeLog('loadStudent:success', {
        assignmentId,
        hasSubmission: !!sub,
        hasSproutAccountId: !!(assign?.sproutAccountId?.trim() ?? ''),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
      setLastApiError('GET /api/prompt/my-submission', 0, String(e));
      appendViewerBridgeLog('loadStudent:error', {
        assignmentId,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [assignmentId, context, setLastFunction, setLastApiResult, setLastApiError]);

  const loadConfiguredAssignments = useCallback(async () => {
    if (!teacher || !context?.courseId) {
      teacherViewerDbg('[TeacherViewer] loadConfiguredAssignments SKIPPED', {
        teacher: !!teacher,
        courseId: context?.courseId,
      });
      setLoadingAssignments(false);
      return;
    }
    teacherViewerDbg('[TeacherViewer] loadConfiguredAssignments CALLING /api/prompt/configured-assignments');
    setLoadingAssignments(true);
    try {
      setLastFunction('GET /api/prompt/configured-assignments');
      const res = await promptApi.getConfiguredAssignments({ omitCanvasImport: true });
      setLastApiResult('GET /api/prompt/configured-assignments', 200, true);
      setConfiguredAssignments(res.configured ?? []);
    } catch {
      setConfiguredAssignments([]);
    } finally {
      setLoadingAssignments(false);
    }
  }, [teacher, context?.courseId, setLastFunction, setLastApiResult]);

  useEffect(() => {
    if (teacher && !assignmentId) loadConfiguredAssignments();
  }, [teacher, assignmentId, loadConfiguredAssignments]);

  useEffect(() => {
    if (gradingMode && assignmentId) loadTeacher();
    else if (assignmentId && context) loadStudent();
    else setLoading(false);
  }, [gradingMode, assignmentId, context, loadTeacher, loadStudent]);

  const rubricEarnedSum = useMemo(() => {
    if (!rubric.length || !current) return null;
    return sumRubricEarnedPoints(rubric, rubricDraft, rubricAssessment);
  }, [rubric, rubricDraft, rubricAssessment, current]);

  useEffect(() => {
    if (!current) {
      setGradeValue('');
      return;
    }
    if (rubric.length > 0 && rubricEarnedSum != null) {
      setGradeValue(String(rubricEarnedSum));
      return;
    }
    if (current.grade != null) setGradeValue(String(current.grade));
    else if (current.score != null) setGradeValue(String(current.score));
    else setGradeValue('');
  }, [current, rubric.length, rubricEarnedSum]);

  const reloadCurrent = useCallback(async () => {
    if (gradingMode) await loadTeacher();
    else await loadStudent();
  }, [gradingMode, loadTeacher, loadStudent]);

  const persistRubricAssessment = useCallback(
    async (draft: Record<string, RubricCriterionDraft>) => {
      if (!teacher || !current || !assignmentId) return;
      const payload = buildRubricAssessmentPayload(rubric, draft, rubricPromptEditorCtxRef.current);
      if (Object.keys(payload).length === 0) return;
      setSaving(true);
      setRubricSaveStatus('Saving…');
      try {
        setLastFunction('POST /api/prompt/grade');
        const gradeResult = await promptApi.submitGrade(
          { userId: current.userId, score: 0, scoreMaximum: pointsPossible, rubricAssessment: payload },
          assignmentId
        );
        setLastApiResult('POST /api/prompt/grade', 200, true);
        setRubricSaveStatus('Saved.');
        setTimeout(() => setRubricSaveStatus(''), 2000);
        setSubmissions((prev) =>
          prev.map((s, i) => {
            if (i !== index) return s;
            const prevRa = (s.rubricAssessment ?? {}) as Record<string, Record<string, unknown>>;
            const merged: Record<string, unknown> = { ...prevRa };
            for (const [critId, row] of Object.entries(payload)) {
              merged[critId] = { ...(typeof merged[critId] === 'object' && merged[critId] ? (merged[critId] as object) : {}), ...row };
            }
            return {
              ...s,
              rubricAssessment: merged,
              ...(gradeResult.score != null ? { score: gradeResult.score } : {}),
              ...(gradeResult.grade != null ? { grade: gradeResult.grade } : {}),
            };
          })
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRubricSaveStatus(`Failed: ${msg}`);
        setError(msg);
      } finally {
        setSaving(false);
      }
    },
    [
      teacher,
      current,
      assignmentId,
      pointsPossible,
      index,
      rubric,
      setLastFunction,
      setLastApiResult,
    ]
  );

  const handleGrade = async () => {
    if (!current || !assignmentId) return;
    const score = parseFloat(gradeValue);
    if (Number.isNaN(score)) return;
    setSaving(true);
    setGradeSaveStatus('');
    setError(null);
    try {
      setLastFunction('POST /api/prompt/grade');
      const gradeResult = await promptApi.submitGrade(
        { userId: current.userId, score, scoreMaximum: pointsPossible },
        assignmentId
      );
      setLastApiResult('POST /api/prompt/grade', 200, true);
      setGradeSaveStatus('Saved.');
      setTimeout(() => setGradeSaveStatus(''), 2000);
      setSubmissions((prev) =>
        prev.map((s, i) =>
          i === index
            ? {
                ...s,
                score: gradeResult.score ?? score,
                grade: gradeResult.grade ?? gradeValue,
              }
            : s
        )
      );
    } catch (e) {
      setGradeSaveStatus('Failed');
      setError(e instanceof Error ? e.message : 'Grade failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRubricRatingClick = useCallback(
    (criterionId: string, ratingId: string, points: number) => {
      if (!teacher || !current || !assignmentId) return;
      const prior = rubricDraft[criterionId] ?? {};
      const wasSelected = prior.rating_id === ratingId;
      const nextEntry: RubricCriterionDraft = wasSelected
        ? { ...prior, rating_id: undefined, points: undefined }
        : {
            ...prior,
            rating_id: ratingId,
            points,
            // Ensure `comments` exists in draft so payload includes composed `Prompt:` + rating on save.
            comments: typeof prior.comments === 'string' ? prior.comments : '',
          };
      const nextDraft: Record<string, RubricCriterionDraft> = {
        ...rubricDraft,
        [criterionId]: nextEntry,
      };
      setRubricDraft(nextDraft);
      if (rubricDraftHasAnyRating(rubric, nextDraft)) {
        void persistRubricAssessment(nextDraft);
      }
    },
    [teacher, current, assignmentId, rubric, rubricDraft, persistRubricAssessment]
  );

  const handleRubricCriterionCommentBlur = useCallback(
    (criterionId: string, comments: string) => {
      if (!teacher || !current || !assignmentId) return;
      let nextDraft!: Record<string, RubricCriterionDraft>;
      flushSync(() => {
        setRubricDraft((prev) => {
          nextDraft = {
            ...prev,
            [criterionId]: { ...(prev[criterionId] ?? {}), comments },
          };
          return nextDraft;
        });
      });
      if (rubricDraftHasPayload(rubric, nextDraft)) {
        void persistRubricAssessment(nextDraft);
      }
    },
    [teacher, current, assignmentId, rubric, persistRubricAssessment]
  );

  const handleReset = async () => {
    if (!current || !assignmentId) return;
    if (!window.confirm("Reset this student's attempt? They will need to enter the access code again and can submit a new attempt.")) return;
    setSaving(true);
    setResetStatus('');
    setError(null);
    try {
      setLastFunction('POST /api/prompt/reset-attempt');
      await promptApi.resetAttempt(current.userId, assignmentId);
      setLastApiResult('POST /api/prompt/reset-attempt', 200, true);
      setResetStatus("Reset. Student must use access code to try again.");
    } catch (e) {
      setResetStatus('Failed');
    } finally {
      setSaving(false);
    }
  };

  const handleAddComment = useCallback(async () => {
    const rawHtml = commentEditorRef.current?.innerHTML ?? '';
    const html = sanitizeTeacherFeedbackHtml(rawHtml);
    if (feedbackEditorIsEmpty(html) || !current || !assignmentId || !videoRef.current) return;
    const v = videoRef.current;
    const anchor = deckFeedbackAnchorRef.current;
    let timeSec = Math.floor(v.currentTime);
    if (anchor.isDeckPromptMode && anchor.deckTimeline.length > 0) {
      if (anchor.activeDeckRubricRowIndex >= 0) {
        const deckIdx = anchor.resolvedRubricDeckIndexMap[anchor.activeDeckRubricRowIndex];
        if (deckIdx != null && deckIdx >= 0 && deckIdx < anchor.deckTimeline.length) {
          timeSec = Math.floor(anchor.deckTimeline[deckIdx].startSec);
        } else if (anchor.activeDeckPrompt) {
          timeSec = Math.floor(anchor.activeDeckPrompt.startSec);
        }
      } else if (anchor.activeDeckPrompt) {
        timeSec = Math.floor(anchor.activeDeckPrompt.startSec);
      } else {
        const seg = activeDeckPromptAt(anchor.currentTime, anchor.deckTimeline);
        if (seg) timeSec = Math.floor(seg.startSec);
      }
    }
    setSaving(true);
    try {
      setLastFunction('POST /api/prompt/comment/add');
      const res = await promptApi.addComment(current.userId, timeSec, html, currentAttempt, assignmentId);
      setLastApiResult('POST /api/prompt/comment/add', 200, true);
      if (commentEditorRef.current) commentEditorRef.current.innerHTML = '';
      const newEntry = { id: res?.commentId ?? 0, time: timeSec, text: html };
      setFeedbackEntries((prev) => {
        const next = [...prev, newEntry];
        next.sort((a, b) => a.time - b.time);
        return next;
      });
      const newComment = {
        id: res?.commentId ?? 0,
        comment: `[${Math.floor(timeSec / 60)}:${timeSec % 60 < 10 ? '0' : ''}${timeSec % 60}] ${html}`,
      };
      setSubmissions((prev) =>
        prev.map((s, i) =>
          i === index
            ? { ...s, submissionComments: [...(s.submissionComments ?? []), newComment] }
            : s
        )
      );
      videoRef.current.play().catch(() => {});
    } catch {
      setError('Failed to add comment');
    } finally {
      setSaving(false);
    }
  }, [current, assignmentId, currentAttempt, index, setLastFunction, setLastApiResult]);

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const v = videoRef.current;
      if (v && !v.paused) v.pause();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleAddComment();
      }
    },
    [handleAddComment]
  );

  const handleFeedbackClick = useCallback((time: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = time;
      v.play().catch(() => {});
    }
  }, []);

  const handleDeckTimelineClick = useCallback((startSec: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = startSec;
      v.play().catch(() => {});
    }
  }, []);

  const handleEditComment = useCallback((entry: FeedbackEntry) => {
    setFeedbackEditEntry(entry);
  }, []);

  const handleSaveFeedbackEdit = useCallback(async () => {
    if (!feedbackEditEntry || !current || !assignmentId) return;
    const rawHtml = feedbackEditModalEditorRef.current?.innerHTML ?? '';
    const newHtml = sanitizeTeacherFeedbackHtml(rawHtml);
    if (feedbackEditorIsEmpty(newHtml)) {
      setError('Feedback cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await promptApi.editComment(
        current.userId,
        String(feedbackEditEntry.id),
        feedbackEditEntry.time,
        newHtml,
        assignmentId,
      );
      const timeLabel = `[${Math.floor(feedbackEditEntry.time / 60)}:${feedbackEditEntry.time % 60 < 10 ? '0' : ''}${feedbackEditEntry.time % 60}] `;
      setFeedbackEntries((prev) =>
        prev.map((f) => (f.id === feedbackEditEntry.id ? { ...f, text: newHtml } : f)).sort((a, b) => a.time - b.time),
      );
      setSubmissions((prev) =>
        prev.map((s, i) =>
          i === index
            ? {
                ...s,
                submissionComments: (s.submissionComments ?? []).map((c) =>
                  c.id === feedbackEditEntry.id ? { ...c, comment: timeLabel + newHtml } : c,
                ),
              }
            : s,
        ),
      );
      setFeedbackEditEntry(null);
    } catch {
      setError('Failed to edit comment');
    } finally {
      setSaving(false);
    }
  }, [feedbackEditEntry, current, assignmentId, index]);

  const handleCancelFeedbackEdit = useCallback(() => {
    setFeedbackEditEntry(null);
  }, []);

  const handleDeleteComment = useCallback(
    async (entry: FeedbackEntry) => {
      if (!window.confirm('Delete this comment?')) return;
      if (!current || !assignmentId) return;
      try {
        await promptApi.deleteComment(current.userId, String(entry.id), assignmentId);
        setFeedbackEntries((prev) => prev.filter((f) => f.id !== entry.id));
        setSubmissions((prev) =>
          prev.map((s, i) =>
            i === index
              ? { ...s, submissionComments: (s.submissionComments ?? []).filter((c) => c.id !== entry.id) }
              : s
          )
        );
      } catch {
        setError('Failed to delete comment');
      }
    },
    [current, assignmentId, index]
  );

  const handleStudentSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const uid = e.target.value;
    if (!uid) return;
    const idx = submissions.findIndex((s) => s.userId === uid);
    if (idx >= 0) setIndex(idx);
  };

  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    v.addEventListener('timeupdate', onTimeUpdate);
    return () => v.removeEventListener('timeupdate', onTimeUpdate);
  }, [current]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const deckTimeline = useMemo(() => {
    const fromApi =
      gradingMode && current?.userId
        ? gradingPrefetchByUserId.get(current.userId)?.deckTimeline ?? current?.deckTimeline
        : current?.deckTimeline;
    if (fromApi?.length) return fromApi as DeckTimelineEntry[];
    return resolveDeckTimeline(current?.body, current?.submissionComments);
  }, [
    gradingMode,
    current?.userId,
    current?.deckTimeline,
    current?.body,
    current?.submissionComments,
    gradingPrefetchByUserId,
  ]);

  const activeFeedback = useMemo(() => {
    if (feedbackEntries.length === 0) return [];
    const dur = current?.videoDurationSeconds;
    const segT = playheadCardSegmentIndex(currentTime, deckTimeline, dur);
    if (segT < 0) return [];
    return feedbackEntries.filter((f) => {
      const segF = playheadCardSegmentIndex(f.time, deckTimeline, dur);
      return segF === segT;
    });
  }, [currentTime, feedbackEntries, deckTimeline, current?.videoDurationSeconds]);
  const isDeckPromptMode = deckTimeline.length > 0;
  const isTextPromptMode = !isDeckPromptMode;
  /** Plain text + deck prompts do not use burned-in transcript tracks; YouTube / sign-to-voice may. */
  const embedSubmissionVtt = useMemo(
    () =>
      !isDeckPromptMode &&
      (assignment?.promptMode === 'youtube' ||
        assignment?.promptMode === 'decks' ||
        assignment?.signToVoiceRequired === true),
    [isDeckPromptMode, assignment?.promptMode, assignment?.signToVoiceRequired],
  );
  const submissionCaptionsForPlayer = useMemo(
    () => (embedSubmissionVtt ? submissionCaptionsVtt : undefined),
    [embedSubmissionVtt, submissionCaptionsVtt],
  );
  /**
   * Teacher grading with a selected submission: stack order is video, then in-slot rubric (deck: Active
   * item + quick ratings), then timestamped comment for deck+grading; non-deck keeps freeform after the slot.
   */
  const viewerGradingStackOrder = gradingMode && !!teacher && !!current && !noSubmissionsInGradingMode;
  /** OS/browser live-caption tips: only where transcript-style playback matters (not deck or static text). */
  const showCaptionsAccessibilityHelp = useMemo(
    () =>
      gradingMode &&
      !!current?.userId &&
      !noSubmissionsInGradingMode &&
      !isDeckPromptMode &&
      (assignment?.promptMode === 'youtube' || assignment?.signToVoiceRequired === true),
    [
      gradingMode,
      current?.userId,
      noSubmissionsInGradingMode,
      isDeckPromptMode,
      assignment?.promptMode,
      assignment?.signToVoiceRequired,
    ],
  );
  const activeDeckPrompt = useMemo(
    () => activeDeckPromptAt(currentTime, deckTimeline),
    [currentTime, deckTimeline],
  );

  const closeSourceCardModal = useCallback(() => {
    setSourceCardPreview(null);
  }, []);

  const activeDeckIndex = useMemo(() => {
    if (!activeDeckPrompt) return -1;
    return deckTimeline.findIndex(
      (s) => s.startSec === activeDeckPrompt.startSec && s.title === activeDeckPrompt.title,
    );
  }, [activeDeckPrompt, deckTimeline]);

  const activeDeckSproutVideoId = useMemo(() => {
    if (!activeDeckPrompt) return '';
    const fromCard = activeDeckPrompt.videoId?.trim();
    if (fromCard) return fromCard;
    if (activeDeckIndex >= 0 && deckTimeline[activeDeckIndex]?.videoId?.trim()) {
      return deckTimeline[activeDeckIndex].videoId!.trim();
    }
    return '';
  }, [activeDeckPrompt, activeDeckIndex, deckTimeline]);

  const activeDeckSproutSecurityToken = useMemo(() => {
    if (!activeDeckPrompt) return '';
    const st = (activeDeckPrompt as DeckTimelineEntry).securityToken?.trim();
    if (st) return st;
    if (activeDeckIndex >= 0 && deckTimeline[activeDeckIndex]?.securityToken?.trim()) {
      return deckTimeline[activeDeckIndex].securityToken!.trim();
    }
    return '';
  }, [activeDeckPrompt, activeDeckIndex, deckTimeline]);

  const openSourceCardModal = useCallback(() => {
    const vid = activeDeckSproutVideoId;
    const tok = activeDeckSproutSecurityToken;
    if (!vid || !tok) return;
    videoRef.current?.pause();
    const src = buildSproutVideoEmbedUrl(vid, tok);
    console.info('[TeacherViewer] Sprout source (active item)', { videoId: vid, securityToken: tok, embedSrc: src });
    appendViewerBridgeLog('Sprout source card (active item)', { videoId: vid, embedSrc: src });
    setSourceCardPreview({ videoId: vid, securityToken: tok });
  }, [activeDeckSproutVideoId, activeDeckSproutSecurityToken]);

  /** Sprout embed needs video id + security token (per Sprout `embed_code`), not the Canvas/env “account” id. */
  const showSourceCardButton =
    !!activeDeckPrompt && !!activeDeckSproutVideoId && !!activeDeckSproutSecurityToken;

  // Bridge diagnostics: "Show me the card" gating (active segment, Sprout id + security token on timeline).
  const showMeCardDiagSigRef = useRef('');
  useEffect(() => {
    if (!isDeckPromptMode || !assignmentId) return;
    const sig = [
      String(!!teacher),
      String(assignmentId),
      String(current?.userId ?? ''),
      String(isDeckPromptMode),
      String(activeDeckPrompt?.startSec ?? ''),
      String(activeDeckPrompt?.title ?? ''),
      String(!!activeDeckSproutVideoId),
      String(!!activeDeckSproutSecurityToken),
      String(!!showSourceCardButton),
    ].join('|');
    if (sig === showMeCardDiagSigRef.current) return;
    showMeCardDiagSigRef.current = sig;
    appendViewerBridgeLog('ShowMeCard gate snapshot', {
      teacher: !!teacher,
      assignmentId,
      userId: current?.userId ?? '(none)',
      isDeckPromptMode,
      deckTimelineLen: deckTimeline.length,
      activeDeckPromptPresent: !!activeDeckPrompt,
      activeDeckPromptStartSec: activeDeckPrompt ? Math.floor(activeDeckPrompt.startSec) : null,
      hasActiveDeckSproutVideoId: !!activeDeckSproutVideoId,
      hasActiveDeckSproutSecurityToken: !!activeDeckSproutSecurityToken,
      showSourceCardButton,
    });
  }, [
    teacher,
    assignmentId,
    isDeckPromptMode,
    deckTimeline.length,
    current?.userId,
    activeDeckPrompt?.startSec,
    activeDeckPrompt?.title,
    activeDeckSproutVideoId,
    activeDeckSproutSecurityToken,
    showSourceCardButton,
  ]);

  const rubricPromptIndexMap = useMemo(
    () =>
      rubric.map((criterion, idx) =>
        rubricCriterionDeckIndex(criterion, idx, rubric.length, deckTimeline.length),
      ),
    [rubric, deckTimeline],
  );

  const resolvedRubricDeckIndexMap = useMemo(
    () =>
      rubricPromptIndexMap.map((mapped, idx) => {
        if (mapped != null && mapped >= 0 && mapped < deckTimeline.length) return mapped;
        // Do not assign deck slots by row index when rubric row count ≠ deck segments (e.g. "Overall"
        // + N cards would otherwise steal deck 0 and the active-item buttons would target the wrong criterion).
        if (
          mapped == null &&
          rubric.length === deckTimeline.length &&
          idx >= 0 &&
          idx < deckTimeline.length
        ) {
          return idx;
        }
        return null;
      }),
    [rubricPromptIndexMap, deckTimeline.length, rubric.length],
  );

  const rubricPromptEditorCtx = useMemo((): RubricPromptEditorContext | undefined => {
    if (!rubric.length) return undefined;
    return {
      deckTimeline,
      resolvedDeckIndices: resolvedRubricDeckIndexMap,
      textPrompts: assignment?.textPrompts,
      youtubeLabel: assignment?.youtubeLabel,
    };
  }, [rubric.length, deckTimeline, resolvedRubricDeckIndexMap, assignment?.textPrompts, assignment?.youtubeLabel]);
  rubricPromptEditorCtxRef.current = rubricPromptEditorCtx;

  useEffect(() => {
    const c = currentRef.current;
    if (!c) {
      setRubricDraft({});
      return;
    }
    setRubricDraft(
      parseRubricAssessmentToDraft(
        c.rubricAssessment as Record<string, unknown> | undefined,
        rubricRef.current,
        rubricPromptEditorCtx,
      ),
    );
  }, [rubricDraftBootstrapKey, rubricAssessmentSyncSig, rubricIdsKey, rubricPromptEditorCtx]);

  const feedbackByDeckRubricRow = useMemo(() => {
    const byDeckIndex = new Map<number, FeedbackEntry[]>();
    for (const entry of feedbackEntries) {
      for (let i = 0; i < deckTimeline.length; i++) {
        const start = deckTimeline[i].startSec;
        const nextStart = i + 1 < deckTimeline.length ? deckTimeline[i + 1].startSec : Infinity;
        if (entry.time >= start && entry.time < nextStart) {
          const list = byDeckIndex.get(i) ?? [];
          list.push(entry);
          byDeckIndex.set(i, list);
          break;
        }
      }
    }
    const out = new Map<number, FeedbackEntry[]>();
    resolvedRubricDeckIndexMap.forEach((deckIdx, rowIdx) => {
      if (deckIdx == null) {
        out.set(rowIdx, []);
        return;
      }
      out.set(rowIdx, [...(byDeckIndex.get(deckIdx) ?? [])].sort((a, b) => a.time - b.time));
    });
    return out;
  }, [feedbackEntries, deckTimeline, resolvedRubricDeckIndexMap]);

  /** Rubric row for the deck segment at the playhead (middle panel + quick ratings). Prefer explicit card mapping when multiple rows tie to the same deck index. */
  const activeDeckRubricRowIndex = useMemo(() => {
    if (activeDeckIndex < 0) return -1;
    const matches: number[] = [];
    for (let i = 0; i < resolvedRubricDeckIndexMap.length; i++) {
      if (resolvedRubricDeckIndexMap[i] === activeDeckIndex) matches.push(i);
    }
    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0];
    const explicit = matches.filter(
      (i) => rubricPromptIndexMap[i] != null && rubricPromptIndexMap[i] === activeDeckIndex,
    );
    if (explicit.length === 1) return explicit[0];
    if (explicit.length > 1) return explicit.sort((a, b) => a - b)[0];
    const aligned = matches.find((i) => i === activeDeckIndex);
    if (aligned != null) return aligned;
    return matches.sort((a, b) => a - b)[0];
  }, [activeDeckIndex, resolvedRubricDeckIndexMap, rubricPromptIndexMap]);

  /**
   * Row in `rubric` whose rating buttons to show in the main column under the video for the
   * active card. Uses `activeDeckRubricRowIndex` when the Canvas rubric lines up with the deck; falls
   * back so the quick grade strip does not vanish (e.g. 1:1 card/criterion by index, single
   * criterion, or first row) when the strict mapper returns -1.
   */
  const quickGradeRubricRowIndex = useMemo(() => {
    if (rubric.length === 0) return -1;
    if (activeDeckRubricRowIndex >= 0 && activeDeckRubricRowIndex < rubric.length) {
      return activeDeckRubricRowIndex;
    }
    if (activeDeckIndex < 0) return -1;
    if (rubric.length === deckTimeline.length && activeDeckIndex < rubric.length) {
      return activeDeckIndex;
    }
    if (rubric.length === 1) return 0;
    if (activeDeckIndex < rubric.length) return activeDeckIndex;
    return -1;
  }, [rubric, activeDeckRubricRowIndex, activeDeckIndex, deckTimeline.length]);

  const activeCardRubricNotFullCredit = useMemo(() => {
    if (activeDeckRubricRowIndex < 0 || activeDeckRubricRowIndex >= rubric.length) return false;
    const c = rubric[activeDeckRubricRowIndex];
    const critId = String(c.id ?? activeDeckRubricRowIndex);
    return criterionRubricRowIsIncorrect(c, critId, rubricDraft, rubricAssessment);
  }, [activeDeckRubricRowIndex, rubric, rubricDraft, rubricAssessment]);

  /** When to load the Sprout model in the left “reference” cell (not layout — two columns are always used). */
  const showStudentBesideSproutModel = useMemo(
    () =>
      !teacher &&
      isDeckPromptMode &&
      !youtubeDualLayout &&
      showIncorrectSourceBeside &&
      activeCardRubricNotFullCredit &&
      !!current?.videoUrl &&
      !!activeDeckSproutVideoId &&
      !!activeDeckSproutSecurityToken,
    [
      teacher,
      isDeckPromptMode,
      youtubeDualLayout,
      showIncorrectSourceBeside,
      activeCardRubricNotFullCredit,
      current?.videoUrl,
      activeDeckSproutVideoId,
      activeDeckSproutSecurityToken,
    ],
  );

  const studentBesideSproutEmbedSrc = useMemo(() => {
    if (!activeDeckSproutVideoId || !activeDeckSproutSecurityToken) return '';
    const base = buildSproutVideoEmbedUrl(activeDeckSproutVideoId, activeDeckSproutSecurityToken);
    return base.includes('?') ? `${base}&autoPlay=true&showControls=false` : `${base}?autoPlay=true&showControls=false`;
  }, [activeDeckSproutVideoId, activeDeckSproutSecurityToken]);

  const studentBesideModelPlaceholderText = useMemo(() => {
    if (!showIncorrectSourceBeside) {
      return 'Turn on the option above to show a model for cards that are not at full credit.';
    }
    if (!activeCardRubricNotFullCredit) {
      return 'A model can appear here when a card is not at full credit.';
    }
    if (!activeDeckSproutVideoId.trim() || !activeDeckSproutSecurityToken.trim()) {
      return 'No model is linked for this deck item.';
    }
    return '';
  }, [
    showIncorrectSourceBeside,
    activeCardRubricNotFullCredit,
    activeDeckSproutVideoId,
    activeDeckSproutSecurityToken,
  ]);

  useLayoutEffect(() => {
    deckFeedbackAnchorRef.current = {
      isDeckPromptMode,
      deckTimeline,
      activeDeckRubricRowIndex,
      resolvedRubricDeckIndexMap,
      activeDeckPrompt,
      currentTime,
    };
  }, [
    isDeckPromptMode,
    deckTimeline,
    activeDeckRubricRowIndex,
    resolvedRubricDeckIndexMap,
    activeDeckPrompt,
    currentTime,
  ]);

  useEffect(() => {
    if (isDeckPromptMode) setTextPromptVisible(false);
  }, [isDeckPromptMode]);

  useEffect(() => {
    const layout = document.getElementById('viewer-layout');
    const leftSidebar = leftSidebarRef.current;
    const rightSidebar = rightSidebarRef.current;
    const handleLeft = document.getElementById('resize-handle-left');
    const handleRight = document.getElementById('resize-handle-right');
    if (!layout || !leftSidebar || !handleLeft) return;
    const minSidebarW = 160;
    const minCenterW = 280;
    const handleW = 10;
    const keyL = 'aslexpress_viewer_left_width';
    const keyR = 'aslexpress_viewer_right_width';
    const handleCount = rightSidebar && handleRight ? 2 : 1;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const getMaxLeft = () => {
      const total = layout.clientWidth;
      const rightW = rightSidebar?.offsetWidth ?? 0;
      const max = total - rightW - handleCount * handleW - minCenterW;
      return Math.max(minSidebarW, max);
    };
    const getMaxRight = () => {
      const total = layout.clientWidth;
      const leftW = leftSidebar.offsetWidth;
      const max = total - leftW - handleCount * handleW - minCenterW;
      return Math.max(minSidebarW, max);
    };
    const setLeft = (w: number) => {
      const ww = clamp(w, minSidebarW, getMaxLeft());
      leftSidebar.style.flex = `0 0 ${ww}px`;
      try {
        localStorage.setItem(keyL, String(ww));
      } catch {
        //
      }
    };
    const setRight = (w: number) => {
      if (!rightSidebar) return;
      const ww = clamp(w, minSidebarW, getMaxRight());
      rightSidebar.style.flex = `0 0 ${ww}px`;
      try {
        localStorage.setItem(keyR, String(ww));
      } catch {
        //
      }
    };
    const logResizeDebug = () => {
      if (!ENABLE_RESIZE_DEBUG_LOG) return;
      const now = Date.now();
      if (now - resizeDebugLastSentAtRef.current < 100) return;
      resizeDebugLastSentAtRef.current = now;
      const payload = {
        leftStyleFlex: leftSidebar.style.flex || '(unset)',
        leftRendered: Number(leftSidebar.getBoundingClientRect().width.toFixed(2)),
        layoutWidth: Number(layout.getBoundingClientRect().width.toFixed(2)),
        rightRendered: Number((rightSidebar?.getBoundingClientRect().width ?? 0).toFixed(2)),
        computedMax: Number(getMaxLeft().toFixed(2)),
        minCenterW,
      };
      appendBridgeLog('resize', 'resize-drag', payload);
    };
    try {
      const sl = localStorage.getItem(keyL);
      const sr = localStorage.getItem(keyR);
      if (sl) {
        const w = parseFloat(sl);
        if (!Number.isNaN(w)) setLeft(w);
      }
      if (sr && rightSidebar) {
        const w = parseFloat(sr);
        if (!Number.isNaN(w)) setRight(w);
      }
    } catch {
      //
    }
    const onResize = () => {
      setLeft(leftSidebar.offsetWidth);
      if (rightSidebar) setRight(rightSidebar.offsetWidth);
    };
    window.addEventListener('resize', onResize);
    const setupHandle = (
      handle: HTMLElement,
      col: HTMLElement,
      setW: (w: number) => void,
      invert: boolean
    ) => {
      const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = col.offsetWidth;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        const onMove = (ev: MouseEvent) => {
          const dx = invert ? startX - ev.clientX : ev.clientX - startX;
          setW(startW + dx);
          logResizeDebug();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
      handle.addEventListener('mousedown', onMouseDown);
      return () => handle.removeEventListener('mousedown', onMouseDown);
    };
    const cleanupLeftHandle = setupHandle(handleLeft, leftSidebar, setLeft, false);
    let cleanupRightHandle: (() => void) | undefined;
    if (handleRight && rightSidebar) {
      cleanupRightHandle = setupHandle(handleRight, rightSidebar, setRight, true);
    }
    return () => {
      cleanupLeftHandle();
      cleanupRightHandle?.();
      window.removeEventListener('resize', onResize);
    };
  }, [loading, textPromptVisible]);

  const viewerBlockingLoader = useMemo(() => {
    if (assignmentId && loading) {
      return {
        active: true as const,
        message: gradingMode ? 'Loading submissions…' : 'Loading submission…',
        subMessage: undefined as string | undefined,
      };
    }
    if (!assignmentId && loadingAssignments) {
      return { active: true as const, message: 'Loading assignments…', subMessage: undefined as string | undefined };
    }
    return { active: false as const, message: '', subMessage: undefined as string | undefined };
  }, [assignmentId, loading, gradingMode, loadingAssignments]);

  const viewerBlockingOverlay = (
    <AppBlockingLoader
      active={viewerBlockingLoader.active}
      message={viewerBlockingLoader.message}
      subMessage={viewerBlockingLoader.subMessage}
    />
  );

  if (!context) {
    return (
      <>
        {viewerBlockingOverlay}
        <div className="prompter-page">
          <div className="prompter-card">
            <p className="prompter-info-message">Launch from Canvas to continue.</p>
          </div>
        </div>
      </>
    );
  }

  if (!assignmentId) {
    return (
      <>
        {viewerBlockingOverlay}
        <div className="prompter-page">
        <div className="prompter-card">
          <h1>{teacher ? 'Grade Submissions' : 'Video Viewer'}</h1>
          {teacher ? (
            <>
              <p className="prompter-info-message prompter-viewer-select-prompt">Select an assignment to grade submissions.</p>
              {loadingAssignments ? (
                <p className="prompter-info-message prompter-sr-only">Loading assignments list</p>
              ) : configuredAssignments.length === 0 ? (
                <p className="prompter-info-message">No configured assignments in this course.</p>
              ) : (
                <div className="prompter-viewer-dropdown-row prompter-viewer-assignment-select-wrap">
                  <label htmlFor="assignment-select">Assignment:</label>
                  <select
                    id="assignment-select"
                    onChange={(e) => {
                      const id = e.target.value?.trim();
                      if (id) setSearchParams({ assignmentId: id, grading: '1' });
                    }}
                    defaultValue=""
                  >
                    <option value="">— Select assignment —</option>
                    {configuredAssignments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ) : (
            <p className="prompter-info-message">Open this page with ?assignmentId=... in the assignment comments.</p>
          )}
        </div>
      </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {viewerBlockingOverlay}
        <div className="prompter-page" aria-hidden="true">
          <div className="prompter-card" />
        </div>
      </>
    );
  }

  if (!gradingMode && !mySubmission) {
    return (
      <>
        {viewerBlockingOverlay}
        <div className="prompter-page">
          <div className="prompter-card">
            <h1>View Submission</h1>
            <p className="prompter-info-message">No submission found for this assignment.</p>
          </div>
        </div>
      </>
    );
  }

  const promptUsed = promptUsedResolved;
  const hasSubmissionNoVideo = current && !current.videoUrl;

  return (
    <>
      {viewerBlockingOverlay}
      <div className="prompter-page prompter-page--viewer">
      <div className="prompter-viewer-layout" id="viewer-layout">
        <aside
          ref={leftSidebarRef}
          className="prompter-viewer-sidebar"
          id="viewer-sidebar-left"
        >
          {rubric.length > 0 && (
            <div className="prompter-viewer-rubric-container">
              <div className="prompter-viewer-feedback-title">
                {isDeckPromptMode ? 'Rubric' : 'All time-stamped notes'}
              </div>
              {isDeckPromptMode ? (
                <table className="prompter-viewer-rubric-table">
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Prompt</th>
                        <th>Rating</th>
                        <th>Feedback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rubric.map((c, rowIdx) => {
                        const critId = String(c.id ?? rowIdx);
                        const assess = getRubricRowAssessment(rubricAssessment, c, critId);
                        const mappedDeckIdx = resolvedRubricDeckIndexMap[rowIdx];
                        const mappedDeckPrompt = mappedDeckIdx != null ? deckTimeline[mappedDeckIdx] : undefined;
                        const mappedDeckActive = mappedDeckIdx != null && mappedDeckIdx === activeDeckIndex;
                        const rowFeedback = feedbackByDeckRubricRow.get(rowIdx) ?? [];
                        const selectedRatingId = rubricDraft[critId]?.rating_id ?? assess?.rating_id;
                        return (
                          <Fragment key={critId}>
                            <tr
                              className={`prompter-viewer-rubric-row ${mappedDeckPrompt ? 'clickable' : ''} ${mappedDeckActive ? 'active' : ''}`}
                              onClick={() => mappedDeckPrompt && handleDeckTimelineClick(mappedDeckPrompt.startSec)}
                              onKeyDown={(e) => {
                                if (mappedDeckPrompt && e.key === 'Enter') handleDeckTimelineClick(mappedDeckPrompt.startSec);
                              }}
                              tabIndex={mappedDeckPrompt ? 0 : undefined}
                            >
                              <td>{mappedDeckPrompt ? formatTime(Math.floor(mappedDeckPrompt.startSec)) : '—'}</td>
                              <td onClick={(e) => e.stopPropagation()}>
                                {mappedDeckPrompt &&
                                (mappedDeckPrompt.videoId ?? '').trim() &&
                                (mappedDeckPrompt.securityToken ?? '').trim() &&
                                criterionRubricRowIsIncorrect(c, critId, rubricDraft, rubricAssessment) ? (
                                  <a
                                    href="#sprout-source"
                                    className="prompter-viewer-feedback-seek-btn"
                                    style={{ display: 'inline-block' }}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const vid = (mappedDeckPrompt.videoId ?? '').trim();
                                      const tok = (mappedDeckPrompt.securityToken ?? '').trim();
                                      if (vid && tok) {
                                        videoRef.current?.pause();
                                        const src = buildSproutVideoEmbedUrl(vid, tok);
                                        console.info('[TeacherViewer] Sprout source (incorrect rubric row)', {
                                          videoId: vid,
                                          rubricCriterionId: critId,
                                          mappedDeckIndex: mappedDeckIdx,
                                          deckStartSec: mappedDeckPrompt.startSec,
                                          embedSrc: src,
                                        });
                                        appendViewerBridgeLog('Sprout source card (incorrect rubric row)', {
                                          videoId: vid,
                                          rubricCriterionId: critId,
                                          mappedDeckIndex: mappedDeckIdx,
                                          deckStartSec: mappedDeckPrompt.startSec,
                                          embedSrc: src,
                                        });
                                        setSourceCardPreview({ videoId: vid, securityToken: tok });
                                      }
                                    }}
                                  >
                                    <span
                                      className="prompter-viewer-rubric-card-prompt-text"
                                      dangerouslySetInnerHTML={{
                                        __html: mappedDeckPrompt?.title || (c.description ?? 'Criterion'),
                                      }}
                                    />
                                  </a>
                                ) : (
                                  <div
                                    className="prompter-viewer-rubric-card-prompt-text"
                                    dangerouslySetInnerHTML={{
                                      __html: mappedDeckPrompt?.title || (c.description ?? 'Criterion'),
                                    }}
                                  />
                                )}
                              </td>
                              <td>
                                <div className="prompter-viewer-rubric-ratings">
                                  {c.ratings?.map((r) => {
                                    const rid = String(r.id ?? '');
                                    const pts = r.points ?? 0;
                                    const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                                    return (
                                      <button
                                        key={rid}
                                        type="button"
                                        className={`prompter-viewer-rubric-rating ${isSelected ? 'selected' : ''}`}
                                        disabled={!teacher}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          teacher && handleRubricRatingClick(critId, rid, pts);
                                        }}
                                      >
                                        {r.description ?? ''} ({pts} pts)
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                {rowFeedback.length === 0 ? (
                                  <span className="prompter-viewer-feedback-empty-inline">No feedback</span>
                                ) : (
                                  <div className="prompter-viewer-rubric-feedback-inline">
                                    {rowFeedback.map((f) => (
                                      <div key={`deck-fb-${critId}-${f.id}`} className="prompter-viewer-rubric-feedback-inline-item">
                                        <button
                                          type="button"
                                          className="prompter-viewer-feedback-seek-btn"
                                          onClick={() =>
                                            mappedDeckPrompt
                                              ? handleDeckTimelineClick(mappedDeckPrompt.startSec)
                                              : handleFeedbackClick(f.time)
                                          }
                                        >
                                          {formatTime(f.time)}
                                        </button>
                                        <div className="prompter-viewer-rubric-feedback-html">
                                          <FeedbackHtmlSnippet html={f.text} />
                                        </div>
                                        {teacher && (
                                          <div className="prompter-viewer-comment-actions">
                                            <button type="button" className="prompter-viewer-comment-action-btn" onClick={() => handleEditComment(f)}>
                                              Edit
                                            </button>
                                            <button
                                              type="button"
                                              className="prompter-viewer-comment-action-btn danger"
                                              onClick={() => handleDeleteComment(f)}
                                            >
                                              Delete
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                </table>
              ) : (
                <div className="prompter-viewer-text-timestamped-col prompter-viewer-text-timestamped-col--sidebar-only">
                  <div className="prompter-viewer-feedback-title">All timestamped feedback</div>
                  <p className="prompter-viewer-hint-muted prompter-viewer-hint--sidebar-timestamped">
                    Rubric ratings and criterion comments are under the student video. Below lists every time-stamped note; the
                    strip under the video shows only notes for the current card/segment.
                  </p>
                  <table className="prompter-viewer-timestamped-feedback-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Feedback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feedbackEntries.length === 0 ? (
                        <tr>
                          <td colSpan={2}>
                            <span className="prompter-viewer-feedback-empty-inline">No timestamped feedback</span>
                          </td>
                        </tr>
                      ) : (
                        feedbackEntries.map((f) => (
                          <tr key={`ts-${f.id}`}>
                            <td className="prompter-viewer-timestamped-time-cell">{formatTime(f.time)}</td>
                            <td>
                              <button
                                type="button"
                                className="prompter-viewer-feedback-seek-btn"
                                onClick={() => handleFeedbackClick(f.time)}
                              >
                                Seek
                              </button>
                              <div className="prompter-viewer-timestamped-feedback-html">
                                <FeedbackHtmlSnippet html={f.text} />
                              </div>
                              {teacher && (
                                <div className="prompter-viewer-comment-actions">
                                  <button
                                    type="button"
                                    className="prompter-viewer-comment-action-btn"
                                    onClick={() => handleEditComment(f)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="prompter-viewer-comment-action-btn danger"
                                    onClick={() => handleDeleteComment(f)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {teacher && rubricSaveStatus && (
                <span className="prompter-viewer-rubric-save-status">{rubricSaveStatus}</span>
              )}
            </div>
          )}
        </aside>
        <div className="prompter-viewer-resize-handle" id="resize-handle-left" title="Drag to resize" />
        <main className="prompter-viewer-center" id="viewer-center">
          <div className={viewerGradingStackOrder ? 'prompter-viewer-slot-top' : undefined}>
            {error && <div className="prompter-viewer-error-box">{error}</div>}
            {noSubmissionsInGradingMode && (
              <div className="prompter-viewer-no-submissions">
                <p className="prompter-info-message">No submissions yet for this assignment.</p>
                <button
                  type="button"
                  className="prompter-viewer-grade-btn"
                  onClick={() => setSearchParams({ grading: '1' })}
                >
                  Change assignment
                </button>
              </div>
            )}
          </div>

          {gradingMode && submissions.length > 0 && (
            <div
              className={`prompter-viewer-center-row prompter-viewer-center-row--grading-toolbar${viewerGradingStackOrder ? ' prompter-viewer-slot-grading-toolbar' : ''}`}
            >
              <div className="prompter-viewer-dropdown-row prompter-viewer-dropdown-row--grading-toolbar">
                <label htmlFor="submission-select">Submission:</label>
                <select
                  id="submission-select"
                  value={current?.userId ?? ''}
                  onChange={handleStudentSelect}
                >
                  <option value="">— Select student —</option>
                  {submissions.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.userName ?? s.userId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="prompter-viewer-nav-row prompter-viewer-nav-row--grading-toolbar">
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index <= 0}
                  className={`prompter-viewer-nav-btn ${index <= 0 ? 'disabled' : ''}`}
                >
                  ← Previous
                </button>
                <span className="prompter-viewer-nav-index">
                  {index + 1} of {submissions.length}
                </span>
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.min(submissions.length - 1, i + 1))}
                  disabled={index >= submissions.length - 1}
                  className={`prompter-viewer-nav-btn ${index >= submissions.length - 1 ? 'disabled' : ''}`}
                >
                  Next →
                </button>
              </div>
              {current && pointsPossible != null && (
                <div className="prompter-viewer-grade-row-full prompter-viewer-grade-row-full--grading-toolbar">
                  <label htmlFor="grade-input">Grade:</label>
                  <input
                    id="grade-input"
                    type="number"
                    min={0}
                    max={pointsPossible > 0 ? pointsPossible : undefined}
                    step="any"
                    value={gradeValue}
                    onChange={(e) => setGradeValue(e.target.value)}
                    placeholder="0"
                  />
                  <span className="prompter-viewer-points-label">/ {Math.round(pointsPossible)} pts</span>
                  <button type="button" onClick={handleGrade} disabled={saving} className="prompter-viewer-grade-btn">
                    Save grade
                  </button>
                  {gradeSaveStatus ? (
                    <span
                      className={`prompter-viewer-save-status${gradeSaveStatus.toLowerCase().includes('fail') ? ' prompter-viewer-save-status--error' : ''}`}
                    >
                      {gradeSaveStatus}
                    </span>
                  ) : null}
                </div>
              )}
              {current && (
                <div className="prompter-viewer-reset-row prompter-viewer-reset-row--grading-toolbar">
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={saving}
                    className="prompter-viewer-reset-btn"
                  >
                    Reset student&apos;s attempt
                  </button>
                  {resetStatus ? (
                    <span
                      className={`prompter-viewer-reset-status${resetStatus.toLowerCase().includes('fail') ? ' prompter-viewer-reset-status--error' : ''}`}
                    >
                      {resetStatus}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {assignmentId && (
            <div
              className={`prompter-viewer-center-row prompter-viewer-center-row--title${viewerGradingStackOrder ? ' prompter-viewer-slot-assignment-title' : ''}`}
            >
              <h1 className="prompter-viewer-assignment-title">
                {assignment?.name?.trim() || `Assignment ${assignmentId}`}
              </h1>
            </div>
          )}

          <div className={viewerGradingStackOrder ? 'prompter-viewer-slot-submission-media' : undefined}>
          {youtubeDualLayout && youtubeStimulusForGrading && current?.videoUrl ? (
            <div className="prompter-viewer-center-row">
              <div className="prompter-viewer-youtube-dual">
                <div className="prompter-viewer-youtube-dual-cols">
                  <div className="prompter-viewer-youtube-dual-col">
                    <h2 className="prompter-viewer-section-heading">Assigned stimulus</h2>
                    {youtubeStimulusForGrading.label && (
                      <p className="prompter-viewer-media-stimulus-label">{youtubeStimulusForGrading.label}</p>
                    )}
                    {youtubeStimulusRuntimeError ? (
                      <p className="prompter-error-message">
                        Stimulus playback unavailable: {youtubeStimulusRuntimeError}
                      </p>
                    ) : (
                      <div className="prompter-viewer-youtube-dual-frame">
                        <YoutubeStimulusShell subtitleMask={assignment?.youtubePromptConfig?.subtitleMask}>
                          <YoutubeIframePlayer
                            ref={ytStimulusRef}
                            videoId={youtubeStimulusForGrading.videoId}
                            clipStartSec={youtubeStimulusForGrading.clipStartSec}
                            clipEndSec={youtubeStimulusForGrading.clipEndSec}
                            isStudent={!gradingMode}
                            allowStudentCaptions={assignment?.youtubePromptConfig?.allowStudentCaptions === true}
                            studentCaptionsVisible={studentStimulusCaptions}
                            teacherCaptionsEnabled={Boolean(gradingMode && teacherStimulusCaptions)}
                            onApiError={(m) => setYoutubeStimulusRuntimeError(m)}
                          />
                        </YoutubeStimulusShell>
                      </div>
                    )}
                    <p className="prompter-viewer-hint-muted">
                      Shown to the student during recording; segment matches the teacher&apos;s clip start and end.
                    </p>
                    {gradingMode ? (
                      <div className="prompter-viewer-youtube-dual-toolbar">
                        <label className="prompter-viewer-cc-toggle">
                          <input
                            type="checkbox"
                            checked={teacherStimulusCaptions}
                            onChange={(e) => setTeacherStimulusCaptions(e.target.checked)}
                          />{' '}
                          Show captions on stimulus
                        </label>
                      </div>
                    ) : assignment?.youtubePromptConfig?.allowStudentCaptions === true ? (
                      <div className="prompter-viewer-youtube-dual-toolbar">
                        <button
                          type="button"
                          className="prompter-viewer-video-bar-btn"
                          onClick={() => setStudentStimulusCaptions((c) => !c)}
                        >
                          {studentStimulusCaptions ? 'Turn off captions' : 'Turn on captions'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="prompter-viewer-youtube-dual-col">
                    <h2 className="prompter-viewer-section-heading">Submission</h2>
                    <GradingVideoPlayer
                      hideControls
                      src={current.videoUrl}
                      videoKey={current.userId ?? ''}
                      videoRef={videoRef}
                      videoDurationSeconds={current.videoDurationSeconds}
                      durationSource={current.durationSource}
                      captionsVtt={submissionCaptionsForPlayer}
                    />
                  </div>
                </div>
                <div className="prompter-viewer-youtube-dual-toolbar prompter-viewer-youtube-dual-toolbar--transport">
                  <GradingPlaybackBar
                    videoRef={videoRef}
                    videoKey={current.userId ?? ''}
                    videoDurationSeconds={current.videoDurationSeconds}
                    durationSource={current.durationSource}
                    youtubeSync={playbackYoutubeSync}
                  />
                </div>
              </div>
            </div>
          ) : (
            <>
              {youtubeStimulusForGrading && (
                <div className="prompter-viewer-center-row prompter-viewer-center-row--media-stimulus">
                  <h2 className="prompter-viewer-section-heading">Assigned stimulus</h2>
                  {youtubeStimulusForGrading.label && (
                    <p className="prompter-viewer-media-stimulus-label">{youtubeStimulusForGrading.label}</p>
                  )}
                  {youtubeStimulusRuntimeError ? (
                    <p className="prompter-error-message">
                      Stimulus playback unavailable: {youtubeStimulusRuntimeError}
                    </p>
                  ) : (
                    <div className="prompter-viewer-media-stimulus-frame">
                      <YoutubeStimulusShell subtitleMask={assignment?.youtubePromptConfig?.subtitleMask}>
                        <YoutubeIframePlayer
                          ref={ytStimulusRef}
                          videoId={youtubeStimulusForGrading.videoId}
                          clipStartSec={youtubeStimulusForGrading.clipStartSec}
                          clipEndSec={youtubeStimulusForGrading.clipEndSec}
                          isStudent={!gradingMode}
                          allowStudentCaptions={assignment?.youtubePromptConfig?.allowStudentCaptions === true}
                          studentCaptionsVisible={studentStimulusCaptions}
                          teacherCaptionsEnabled={Boolean(gradingMode && teacherStimulusCaptions)}
                          onApiError={(m) => setYoutubeStimulusRuntimeError(m)}
                        />
                      </YoutubeStimulusShell>
                    </div>
                  )}
                  <p className="prompter-viewer-hint-muted">
                    Shown to the student during recording; segment matches the teacher&apos;s clip start and end.
                  </p>
                  {gradingMode ? (
                    <div className="prompter-viewer-youtube-dual-toolbar">
                      <label className="prompter-viewer-cc-toggle">
                        <input
                          type="checkbox"
                          checked={teacherStimulusCaptions}
                          onChange={(e) => setTeacherStimulusCaptions(e.target.checked)}
                        />{' '}
                        Show captions on stimulus
                      </label>
                    </div>
                  ) : assignment?.youtubePromptConfig?.allowStudentCaptions === true ? (
                    <div className="prompter-viewer-youtube-dual-toolbar">
                      <button
                        type="button"
                        className="prompter-viewer-video-bar-btn"
                        onClick={() => setStudentStimulusCaptions((c) => !c)}
                      >
                        {studentStimulusCaptions ? 'Turn off captions' : 'Turn on captions'}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}

              {!teacher &&
                isDeckPromptMode &&
                !youtubeDualLayout &&
                rubric.length > 0 &&
                current?.videoUrl && (
                  <div className="prompter-viewer-center-row prompter-viewer-center-row--student-sprout-beside-toggle">
                    <label className="prompter-viewer-cc-toggle">
                      <input
                        type="checkbox"
                        checked={showIncorrectSourceBeside}
                        onChange={(e) => setShowIncorrectSourceBeside(e.target.checked)}
                      />{' '}
                      Show model video beside my recording for cards that aren&apos;t at full credit
                    </label>
                  </div>
                )}

              <div className="prompter-viewer-video-wrap">
                {noSubmissionsInGradingMode ? (
                  <p className="prompter-viewer-no-video">No submissions for this assignment.</p>
                ) : current?.videoUrl ? (
                  !teacher && isDeckPromptMode && !youtubeDualLayout ? (
                    <div className="prompter-viewer-youtube-dual prompter-viewer-sprout-beside-dual">
                      <div className="prompter-viewer-sprout-beside-dual-grid">
                        <h2
                          className="prompter-viewer-section-heading prompter-viewer-sprout-beside-dual-title prompter-viewer-sprout-beside-dual-title--model"
                        >
                          Model (card)
                        </h2>
                        <h2
                          className="prompter-viewer-section-heading prompter-viewer-sprout-beside-dual-title prompter-viewer-sprout-beside-dual-title--yours"
                        >
                          Your recording
                        </h2>
                        <p className="prompter-viewer-hint-muted prompter-viewer-sprout-beside-dual-hint">
                          Matches the deck item at the current playhead.
                        </p>
                        <div
                          className="prompter-viewer-sprout-beside-dual-hint-spacer"
                          aria-hidden="true"
                        />
                        <div className="prompter-viewer-sprout-beside-dual-movie prompter-viewer-youtube-dual-frame prompter-viewer-sprout-beside-dual-movie--model">
                            {showStudentBesideSproutModel && studentBesideSproutEmbedSrc ? (
                              <iframe
                                key={`beside-sprout-${activeDeckIndex}-${activeDeckSproutVideoId}`}
                                title="Sprout model for this card"
                                src={studentBesideSproutEmbedSrc}
                                className="prompter-viewer-sprout-beside-embed"
                                allow="fullscreen; autoplay; encrypted-media"
                                referrerPolicy="strict-origin-when-cross-origin"
                              />
                            ) : (
                              <div className="prompter-viewer-sprout-beside-model-placeholder">
                                {studentBesideModelPlaceholderText}
                              </div>
                            )}
                        </div>
                        <div className="prompter-viewer-sprout-beside-dual-movie prompter-viewer-sprout-beside-dual-movie--submission">
                          <GradingVideoPlayer
                            hideControls
                            src={current.videoUrl}
                            videoKey={current.userId ?? ''}
                            videoRef={videoRef}
                            videoDurationSeconds={current.videoDurationSeconds}
                            durationSource={current.durationSource}
                            captionsVtt={submissionCaptionsForPlayer}
                          />
                        </div>
                      </div>
                      <div className="prompter-viewer-youtube-dual-toolbar prompter-viewer-youtube-dual-toolbar--transport">
                        <GradingPlaybackBar
                          videoRef={videoRef}
                          videoKey={current.userId ?? ''}
                          videoDurationSeconds={current.videoDurationSeconds}
                          durationSource={current.durationSource}
                        />
                      </div>
                    </div>
                  ) : (
                    <GradingVideoPlayer
                      src={current.videoUrl}
                      videoKey={current.userId ?? ''}
                      videoRef={videoRef}
                      videoDurationSeconds={current.videoDurationSeconds}
                      durationSource={current.durationSource}
                      captionsVtt={submissionCaptionsForPlayer}
                    />
                  )
                ) : hasSubmissionNoVideo ? (
                  <div className="prompter-viewer-processing">
                    <p>Your submission is being processed. Video will appear shortly. Refresh the page to check.</p>
                  </div>
                ) : (
                  <p className="prompter-viewer-no-video">No video</p>
                )}
              </div>
            </>
          )}

          {isDeckPromptMode && (
            <>
            <div className="prompter-viewer-grading-below-submission prompter-viewer-slot-deck-active-group">
              <div className="prompter-viewer-center-row prompter-viewer-center-row--active-header">
                <h2 className="prompter-viewer-section-heading">Active item</h2>
              </div>
              <div className="prompter-viewer-center-row prompter-viewer-center-row--active-item">
                {activeDeckPrompt && quickGradeRubricRowIndex >= 0 && rubric[quickGradeRubricRowIndex] ? (
                  <div className="prompter-viewer-active-item-panel prompter-viewer-active-item-panel--stacked">
                    <div className="prompter-viewer-active-item-ratings">
                      {rubric[quickGradeRubricRowIndex].ratings?.map((r) => {
                        const c = rubric[quickGradeRubricRowIndex];
                        const critId = String(c.id ?? quickGradeRubricRowIndex);
                        const selectedRatingId =
                          rubricDraft[critId]?.rating_id ?? getRubricRowAssessment(rubricAssessment, c, critId)?.rating_id;
                        const rid = String(r.id ?? '');
                        const pts = r.points ?? 0;
                        const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                        return (
                          <button
                            key={`active-${rid}`}
                            type="button"
                            className={`prompter-viewer-rubric-rating prompter-viewer-rubric-rating--active-item ${isSelected ? 'selected' : ''}`}
                            disabled={!teacher}
                            onClick={() => teacher && handleRubricRatingClick(critId, rid, pts)}
                          >
                            {r.description ?? ''} ({pts} pts)
                          </button>
                        );
                      })}
                    </div>
                    <div className="prompter-viewer-active-item-meta">
                      <div className="prompter-viewer-active-item-time-prompt-inline">
                        <span className="prompter-viewer-active-item-time">
                          {formatTime(Math.floor(activeDeckPrompt.startSec))}
                        </span>
                        <div
                          className="prompter-viewer-active-item-prompt-html"
                          dangerouslySetInnerHTML={{ __html: activeDeckPrompt.title || '—' }}
                        />
                        {showSourceCardButton && (
                          <button
                            type="button"
                            className="prompter-viewer-show-source-card-btn prompter-viewer-show-source-card-btn--inline-prompt"
                            disabled={!activeDeckSproutVideoId || !activeDeckSproutSecurityToken}
                            title={
                              !activeDeckSproutVideoId
                                ? 'No Sprout source video is recorded for this card on the timeline'
                                : !activeDeckSproutSecurityToken
                                  ? 'No Sprout security token for this card (sync decks or re-submit to refresh)'
                                  : 'Pause submission video and open the Sprout source for this card'
                            }
                            onClick={openSourceCardModal}
                          >
                            Show me the card
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : activeDeckPrompt ? (
                  <div className="prompter-viewer-active-item-panel prompter-viewer-active-item-panel--prompt-only prompter-viewer-active-item-panel--stacked">
                    <div className="prompter-viewer-active-item-meta">
                      <div className="prompter-viewer-active-item-time-prompt-inline">
                        <span className="prompter-viewer-active-item-time">
                          {formatTime(Math.floor(activeDeckPrompt.startSec))}
                        </span>
                        <div
                          className="prompter-viewer-active-item-prompt-html"
                          dangerouslySetInnerHTML={{ __html: activeDeckPrompt.title || '—' }}
                        />
                        {showSourceCardButton && (
                          <button
                            type="button"
                            className="prompter-viewer-show-source-card-btn prompter-viewer-show-source-card-btn--inline-prompt"
                            disabled={!activeDeckSproutVideoId || !activeDeckSproutSecurityToken}
                            title={
                              !activeDeckSproutVideoId
                                ? 'No Sprout source video is recorded for this card on the timeline'
                                : !activeDeckSproutSecurityToken
                                  ? 'No Sprout security token for this card (sync decks or re-submit to refresh)'
                                  : 'Pause submission video and open the Sprout source for this card'
                            }
                            onClick={openSourceCardModal}
                          >
                            Show me the card
                          </button>
                        )}
                      </div>
                    </div>
                    {rubric.length > 0 ? (
                      <p className="prompter-viewer-active-item-hint" role="status">
                        No quick grade row is aligned for this card with the current rubric. Use the
                        table in the left column, or fix rubric descriptions / card count vs. criteria
                        count.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="prompter-viewer-active-item-hint">Play the video to see the active deck item.</p>
                )}
              </div>
            </div>
            {teacher && !noSubmissionsInGradingMode && viewerGradingStackOrder && (
              <div
                className={`prompter-viewer-center-row prompter-viewer-center-row--freeform-feedback${viewerGradingStackOrder ? ' prompter-viewer-slot-freeform-group' : ''}`}
              >
                <div className="prompter-viewer-textarea-wrap" onKeyDown={handleCommentKeyDown}>
                  <TeacherFeedbackRichEditor
                    key={`freeform-${current?.userId ?? 'none'}`}
                    editorRef={commentEditorRef}
                    initialHtml=""
                    autoFocus={false}
                    toolbarAtBottom
                  />
                </div>
                <p className="prompter-hint prompter-viewer-feedback-richtext-hint">
                  Shown for the <strong>current card/segment</strong> while the playhead is within that segment. Rich
                  text is stored on the Canvas submission. <strong>Enter</strong> posts at the segment start;{' '}
                  <strong>Shift+Enter</strong> is a new line.
                </p>
                {activeFeedback.length > 0 && (
                  <div className="prompter-viewer-feedback-at-playhead" aria-live="polite">
                    {activeFeedback.map((f) => (
                      <span key={f.id} className="prompter-viewer-feedback-at-playhead-item">
                        <strong>{formatTime(f.time)}</strong>:{' '}
                        <FeedbackHtmlSnippet html={f.text} />{' '}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            </>
          )}

          {viewerGradingStackOrder && !isDeckPromptMode && rubric.length > 0 && (
            <div className="prompter-viewer-grading-below-submission prompter-viewer-slot-nondeck-grading-group">
              <div className="prompter-viewer-center-row prompter-viewer-center-row--active-header">
                <h2 className="prompter-viewer-section-heading">Rubric (this response)</h2>
              </div>
              <div className="prompter-viewer-nondeck-grading-panels">
                {rubric.map((c, rowIdx) => {
                  const critId = String(c.id ?? rowIdx);
                  const assess = getRubricRowAssessment(rubricAssessment, c, critId);
                  const selectedRatingId = rubricDraft[critId]?.rating_id ?? assess?.rating_id;
                  const commentVal = rubricDraft[critId]?.comments ?? '';
                  return (
                    <div key={`center-rubric-${critId}`} className="prompter-viewer-nondeck-criterion-panel">
                      <div className="prompter-viewer-canvas-criterion-desc prompter-viewer-nondeck-criterion-title">
                        {c.description ?? 'Criterion'}{' '}
                        <span className="prompter-viewer-criterion-pts">({c.points ?? 0} pts)</span>
                      </div>
                      <div className="prompter-viewer-rubric-ratings prompter-viewer-nondeck-criterion-ratings">
                        {c.ratings?.map((r) => {
                          const rid = String(r.id ?? '');
                          const pts = r.points ?? 0;
                          const isSelected = selectedRatingId != null && String(selectedRatingId) === rid;
                          return (
                            <button
                              key={rid}
                              type="button"
                              className={`prompter-viewer-rubric-rating prompter-viewer-rubric-rating--active-item ${isSelected ? 'selected' : ''}`}
                              disabled={!teacher}
                              onClick={() => teacher && handleRubricRatingClick(critId, rid, pts)}
                            >
                              {r.description ?? ''} ({pts} pts)
                            </button>
                          );
                        })}
                      </div>
                      <div className="prompter-viewer-criterion-comment-wrap">
                        <label className="prompter-viewer-criterion-comment-label" htmlFor={`rubric-comment-center-${critId}`}>
                          Criterion comment
                        </label>
                        <textarea
                          id={`rubric-comment-center-${critId}`}
                          className="prompter-viewer-criterion-comment-textarea"
                          rows={2}
                          value={commentVal}
                          onChange={(e) =>
                            setRubricDraft((prev) => ({
                              ...prev,
                              [critId]: { ...(prev[critId] ?? {}), comments: e.target.value },
                            }))
                          }
                          onBlur={(e) => {
                            if (!teacher) return;
                            handleRubricCriterionCommentBlur(critId, e.target.value);
                          }}
                          disabled={!teacher}
                          placeholder="Optional — saved to Canvas when you leave this field"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          </div>

          {teacher && !noSubmissionsInGradingMode && (!isDeckPromptMode || !viewerGradingStackOrder) && (
            <div
              className={`prompter-viewer-center-row prompter-viewer-center-row--freeform-feedback${viewerGradingStackOrder ? ' prompter-viewer-slot-freeform-group' : ''}`}
            >
              <div className="prompter-viewer-textarea-wrap" onKeyDown={handleCommentKeyDown}>
                <TeacherFeedbackRichEditor
                  key={`freeform-${current?.userId ?? 'none'}`}
                  editorRef={commentEditorRef}
                  initialHtml=""
                  autoFocus={false}
                  toolbarAtBottom
                />
              </div>
              <p className="prompter-hint prompter-viewer-feedback-richtext-hint">
                Shown for the <strong>current card/segment</strong> while the playhead is within that segment. Rich text
                is stored on the Canvas submission. <strong>Enter</strong> posts at the segment start;{' '}
                <strong>Shift+Enter</strong> is a new line.
              </p>
              {activeFeedback.length > 0 && (
                <div className="prompter-viewer-feedback-at-playhead" aria-live="polite">
                  {activeFeedback.map((f) => (
                    <span key={f.id} className="prompter-viewer-feedback-at-playhead-item">
                      <strong>{formatTime(f.time)}</strong>:{' '}
                      <FeedbackHtmlSnippet html={f.text} />{' '}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {showCaptionsAccessibilityHelp ? (
            <div
              className={`prompter-viewer-center-row prompter-viewer-captions-access-wrap${viewerGradingStackOrder ? ' prompter-viewer-slot-captions-disclosure' : ''}`}
            >
              <button
                type="button"
                className="prompter-viewer-grade-btn prompter-viewer-caption-help-toggle"
                aria-expanded={captionHelpOpen}
                onClick={() => setCaptionHelpOpen((o) => !o)}
              >
                {captionHelpOpen ? 'Hide' : 'Show'} caption & transcript accessibility tips
              </button>
              {captionHelpOpen ? (
                <div className="prompter-viewer-caption-help-panel">
                  <CaptionsAccessibilityPanel />
                </div>
              ) : null}
            </div>
          ) : null}

          {isTextPromptMode && (
            <div className={viewerGradingStackOrder ? 'prompter-viewer-slot-text-prompt-group' : undefined}>
              <div className="prompter-viewer-center-row prompter-viewer-center-row--active-header">
                <h2 className="prompter-viewer-section-heading">Prompt</h2>
              </div>
              <div className="prompter-viewer-center-row prompter-viewer-center-row--active-item">
                <div className="prompter-viewer-text-prompt-inline-actions">
                  <button
                    type="button"
                    className="prompter-viewer-grade-btn"
                    onClick={() => setTextPromptVisible((v) => !v)}
                  >
                    {textPromptVisible ? 'Hide full prompt (side panel)' : 'Show full prompt (side panel)'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
        {isTextPromptMode && textPromptVisible && (
          <>
            <div className="prompter-viewer-resize-handle" id="resize-handle-right" title="Drag to resize" />
            <aside
              ref={rightSidebarRef}
              className="prompter-viewer-sidebar prompter-viewer-sidebar-right"
              id="viewer-sidebar-right"
            >
              <div className="prompter-viewer-right-prompt-sticky">
                <div className="prompter-viewer-prompt-label">Prompt</div>
                <div
                  className="prompter-viewer-prompt-content-block"
                  dangerouslySetInnerHTML={{ __html: promptUsed }}
                />
              </div>
            </aside>
          </>
        )}
      </div>
      <SproutSourceCardModal
        isOpen={sourceCardPreview != null}
        onClose={closeSourceCardModal}
        videoId={sourceCardPreview?.videoId ?? ''}
        securityToken={sourceCardPreview?.securityToken ?? ''}
      />
      {feedbackEditEntry && (
        <div
          className="teacher-feedback-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-edit-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancelFeedbackEdit();
          }}
        >
          <div className="teacher-feedback-modal">
            <h3 id="feedback-edit-title">Edit feedback at {formatTime(feedbackEditEntry.time)}</h3>
            <TeacherFeedbackRichEditor
              key={`edit-${feedbackEditEntry.id}`}
              editorRef={feedbackEditModalEditorRef}
              initialHtml={feedbackEditEntry.text}
              autoFocus
            />
            <div className="teacher-feedback-modal-actions">
              <button
                type="button"
                className="prompter-viewer-grade-btn"
                onClick={handleCancelFeedbackEdit}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="prompter-viewer-grade-btn"
                onClick={() => void handleSaveFeedbackEdit()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
