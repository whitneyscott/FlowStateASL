import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { statSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { appendLtiLog } from '../common/last-error.store';
import { CanvasService } from '../canvas/canvas.service';
import { transcribeWavFileWithDeepgram } from './deepgram-transcribe.util';
import {
  DEFAULT_SIGN_TO_VOICE_DOWNLOAD_MAX_BYTES,
  downloadToTempWebm,
  extractAudioWavFromWebm,
  muxWebVttIntoWebm,
} from './ffmpeg-captions.util';
import { PromptSubmissionCaptionsEntity, type PromptCaptionsStatus } from './entities/prompt-submission-captions.entity';

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
    @InjectRepository(PromptSubmissionCaptionsEntity)
    private readonly repo: Repository<PromptSubmissionCaptionsEntity>,
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

  async getStatusesForUsers(
    courseId: string,
    assignmentId: string,
    userIds: string[],
  ): Promise<Map<string, PromptCaptionsStatus>> {
    const out = new Map<string, PromptCaptionsStatus>();
    if (!userIds.length) return out;
    const rows = await this.repo.find({
      where: { courseId, assignmentId, userId: In(userIds) },
    });
    for (const r of rows) {
      out.set(r.userId, r.captionsStatus);
    }
    return out;
  }

  async getVttIfReady(
    courseId: string,
    assignmentId: string,
    userId: string,
  ): Promise<{ vtt: string } | null> {
    const row = await this.repo.findOne({ where: { courseId, assignmentId, userId } });
    if (!row || row.captionsStatus !== 'ready' || !(row.vttText ?? '').trim()) return null;
    return { vtt: row.vttText ?? '' };
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
      void this.markFailed(args.courseId, args.assignmentId, args.studentUserId, 'deepgram_api_key_missing');
      return;
    }
    void (async () => {
      await this.acquireCaptionPipelineSlot();
      try {
        await this.runPipeline({ ...args, deepgramApiKey: apiKey });
      } catch (e) {
        appendLtiLog('sign-to-voice', 'pipeline unhandled', { error: String(e), userId: args.studentUserId });
        await this.markFailed(args.courseId, args.assignmentId, args.studentUserId, String(e));
      } finally {
        this.releaseCaptionPipelineSlot();
      }
    })();
  }

  private async markFailed(courseId: string, assignmentId: string, userId: string, message: string): Promise<void> {
    await this.repo.upsert(
      {
        courseId,
        assignmentId,
        userId,
        captionsStatus: 'failed',
        vttText: null,
        errorMessage: message.slice(0, 4000),
        updatedAt: new Date(),
      },
      { conflictPaths: ['courseId', 'assignmentId', 'userId'] },
    );
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
    const { courseId, assignmentId, studentUserId, initialCanvasFileId, filename, domainOverride, canvasToken } = args;
    appendLtiLog('sign-to-voice', 'pipeline: start', { assignmentId, userId: studentUserId, fileId: initialCanvasFileId });

    await this.repo.upsert(
      {
        courseId,
        assignmentId,
        userId: studentUserId,
        captionsStatus: 'pending',
        vttText: null,
        errorMessage: null,
        updatedAt: new Date(),
      },
      { conflictPaths: ['courseId', 'assignmentId', 'userId'] },
    );

    let webmDlCleanup: (() => void) | null = null;
    let audioCleanup: (() => void) | null = null;
    let muxCleanup: (() => void) | null = null;

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

      const { outputPath: muxedPath, size: muxedSize, cleanup: c3 } = await muxWebVttIntoWebm({
        webmPath,
        vttContent: vtt,
      });
      muxCleanup = c3;
      appendLtiLog('sign-to-voice', 'pipeline: WebM+VTT mux complete', { userId: studentUserId, muxedBytes: muxedSize });

      const { uploadUrl, uploadParams } = await this.canvas.initiateSubmissionFileUploadForUser(
        courseId,
        assignmentId,
        studentUserId,
        filename,
        muxedSize,
        'video/webm',
        domainOverride,
        canvasToken,
      );
      const up = await this.canvas.uploadFileToCanvas(
        uploadUrl,
        uploadParams,
        { filePath: muxedPath, size: muxedSize },
        { tokenOverride: canvasToken },
      );
      const newFileId = up.fileId;

      try {
        await this.canvas.putSubmissionOnlineUploadFileIds(
          courseId,
          assignmentId,
          studentUserId,
          [newFileId],
          domainOverride,
          canvasToken,
        );
      } catch (putErr) {
        appendLtiLog('sign-to-voice', 'pipeline: PUT file_ids failed, trying attach', { error: String(putErr) });
        await this.canvas.attachFileToSubmission(
          courseId,
          assignmentId,
          studentUserId,
          newFileId,
          domainOverride,
          canvasToken,
        );
      }

      try {
        await this.canvas.deleteCanvasFile(initialCanvasFileId, domainOverride, canvasToken);
      } catch (delErr) {
        appendLtiLog('sign-to-voice', 'pipeline: delete old file non-fatal', { error: String(delErr) });
      }

      await this.repo.upsert(
        {
          courseId,
          assignmentId,
          userId: studentUserId,
          captionsStatus: 'ready',
          vttText: vtt,
          errorMessage: null,
          updatedAt: new Date(),
        },
        { conflictPaths: ['courseId', 'assignmentId', 'userId'] },
      );
      appendLtiLog('sign-to-voice', 'pipeline: OK', { userId: studentUserId, newFileId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLtiLog('sign-to-voice', 'pipeline: FAIL', { userId: studentUserId, error: msg });
      await this.markFailed(courseId, assignmentId, studentUserId, msg);
    } finally {
      muxCleanup?.();
      audioCleanup?.();
      webmDlCleanup?.();
    }
  }
}
