/**
 * Prefer FFMPEG_PATH; else bundled ffmpeg-static (works on Render without apt ffmpeg).
 */
let cached: string | null = null;

export function resolveFfmpegPathForCaptions(): string {
  if (cached) return cached;
  const env = (process.env.FFMPEG_PATH ?? '').trim();
  if (env) {
    cached = env;
    return env;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ffmpeg-static') as string | null | undefined;
    if (mod && typeof mod === 'string') {
      cached = mod;
      return mod;
    }
  } catch {
    /* optional at install time */
  }
  cached = 'ffmpeg';
  return 'ffmpeg';
}
