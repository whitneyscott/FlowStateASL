import { useCallback, useEffect, useRef, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import * as promptApi from '../api/prompt.api';
import { ManualTokenModal } from '../components/ManualTokenModal';
import { resolveLtiContextValue } from '../utils/lti-context';
import { ltiTokenHeaders } from '../api/lti-token';
import { appendBridgeLog } from '../utils/bridge-log';
import { nextDeckIndexAfterAdvance } from '../utils/deck-advance';
import { buildYoutubeNocookieEmbedSrc } from '../utils/youtube-embed';
import './PrompterPage.css';

const TEACHER_ROLE_PATTERNS = [
  'instructor',
  'administrator',
  'faculty',
  'teacher',
  'staff',
  'contentdeveloper',
  'teachingassistant',
  'ta',
];

function isPrompterTeacher(roles: string | undefined): boolean {
  if (!roles || typeof roles !== 'string') return false;
  return TEACHER_ROLE_PATTERNS.some((p) => roles.toLowerCase().includes(p));
}

interface TimerPageProps {
  context: LtiContext | null;
}

function simpleFingerprint(): string {
  const ua = navigator.userAgent;
  const lang = navigator.language;
  return btoa(ua + '|' + lang).slice(0, 32);
}

/** Must match prompt.service.ts: min prompt floor (2.5s) + cognitive transition (1s). */
const DECK_MIN_VIDEO_FLOOR_SECONDS = 2.5;
const DECK_COGNITIVE_TRANSITION_SECONDS = 1;
const DECK_FALLBACK_TOTAL_SECONDS = DECK_MIN_VIDEO_FLOOR_SECONDS + DECK_COGNITIVE_TRANSITION_SECONDS;

/** Deck-based prompt with timing info */
interface DeckPromptItem {
  title: string;
  videoId?: string;
  /** Total seconds for this card (see server buildDeckPromptList). */
  duration: number;
}

interface CaptureProfile {
  id: 'p720' | 'p540' | 'p480';
  requestedWidth: number;
  requestedHeight: number;
  requestedFps: number;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
}

interface CaptureProfileTelemetry {
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
}

const CAPTURE_PROFILE_LADDER: CaptureProfile[] = [
  { id: 'p720', requestedWidth: 1280, requestedHeight: 720, requestedFps: 30, videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 96_000 },
  { id: 'p540', requestedWidth: 960, requestedHeight: 540, requestedFps: 24, videoBitsPerSecond: 1_300_000, audioBitsPerSecond: 80_000 },
  { id: 'p480', requestedWidth: 854, requestedHeight: 480, requestedFps: 24, videoBitsPerSecond: 950_000, audioBitsPerSecond: 64_000 },
];

const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const RECORDER_TIMESLICE_MS = 1000;
const CLIENT_UPLOAD_SOFT_WARN_BYTES = 65 * 1024 * 1024;
const YOUTUBE_EMBED_READY_TIMEOUT_MS = 10_000;

function pickSupportedMimeType(): string {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function toMb(sizeBytes: number): string {
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FlashcardPlaylistItem = { id?: string; title?: string };

/** Bridge / LTI log: compact summary of deck prompts for tracing videoId through the pipeline. */
const DECK_LIVE_BUILD_BRIDGE_SAMPLE = 8;
function summaryDeckPromptsForLiveBuildBridge(
  stage: string,
  prompts: DeckPromptItem[],
): {
  stage: string;
  count: number;
  withVideoIdCount: number;
  missingVideoIdCount: number;
  sample: Array<{ title: string; videoId: string | null; duration: number }>;
} {
  const withVideoIdCount = prompts.filter((p) => (p.videoId ?? '').trim().length > 0).length;
  return {
    stage,
    count: prompts.length,
    withVideoIdCount,
    missingVideoIdCount: prompts.length - withVideoIdCount,
    sample: prompts.slice(0, DECK_LIVE_BUILD_BRIDGE_SAMPLE).map((p) => ({
      title: (p.title ?? '').trim().slice(0, 56),
      videoId: (p.videoId ?? '').trim() || null,
      duration: p.duration,
    })),
  };
}

/** When live build-deck-prompts fails, fallback prompts may lack Sprout video ids. Hydrate from playlist cache (same source as Flashcards). */
async function hydrateDeckPromptVideoIds(
  prompts: DeckPromptItem[],
  selectedDecks: Array<{ id: string }>,
): Promise<DeckPromptItem[]> {
  if (!prompts.length || !selectedDecks.length) return prompts;
  const needsId = prompts.some((p) => !(p.videoId ?? '').trim());
  if (!needsId) return prompts;

  const titleToIds = new Map<string, string[]>();
  const norm = (t: string) => t.toLowerCase().trim();

  await Promise.all(
    selectedDecks.map(async (d) => {
      const id = (d.id ?? '').trim();
      if (!id) return;
      try {
        const res = await fetch(`/api/flashcard/items?playlist_id=${encodeURIComponent(id)}`, {
          credentials: 'include',
          headers: ltiTokenHeaders(),
        });
        const data = (await res.json().catch(() => [])) as unknown;
        const list = Array.isArray(data) ? (data as FlashcardPlaylistItem[]) : [];
        for (const it of list) {
          const vid = String(it.id ?? '').trim();
          const title = String(it.title ?? '').trim();
          if (!vid || !title) continue;
          const key = norm(title);
          const arr = titleToIds.get(key) ?? [];
          arr.push(vid);
          titleToIds.set(key, arr);
        }
      } catch {
        // best-effort only
      }
    }),
  );

  return prompts.map((p) => {
    const existing = (p.videoId ?? '').trim();
    if (existing) return p;
    const ids = titleToIds.get(norm(p.title));
    const first = ids?.[0]?.trim();
    if (!first) return p;
    return { ...p, videoId: first };
  });
}

/** Cap wait for metadata; fail open so submission never blocks on duration. */
const VIDEO_DURATION_PROBE_MS = 1200;

/**
 * Best-effort duration for a recorded blob (object URL + video loadedmetadata).
 * Resolves null on timeout, decode error, or non-finite duration.
 */
function probeBlobVideoDurationSeconds(
  blob: Blob,
  timeoutMs = VIDEO_DURATION_PROBE_MS,
): Promise<{ seconds: number | null; reason: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let settled = false;
    const finish = (seconds: number | null, reason: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(tid);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve({ seconds, reason });
    };
    const tid = window.setTimeout(() => finish(null, 'timeout'), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        finish(Math.round(d * 1000) / 1000, 'loadedmetadata_ok');
      } else {
        finish(null, 'loadedmetadata_invalid_duration');
      }
    };
    video.onerror = () => finish(null, 'video_element_error');
    video.src = url;
  });
}

