import { Injectable } from '@nestjs/common';
import { statSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { appendLtiLog } from '../common/last-error.store';
import { CanvasService } from '../canvas/canvas.service';
import { transcribeWavFileWithDeepgram } from './deepgram-transcribe.util';
import {
  DEFAULT_SIGN_TO_VOICE_DOWNLOAD_MAX_BYTES,
  downloadToTempWebm,
  extractAudioWavFromWebm,
} from './ffmpeg-captions.util';

/** First Canvas attachment id with a direct HTTP(S) download URL (for deep-link ingest polling). */
export function pickFirstCanvasVideoFileIdFromSubmission(
  sub: NonNullable<Awaited<ReturnType<CanvasService['getSubmissionFull']>>>,
): string | undefined {
  const collect: Array<{ id?: number; url?: string; download_url?: string }> = [];
  if (sub.attachment) collect.push(sub.attachment);
  if (Array.isArray(sub.attachments)) collect.push(...sub.attachments);
  for (const a of collect) {
    const u = (a?.url ?? a?.download_url ?? '').trim();
    if (
      a?.id != null &&
      u &&
      (u.startsWith('http://') || u.startsWith('https://')) &&
      !u.includes('external_tools/retrieve')
    ) {
      return String(a.id);
    }
  }
  return undefined;
}

function pickVideoDownloadUrlForFileId(
  sub: NonNullable<Awaited<ReturnType<CanvasService['getSubmissionFull']>>>,
  fileId: string,
): string | undefined {
  const idStr = String(fileId).trim();
  const collect: Array<{ id?: number; url?: string; download_url?: string }> = [];
  if (sub.attachment) collect.push(sub.attachment);
  if (Array.isArray(sub.attachments)) collect.push(...sub.attachments);
  const m = collect.find((a) => a?.id != null && String(a.id) === idStr);
  const u = (m?.url ?? m?.download_url ?? '').trim();
  if (u && (u.startsWith('http://') || u.startsWith('https://')) && !u.includes('external_tools/retrieve')) return u;
  for (const a of collect) {
    const u2 = (a?.url ?? a?.download_url ?? '').trim();
    if (u2 && (u2.startsWith('http://') || u2.startsWith('https://')) && !u2.includes('external_tools/retrieve')) return u2;
  }
  return undefined;
}

@Injectable()
export class SignToVoiceCaptionService {
  private static readonly captionPipelineConcurrency = 2;
  private captionPipelineActive = 0;
  private readonly captionPipelineWaiters: Array<() => void> = [];

  constructor(
    private readonly canvas: CanvasService,
    private readonly config: ConfigService,
  ) {}

  private async acquireCaptionPipelineSlot(): Promise<void> {
    if (this.captionPipelineActive < SignToVoiceCaptionService.captionPipelineConcurrency) {
      this.captionPipelineActive++;
      return;
    }
    await new Promise<void>((resolve) => this.captionPipelineWaiters.push(resolve));
    this.captionPipelineActive++;
  }

  private releaseCaptionPipelineSlot(): void {
    this.captionPipelineActive--;
    const next = this.captionPipelineWaiters.shift();
    if (next) next();
  }

  /**
   * After Deep Link return, Canvas ingests the file asynchronously. Poll until a video attachment id exists, then run the caption pipeline.
   */
  pollDeepLinkThenScheduleCaptions(args: {
    signToVoiceRequired: boolean;
    courseId: string;
    assignmentId: string;
    studentUserId: string;
    filename: string;
    domainOverride: string | undefined;
    canvasToken: string;
  }): void {
    void this.runDeepLinkCaptionPoll(args).catch((err: unknown) => {
      appendLtiLog('sign-to-voice', 'deep-link poll: fatal outer rejection', {
        assignmentId: args.assignmentId,
        userId: args.studentUserId,
        error: String(err),
      });
      console.error('[sign-to-voice] deep-link poll rejected', err);
    });
  }

  private async runDeepLinkCaptionPoll(args: {
    signToVoiceRequired: boolean;
    courseId: string;
    assignmentId: string;
    studentUserId: string;
    filename: string;
    domainOverride: string | undefined;
    canvasToken: string;
  }): Promise<void> {
    const { courseId, assignmentId, studentUserId, filename, domainOverride, canvasToken } = args;
    if (!(canvasToken ?? '').trim()) {
      appendLtiLog('sign-to-voice', 'deep-link poll: SKIP (empty canvas token)', {
        assignmentId,
        userId: studentUserId,
      });
      return;
    }
    if (!args.signToVoiceRequired) {
      appendLtiLog('sign-to-voice', 'deep-link poll: SKIPPED (assignment not configured for sign-to-voice)', {
        assignmentId,
        userId: studentUserId,
      });
      return;
    }

    const POLL_INTERVAL_MS = 3000;
    const POLL_MAX_ATTEMPTS = 50;
    appendLtiLog('sign-to-voice', 'deep-link poll: start (waiting for Canvas attachment)', {
      assignmentId,
      userId: studentUserId,
      maxAttempts: POLL_MAX_ATTEMPTS,
      intervalMs: POLL_INTERVAL_MS,
    });

    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
      try {
        const sub = await this.canvas.getSubmissionFull(
          courseId,
          assignmentId,
          studentUserId,
          domainOverride,
          canvasToken,
          { tag: `deep-link-caption-poll-${attempt}` },
        );
        const fileId = sub ? pickFirstCanvasVideoFileIdFromSubmission(sub) : undefined;
        if (fileId) {
          appendLtiLog('sign-to-voice', 'deep-link poll: Canvas file visible, scheduling pipeline', {
            assignmentId,
            userId: studentUserId,
            fileId,
            attempt,
          });
          this.scheduleAfterSuccessfulUpload({
            signToVoiceRequired: true,
            courseId,
            assignmentId,
            studentUserId,
            initialCanvasFileId: fileId,
            filename,
            domainOverride,
            canvasToken,
          });
          return;
        }
      } catch (e) {
        appendLtiLog('sign-to-voice', 'deep-link poll: attempt error (non-fatal)', {
          assignmentId,
          userId: studentUserId,
          attempt,
          error: String(e),
        });
      }
      if (attempt % 5 === 0) {
        appendLtiLog('sign-to-voice', 'deep-link poll: still waiting', { assignmentId, userId: studentUserId, attempt });
      }
      if (attempt < POLL_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }

    appendLtiLog('sign-to-voice', 'deep-link poll: TIMEOUT (no Canvas attachment id)', {
      assignmentId,
      userId: studentUserId,
    });
  }

  scheduleAfterSuccessfulUpload(args: {
    signToVoiceRequired: boolean;
    courseId: string;
    assignmentId: string;
    studentUserId: string;
    initialCanvasFileId: string;
    filename: string;
    domainOverride: string | undefined;
    canvasToken: string;
  }): void {
    if (!args.signToVoiceRequired) {
      appendLtiLog('sign-to-voice', 'pipeline: SKIPPED (assignment not configured for sign-to-voice)', {
        assignmentId: args.assignmentId,
        userId: args.studentUserId,
        fileId: args.initialCanvasFileId,
      });
      return;
    }
    appendLtiLog('sign-to-voice', 'pipeline: scheduled after upload (signToVoiceRequired=true)', {
      assignmentId: args.assignmentId,
      userId: args.studentUserId,
      fileId: args.initialCanvasFileId,
    });
    const apiKey = (this.config.get<string>('DEEPGRAM_API_KEY') ?? process.env.DEEPGRAM_API_KEY ?? '').trim();
    if (!apiKey) {
      appendLtiLog('sign-to-voice', 'SKIP pipeline: DEEPGRAM_API_KEY unset', {
        assignmentId: args.assignmentId,
        userId: args.studentUserId,
      });
      return;
    }
    const run = async () => {
      try {
        await this.acquireCaptionPipelineSlot();
      } catch (e) {
        appendLtiLog('sign-to-voice', 'pipeline: acquireCaptionPipelineSlot failed', {
          error: String(e),
          userId: args.studentUserId,
          assignmentId: args.assignmentId,
        });
        console.error('[sign-to-voice] acquireCaptionPipelineSlot failed', e);
        return;
      }
      try {
        await this.runPipeline({ ...args, deepgramApiKey: apiKey });
      } finally {
        this.releaseCaptionPipelineSlot();
      }
    };
    void run().catch((err: unknown) => {
      appendLtiLog('sign-to-voice', 'pipeline: fatal outer rejection', {
        error: String(err),
        userId: args.studentUserId,
        assignmentId: args.assignmentId,
      });
      console.error('[sign-to-voice] pipeline run() rejected', err);
    });
  }

  private async runPipeline(args: {
    courseId: string;
    assignmentId: string;
    studentUserId: string;
    initialCanvasFileId: string;
    filename: string;
    domainOverride: string | undefined;
    canvasToken: string;
    deepgramApiKey: string;
  }): Promise<void> {
    const { courseId, assignmentId, studentUserId, initialCanvasFileId, domainOverride, canvasToken } = args;
    appendLtiLog('sign-to-voice', 'pipeline: start', { assignmentId, userId: studentUserId, fileId: initialCanvasFileId });

    let webmDlCleanup: (() => void) | null = null;
    let audioCleanup: (() => void) | null = null;

    try {
      const sub = await this.canvas.getSubmissionFull(courseId, assignmentId, studentUserId, domainOverride, canvasToken);
      if (!sub) throw new Error('submission_not_found');
      const videoUrl = pickVideoDownloadUrlForFileId(sub, initialCanvasFileId);
      if (!videoUrl) throw new Error('no_download_url_for_file');

      const { path: webmPath, cleanup: c1 } = await downloadToTempWebm(
        videoUrl,
        canvasToken,
        DEFAULT_SIGN_TO_VOICE_DOWNLOAD_MAX_BYTES,
      );
      webmDlCleanup = c1;
      appendLtiLog('sign-to-voice', 'pipeline: WebM downloaded for extract', {
        userId: studentUserId,
        maxBytesDownloaded: DEFAULT_SIGN_TO_VOICE_DOWNLOAD_MAX_BYTES,
      });

      const { wavPath, cleanup: c2 } = await extractAudioWavFromWebm(webmPath);
      audioCleanup = c2;
      let wavBytes = 0;
      try {
        wavBytes = statSync(wavPath).size;
      } catch {
        /* ignore */
      }
      appendLtiLog('sign-to-voice', 'pipeline: WAV extracted for Deepgram', {
        userId: studentUserId,
        wavBytes,
      });

      appendLtiLog('sign-to-voice', 'pipeline: Deepgram transcribe request', { userId: studentUserId });
      const { vtt } = await transcribeWavFileWithDeepgram(wavPath, args.deepgramApiKey);
      const vttLen = (vtt ?? '').length;
      appendLtiLog('sign-to-voice', 'pipeline: Deepgram transcribe OK', {
        userId: studentUserId,
        vttChars: vttLen,
        vttCueLines: (vtt.match(/\n\n/g) ?? []).length,
      });

      const attachmentGet = await this.canvas.getMediaAttachment(
        initialCanvasFileId,
        domainOverride,
        canvasToken,
      );
      let mediaObjectId: unknown;
      let contentType: unknown;
      try {
        const parsed = JSON.parse(attachmentGet.raw) as Record<string, unknown>;
        mediaObjectId = parsed.media_object_id;
        if (mediaObjectId == null && parsed.media_object && typeof parsed.media_object === 'object') {
          mediaObjectId = (parsed.media_object as { id?: unknown }).id;
        }
        contentType = parsed.content_type ?? parsed['content-type'];
      } catch {
        /* non-JSON body */
      }
      appendLtiLog('sign-to-voice', 'media_attachment GET before media_tracks PUT', {
        attachmentId: initialCanvasFileId,
        httpStatus: attachmentGet.status,
        ok: attachmentGet.ok,
        media_object_id: mediaObjectId,
        content_type: contentType,
        fullResponse: attachmentGet.raw,
      });

      const putUrlInfo = this.canvas.buildMediaAttachmentMediaTracksPutUrl(
        initialCanvasFileId,
        domainOverride,
        studentUserId,
      );
      appendLtiLog('sign-to-voice', 'media_tracks PUT URL (next request)', {
        putUrl: putUrlInfo.url,
        as_user_id_present: putUrlInfo.asUserIdPresent,
        as_user_id_value: putUrlInfo.asUserIdValue ?? null,
      });

      await this.canvas.putMediaAttachmentMediaTracks(
        initialCanvasFileId,
        [{ locale: 'en', kind: 'subtitles', content: vtt }],
        domainOverride,
        canvasToken,
        studentUserId,
      );
      appendLtiLog('sign-to-voice', 'pipeline: OK (Canvas media_tracks)', {
        userId: studentUserId,
        attachmentId: initialCanvasFileId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLtiLog('sign-to-voice', 'pipeline: FAIL', { userId: studentUserId, error: msg });
      console.error('[sign-to-voice] pipeline error', e);
    } finally {
      audioCleanup?.();
      webmDlCleanup?.();
    }
  }
}
