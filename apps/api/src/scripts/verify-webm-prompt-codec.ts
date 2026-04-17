/**
 * Verifies WebM PROMPT_DATA codec: compact JSON → base64 tag → decode → comparable fields match.
 * Optional: ffmpeg round-trip on repo-root sample WebM when `asl_submission_*.webm` and ffmpeg exist.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  decodePromptDataFromFfmpegMetadataTag,
  encodePromptDataForFfmpegMetadataTag,
  extractComparablePromptUploadFields,
  FSASL_PROMPT_UPLOAD_KIND,
  stableStringifyForPromptMatch,
} from '../prompt/prompt-upload-payload.util';
import {
  cleanupMuxOutputPath,
  ffprobeWebmPromptDataJson,
  muxWebmWithPromptDataTag,
} from '../prompt/webm-prompt-metadata.util';

function ffmpegAvailable(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
}

async function main(): Promise<void> {
  const payload: Record<string, unknown> = {
    submittedAt: new Date().toISOString(),
    fsaslKind: FSASL_PROMPT_UPLOAD_KIND,
    promptSnapshotHtml:
      '<p><strong>Bold</strong> & <em>italic</em><br/>line2<table><tr><td>cell</td></tr></table></p>',
    durationSeconds: 42.5,
  };

  const enc = encodePromptDataForFfmpegMetadataTag(payload);
  const jsonUtf8 = JSON.stringify(payload);
  if (enc.utf8ByteLength !== Buffer.byteLength(jsonUtf8, 'utf8')) {
    throw new Error('utf8ByteLength mismatch');
  }

  const dec = decodePromptDataFromFfmpegMetadataTag(enc.tag, 512_000);
  if (!dec.ok) throw new Error(dec.error);

  const a = stableStringifyForPromptMatch(extractComparablePromptUploadFields(payload));
  const b = stableStringifyForPromptMatch(extractComparablePromptUploadFields(dec.obj));
  if (a !== b) {
    throw new Error(`Comparable stable mismatch:\n${a}\n---\n${b}`);
  }

  console.log('verify-webm-prompt-codec: JSON/base64 round-trip OK', {
    utf8Bytes: dec.utf8ByteLength,
    tagChars: enc.tag.length,
  });

  const root = process.cwd();
  const samplePath = join(root, 'asl_submission_1775500023.webm');
  const sample = existsSync(samplePath) ? samplePath : undefined;

  if (sample && ffmpegAvailable()) {
    const muxed = await muxWebmWithPromptDataTag({
      inputPath: sample,
      promptDataTagValue: enc.tag,
      timeoutMs: 30_000,
    });
    if (!muxed.ok) {
      console.warn('verify-webm-prompt-codec: ffmpeg mux skipped/failed', muxed.error);
      return;
    }
    try {
      const tagRaw = await ffprobeWebmPromptDataJson(muxed.outputPath, 25_000);
      if (!tagRaw) throw new Error('no PROMPT_DATA from ffprobe');
      const fromFile = decodePromptDataFromFfmpegMetadataTag(tagRaw, 512_000);
      if (!fromFile.ok) throw new Error(fromFile.error);
      const c = stableStringifyForPromptMatch(extractComparablePromptUploadFields(fromFile.obj));
      if (c !== a) throw new Error('ffprobe round-trip comparable mismatch');
      console.log('verify-webm-prompt-codec: ffmpeg+ffprobe round-trip OK', { sample });
    } finally {
      cleanupMuxOutputPath(muxed.outputPath);
    }
  } else {
    console.log('verify-webm-prompt-codec: skip ffmpeg test (no sample WebM or ffmpeg)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
