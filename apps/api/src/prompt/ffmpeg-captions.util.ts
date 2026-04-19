import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveFfmpegPathForCaptions } from './ffmpeg-binary.util';

const DEFAULT_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.SIGN_TO_VOICE_FFMPEG_TIMEOUT_MS ?? 120_000) || 120_000, 10_000),
  600_000,
);

/** Caption pipeline WebM download cap (independent of WEBM_PROMPT_PROBE_MAX_BYTES). Default 48 MiB. */
export const DEFAULT_SIGN_TO_VOICE_DOWNLOAD_MAX_BYTES = Math.min(
  Math.max(Number(process.env.SIGN_TO_VOICE_MAX_DOWNLOAD_BYTES ?? 48 * 1024 * 1024) || 48 * 1024 * 1024, 256 * 1024),
  512 * 1024 * 1024,
);

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  const bin = resolveFfmpegPathForCaptions();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: String(err) });
    });
  });
}

/**
 * Extract mono 16kHz WAV for Deepgram.
 */
export async function extractAudioWavFromWebm(webmPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
  wavPath: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'fsasl-cap-audio-'));
  const wavPath = join(dir, 'audio.wav');
  const { code, stderr } = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      webmPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-acodec',
      'pcm_s16le',
      wavPath,
    ],
    timeoutMs,
  );
  if (code !== 0) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`ffmpeg_extract_audio_${code}: ${stderr.slice(0, 600)}`);
  }
  return {
    wavPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Download URL to temp WebM file (streaming, capped). */
export async function downloadToTempWebm(
  url: string,
  bearerToken: string,
  maxBytes: number,
): Promise<{ path: string; cleanup: () => void }> {
  const { downloadAuthenticatedVideoToTempFile } = await import('./webm-prompt-metadata.util');
  const dl = await downloadAuthenticatedVideoToTempFile(url, bearerToken, maxBytes);
  if (!dl.ok) {
    throw new Error(`download_${dl.error}`);
  }
  return { path: dl.path, cleanup: dl.cleanup };
}

export type WebmVttMuxOk = { ok: true; outputPath: string; size: number };
export type WebmVttMuxFail = { ok: false; error: string };
export type WebmVttMuxResult = WebmVttMuxOk | WebmVttMuxFail;

/**
 * Remux WebM to add a WebVTT subtitle track from `vttContent` (stream copy where possible).
 * Fail-open callers keep the original file when `ok` is false.
 */
export async function muxWebmWithWebVttContent(options: {
  inputWebmPath: string;
  vttContent: string;
  timeoutMs?: number;
}): Promise<WebmVttMuxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vtt = (options.vttContent ?? '').trim();
  if (!vtt) return { ok: false, error: 'empty_vtt' };
  if (vtt.length > 1_500_000) return { ok: false, error: 'vtt_too_large' };
  const dir = mkdtempSync(join(tmpdir(), 'fsasl-webm-vttmux-'));
  const vttPath = join(dir, 'captions.vtt');
  const outPath = join(dir, 'out.webm');
  try {
    writeFileSync(vttPath, vtt, 'utf8');
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `write_vtt_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { code, stderr } = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      options.inputWebmPath,
      '-i',
      vttPath,
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-c:s',
      'webvtt',
      outPath,
    ],
    timeoutMs,
  );
  if (code !== 0) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `ffmpeg_exit_${code ?? 'null'}: ${stderr.slice(0, 800)}` };
  }
  try {
    const st = statSync(outPath);
    if (!st.isFile() || st.size <= 0) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: 'mux_output_missing_or_empty' };
    }
    return { ok: true, outputPath: outPath, size: st.size };
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `stat_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Remove temp directory containing muxed WebM+VTT output (parent of `outputPath`). */
export function cleanupWebmVttMuxOutputPath(outputPath: string): void {
  try {
    const dir = dirname(outputPath);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
