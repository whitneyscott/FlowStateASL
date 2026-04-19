import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';

const FFMPEG_BIN = (process.env.FFMPEG_PATH ?? 'ffmpeg').trim() || 'ffmpeg';
const FFPROBE_BIN = (process.env.FFPROBE_PATH ?? 'ffprobe').trim() || 'ffprobe';

export const DEFAULT_WEBM_MUX_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.WEBM_PROMPT_MUX_TIMEOUT_MS ?? 25_000) || 25_000, 3_000),
  120_000,
);

export const DEFAULT_WEBM_PROBE_DOWNLOAD_MAX_BYTES = Math.min(
  Math.max(Number(process.env.WEBM_PROMPT_PROBE_MAX_BYTES ?? 96 * 1024 * 1024) || 96 * 1024 * 1024, 256 * 1024),
  512 * 1024 * 1024,
);

function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
    };
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

export type WebmMuxOk = { ok: true; outputPath: string; size: number };
export type WebmMuxFail = { ok: false; error: string };
export type WebmMuxResult = WebmMuxOk | WebmMuxFail;

/**
 * Remux WebM with Matroska/WebM tag `PROMPT_DATA` (stream copy). Fail-open callers use original bytes on non-ok.
 * `promptDataTagValue` is base64(JSON.stringify(...)) — see `encodePromptDataForFfmpegMetadataTag`.
 */
export async function muxWebmWithPromptDataTag(options: {
  inputPath: string;
  promptDataTagValue: string;
  timeoutMs?: number;
}): Promise<WebmMuxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBM_MUX_TIMEOUT_MS;
  const tag = options.promptDataTagValue;
  if (!tag) return { ok: false, error: 'empty_prompt_data' };
  /** ~512 KiB JSON → base64; cap tag string length for ffmpeg argv safety. */
  if (tag.length > 900_000) return { ok: false, error: 'prompt_data_too_large' };
  const dir = mkdtempSync(join(tmpdir(), 'fsasl-webm-mux-'));
  const outPath = join(dir, 'out.webm');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    options.inputPath,
    '-map',
    '0',
    '-c',
    'copy',
    '-metadata',
    `PROMPT_DATA=${tag}`,
    outPath,
  ];
  const { code, stderr } = await runWithTimeout(FFMPEG_BIN, args, timeoutMs);
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

/** Remove temp mux output directory containing `outputPath` (parent is unique mkdtemp). */
export function cleanupMuxOutputPath(outputPath: string): void {
  try {
    const dir = dirname(outputPath);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const WEBM_VTT_EXTRACT_MAX_BYTES = Math.min(
  Math.max(Number(process.env.WEBM_VTT_EXTRACT_MAX_BYTES ?? 2_000_000) || 2_000_000, 64_000),
  8_000_000,
);

export type FfprobeWebmPromptDataProbe = {
  /** Raw `format.tags.PROMPT_DATA` (base64 of compact JSON), if present. */
  promptDataTag: string | null;
  /** True if any stream has `codec_type` === `subtitle`. */
  hasSubtitleStream: boolean;
};

/**
 * One ffprobe subprocess: `-show_format -show_streams` JSON. Used for PROMPT_DATA tag + subtitle detection.
 */
export async function ffprobeWebmPromptDataJson(
  filePath: string,
  timeoutMs = 20_000,
): Promise<FfprobeWebmPromptDataProbe | null> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  const child = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => chunks.push(c));
  const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', (c) => {
      clearTimeout(t);
      resolve({ code: c, out: Buffer.concat(chunks).toString('utf8') });
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, out: '' });
    });
  });
  if (code !== 0) return null;
  try {
    const j = JSON.parse(out) as {
      format?: { tags?: Record<string, string> };
      streams?: Array<{ codec_type?: string }>;
    };
    const tags = j?.format?.tags;
    let promptDataTag: string | null = null;
    if (tags && typeof tags === 'object') {
      let v: string | undefined;
      for (const [k, val] of Object.entries(tags)) {
        if (k.toUpperCase() === 'PROMPT_DATA' && typeof val === 'string') {
          v = val;
          break;
        }
      }
      const s = (v ?? '').trim();
      promptDataTag = s || null;
    }
    const streams = j?.streams;
    const hasSubtitleStream = Array.isArray(streams)
      ? streams.some((s) => String(s?.codec_type ?? '').toLowerCase() === 'subtitle')
      : false;
    return { promptDataTag, hasSubtitleStream };
  } catch {
    return null;
  }
}

/**
 * Extract first subtitle stream as WebVTT text via ffmpeg (stdout). Fail-open: returns null on error / missing stream.
 */
export async function extractFirstSubtitleWebVttFromWebm(
  filePath: string,
  timeoutMs = 25_000,
): Promise<string | null> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-map',
    '0:s:0',
    '-c',
    'copy',
    '-f',
    'webvtt',
    'pipe:1',
  ];
  const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let total = 0;
  child.stdout?.on('data', (c: Buffer) => {
    total += c.length;
    if (total <= WEBM_VTT_EXTRACT_MAX_BYTES) {
      chunks.push(c);
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });
  const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', (c) => {
      clearTimeout(t);
      resolve({ code: c, out: Buffer.concat(chunks).toString('utf8') });
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve({ code: -1, out: '' });
    });
  });
  if (code !== 0) return null;
  const s = out.trim();
  return s || null;
}

export type DownloadResult =
  | { ok: true; path: string; cleanup: () => void }
  | { ok: false; error: string };

/**
 * Download Canvas file URL with Bearer auth to a temp file, capped at maxBytes (streaming).
 */
export async function downloadAuthenticatedVideoToTempFile(
  url: string,
  bearerToken: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const dir = mkdtempSync(join(tmpdir(), 'fsasl-webm-dl-'));
  const path = join(dir, 'video.webm');
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      redirect: 'follow',
      signal,
    });
    if (!res.ok) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: `http_${res.status}` };
    }
    const body = res.body;
    if (!body) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: 'no_body' };
    }
    const ws = createWriteStream(path);
    let total = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          ws.destroy();
          rmSync(dir, { recursive: true, force: true });
          return { ok: false, error: 'max_bytes_exceeded' };
        }
        if (!ws.write(value)) {
          await new Promise<void>((r, j) => ws.once('drain', r).once('error', j));
        }
      }
    } finally {
      ws.end();
      await finished(ws).catch(() => undefined);
    }
    const st = statSync(path);
    if (!st.isFile() || st.size <= 0) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: 'empty_file' };
    }
    return {
      ok: true,
      path,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function writeBufferToTempWebmFile(buf: Buffer): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fsasl-webm-in-'));
  const path = join(dir, 'in.webm');
  writeFileSync(path, buf);
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
