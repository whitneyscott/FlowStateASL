import { useCallback, useEffect, useRef, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import * as promptApi from '../api/prompt.api';
import { ManualTokenModal } from '../components/ManualTokenModal';
import './PrompterPage.css';

interface TimerPageProps {
  context: LtiContext | null;
}

function simpleFingerprint(): string {
  const ua = navigator.userAgent;
  const lang = navigator.language;
  return btoa(ua + '|' + lang).slice(0, 32);
}

/** Deck-based prompt with timing info */
interface DeckPromptItem {
  title: string;
  videoId?: string;
  duration: number; // total time in seconds for this prompt
}

export default function TimerPage({ context }: TimerPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<'access' | 'warmup' | 'preflight' | 'record' | 'upload' | 'done'>('access');
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
  const [wordTimestamps, setWordTimestamps] = useState<Array<{ word: string; timestampMs: number }>>([]);
  const [showTransition, setShowTransition] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<number>(0);
  
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const submitOnStopRef = useRef(false);
  const pendingPromptRef = useRef('');
  const autoFinishFiredRef = useRef(false);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);

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
        setLastFunction('POST /api/prompt/save-prompt');
        await promptApi.savePrompt(promptSnapshot);
        setLastApiResult('POST /api/prompt/save-prompt', 200, true);
        console.log('[TimerPage:doSubmit] savePrompt OK');

        if (isDeepLink && blob) {
          lastEndpoint = 'POST /api/prompt/submit-deep-link';
          console.log('[TimerPage:doSubmit] Step 2a: submitDeepLink (isDeepLink=true)', { blobSize: blob.size });
          setLastFunction('POST /api/prompt/submit-deep-link');
          const result = await promptApi.submitDeepLink(blob, `asl_submission_${Date.now()}.webm`);
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
          await promptApi.submitPrompt(promptSnapshot);
          setLastApiResult('POST /api/prompt/submit', 200, true);
          console.log('[TimerPage:doSubmit] submitPrompt OK');
        }
        if (blob && !isDeepLink) {
          lastEndpoint = 'POST /api/prompt/upload-video';
          console.log('[TimerPage:doSubmit] Step 3: uploadVideo', { blobSize: blob.size });
          setLastFunction('POST /api/prompt/upload-video');
          const result = await promptApi.uploadVideo(blob, `asl_submission_${Date.now()}.webm`);
          setLastApiResult('POST /api/prompt/upload-video', 200, true);
          console.log('[TimerPage:doSubmit] uploadVideo OK', result);
        }
        setPhase('done');
        console.log('[TimerPage:doSubmit] DONE');
      } catch (e) {
        console.error('[TimerPage:doSubmit] FAILED', { lastEndpoint, error: e });
        setSubmitError(e instanceof Error ? e.message : 'Submit failed');
        setLastApiError(lastEndpoint, 0, String(e));
      }
    },
    [context?.messageType, setLastFunction, setLastApiResult, setLastApiError]
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
  
  // Use deck prompts in deck mode, otherwise use text prompts
  const displayPrompts = deckPrompts.length > 0 
    ? deckPrompts.map(p => p.title) 
    : prompts;

  const loadConfig = useCallback(async () => {
    if (!context?.courseId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig();
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      
      // If deck mode, fetch the prompt list
      if (data?.promptMode === 'decks' && data?.videoPromptConfig?.selectedDecks && data.videoPromptConfig.selectedDecks.length > 0) {
        try {
          setLastFunction('POST /api/prompt/build-deck-prompts');
          const result = await promptApi.buildDeckPrompts(
            data.videoPromptConfig.selectedDecks,
            data.videoPromptConfig.totalCards ?? 10
          );
          setLastApiResult('POST /api/prompt/build-deck-prompts', 200, true);
          setDeckPrompts(result.prompts || []);
        } catch (e) {
          console.error('Failed to build deck prompts:', e);
        }
      }
      
      if (!data?.accessCode?.trim()) {
        setPhase('warmup');
        setSecondsLeft((data?.minutes ?? 5) * 60);
      }
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      }
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [context?.courseId, setLastFunction, setLastApiResult]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (phase !== 'warmup' || secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [phase, secondsLeft]);

  useEffect(() => {
    if (phase !== 'warmup' || secondsLeft > 0) return;
    setPhase('preflight');
  }, [phase, secondsLeft]);

  const handleVerifyAccess = async () => {
    setAccessError(null);
    try {
      setLastFunction('POST /api/prompt/verify-access');
      const res = await promptApi.verifyAccess(accessCode, simpleFingerprint());
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
      setPhase('warmup');
      setSecondsLeft(minutes * 60);
    } catch (e) {
      setAccessError(e instanceof Error ? e.message : 'Verify failed');
    }
  };

  const startPreflight = () => {
    if (streamRef.current) setPhase('record');
  };

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const finishAndSubmit = useCallback(() => {
    pendingPromptRef.current = displayPrompts[promptIndex] ?? displayPrompts[0] ?? '';
    submitOnStopRef.current = true;
    stopRecording();
  }, [displayPrompts, promptIndex, stopRecording]);

  useEffect(() => {
    if (phase === 'record') {
      setRecordSecondsLeft(minutes * 60);
      autoFinishFiredRef.current = false;
    }
  }, [phase, minutes]);

  useEffect(() => {
    if (phase !== 'record' || recordSecondsLeft > 0) return;
    if (autoFinishFiredRef.current || !recording) return;
    console.log('[TimerPage] Timer expired (recordSecondsLeft=0), calling finishAndSubmit');
    autoFinishFiredRef.current = true;
    finishAndSubmit();
  }, [phase, recordSecondsLeft, recording, finishAndSubmit]);

  useEffect(() => {
    if (phase !== 'record' || recordSecondsLeft <= 0) return;
    const t = setInterval(() => setRecordSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [phase, recordSecondsLeft]);

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
        const promptSnapshot = pendingPromptRef.current || (displayPrompts[promptIndex] ?? displayPrompts[0] ?? '');
        console.log('[TimerPage:recorder.onstop] Calling doSubmit...');
        doSubmit(promptSnapshot, blob);
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  }, [phase, prompts, promptIndex, doSubmit]);

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
          <div className="prompter-prompt-column prompter-prompt-column-center">
            {display}
          </div>
          <div className="prompter-timer-display">{m}:{s < 10 ? '0' : ''}{s}</div>
          <button type="button" onClick={() => setPhase('preflight')} className="prompter-btn-ready">Ready Early</button>
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
            disabled={!preflightReady || !!preflightError}
          >
            Everything Looks Good - Start
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
          <div className="prompter-record-layout">
            <div className="prompter-prompt-column" style={{ flex: '1 1 300px', maxWidth: 480 }}>
              {displayPrompts[promptIndex] ?? (displayPrompts[0] ?? '')}
            </div>
            <div className="prompter-record-video-col">
              <div className="prompter-video-container">
                <video ref={videoRef} autoPlay muted playsInline />
              </div>
              {recording && (
                <button type="button" onClick={finishAndSubmit} className="prompter-btn-danger">
                  Finish & Submit to Canvas
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
