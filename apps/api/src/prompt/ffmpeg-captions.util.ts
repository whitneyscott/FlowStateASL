import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
