import { useCallback, useEffect, useRef, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import * as promptApi from '../api/prompt.api';
import { ManualTokenModal } from '../components/ManualTokenModal';
import { resolveLtiContextValue } from '../utils/lti-context';
import { ltiTokenHeaders } from '../api/lti-token';
import { nextDeckIndexAfterAdvance } from '../utils/deck-advance';
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

/** When duration is unknown — must match `DECK_DEFAULT_TOTAL_SECONDS_UNKNOWN` in prompt.service.ts */
const DECK_FALLBACK_TOTAL_SECONDS = 4;

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

function pickSupportedMimeType(): string {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function toMb(sizeBytes: number): string {
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
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
  void fetch('/api/debug/lti-log', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...ltiTokenHeaders() },
    body: JSON.stringify({ tag: 'duration', message }),
  }).catch(() => {});
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
    return Math.max(1, Math.ceil(d));
  }
  return Math.max(1, Math.ceil(DECK_FALLBACK_TOTAL_SECONDS));
}

export default function TimerPage({ context }: TimerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<
    'access' | 'warmup' | 'getReady' | 'preflight' | 'record' | 'upload' | 'done'
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
  const deckBoundaryListRef = useRef<Array<{ title: string; startSec: number }>>([]);
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
        console.log('[TimerPage:doSubmit] Step 1: savePrompt');
        setLastFunction('POST /api/prompt/save-prompt');
        await promptApi.savePrompt(promptSnapshot, effectiveAssignmentId);
        setLastApiResult('POST /api/prompt/save-prompt', 200, true);
        console.log('[TimerPage:doSubmit] savePrompt OK');

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
          await promptApi.submitPrompt(promptSnapshot, effectiveAssignmentId, deckTimeline, {
            idempotencyKey: `submit-${submitAttemptKey}`,
          });
          setLastApiResult('POST /api/prompt/submit', 200, true);
          console.log('[TimerPage:doSubmit] submitPrompt OK');
          if (blob) {
            lastEndpoint = 'POST /api/prompt/upload-video';
            console.log('[TimerPage:doSubmit] Step 3: uploadVideo (attach to row; upload_handler.php)', {
              blobSize: blob.size,
            });
            setLastFunction('POST /api/prompt/upload-video');
            const result = await promptApi.uploadVideo(
              blob,
              `asl_submission_${Date.now()}.webm`,
              effectiveAssignmentId,
              {
                promptSnapshotHtml: promptSnapshot,
                deckTimeline,
                idempotencyKey: `upload-${submitAttemptKey}`,
                captureProfile: captureProfile ?? undefined,
                ...(durationSeconds != null ? { durationSeconds } : {}),
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
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig(ltiOrUrlAssignmentId);
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      const targetAssignmentId =
        (data?.resolvedAssignmentId?.trim() ?? '') || ltiOrUrlAssignmentId || null;

      const isDeckAssignment =
        data?.promptMode === 'decks' &&
        (data.videoPromptConfig?.selectedDecks?.length ?? 0) > 0;
      setStudentDeckFlow(!!isDeckAssignment);

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
            setDeckPrompts(livePrompts);
          } else {
            throw new Error(result.warning || 'live build returned zero prompts');
          }
        } catch (e) {
          console.error('Failed to build deck prompts:', e);
          const storedBanks = data.videoPromptConfig?.storedPromptBanks ?? [];
          const nonEmptyBanks = storedBanks.filter((bank) => Array.isArray(bank) && bank.length > 0);
          if (nonEmptyBanks.length > 0) {
            const idx = Math.floor(Math.random() * nonEmptyBanks.length);
            const chosenBank = nonEmptyBanks[idx];
            setDeckPrompts(chosenBank);
          } else {
            const staticTitles = (data.videoPromptConfig?.staticFallbackPrompts ?? []).filter(Boolean);
            if (staticTitles.length > 0) {
              setDeckPrompts(
                staticTitles.map((title) => ({ title, duration: DECK_FALLBACK_TOTAL_SECONDS })),
              );
            } else {
              setDeckPrompts([]);
              setLastApiError('POST /api/prompt/build-deck-prompts', 0, String(e));
            }
          }
        }
      } else {
        setDeckPrompts([]);
      }

      if (!data?.accessCode?.trim()) {
        if (isDeckAssignment) {
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
      setPhase('record');
      return;
    }
    const id = window.setTimeout(() => setGetReadyTick((t) => t - 1), 1000);
    return () => window.clearTimeout(id);
  }, [phase, getReadyTick]);

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
      if (deckAfterAccess) {
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
    if (useDeckCountdown) {
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
    pendingPromptRef.current =
      deckMode && displayPrompts.length > 0
        ? displayPrompts.join('\n\n')
        : (displayPrompts[promptIndex] ?? displayPrompts[0] ?? '');
    submitOnStopRef.current = true;
    stopRecording();
  }, [deckMode, displayPrompts, promptIndex, stopRecording]);

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
      const title = deckPrompts[nextPrompt]?.title ?? '';
      deckBoundaryListRef.current.push({
        title,
        startSec: Math.round(elapsed * 1000) / 1000,
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
        deckBoundaryListRef.current.push({ title: deckPrompts[0]?.title ?? '', startSec: 0 });
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
            ? deckBoundaryListRef.current.map((e) => ({ title: e.title, startSec: e.startSec }))
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

  if (phase === 'preflight') {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <h1>Camera & Mic</h1>
          <p className="prompter-info-message prompter-info-message-spaced">Allow camera and microphone to record your signing.</p>
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
              (studentDeckFlow && deckPrompts.length === 0)
            }
          >
            {studentDeckFlow && deckPrompts.length === 0
              ? 'Loading prompts…'
              : studentDeckFlow
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
          <div className="prompter-record-layout">
            {deckMode ? (
              <div className="prompter-deck-prompt-shell prompter-deck-prompt-shell--record">
                <div key={promptIndex} className="prompter-deck-prompt-display">
                  {currentPromptText}
                </div>
              </div>
            ) : (
              <div className="prompter-prompt-column" style={{ flex: '1 1 300px', maxWidth: 480 }}>
                <div>{currentPromptText}</div>
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
