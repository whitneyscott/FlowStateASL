import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import * as promptApi from '../api/prompt.api';
import { ManualTokenModal } from '../components/ManualTokenModal';
import { resolveLtiContextValue } from '../utils/lti-context';
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
  const [preflightReady, setPreflightReady] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  
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
  const effectiveAssignmentId = assignmentId || urlAssignmentId || null;
  const teacherViewingTimer = context ? isPrompterTeacher(context.roles) : false;

  const appendDeckDebugLog = useCallback((message: string, extra?: Record<string, unknown>) => {
    const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
    fetch('/api/debug/lti-log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'prompt-decks', message: `[client] ${line}` }),
    }).catch(() => {});
  }, []);

  const doSubmit = useCallback(
    async (promptSnapshot: string, blob: Blob | null) => {
      console.log('[TimerPage:doSubmit] ENTER', {
        hasBlob: !!blob,
        blobSize: blob?.size,
        promptLength: promptSnapshot?.length,
        messageType: context?.messageType,
      });
      setSubmitError(null);
      setPhase(blob ? 'upload' : 'done');
      const isDeepLink = context?.messageType === 'LtiDeepLinkingRequest';
      let lastEndpoint = 'POST /api/prompt/save-prompt';
      try {
        console.log('[TimerPage:doSubmit] Step 1: savePrompt');
        appendDeckDebugLog('doSubmit: start', {
          effectiveAssignmentId: effectiveAssignmentId ?? '(none)',
          hasBlob: !!blob,
          promptLength: promptSnapshot?.length ?? 0,
        });
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
            console.log('[SproutVideo]', dev.message);
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
          lastEndpoint = 'POST /api/prompt/submit';
          console.log('[TimerPage:doSubmit] Step 2b: submitPrompt (body to Canvas)');
          setLastFunction('POST /api/prompt/submit');
          await promptApi.submitPrompt(promptSnapshot, effectiveAssignmentId);
          setLastApiResult('POST /api/prompt/submit', 200, true);
          console.log('[TimerPage:doSubmit] submitPrompt OK');
        }
        if (blob && !isDeepLink) {
          lastEndpoint = 'POST /api/prompt/upload-video';
          console.log('[TimerPage:doSubmit] Step 3: uploadVideo', { blobSize: blob.size });
          setLastFunction('POST /api/prompt/upload-video');
          const result = await promptApi.uploadVideo(blob, `asl_submission_${Date.now()}.webm`, effectiveAssignmentId);
          setLastApiResult('POST /api/prompt/upload-video', 200, true);
          console.log('[TimerPage:doSubmit] uploadVideo OK', result);
        }
        setPhase('done');
        console.log('[TimerPage:doSubmit] DONE');
      } catch (e) {
        console.error('[TimerPage:doSubmit] FAILED', { lastEndpoint, error: e });
        appendDeckDebugLog('doSubmit: failed', {
          endpoint: lastEndpoint,
          error: String(e),
          effectiveAssignmentId: effectiveAssignmentId ?? '(none)',
        });
        setSubmitError(e instanceof Error ? e.message : 'Submit failed');
        setLastApiError(lastEndpoint, 0, String(e));
      }
    },
    [
      context?.messageType,
      setLastFunction,
      setLastApiResult,
      setLastApiError,
      effectiveAssignmentId,
      appendDeckDebugLog,
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
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setPreflightReady(true);
      })
      .catch(() => {
        if (!cancelled) setPreflightError('Camera/mic access denied.');
      });
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
      const data = await promptApi.getPromptConfig(effectiveAssignmentId);
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      appendDeckDebugLog('loadConfig: received config', {
        effectiveAssignmentId: effectiveAssignmentId ?? '(none)',
        promptMode: data?.promptMode ?? '(none)',
        hasVideoPromptConfig: !!data?.videoPromptConfig,
      });

      const isDeckAssignment =
        data?.promptMode === 'decks' &&
        (data.videoPromptConfig?.selectedDecks?.length ?? 0) > 0;
      setStudentDeckFlow(!!isDeckAssignment);

      // If deck mode, fetch the prompt list
      if (data?.promptMode === 'decks' && data?.videoPromptConfig?.selectedDecks && data.videoPromptConfig.selectedDecks.length > 0) {
        const rawTotal = Number(data.videoPromptConfig.totalCards);
        const totalCards = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 10;
        appendDeckDebugLog('deck flow: live build start', {
          effectiveAssignmentId: effectiveAssignmentId ?? '(none)',
          selectedDeckCount: data.videoPromptConfig.selectedDecks.length,
          totalCards,
        });
        try {
          setLastFunction('POST /api/prompt/build-deck-prompts');
          const result = await promptApi.buildDeckPrompts(
            data.videoPromptConfig.selectedDecks,
            totalCards,
            effectiveAssignmentId
          );
          const livePrompts = Array.isArray(result.prompts) ? result.prompts : [];
          if (livePrompts.length > 0) {
            setLastApiResult('POST /api/prompt/build-deck-prompts', 200, true);
            setDeckPrompts(livePrompts);
            appendDeckDebugLog('deck flow: source selected', {
              source: 'live',
              count: livePrompts.length,
              preview: livePrompts.slice(0, 3).map((p) => p.title),
            });
          } else {
            throw new Error(result.warning || 'live build returned zero prompts');
          }
        } catch (e) {
          console.error('Failed to build deck prompts:', e);
          appendDeckDebugLog('deck flow: live build failed', { error: String(e) });
          const storedBanks = data.videoPromptConfig?.storedPromptBanks ?? [];
          const nonEmptyBanks = storedBanks.filter((bank) => Array.isArray(bank) && bank.length > 0);
          if (nonEmptyBanks.length > 0) {
            const idx = Math.floor(Math.random() * nonEmptyBanks.length);
            const chosenBank = nonEmptyBanks[idx];
            setDeckPrompts(chosenBank);
            appendDeckDebugLog('deck flow: source selected', {
              source: 'bank',
              bankIndex: idx,
              bankCount: nonEmptyBanks.length,
              count: chosenBank.length,
              preview: chosenBank.slice(0, 3).map((p) => p.title),
            });
          } else {
            const staticTitles = (data.videoPromptConfig?.staticFallbackPrompts ?? []).filter(Boolean);
            if (staticTitles.length > 0) {
              setDeckPrompts(
                staticTitles.map((title) => ({ title, duration: DECK_FALLBACK_TOTAL_SECONDS })),
              );
              appendDeckDebugLog('deck flow: source selected', {
                source: 'static',
                count: staticTitles.length,
                preview: staticTitles.slice(0, 3),
              });
            } else {
              setDeckPrompts([]);
              setLastApiError('POST /api/prompt/build-deck-prompts', 0, String(e));
              appendDeckDebugLog('deck flow: no prompts available', {
                source: 'none',
                error: String(e),
              });
            }
          }
        }
      } else {
        setDeckPrompts([]);
        appendDeckDebugLog('deck flow: skipped', {
          reason: 'prompt_mode_not_decks_or_no_selected_decks',
          promptMode: data?.promptMode ?? '(none)',
          selectedDeckCount: data?.videoPromptConfig?.selectedDecks?.length ?? 0,
        });
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
      appendDeckDebugLog('loadConfig: failed', {
        effectiveAssignmentId: effectiveAssignmentId ?? '(none)',
        error: String(e),
      });
      setConfig(null);
      setStudentDeckFlow(false);
    } finally {
      setLoading(false);
    }
  }, [
    context?.courseId,
    effectiveAssignmentId,
    setLastFunction,
    setLastApiResult,
    setLastApiError,
    appendDeckDebugLog,
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
      appendDeckDebugLog('deck flow: advance card (continuous recording)', {
        fromIndex: promptIndex,
        toIndex: nextPrompt,
        totalCards: deckPrompts.length,
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
    deckPrompts.length,
    finishAndSubmit,
    appendDeckDebugLog,
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
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      console.log('[TimerPage:recorder.onstop] MediaRecorder stopped', {
        blobSize: blob.size,
        chunksCount: chunksRef.current.length,
        submitOnStop: submitOnStopRef.current,
      });
      setRecordedBlob(blob);
      if (submitOnStopRef.current) {
        submitOnStopRef.current = false;
        const promptSnapshot = pendingPromptRef.current.trim();
        console.log('[TimerPage:recorder.onstop] Calling doSubmit...');
        doSubmit(promptSnapshot, blob);
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  }, [phase, doSubmit]);

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
    return (
      <div className="prompter-page">
        <div className="prompter-card prompter-teacher-timer-placeholder">
          <h1 className="prompter-settings-card-title">Student recording view</h1>
          <p className="prompter-info-message">
            Teachers set up prompts, deck mode, and warm-up under <strong>Config</strong>. The student timer and recorder are not shown here.
          </p>
          <NavLink to="/config" className="prompter-btn-ready prompter-btn-full prompter-btn-lg">
            Open Prompt Manager (Config)
          </NavLink>
        </div>
      </div>
    );
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
        </div>
      </div>
    );
  }

  if (phase === 'upload') {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Uploading video...</p>
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
