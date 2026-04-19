import { statSync } from 'node:fs';
import { appendLtiLog } from '../common/last-error.store';
import { transcribeWavFileWithDeepgram } from './deepgram-transcribe.util';
import {
  cleanupWebmVttMuxOutputPath,
  extractAudioWavFromWebm,
  muxWebmWithWebVttContent,
} from './ffmpeg-captions.util';
import { DEFAULT_WEBM_MUX_TIMEOUT_MS } from './webm-prompt-metadata.util';

export type TryPreuploadSignToVoiceCaptionsMuxResult = {
  /** Path to upload (muxed WebM or original). */
  nextPath: string;
  nextSize: number;
  /** When set, delete via `cleanupWebmVttMuxOutputPath` after Canvas upload (same pattern as PROMPT_DATA mux). */
  muxOutputPathForCleanup: string | null;
};

/**
 * Sign-to-voice: extract audio → Deepgram → WebVTT → ffmpeg mux subtitle into WebM.
 * Gates on `signToVoiceRequired` and non-empty `deepgramApiKey`. Fail-open: never throws; returns original path on any failure.
 */
export async function tryPreuploadSignToVoiceCaptionsMux(args: {
  webmPath: string;
  originalSize: number;
  signToVoiceRequired: boolean;
  deepgramApiKey: string;
}): Promise<TryPreuploadSignToVoiceCaptionsMuxResult> {
  const { webmPath, originalSize, signToVoiceRequired, deepgramApiKey } = args;
  const key = (deepgramApiKey ?? '').trim();
  const orig = (): TryPreuploadSignToVoiceCaptionsMuxResult => ({
    nextPath: webmPath,
    nextSize: originalSize,
    muxOutputPathForCleanup: null,
  });

  if (!signToVoiceRequired) {
    appendLtiLog('sign-to-voice', 'preupload: SKIP (signToVoiceRequired=false)', {});
    return orig();
  }
  if (!key) {
    appendLtiLog('sign-to-voice', 'preupload: SKIP (DEEPGRAM_API_KEY unset)', {});
    return orig();
  }

  appendLtiLog('sign-to-voice', 'preupload: start', { inputPath: webmPath, originalBytes: originalSize });

  let wavCleanup: (() => void) | null = null;
  try {
    appendLtiLog('sign-to-voice', 'preupload: extract audio (wav)', {});
    const wav = await extractAudioWavFromWebm(webmPath);
    wavCleanup = wav.cleanup;
    let wavBytes = 0;
    try {
      wavBytes = statSync(wav.wavPath).size;
    } catch {
      /* ignore */
    }
    appendLtiLog('sign-to-voice', 'preupload: wav ready', { wavBytes });

    appendLtiLog('sign-to-voice', 'preupload: Deepgram transcribe', {});
    const { vtt } = await transcribeWavFileWithDeepgram(wav.wavPath, key);
    const vttLen = (vtt ?? '').length;
    appendLtiLog('sign-to-voice', 'preupload: Deepgram OK', {
      vttChars: vttLen,
      vttCueBlocks: (vtt.match(/\n\n/g) ?? []).length,
    });

    appendLtiLog('sign-to-voice', 'preupload: ffmpeg mux WebVTT into WebM', {});
    const muxed = await muxWebmWithWebVttContent({
      inputWebmPath: webmPath,
      vttContent: vtt,
      timeoutMs: DEFAULT_WEBM_MUX_TIMEOUT_MS,
    });
    if (!muxed.ok) {
      appendLtiLog('sign-to-voice', 'preupload: mux FAIL (using_original)', { error: muxed.error });
      return orig();
    }
    appendLtiLog('sign-to-voice', 'preupload: mux OK', {
      outputBytes: muxed.size,
      originalBytes: originalSize,
    });
    return {
      nextPath: muxed.outputPath,
      nextSize: muxed.size,
      muxOutputPathForCleanup: muxed.outputPath,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLtiLog('sign-to-voice', 'preupload: FAIL (using_original)', { error: msg });
    return orig();
  } finally {
    try {
      wavCleanup?.();
    } catch {
      /* ignore */
    }
  }
}