function appendDurationBridgeLog(message: string): void {
  appendBridgeLog('duration', message);
}

function mapSubmitErrorForStudent(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('server busy')) return 'Many students are submitting right now. Wait about 30 seconds, then try again.';
  if (lower.includes('temporarily unavailable')) return 'Server is temporarily unavailable. Please wait a moment, then retry.';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'Upload timed out. Please retry, or re-record if your connection is unstable.';
  if (lower.includes('too large') || lower.includes('upload_too_large')) {
    return `Video file is too large. Please keep it under ${Math.round(promptApi.DEFAULT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
  }
  return message;
}

function recordSecondsForDeckCard(item: DeckPromptItem | undefined): number {
  const d = item?.duration;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
    const total = Math.max(DECK_MIN_VIDEO_FLOOR_SECONDS, d) + DECK_COGNITIVE_TRANSITION_SECONDS;
    return Math.max(1, Math.ceil(total));
  }
  return Math.max(1, Math.ceil(DECK_FALLBACK_TOTAL_SECONDS));
}

export default function TimerPage({ context }: TimerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<
    'access' | 'warmup' | 'getReady' | 'youtubeStimulus' | 'preflight' | 'record' | 'upload' | 'done'
  >('access');
  const [accessCode, setAccessCode] = useState('');
  const [accessError, setAccessError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [recordSecondsLeft, setRecordSecondsLeft] = useState(0);
  const [promptIndex, setPromptIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitInfo, setSubmitInfo] = useState<string | null>(null);
  const [preflightReady, setPreflightReady] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [captureProfile, setCaptureProfile] = useState<CaptureProfileTelemetry | null>(null);
  
  // Deck mode state
  const [deckPrompts, setDeckPrompts] = useState<DeckPromptItem[]>([]);
  /** True when assignment is configured for deck prompts (used before deck list finishes loading). */
  const [studentDeckFlow, setStudentDeckFlow] = useState(false);
  /** Set when live POST /build-deck-prompts fails; we do not fall back to banks/static (no Sprout ids). */
  const [deckLiveBuildError, setDeckLiveBuildError] = useState<string | null>(null);
  /** YouTube clip → then camera recording (no deck cards). */
  const [studentYoutubeFlow, setStudentYoutubeFlow] = useState(false);
  /** Wall-clock countdown while the YouTube iframe segment plays (not recorded). */
  const [youtubeStimulusSecondsLeft, setYoutubeStimulusSecondsLeft] = useState(0);
  /** True once the student-side YouTube iframe has loaded its embed page. */
  const [youtubeEmbedReady, setYoutubeEmbedReady] = useState(false);
  /** Surface a clear message when embed load takes too long. */
  const [youtubeEmbedLoadSlow, setYoutubeEmbedLoadSlow] = useState(false);
  /** 3 → 2 → 1 → record (deck flow only). */
  const [getReadyTick, setGetReadyTick] = useState(3);
  
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const submitOnStopRef = useRef(false);
  const pendingPromptRef = useRef('');
  const lastDeckTimelineRef = useRef<promptApi.DeckTimelineEntry[] | undefined>(undefined);
  /** MediaRecorder `onstart` time; used to mark deck card boundaries in the real recording timeline. */
  const recordStartPerfRef = useRef(0);
  const deckBoundaryListRef = useRef<Array<{ title: string; startSec: number; videoId?: string }>>([]);
  const autoFinishFiredRef = useRef(false);
  /** Prevents double-handling when per-card timer hits 0 (React strict / re-renders). */
  const deckZeroHandledForIndexRef = useRef<number>(-1);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);
  const assignmentId = resolveLtiContextValue(context?.assignmentId);
  const params = new URLSearchParams(window.location.search);
  const urlAssignmentId =
    params.get('assignmentId')?.trim() ??
    params.get('assignment_id')?.trim() ??
    '';
  /** From LTI/URL only — used for initial GET /config so we do not refetch when resolvedAssignmentId arrives. */
  const ltiOrUrlAssignmentId = assignmentId || urlAssignmentId || null;
  /** Submission target: launch/query id, else id resolved server-side from Prompt Manager Settings blob. */
  const effectiveAssignmentId =
    ltiOrUrlAssignmentId || (config?.resolvedAssignmentId?.trim() ?? '') || null;
  const teacherViewingTimer = context ? isPrompterTeacher(context.roles) : false;

  const doSubmit = useCallback(
    async (
      promptSnapshot: string,
      blob: Blob | null,
      deckTimeline?: promptApi.DeckTimelineEntry[],
    ) => {
      console.log('[TimerPage:doSubmit] ENTER', {
        hasBlob: !!blob,
        blobSize: blob?.size,
        promptLength: promptSnapshot?.length,
        deckTimelineCount: deckTimeline?.length ?? 0,
        messageType: context?.messageType,
      });
      setSubmitError(null);
      setSubmitInfo(null);
      if (blob && blob.size > promptApi.DEFAULT_UPLOAD_MAX_BYTES) {
        setSubmitError(
          `Video is ${toMb(blob.size)}, which is above the upload limit (${Math.round(promptApi.DEFAULT_UPLOAD_MAX_BYTES / (1024 * 1024))} MB). Please record a shorter/lower-quality clip and submit again.`,
        );
        setPhase('record');
        return;
      }
      if (blob && blob.size > CLIENT_UPLOAD_SOFT_WARN_BYTES) {
        setSubmitInfo(
          `Large upload detected (${toMb(blob.size)}). Keep this tab open during submission.`,
        );
      }
      let durationSeconds: number | null = null;
      let probeReason = 'no_blob';
      if (blob) {
        try {
          const probe = await probeBlobVideoDurationSeconds(blob);
          durationSeconds = probe.seconds;
          probeReason = probe.reason;
        } catch (e) {
          durationSeconds = null;
          probeReason = `exception:${e instanceof Error ? e.message : String(e)}`;
        }
      }
      appendDurationBridgeLog(
        `TimerPage probeBlobVideoDurationSeconds: seconds=${durationSeconds === null ? 'null' : String(durationSeconds)} reason=${probeReason}`,
      );
      setPhase(blob ? 'upload' : 'done');
      const isDeepLink = context?.messageType === 'LtiDeepLinkingRequest';
      const submitAttemptKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let lastEndpoint = 'POST /api/prompt/save-prompt';
      try {
        const isDeckSubmit = (deckTimeline?.length ?? 0) > 0;
        if (isDeckSubmit && deckTimeline && deckTimeline.length > 0) {
          const withVid = deckTimeline.filter((r) => (r.videoId ?? '').trim().length > 0).length;
          appendBridgeLog(
            'deck-live-build',
            'OK: deckTimeline at submit (sent to /submit and upload-video form)',
            {
              outcome: 'success',
              stage: 'submit-payload',
              rowCount: deckTimeline.length,
              withVideoIdCount: withVid,
              missingVideoIdCount: deckTimeline.length - withVid,
              sample: deckTimeline.slice(0, DECK_LIVE_BUILD_BRIDGE_SAMPLE).map((r) => ({
                title: (r.title ?? '').trim().slice(0, 56),
                videoId: (r.videoId ?? '').trim() || null,
                startSec: r.startSec,
              })),
            },
          );
        }
        if (!isDeckSubmit) {
          console.log('[TimerPage:doSubmit] Step 1: savePrompt');
          setLastFunction('POST /api/prompt/save-prompt');
          await promptApi.savePrompt(promptSnapshot, effectiveAssignmentId);
          setLastApiResult('POST /api/prompt/save-prompt', 200, true);
          console.log('[TimerPage:doSubmit] savePrompt OK');
        } else {
          console.log('[TimerPage:doSubmit] Step 1: skip savePrompt (deck submission; deckTimeline is authoritative)');
        }

        if (isDeepLink && blob) {
          lastEndpoint = 'POST /api/prompt/submit-deep-link';
          console.log('[TimerPage:doSubmit] Step 2a: submitDeepLink (isDeepLink=true)', { blobSize: blob.size });
          setLastFunction('POST /api/prompt/submit-deep-link');
          const result = await promptApi.submitDeepLink(blob, `asl_submission_${Date.now()}.webm`, effectiveAssignmentId);
          setLastApiResult('POST /api/prompt/submit-deep-link', 200, true);
          let html: string;
          if (typeof result === 'object' && result?.dev) {
            const dev = result.dev;
            console.log('[TimerPage:doSubmit]', dev.message);
            console.log('[TimerPage:doSubmit] Video title for submission:', {
              contentItemTitle: dev.contentItemTitle ?? '(not returned)',
              videoTitle: dev.videoTitle ?? '(not returned)',
              length: (dev.contentItemTitle ?? dev.videoTitle ?? '').length,
            });
            if (dev.contentItemTitle) {
              console.log('[TimerPage:doSubmit] Content item title sent to Canvas (should appear on submission):', dev.contentItemTitle);
            }
            await new Promise((r) => setTimeout(r, dev.delayMs ?? 2500));
            html = result.html;
          } else {
            html = typeof result === 'string' ? result : '';
          }
          console.log('[TimerPage:doSubmit] submitDeepLink OK, document.write...');
          document.open();
          document.write(html);
          document.close();
          console.log('[TimerPage:doSubmit] document.write done → Canvas panel should load');
          return;
        }
        if (!isDeepLink) {
          // PHP parity: submit_prompt_first.php then upload_handler.php — submission row must exist before file attach.
          lastEndpoint = 'POST /api/prompt/submit';
          console.log('[TimerPage:doSubmit] Step 2: submitPrompt (create submission row; submit_prompt_first.php)');
          setLastFunction('POST /api/prompt/submit');
          // #region agent log
          appendBridgeLog('agent-debug', 'TimerPage doSubmit: before submitPrompt', {
            hypothesisId: 'H1',
            deckLen: deckTimeline?.length ?? 0,
            omitSnapshotBecauseDeck: !!(deckTimeline?.length),
            snapshotLenIfSent: deckTimeline?.length ? 0 : (promptSnapshot?.length ?? 0),
            firstRowVideoIdLen:
              (deckTimeline?.[0] as { videoId?: string } | undefined)?.videoId?.trim()?.length ?? 0,
          });
          // #endregion
          await promptApi.submitPrompt(
            deckTimeline?.length ? undefined : promptSnapshot,
            effectiveAssignmentId,
            deckTimeline,
            {
              idempotencyKey: `submit-${submitAttemptKey}`,
            },
          );
          setLastApiResult('POST /api/prompt/submit', 200, true);
          console.log('[TimerPage:doSubmit] submitPrompt OK');
          if (blob) {
            lastEndpoint = 'POST /api/prompt/upload-video';
            console.log('[TimerPage:doSubmit] Step 3: uploadVideo (attach to row; upload_handler.php)', {
              blobSize: blob.size,
            });
            setLastFunction('POST /api/prompt/upload-video');
            const yc = config?.youtubePromptConfig;
            const mediaStimulus: promptApi.MediaStimulusPayload | undefined =
              yc?.videoId &&
              Number.isFinite(Number(yc.clipEndSec)) &&
              Math.floor(Number(yc.clipEndSec)) > Math.max(0, Math.floor(Number(yc.clipStartSec ?? 0)))
                ? {
                    kind: 'youtube',
                    videoId: String(yc.videoId).trim(),
                    clipStartSec: Math.max(0, Math.floor(Number(yc.clipStartSec ?? 0))),
                    clipEndSec: Math.floor(Number(yc.clipEndSec)),
                    ...(yc.label?.trim() ? { label: yc.label.trim() } : {}),
                  }
                : undefined;
            const result = await promptApi.uploadVideo(
              blob,
              `asl_submission_${Date.now()}.webm`,
              effectiveAssignmentId,
              {
                deckTimeline,
                idempotencyKey: `upload-${submitAttemptKey}`,
                captureProfile: captureProfile ?? undefined,
                ...(durationSeconds != null ? { durationSeconds } : {}),
                ...(mediaStimulus ? { mediaStimulus } : {}),
              },
            );
            setLastApiResult('POST /api/prompt/upload-video', 200, true);
            console.log('[TimerPage:doSubmit] uploadVideo OK', result);
          }
        }
        setPhase('done');
        console.log('[TimerPage:doSubmit] DONE');
      } catch (e) {
        console.error('[TimerPage:doSubmit] FAILED', { lastEndpoint, error: e });
        const rawMessage = e instanceof Error ? e.message : 'Submit failed';
        setSubmitError(mapSubmitErrorForStudent(rawMessage));
        if (blob) {
          setSubmitInfo(
            `Retry tip: keep your browser tab open and avoid switching networks while uploading ${toMb(blob.size)}.`,
          );
        }
        setLastApiError(lastEndpoint, 0, String(e));
      }
    },
    [
      context?.messageType,
      captureProfile,
      config?.youtubePromptConfig,
      setLastFunction,
      setLastApiResult,
      setLastApiError,
      effectiveAssignmentId,
    ]
  );

  useEffect(() => {
    const el = videoRef.current;
    const stream = streamRef.current;
    if (el && stream) {
      el.srcObject = stream;
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [phase, preflightReady]);

  useEffect(() => {
    if (phase !== 'preflight') return;
    setPreflightReady(false);
    setPreflightError(null);
    setSubmitInfo(null);
    let cancelled = false;
    const openCameraWithFallback = async () => {
      let lastError: unknown;
      for (const profile of CAPTURE_PROFILE_LADDER) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: profile.requestedWidth, max: profile.requestedWidth },
              height: { ideal: profile.requestedHeight, max: profile.requestedHeight },
              frameRate: { ideal: profile.requestedFps, max: profile.requestedFps },
            },
            audio: true,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          const trackSettings = stream.getVideoTracks()[0]?.getSettings();
          const telemetry: CaptureProfileTelemetry = {
            profileId: profile.id,
            requestedWidth: profile.requestedWidth,
            requestedHeight: profile.requestedHeight,
            requestedFps: profile.requestedFps,
            actualWidth: Number(trackSettings?.width ?? 0) || undefined,
            actualHeight: Number(trackSettings?.height ?? 0) || undefined,
            actualFps: Number(trackSettings?.frameRate ?? 0) || undefined,
            videoBitsPerSecond: profile.videoBitsPerSecond,
            audioBitsPerSecond: profile.audioBitsPerSecond,
            mimeType: pickSupportedMimeType() || 'browser-default',
          };
          console.log('[TimerPage:preflight] capture profile selected', telemetry);
          streamRef.current = stream;
          setCaptureProfile(telemetry);
          setPreflightReady(true);
          return;
        } catch (err) {
          lastError = err;
          console.warn('[TimerPage:preflight] capture profile failed, trying fallback', {
            profileId: profile.id,
            error: String(err),
          });
        }
      }
      if (!cancelled) {
        setCaptureProfile(null);
        setPreflightError('Camera/mic access denied or unavailable for recording.');
        if (lastError) {
          console.error('[TimerPage:preflight] all capture profile attempts failed', lastError);
        }
      }
    };
    void openCameraWithFallback();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const minutes = config?.minutes ?? 5;
  const prompts = config?.prompts ?? [];
  const needsAccessCode = !!config?.accessCode?.trim();
  // Use dynamically generated deck prompts when present; otherwise use configured text prompts.
  // This keeps deck-mode rendering on the same display path as standard text prompts.
  const displayPrompts = deckPrompts.length > 0 
    ? deckPrompts.map(p => p.title) 
    : prompts;
  const deckMode = deckPrompts.length > 0;
  const currentPromptText = displayPrompts[promptIndex] ?? (displayPrompts[0] ?? '');

  const loadConfig = useCallback(async () => {
    if (!context?.courseId) {
      setLoading(false);
      return;
    }
       setLoading(true);
    setDeckLiveBuildError(null);
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig(ltiOrUrlAssignmentId);
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      const targetAssignmentId =
        (data?.resolvedAssignmentId?.trim() ?? '') || ltiOrUrlAssignmentId || null;
      const selectedDecksForHydration = data?.videoPromptConfig?.selectedDecks ?? [];

      const isDeckAssignment =
        data?.promptMode === 'decks' &&
        (data.videoPromptConfig?.selectedDecks?.length ?? 0) > 0;
      const isYoutubeAssignment =
        data?.promptMode === 'youtube' &&
        !!data.youtubePromptConfig?.videoId &&
        Math.floor(Number(data.youtubePromptConfig.clipEndSec)) >
          Math.max(0, Math.floor(Number(data.youtubePromptConfig.clipStartSec ?? 0)));
      setStudentDeckFlow(!!isDeckAssignment);
      setStudentYoutubeFlow(!!isYoutubeAssignment);

      // If deck mode, fetch the prompt list
      if (data?.promptMode === 'decks' && data?.videoPromptConfig?.selectedDecks && data.videoPromptConfig.selectedDecks.length > 0) {
        const rawTotal = Number(data.videoPromptConfig.totalCards);
        const totalCards = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 10;
        try {
          setLastFunction('POST /api/prompt/build-deck-prompts');
          const result = await promptApi.buildDeckPrompts(
            data.videoPromptConfig.selectedDecks,
            totalCards,
            targetAssignmentId
          );
          const livePrompts = Array.isArray(result.prompts) ? result.prompts : [];
          if (livePrompts.length > 0) {
            setLastApiResult('POST /api/prompt/build-deck-prompts', 200, true);
            const preSummary = summaryDeckPromptsForLiveBuildBridge('pre-hydrate', livePrompts);
            appendBridgeLog(
              'deck-live-build',
              'OK: live build — prompts from API before hydrateDeckPromptVideoIds',
              {
                outcome: 'success',
                assignmentId: targetAssignmentId ?? '(none)',
                warning: result.warning ?? null,
                ...preSummary,
              },
            );
            const hydrated = await hydrateDeckPromptVideoIds(livePrompts, selectedDecksForHydration);
            const postSummary = summaryDeckPromptsForLiveBuildBridge('post-hydrate', hydrated);
            appendBridgeLog(
              'deck-live-build',
              'OK: live build — prompts after hydrateDeckPromptVideoIds (used for recording + submit)',
              {
                outcome: 'success',
                assignmentId: targetAssignmentId ?? '(none)',
                videoIdsAddedByHydrate:
                  postSummary.withVideoIdCount - preSummary.withVideoIdCount,
                preHydrate: { withVideoIdCount: preSummary.withVideoIdCount, count: preSummary.count },
                postHydrate: { withVideoIdCount: postSummary.withVideoIdCount, count: postSummary.count },
                sampleAfterHydrate: postSummary.sample,
              },
            );
            setDeckPrompts(hydrated);
            setDeckLiveBuildError(null);
          } else {
            throw new Error(result.warning || 'live build returned zero prompts');
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error('Failed to build deck prompts:', e);
          appendBridgeLog(
            'deck-live-build',
            'ALERT: Live deck build failed — prompts not loaded (no stored-bank / static fallback).',
            {
              outcome: 'fail',
              error: errMsg,
              assignmentId: targetAssignmentId ?? '(none)',
              selectedDeckCount: data.videoPromptConfig.selectedDecks.length,
              totalCards,
            },
          );
          setDeckPrompts([]);
          setDeckLiveBuildError(
            'Deck prompts could not be loaded from the server. Try again, or contact your instructor if this keeps happening.',
          );
          setLastApiError('POST /api/prompt/build-deck-prompts', 0, errMsg);
        }
      } else {
        setDeckPrompts([]);
      }

      if (!data?.accessCode?.trim()) {
        if (isDeckAssignment || isYoutubeAssignment) {
          setPhase('preflight');
        } else {
          setPhase('warmup');
          setSecondsLeft((data?.minutes ?? 5) * 60);
        }
      }
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      }
      setConfig(null);
      setStudentDeckFlow(false);
      setStudentYoutubeFlow(false);
      setDeckLiveBuildError(null);
    } finally {
      setLoading(false);
    }
  }, [
    context?.courseId,
    ltiOrUrlAssignmentId,
    setLastFunction,
    setLastApiResult,
    setLastApiError,
  ]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const onCanvasTokenCleared = () => {
      setShowManualTokenModal(true);
      setSubmitError(null);
      setLastApiError('manual-token', 401, 'Canvas token cleared. Enter a new token to continue.');
    };
    window.addEventListener('aslexpress:canvas-token-cleared', onCanvasTokenCleared as EventListener);
    return () => {
      window.removeEventListener('aslexpress:canvas-token-cleared', onCanvasTokenCleared as EventListener);
    };
  }, [setLastApiError]);

  useEffect(() => {
    if (phase !== 'warmup' || secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [phase, secondsLeft]);

  useEffect(() => {
    if (phase !== 'warmup' || secondsLeft > 0) return;
    setPhase('preflight');
  }, [phase, secondsLeft]);

  useEffect(() => {
    if (phase !== 'getReady') return;
    if (getReadyTick <= 0) {
      setPhase(studentYoutubeFlow ? 'youtubeStimulus' : 'record');
      return;
    }
    const id = window.setTimeout(() => setGetReadyTick((t) => t - 1), 1000);
    return () => window.clearTimeout(id);
  }, [phase, getReadyTick, studentYoutubeFlow]);

  useEffect(() => {
    if (phase !== 'youtubeStimulus') return;
    const yc = config?.youtubePromptConfig;
    if (!yc?.videoId) return;
    setYoutubeEmbedReady(false);
    setYoutubeEmbedLoadSlow(false);
    const wall = Math.max(
      1,
      Math.floor(Number(yc.clipEndSec)) - Math.max(0, Math.floor(Number(yc.clipStartSec ?? 0))),
    );
    setYoutubeStimulusSecondsLeft(wall);
  }, [phase, config]);

  useEffect(() => {
    if (phase !== 'youtubeStimulus' || !youtubeEmbedReady || youtubeStimulusSecondsLeft <= 0) return;
    const id = window.setInterval(() => setYoutubeStimulusSecondsLeft((s) => s - 1), 1000);
    return () => window.clearInterval(id);
  }, [phase, youtubeEmbedReady, youtubeStimulusSecondsLeft]);

  useEffect(() => {
    if (phase !== 'youtubeStimulus' || !youtubeEmbedReady || youtubeStimulusSecondsLeft > 0) return;
    setPhase('record');
  }, [phase, youtubeEmbedReady, youtubeStimulusSecondsLeft]);

  useEffect(() => {
    if (phase !== 'youtubeStimulus' || youtubeEmbedReady) return;
    const id = window.setTimeout(() => {
      setYoutubeEmbedLoadSlow(true);
      appendBridgeLog('youtube-stimulus', 'ALERT: iframe load is slow', {
        timeoutMs: YOUTUBE_EMBED_READY_TIMEOUT_MS,
      });
    }, YOUTUBE_EMBED_READY_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [phase, youtubeEmbedReady]);

  const handleVerifyAccess = async () => {
    setAccessError(null);
    try {
      setLastFunction('POST /api/prompt/verify-access');
      const res = await promptApi.verifyAccess(accessCode, simpleFingerprint(), effectiveAssignmentId);
      setLastApiResult('POST /api/prompt/verify-access', 200, true);
      if (res.blocked) {
        setBlocked(true);
        setAccessError(`Too many attempts. Contact your teacher to reset.`);
        return;
      }
      if (!res.success) {
        setAccessError('Invalid code.');
        return;
      }
      const deckAfterAccess =
        config?.promptMode === 'decks' && (config.videoPromptConfig?.selectedDecks?.length ?? 0) > 0;
      const youtubeAfterAccess =
        config?.promptMode === 'youtube' &&
        !!config.youtubePromptConfig?.videoId &&
        Math.floor(Number(config.youtubePromptConfig.clipEndSec)) >
          Math.max(0, Math.floor(Number(config.youtubePromptConfig.clipStartSec ?? 0)));
      if (deckAfterAccess || youtubeAfterAccess) {
        setPhase('preflight');
      } else {
        setPhase('warmup');
        setSecondsLeft(minutes * 60);
      }
    } catch (e) {
      setAccessError(e instanceof Error ? e.message : 'Verify failed');
    }
  };

  const startPreflight = () => {
    if (!streamRef.current) return;
    const useDeckCountdown = studentDeckFlow && deckPrompts.length > 0;
    const useYoutubeCountdown = studentYoutubeFlow;
    if (useDeckCountdown || useYoutubeCountdown) {
      setPromptIndex(0);
      setGetReadyTick(3);
      setPhase('getReady');
    } else {
      setPhase('record');
    }
  };

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const finishAndSubmit = useCallback(() => {
    // One continuous video for the whole deck: snapshot lists every prompt (newline-separated).
    const youtubeSnapshot =
      studentYoutubeFlow && config?.youtubePromptConfig
        ? [
            config.youtubePromptConfig.label?.trim() || 'YouTube clip response',
            `videoId=${config.youtubePromptConfig.videoId}`,
            `clip=${Math.floor(Number(config.youtubePromptConfig.clipStartSec ?? 0))}-${Math.floor(Number(config.youtubePromptConfig.clipEndSec))}`,
          ]
            .filter(Boolean)
            .join('\n')
        : '';
    pendingPromptRef.current =
      deckMode && displayPrompts.length > 0
        ? displayPrompts.join('\n\n')
        : studentYoutubeFlow
          ? youtubeSnapshot
          : (displayPrompts[promptIndex] ?? displayPrompts[0] ?? '');
    submitOnStopRef.current = true;
    stopRecording();
  }, [deckMode, displayPrompts, promptIndex, stopRecording, studentYoutubeFlow, config]);

  const retryLastSubmit = useCallback(() => {
    if (!recordedBlob) {
      setSubmitError('No recording available to retry. Please record again.');
      setPhase('record');
      return;
    }
    const promptSnapshot = pendingPromptRef.current.trim();
    const deckTimeline = lastDeckTimelineRef.current;
    void doSubmit(promptSnapshot, recordedBlob, deckTimeline);
  }, [recordedBlob, doSubmit]);

  useEffect(() => {
    if (phase === 'record') {
      autoFinishFiredRef.current = false;
      deckZeroHandledForIndexRef.current = -1;
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'record') return;
    const sec = deckMode ? recordSecondsForDeckCard(deckPrompts[promptIndex]) : minutes * 60;
    setRecordSecondsLeft(sec);
  }, [phase, minutes, deckMode, deckPrompts, promptIndex]);

  useEffect(() => {
    if (phase !== 'record' || recordSecondsLeft !== 0 || !recording) return;
    // Same index + zero: ignore duplicate effect runs (e.g. React Strict Mode).
    if (deckZeroHandledForIndexRef.current === promptIndex) return;
    deckZeroHandledForIndexRef.current = promptIndex;

    const nextPrompt = deckMode ? nextDeckIndexAfterAdvance(promptIndex, deckPrompts.length) : undefined;
    if (nextPrompt !== undefined) {
      const elapsed = (performance.now() - recordStartPerfRef.current) / 1000;
      const nextItem = deckPrompts[nextPrompt];
      const title = nextItem?.title ?? '';
      const videoId = nextItem?.videoId?.trim();
      deckBoundaryListRef.current.push({
        title,
        startSec: Math.round(elapsed * 1000) / 1000,
        ...(videoId ? { videoId } : {}),
      });
      setPromptIndex(nextPrompt);
      // Avoid a frame where index advanced but seconds stayed 0 (would re-trigger this effect).
      setRecordSecondsLeft(recordSecondsForDeckCard(deckPrompts[nextPrompt]));
      return;
    }

    if (!deckMode) {
      if (autoFinishFiredRef.current) return;
      autoFinishFiredRef.current = true;
    }
    console.log('[TimerPage] Timer expired (recordSecondsLeft=0), calling finishAndSubmit');
    finishAndSubmit();
  }, [
    phase,
    recordSecondsLeft,
    recording,
    deckMode,
    promptIndex,
    deckPrompts,
    finishAndSubmit,
  ]);

  useEffect(() => {
    if (phase !== 'record' || recordSecondsLeft <= 0) return;
    const t = setInterval(() => setRecordSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [phase, recordSecondsLeft]);

  // One MediaRecorder for the entire record phase; do not restart when the deck card index changes.
  useEffect(() => {
    if (phase !== 'record' || !streamRef.current || recorderRef.current) return;
    const stream = streamRef.current;
    chunksRef.current = [];
    const selectedProfile = CAPTURE_PROFILE_LADDER.find((p) => p.id === captureProfile?.profileId);
    const mimeType = pickSupportedMimeType();
    const recorderOptions: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      ...(selectedProfile?.videoBitsPerSecond ? { videoBitsPerSecond: selectedProfile.videoBitsPerSecond } : {}),
      ...(selectedProfile?.audioBitsPerSecond ? { audioBitsPerSecond: selectedProfile.audioBitsPerSecond } : {}),
    };
    const recorder = new MediaRecorder(stream, recorderOptions);
    recorder.onstart = () => {
      recordStartPerfRef.current = performance.now();
      deckBoundaryListRef.current = [];
      if (deckPrompts.length > 0) {
        deckBoundaryListRef.current.push({
          title: deckPrompts[0]?.title ?? '',
          startSec: 0,
          ...(deckPrompts[0]?.videoId?.trim() ? { videoId: deckPrompts[0].videoId.trim() } : {}),
        });
      }
      setCaptureProfile((prev) => ({
        ...(prev ?? {}),
        mimeType: recorder.mimeType || prev?.mimeType || mimeType || 'browser-default',
        videoBitsPerSecond: selectedProfile?.videoBitsPerSecond,
        audioBitsPerSecond: selectedProfile?.audioBitsPerSecond,
      }));
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      console.log('[TimerPage:recorder.onstop] MediaRecorder stopped', {
        blobSize: blob.size,
        chunksCount: chunksRef.current.length,
        submitOnStop: submitOnStopRef.current,
        captureProfile,
      });
      setRecordedBlob(blob);
      if (submitOnStopRef.current) {
        submitOnStopRef.current = false;
        const promptSnapshot = pendingPromptRef.current.trim();
        const deckTimeline =
          deckBoundaryListRef.current.length > 0
            ? deckBoundaryListRef.current.map((e) => ({
                title: e.title,
                startSec: e.startSec,
                ...(e.videoId ? { videoId: e.videoId } : {}),
              }))
            : undefined;
        lastDeckTimelineRef.current = deckTimeline;
        console.log('[TimerPage:recorder.onstop] Calling doSubmit...');
        doSubmit(promptSnapshot, blob, deckTimeline);
      }
    };
    recorder.start(RECORDER_TIMESLICE_MS);
    recorderRef.current = recorder;
    setRecording(true);
  }, [phase, doSubmit, deckPrompts, captureProfile]);

  if (!context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Launch from Canvas to continue.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading...</p>
        </div>
      </div>
    );
  }

  if (showManualTokenModal) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Canvas API token required.</p>
        </div>
        <ManualTokenModal
          message="LTI 1.1 does not support OAuth. Enter your Canvas API token to load the prompt timer."
          onSuccess={() => {
            setShowManualTokenModal(false);
            loadConfig();
          }}
          onDismiss={() => setShowManualTokenModal(false)}
        />
      </div>
    );
  }

  const isDeepLink = context?.messageType === 'LtiDeepLinkingRequest';
  if (isDeepLink && config === null && !loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">
            This assignment is not configured for ASL Express. Please use the standard file upload tab instead.
          </p>
        </div>
      </div>
    );
  }

  if (teacherViewingTimer) {
    return <div className="prompter-page" />;
  }

  if (phase === 'access' && needsAccessCode) {
    return (
      <div className="prompter-page">
        <div className="prompter-access-code-container">
          <h1>Access Code</h1>
          <p className="prompter-info-message">Please enter the access code provided by your instructor.</p>
          <p className="prompter-info-message"><strong>You have 3 attempts.</strong></p>
          {blocked && (
            <p className="prompter-error-message">Too many attempts. Contact your teacher to reset.</p>
          )}
          {!blocked && (
            <form onSubmit={(e) => { e.preventDefault(); handleVerifyAccess(); }}>
              <input
                type="text"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Enter Access Code"
                className="prompter-access-code-input"
                onKeyDown={(e) => e.key === 'Enter' && handleVerifyAccess()}
              />
              {accessError && <div className="prompter-error-message">{accessError}</div>}
              <button type="button" onClick={handleVerifyAccess} className="prompter-btn-ready prompter-btn-full prompter-btn-lg">
                Verify & Continue
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'warmup') {
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    const display = displayPrompts[promptIndex] ?? (displayPrompts[0] ?? 'Warm up. When the timer ends, you will record.');
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <div className="prompter-prompt-column prompter-prompt-column-center">{display}</div>
          <div className="prompter-timer-display">{m}:{s < 10 ? '0' : ''}{s}</div>
          <button type="button" onClick={() => setPhase('preflight')} className="prompter-btn-ready">Ready Early</button>
        </div>
      </div>
    );
  }

  if (phase === 'getReady') {
    const showNum = Math.max(1, getReadyTick);
    return (
      <div className="prompter-page">
        <div className="prompter-card prompter-get-ready-card">
          <p className="prompter-get-ready-heading">Get Ready!</p>
          <div className="prompter-get-ready-count" aria-live="polite">
            {getReadyTick > 0 ? showNum : ''}
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'youtubeStimulus') {
    const yc = config?.youtubePromptConfig;
    const vid = yc?.videoId?.trim();
    if (!vid || !yc) {
      return (
        <div className="prompter-page">
          <div className="prompter-card">
            <p className="prompter-error-message">
              This assignment is missing valid YouTube settings. Please contact your instructor.
            </p>
          </div>
        </div>
      );
    }
    const startSec = Math.max(0, Math.floor(Number(yc.clipStartSec ?? 0)));
    const endSec = Math.floor(Number(yc.clipEndSec));
    const src = buildYoutubeNocookieEmbedSrc(vid, { startSec, endSec: endSec > startSec ? endSec : startSec + 1 });
    const m = Math.floor(youtubeStimulusSecondsLeft / 60);
    const s = youtubeStimulusSecondsLeft % 60;
    return (
      <div className="prompter-page">
        <div className="prompter-card prompter-youtube-stimulus-card">
          <h1 className="prompter-youtube-stimulus-heading">Watch the clip</h1>
          <p className="prompter-info-message prompter-info-message-spaced">
            Your camera is not recording yet. Recording starts only after the video player is ready.
          </p>
          {!youtubeEmbedReady && (
            <p className="prompter-info-message prompter-info-message-spaced">
              <span className="prompter-inline-spinner" /> Loading YouTube player...
            </p>
          )}
          {youtubeEmbedLoadSlow && !youtubeEmbedReady && (
            <p className="prompter-error-message prompter-info-message-spaced" role="alert">
              YouTube is taking longer than expected to load. Please keep this tab open.
            </p>
          )}
          <div className="prompter-timer-display-sm" aria-live="polite">
            {m}:{s < 10 ? '0' : ''}
            {s}
          </div>
          <div className="prompter-youtube-stimulus-frame">
            <iframe
              title="Assignment stimulus video"
              src={src}
              onLoad={() => {
                if (!youtubeEmbedReady) {
                  setYoutubeEmbedReady(true);
                  appendBridgeLog('youtube-stimulus', 'OK: iframe loaded', {
                    videoId: vid,
                    clipStartSec: startSec,
                    clipEndSec: endSec,
                  });
                }
              }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'preflight') {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>Camera & Mic</h1>
          <p className="prompter-info-message prompter-info-message-spaced">Allow camera and microphone to record your signing.</p>
          {studentDeckFlow && deckLiveBuildError && (
            <p className="prompter-error-message prompter-info-message-spaced" role="alert">
              {deckLiveBuildError}
            </p>
          )}
          <div className="prompter-video-container prompter-video-container-preflight">
            {preflightError ? (
              <p className="prompter-error-message">{preflightError}</p>
            ) : preflightReady ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : (
              <p className="prompter-info-message">Requesting camera access...</p>
            )}
          </div>
          {preflightReady && captureProfile && (
            <p className="prompter-info-message">
              Recording profile: {captureProfile.actualWidth ?? captureProfile.requestedWidth}x
              {captureProfile.actualHeight ?? captureProfile.requestedHeight} @
              {Math.round(captureProfile.actualFps ?? captureProfile.requestedFps ?? 30)}fps
            </p>
          )}
          <button
            type="button"
            onClick={startPreflight}
            className="prompter-btn-ready"
            disabled={
              !preflightReady ||
              !!preflightError ||
              !!deckLiveBuildError ||
              (studentDeckFlow && deckPrompts.length === 0) ||
              (studentYoutubeFlow &&
                (!config?.youtubePromptConfig?.videoId ||
                  Math.floor(Number(config.youtubePromptConfig.clipEndSec)) <=
                    Math.max(0, Math.floor(Number(config.youtubePromptConfig.clipStartSec ?? 0)))))
            }
          >
            {studentDeckFlow && deckLiveBuildError
              ? 'Deck prompts unavailable'
              : studentDeckFlow && deckPrompts.length === 0
              ? 'Loading prompts…'
              : studentDeckFlow || studentYoutubeFlow
                ? 'Continue'
                : 'Everything Looks Good - Start'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'record') {
    const rm = Math.floor(recordSecondsLeft / 60);
    const rs = recordSecondsLeft % 60;
    const recordPromptText =
      deckMode
        ? currentPromptText
        : studentYoutubeFlow
          ? config?.youtubePromptConfig?.label?.trim() ||
            (config?.instructions?.trim()
              ? `${config.instructions.trim().slice(0, 500)}${config.instructions.trim().length > 500 ? '…' : ''}`
              : '') ||
            'Record your response to the clip you just watched.'
          : currentPromptText;
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <div className="prompter-timer-display-sm">
            {rm}:{rs < 10 ? '0' : ''}{rs}
          </div>
          {deckMode && (
            <p className="prompter-info-message prompter-deck-progress-hint">
              Item {promptIndex + 1} of {deckPrompts.length} — one continuous recording for all prompts
            </p>
          )}
          {studentYoutubeFlow && !deckMode && (
            <p className="prompter-info-message prompter-deck-progress-hint">
              Recording your response — the YouTube clip is finished
            </p>
          )}
          <div className="prompter-record-layout">
            {deckMode ? (
              <div className="prompter-deck-prompt-shell prompter-deck-prompt-shell--record">
                <div key={promptIndex} className="prompter-deck-prompt-display">
                  {currentPromptText}
                </div>
              </div>
            ) : (
              <div className="prompter-prompt-column" style={{ flex: '1 1 300px', maxWidth: 480 }}>
                <div>{recordPromptText}</div>
              </div>
            )}
            <div className="prompter-record-video-col">
              <div className="prompter-video-container">
                <video ref={videoRef} autoPlay muted playsInline />
              </div>
              {recording && (
                <button type="button" onClick={finishAndSubmit} className="prompter-btn-danger">
                  {deckMode ? 'Finish deck & submit to Canvas' : 'Finish & Submit to Canvas'}
                </button>
              )}
            </div>
          </div>
          {submitError && <p className="prompter-error-message prompter-error-message-mt">{submitError}</p>}
          {submitInfo && <p className="prompter-info-message">{submitInfo}</p>}
        </div>
      </div>
    );
  }

  if (phase === 'upload') {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Uploading video to Canvas...</p>
          {recordedBlob && (
            <p className="prompter-info-message">Upload size: {toMb(recordedBlob.size)}</p>
          )}
          {submitError && <p className="prompter-error-message prompter-error-message-mt">{submitError}</p>}
          {submitInfo && <p className="prompter-info-message">{submitInfo}</p>}
          {submitError && (
            <button type="button" onClick={retryLastSubmit} className="prompter-btn-ready">
              Retry upload
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="prompter-page">
      <div className="prompter-card">
        <h1>Done</h1>
        <p className="prompter-info-message">Your submission has been sent to Canvas.</p>
      </div>
    </div>
  );
}
