import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ASSESSMENT_REPOSITORY, PROMPT_DATA_REPOSITORY } from '../data/tokens';
import type { IAssessmentRepository } from '../data/interfaces/assessment-repository.interface';
import type { IPromptDataRepository } from '../data/interfaces/prompt-data-repository.interface';
import { appendLtiLog, appendPlacementMarker, type PlacementLtiVersion, type PlacementPath } from '../common/last-error.store';
import { ConfigService } from '@nestjs/config';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { LtiAgsService } from '../lti/lti-ags.service';
import { LtiDeepLinkFileStore } from '../lti/lti-deep-link-file.store';
import { LtiDeepLinkResponseService } from '../lti/lti-deep-link-response.service';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { SproutPlaylistVideoEntity } from '../sproutvideo/entities/sprout-playlist-video.entity';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import {
  canvasApiBaseFromLtiContext,
  normalizeToCanvasRestBase,
} from '../common/utils/canvas-base-url.util';
import { resolveCanvasApiUserId } from '../common/utils/canvas-api-user.util';
import { getSproutAccountId } from '../common/utils/sprout-account-id.util';
import { parseSproutEmbedPairFromEmbedCode } from '../common/utils/sprout-embed-url.util';
import type { PromptConfigJson, PutPromptConfigDto, VideoPromptConfig } from './dto/prompt-config.dto';
import { cleanupWebmVttMuxOutputPath } from './ffmpeg-captions.util';
import { tryPreuploadSignToVoiceCaptionsMux } from './sign-to-voice-preupload.util';
import { normalizeYoutubeInputToVideoId } from './youtube-video-id.util';
import { normalizeCanvasRubricAssessment } from './canvas-rubric-assessment.util';
import {
  decodePromptDataFromFfmpegMetadataTag,
  encodePromptDataForFfmpegMetadataTag,
  FSASL_PROMPT_UPLOAD_KIND,
} from './prompt-upload-payload.util';
import {
  cleanupMuxOutputPath,
  DEFAULT_WEBM_MUX_TIMEOUT_MS,
  DEFAULT_WEBM_PROBE_DOWNLOAD_MAX_BYTES,
  downloadAuthenticatedVideoToTempFile,
  extractFirstSubtitleWebVttFromWebm,
  ffprobeWebmPromptDataJson,
  muxWebmWithPromptDataTag,
  writeBufferToTempWebmFile,
} from './webm-prompt-metadata.util';
import { isMachinePromptJsonComment } from './machine-prompt-comment.util';
import {
  buildHumanReadableSubmissionBodyText,
  gradingDisplayHtmlFromDeckTimelineRows,
  gradingDisplayHtmlFromPromptSnapshotRte,
  humanSubmissionBodyToPromptHtml,
} from './submission-human-readable-body.util';
import { randomUUID } from 'crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import {
  type PromptManagerSettingsBlob,
  PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
  migrateMonolithicPromptBlobToPerAssignmentEmbeds,
  readPromptManagerSettingsBlobFromCanvas,
  readPromptManagerSettingsBlobFromCanvasAssignmentDescription,
  readPromptManagerSettingsBlobWithEmbedsResolved,
  promptManagerBlobFromAssignmentDescription,
  writePromptManagerSettingsBlobToCanvas,
} from './prompt-manager-settings-blob.storage';
import {
  mergeAssignmentDescriptionWithEmbeds,
  parseAssignmentDescriptionForPromptManager,
} from './assignment-description-embed.util';
import { repairPromptManagerSettingsBlobFromUnknown } from './prompt-settings-blob-repair.util';
import { inferPromptModeFromStructuredConfig, mergeSourceEmbedForImport } from './prompt-mode-infer.util';
import { mapWithConcurrency } from '../common/map-with-concurrency.util';
import { resolveAssignmentIdByName, type CanvasAssignmentBrief } from './assignment-id-resolve.util';
import type { ImportPromptManagerBlobDto } from './dto/import-prompt-manager-blob.dto';
import type { ImportSinglePromptAssignmentDto } from './dto/import-single-prompt-assignment.dto';
import { buildPartialPromptConfigForTrueWay, scanTrueWayAssignments, type TrueWayTemplateMatch } from './true-way-templates';

/** Import modal payload derived from one `listAssignmentsForPromptImport` result (sorted). */
function buildCanvasImportListsFromAssignments(all: CanvasAssignmentBrief[]): {
  allAssignments: CanvasAssignmentBrief[];
  settingsTitleCandidates: CanvasAssignmentBrief[];
} {
  const byName = (a: CanvasAssignmentBrief, b: CanvasAssignmentBrief) => a.name.localeCompare(b.name);
  const settingsTitleCandidates = all
    .filter((a) => a.name.toLowerCase().includes('prompt manager settings'))
    .sort(byName);
  return {
    allAssignments: [...all].sort(byName),
    settingsTitleCandidates,
  };
}

/**
 * Deck card timing (mirrors TimerPage): minimum prompt floor + cognitive transition.
 */
const DECK_MIN_VIDEO_FLOOR_SECONDS = 2.5;
const DECK_COGNITIVE_TRANSITION_SECONDS = 1;
const DECK_MIN_TOTAL_SECONDS = DECK_MIN_VIDEO_FLOOR_SECONDS + DECK_COGNITIVE_TRANSITION_SECONDS;

/** Canvas submission and file-upload API paths require a numeric user id, not LTI `sub` (opaque). */
function isCanvasNumericUserId(id: string): boolean {
  return id.length > 0 && /^\d+$/.test(id);
}

interface DeckCardSource {
  id: string;
  title: string;
  durationSeconds: number | null;
  /** Sprout security token (second embed path segment) when known. */
  securityToken: string | null;
}

/** Canvas shows "submitted" when workflow_state is submitted or graded. Match that. */
function submissionHasFile(s: {
  attachment?: { url?: string; download_url?: string };
  attachments?: Array<{ url?: string; download_url?: string }>;
  versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
  submission_type?: string;
  workflow_state?: string;
  submission_history?: Array<{
    attachment?: { url?: string; download_url?: string };
    attachments?: Array<{ url?: string; download_url?: string }>;
    versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
  }>;
}): boolean {
  const urlFromCanvas = getVideoUrlFromCanvasSubmission(s);
  if (urlFromCanvas) return true;
  const ws = (s.workflow_state ?? '').toLowerCase();
  if (['submitted', 'graded'].includes(ws)) return true;
  const hist = s.submission_history;
  if (Array.isArray(hist) && hist.length > 0) {
    const last = hist[hist.length - 1];
    if (getVideoUrlFromCanvasSubmission(last)) return true;
  }
  return false;
}

/** Extract video URL from Canvas submission (top-level url, attachment, attachments, or submission_history). */
function getVideoUrlFromCanvasSubmission(s: {
  url?: string;
  attachment?: { url?: string; download_url?: string };
  attachments?: Array<{ url?: string; download_url?: string }>;
  versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
  submission_history?: Array<{
    url?: string;
    attachment?: { url?: string; download_url?: string };
    attachments?: Array<{ url?: string; download_url?: string }>;
    versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
  }>;
}): string | undefined {
  // Canvas puts URL in submission.url — but for basic_lti_launch it's the LTI retrieve URL
  // (external_tools/retrieve), which returns HTML, not video. Only use direct file URLs.
  const topUrl = (s as { url?: string }).url;
  if (topUrl && typeof topUrl === 'string' && (topUrl.startsWith('http://') || topUrl.startsWith('https://'))) {
    if (!topUrl.includes('external_tools/retrieve')) return topUrl;
    // LTI retrieve URL is HTML — fall through to attachment/deepLinkStore
  }
  const fromOne = (obj: typeof s & { url?: string }): string | undefined => {
    const first = obj.attachment ?? obj.attachments?.[0];
    if (first?.url) return first.url;
    if (first?.download_url) return first.download_url;
    const va = obj.versioned_attachments;
    if (Array.isArray(va) && va.length > 0) {
      const last = va[va.length - 1];
      const arr = Array.isArray(last) ? last : [];
      const f = arr[0];
      return f?.url ?? f?.download_url;
    }
    return undefined;
  };
  const url = fromOne(s);
  if (url) return url;
  const hist = s.submission_history;
  if (Array.isArray(hist) && hist.length > 0) {
    for (let i = hist.length - 1; i >= 0; i--) {
      const entry = hist[i] as { url?: string } & typeof hist[0];
      const eu = entry?.url;
      if (eu && (eu.startsWith('http://') || eu.startsWith('https://')) && !eu.includes('external_tools/retrieve'))
        return eu;
      const u = fromOne(entry);
      if (u) return u;
    }
  }
  return undefined;
}

/** Convert datetime-local or partial datetime string to ISO 8601 for Canvas API. */
function toCanvasIso8601(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

@Injectable()
export class PromptService {
  private readonly deckSourceCache = new Map<string, { cards: DeckCardSource[]; expiresAt: number }>();
  private readonly deckSourceInflight = new Map<string, Promise<DeckCardSource[]>>();
  /** Coalesces `listAssignmentsForPromptImport` across import UI + POST within a short window. */
  private readonly assignmentImportListCache = new Map<string, { list: CanvasAssignmentBrief[]; expiresAt: number }>();
  private readonly assignmentImportListInflight = new Map<string, Promise<CanvasAssignmentBrief[]>>();
  private static readonly ASSIGNMENT_IMPORT_LIST_TTL_MS = 45_000;

  constructor(
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessmentRepo: IAssessmentRepository,
    @Inject(PROMPT_DATA_REPOSITORY) private readonly promptDataRepo: IPromptDataRepository,
    private readonly config: ConfigService,
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiAgs: LtiAgsService,
    private readonly deepLinkFileStore: LtiDeepLinkFileStore,
    private readonly deepLinkResponse: LtiDeepLinkResponseService,
    private readonly sproutVideo: SproutVideoService,
    @InjectRepository(SproutPlaylistVideoEntity)
    private readonly sproutPlaylistVideoRepo: Repository<SproutPlaylistVideoEntity>,
  ) {}

  private assignmentImportListCacheKey(courseId: string, token: string): string {
    return `${courseId}\u0000${token}`;
  }

  private async listAssignmentsForPromptImportCached(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<CanvasAssignmentBrief[]> {
    const key = this.assignmentImportListCacheKey(courseId, token);
    const now = Date.now();
    const cached = this.assignmentImportListCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.list;
    }
    const inflight = this.assignmentImportListInflight.get(key);
    if (inflight) return inflight;
    const p = this.canvas
      .listAssignmentsForPromptImport(courseId, domainOverride, token)
      .then((list) => {
        this.assignmentImportListInflight.delete(key);
        this.assignmentImportListCache.set(key, {
          list,
          expiresAt: Date.now() + PromptService.ASSIGNMENT_IMPORT_LIST_TTL_MS,
        });
        return list;
      })
      .catch((err) => {
        this.assignmentImportListInflight.delete(key);
        throw err;
      });
    this.assignmentImportListInflight.set(key, p);
    return p;
  }

  /**
   * SSRF guard for unauthenticated video-proxy: Instructure CDN/hosting + optional school host
   * from `canvas_base` query (set by server in toViewerVideoUrl) or CANVAS_API_BASE_URL.
   */
  assertVideoProxyTargetForCourse(
    targetUrl: string,
    courseId: string,
    canvasBaseFromQuery?: string | null,
  ): void {
    const cid = (courseId ?? '').trim();
    if (!cid) {
      throw new BadRequestException('course_id is required');
    }
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new BadRequestException('Invalid video URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Invalid video URL');
    }
    const isInstructure =
      parsed.hostname === 'instructure.com' ||
      parsed.hostname.endsWith('.instructure.com') ||
      parsed.hostname === 'instructureusercontent.com' ||
      parsed.hostname.endsWith('.instructureusercontent.com');
    if (isInstructure) return;

    let canvasHost = '';
    const qBase = (canvasBaseFromQuery ?? '').trim();
    if (qBase) {
      try {
        const decoded = decodeURIComponent(qBase);
        const norm = normalizeToCanvasRestBase(decoded);
        if (norm) canvasHost = new URL(norm).hostname;
      } catch {
        throw new BadRequestException('Invalid canvas_base');
      }
    }
    if (!canvasHost) {
      const envBase = normalizeToCanvasRestBase(this.config.get<string>('CANVAS_API_BASE_URL'));
      if (envBase) {
        try {
          canvasHost = new URL(envBase).hostname;
        } catch {
          //
        }
      }
    }
    if (canvasHost && parsed.hostname.toLowerCase() === canvasHost.toLowerCase()) return;
    throw new ForbiddenException('Video URL not allowed');
  }

  /**
   * Stream Canvas video for grading viewer: no LTI session on &lt;video&gt; requests; uses per-course
   * Canvas token from DB. Forwards Range for seeking; streams without buffering the full file.
   */
  async pipeCanvasVideoProxyForCourse(
    res: Response,
    clientRange: string | undefined,
    targetUrl: string,
    courseId: string,
    canvasBaseFromQuery?: string | null,
  ): Promise<void> {
    this.assertVideoProxyTargetForCourse(targetUrl, courseId, canvasBaseFromQuery);
    const canvasToken = await this.courseSettings.getEffectiveCanvasToken(courseId.trim(), undefined);
    if (!canvasToken) {
      if (!res.headersSent) res.status(502).end();
      return;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${canvasToken}` };
    if (clientRange?.trim()) {
      headers.Range = clientRange.trim();
    }
    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!upstream.ok) {
      await upstream.arrayBuffer().catch(() => undefined);
      if (!res.headersSent) res.status(upstream.status === 404 ? 404 : 502).end();
      return;
    }
    const contentTypeRaw = (upstream.headers.get('content-type') || 'video/mp4').split(';')[0].trim().toLowerCase();
    if (contentTypeRaw.startsWith('text/html')) {
      appendLtiLog('viewer', 'video-proxy: upstream HTML, rejecting', {
        targetUrl: targetUrl.slice(0, 80),
      });
      await upstream.body?.cancel().catch(() => undefined);
      if (!res.headersSent) res.status(404).end();
      return;
    }
    if (!upstream.body) {
      if (!res.headersSent) res.status(502).end();
      return;
    }
    if (!clientRange?.trim()) {
      let targetHint = targetUrl.slice(0, 96);
      try {
        const u = new URL(targetUrl);
        targetHint = `${u.hostname}${u.pathname}`.slice(0, 96);
      } catch {
        /* keep slice */
      }
      appendLtiLog('viewer', 'video-proxy (initial)', {
        courseId: courseId.trim(),
        targetHint,
        contentType: contentTypeRaw,
      });
    }
    res.status(upstream.status);
    res.setHeader('Content-Type', contentTypeRaw);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    try {
      const nodeReadable = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
      await pipeline(nodeReadable, res);
    } catch (err) {
      appendLtiLog('viewer', 'video-proxy: stream error', { error: String(err) });
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }
  }

  private get deckSourceCacheTtlMs(): number {
    const raw = this.config.get<string>('DECK_SOURCE_CACHE_TTL_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
  }

  private async getDeckCardsWithCache(deckId: string): Promise<DeckCardSource[]> {
    const now = Date.now();
    const cached = this.deckSourceCache.get(deckId);
    if (cached && cached.expiresAt > now) {
      return cached.cards.map((c) => ({ ...c }));
    }
    const inflight = this.deckSourceInflight.get(deckId);
    if (inflight) {
      const fromInflight = await inflight;
      return fromInflight.map((c) => ({ ...c }));
    }
    const fetchPromise = (async () => {
      const videos = await this.sproutVideo.fetchVideosByPlaylistId(deckId);
      const seen = new Set<string>();
      const deduped: DeckCardSource[] = [];
      for (const v of videos) {
        const key = (v.title ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const ds = v.durationSeconds;
        const st = (v.securityToken ?? '').trim();
        deduped.push({
          id: v.id,
          title: v.title.trim(),
          durationSeconds:
            typeof ds === 'number' && Number.isFinite(ds) && ds > 0 ? ds : null,
          securityToken: st.length > 0 ? st : null,
        });
      }
      this.deckSourceCache.set(deckId, {
        cards: deduped,
        expiresAt: Date.now() + this.deckSourceCacheTtlMs,
      });
      return deduped;
    })()
      .finally(() => {
        this.deckSourceInflight.delete(deckId);
      });
    this.deckSourceInflight.set(deckId, fetchPromise);
    const cards = await fetchPromise;
    return cards.map((c) => ({ ...c }));
  }

  /** Canvas REST paths need the numeric Canvas user id (custom), not an opaque LTI 1.3 sub. */
  private async resolveCanvasUserIdForRestApi(
    ctx: LtiContext,
    token: string,
    domainOverride?: string,
  ): Promise<string> {
    const fromCtx = resolveCanvasApiUserId(ctx);
    if (fromCtx) return fromCtx;
    if (!token.trim()) {
      throw new Error(
        'Canvas token required when LTI custom user_id is missing. For LTI 1.3 add Custom Field user_id = $Canvas.user.id on the Developer Key.',
      );
    }
    const self = await this.canvas.getCurrentCanvasUserId(domainOverride, token);
    if (self) return self;
    throw new Error(
      'Canvas user id required. LTI 1.1: Custom Field user_id=$Canvas.user.id (custom_user_id) or cartridge custom_canvas_user_id; LTI 1.3: user_id on Developer Key; or Canvas OAuth as the submitting user.',
    );
  }

  /** Total seconds allowed on a deck card (prompt timer). */
  private deckCardTotalSeconds(videoDurationSec: number | null | undefined): number {
    if (
      typeof videoDurationSec === 'number' &&
      Number.isFinite(videoDurationSec) &&
      videoDurationSec > 0
    ) {
      const total = Math.max(DECK_MIN_VIDEO_FLOOR_SECONDS, videoDurationSec) + DECK_COGNITIVE_TRANSITION_SECONDS;
      return Math.round(total * 1000) / 1000;
    }
    return DECK_MIN_TOTAL_SECONDS;
  }

  private async loadVideoDurationsFromDb(videoIds: string[]): Promise<Map<string, number>> {
    const uniq = [...new Set(videoIds.filter(Boolean))];
    if (uniq.length === 0) return new Map();
    const rows = await this.sproutPlaylistVideoRepo.find({
      where: { videoId: In(uniq) },
      select: ['videoId', 'durationSeconds'],
    });
    const m = new Map<string, number>();
    for (const r of rows) {
      const d = r.durationSeconds;
      if (typeof d === 'number' && Number.isFinite(d) && d > 0 && !m.has(r.videoId)) {
        m.set(r.videoId, d);
      }
    }
    return m;
  }

  private createPlacementAttemptId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }

  private detectLtiVersion(ctx: LtiContext): PlacementLtiVersion {
    if (ctx.ltiLaunchType === '1.1' || ctx.ltiLaunchType === '1.3') return ctx.ltiLaunchType;
    if (ctx.messageType === 'LtiDeepLinkingRequest') return '1.3';
    if (ctx.agsLineitemsUrl || ctx.agsLineitemUrl || ctx.deepLinkReturnUrl || ctx.deploymentId) return '1.3';
    if (ctx.lisOutcomeServiceUrl || ctx.lisResultSourcedid) return '1.1';
    return 'unknown';
  }

  private toCanvasResponseCode(err: unknown): number | undefined {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/failed:\s*(\d{3})/i) ?? msg.match(/\b(\d{3})\b/);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  }

  private placementMarker(args: {
    placementAttemptId: string;
    ltiVersion: PlacementLtiVersion;
    path: PlacementPath;
    marker: string;
    outcome: 'ok' | 'fail' | 'skip' | 'warn';
    assignmentId: string;
    moduleId: string;
    reason?: string;
    canvasResponseCode?: number;
  }): void {
    appendPlacementMarker({
      placementAttemptId: args.placementAttemptId,
      ltiVersion: args.ltiVersion,
      path: args.path,
      marker: args.marker,
      outcome: args.outcome,
      reason: args.reason,
      canvasResponseCode: args.canvasResponseCode,
      assignmentId: args.assignmentId,
      moduleId: args.moduleId,
    });
  }

  /**
   * Resolve the visible assignment ID. In course_navigation, assignmentId comes from query param
   * (controller merges into ctx). When empty, throw — do not fall back to "Prompt Manager Submissions".
   */
  private async getPrompterAssignmentId(ctx: LtiContext): Promise<string> {
    const id = ctx.assignmentId?.trim();
    if (id) {
      return id;
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (token) {
      const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
      const resolved = await this.resolveAssignmentIdForContext(ctx, token, domainOverride);
      const assignmentName = resolved.assignmentId
        ? await this.canvasAssignmentNameForLog(ctx.courseId, resolved.assignmentId, domainOverride, token)
        : '(none)';
      appendLtiLog('prompt', 'getPrompterAssignmentId: fallback resolution', {
        source: resolved.source,
        assignmentId: resolved.assignmentId ?? '(none)',
        assignmentName,
        resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
        moduleId: (ctx.moduleId ?? '').trim() || '(none)',
      });
      if (resolved.assignmentId) {
        return resolved.assignmentId;
      }
    }
    throw new Error('Assignment ID required. In course_navigation, pass assignmentId as query parameter.');
  }

  private async readPromptManagerSettingsBlob(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<PromptManagerSettingsBlob | null> {
    return readPromptManagerSettingsBlobFromCanvas(this.canvas, courseId, domainOverride, token);
  }

  /** Max concurrent `resolvePromptRowFromWebmMetadata` in getSubmissions (default 2). Env: WEBM_PROBE_MAX_CONCURRENT. */
  private getWebmProbeMaxConcurrent(): number {
    const raw = this.config.get<string | undefined>('WEBM_PROBE_MAX_CONCURRENT') ?? process.env.WEBM_PROBE_MAX_CONCURRENT;
    const n = parseInt((raw ?? '2').trim() || '2', 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  }

  private async ensureMigrated(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<void> {
    await migrateMonolithicPromptBlobToPerAssignmentEmbeds(this.canvas, courseId, domainOverride, token);
  }

  private promptConfigFromAssignmentDescriptionString(description: string | undefined): PromptConfigJson | null {
    if (typeof description !== 'string' || !description.trim()) return null;
    const parsed = parseAssignmentDescriptionForPromptManager(description);
    if (!parsed.config) return null;
    return { ...parsed.config, instructions: parsed.visibleHtml };
  }

  /** Canvas `name` for Bridge / LTI logs (IDs alone are not human-transparent). */
  private async canvasAssignmentNameForLog(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<string> {
    if (!courseId || !assignmentId) return '(none)';
    try {
      const a = await this.canvas.getAssignment(courseId, assignmentId, domainOverride, token);
      const n = (a?.name ?? '').trim();
      return n || '(unnamed)';
    } catch {
      return '(unavailable)';
    }
  }

  private async readPromptConfigFromAssignmentDescription(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<PromptConfigJson | null> {
    const raw = await this.canvas.getAssignment(courseId, assignmentId, domainOverride, token);
    const assignmentName = (raw?.name ?? '').trim() || '(unnamed)';
    const desc = raw?.description;
    if (typeof desc === 'string' && desc.trim()) {
      const parsed = parseAssignmentDescriptionForPromptManager(desc);
      if (!parsed.config) {
        appendLtiLog('student-prompt-type', 'readPromptConfig: non-empty description but no ASL config (check assignment id / Canvas HTML vs editor)', {
          courseId,
          assignmentId,
          assignmentName,
          descLength: desc.length,
          aslDataMarker: desc.includes('data-asl-express'),
          repairNotes: parsed.repairNotes,
        });
        return null;
      }
      return { ...parsed.config, instructions: parsed.visibleHtml };
    }
    return null;
  }

  /** True when videoPromptConfig has enough structure for deck mode (matches infer heuristics). */
  private hasDeckShapedVideoPromptConfig(vpc: VideoPromptConfig | undefined): boolean {
    if (!vpc) return false;
    if (Array.isArray(vpc.selectedDecks) && vpc.selectedDecks.length > 0) return true;
    if (
      Array.isArray(vpc.storedPromptBanks) &&
      vpc.storedPromptBanks.some((b) => Array.isArray(b) && b.length > 0)
    ) {
      return true;
    }
    if (Array.isArray(vpc.staticFallbackPrompts) && vpc.staticFallbackPrompts.length > 0) return true;
    return false;
  }

  /**
   * Canvas GET assignment + description embed and course Prompt Manager settings blob can disagree:
   * a partial/empty description (or student-visible HTML) may parse without deck fields while
   * `legacyBlob.configs[id]` still holds the teacher-saved deck config. Merge so we do not drop blob decks.
   */
  private mergeDescriptionAndBlobPromptConfig(
    fromDesc: PromptConfigJson | null,
    fromBlob: PromptConfigJson | null,
  ): PromptConfigJson | null {
    if (!fromDesc && !fromBlob) return null;
    if (!fromBlob) return fromDesc ? { ...fromDesc } : null;
    if (!fromDesc) return { ...fromBlob };

    const descDecks = this.hasDeckShapedVideoPromptConfig(fromDesc.videoPromptConfig);
    const blobDecks = this.hasDeckShapedVideoPromptConfig(fromBlob.videoPromptConfig);
    const descVid = (fromDesc.youtubePromptConfig?.videoId ?? '').trim();
    const blobVid = (fromBlob.youtubePromptConfig?.videoId ?? '').trim();
    const descHasYt = !!descVid;
    const blobHasYt = !!blobVid;

    const out: PromptConfigJson = {
      ...fromBlob,
      ...fromDesc,
      instructions: fromDesc.instructions ?? fromBlob.instructions,
    };

    if (descDecks) {
      out.videoPromptConfig = fromDesc.videoPromptConfig;
    } else if (blobDecks) {
      out.videoPromptConfig = fromBlob.videoPromptConfig;
    } else {
      out.videoPromptConfig = fromDesc.videoPromptConfig ?? fromBlob.videoPromptConfig;
    }

    if (descHasYt) {
      out.youtubePromptConfig = fromDesc.youtubePromptConfig;
    } else if (blobHasYt) {
      out.youtubePromptConfig = fromBlob.youtubePromptConfig;
    } else {
      out.youtubePromptConfig = fromDesc.youtubePromptConfig ?? fromBlob.youtubePromptConfig;
    }

    if (!fromDesc.promptMode) {
      if (blobDecks && fromBlob.promptMode) out.promptMode = fromBlob.promptMode;
      else if (blobHasYt && fromBlob.promptMode) out.promptMode = fromBlob.promptMode;
    }

    return out;
  }

  private async loadPromptConfigForAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
    legacyBlob: PromptManagerSettingsBlob | null,
  ): Promise<PromptConfigJson | null> {
    const fromDesc = await this.readPromptConfigFromAssignmentDescription(
      courseId,
      assignmentId,
      domainOverride,
      token,
    );
    const fromBlob = legacyBlob?.configs?.[assignmentId] ?? null;
    const descDeck = this.hasDeckShapedVideoPromptConfig(fromDesc?.videoPromptConfig);
    const blobDeck = this.hasDeckShapedVideoPromptConfig(fromBlob?.videoPromptConfig);
    const merged = this.mergeDescriptionAndBlobPromptConfig(fromDesc, fromBlob);
    if (merged && blobDeck && !descDeck) {
      const assignmentName = await this.canvasAssignmentNameForLog(
        courseId,
        assignmentId,
        domainOverride,
        token,
      );
      appendLtiLog('prompt-decks', 'loadPromptConfig: deck fields taken from course settings blob (description lacked deck shape)', {
        courseId,
        assignmentId,
        assignmentName,
      });
    }
    return merged;
  }

  /**
   * Module placement for Prompt Manager is not stored in the assignment description embed.
   * Resolve the first Canvas module (by position) that contains this assignment as an Assignment module item.
   */
  private async resolveLiveModuleIdForAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<string> {
    try {
      const mid = await this.canvas.findFirstModuleIdContainingAssignment(
        courseId,
        assignmentId,
        domainOverride,
        token,
      );
      return mid ?? '';
    } catch (e) {
      appendLtiLog('prompt', 'resolveLiveModuleIdForAssignment: Canvas modules scan failed', {
        courseId,
        assignmentId,
        error: String(e),
      });
      return '';
    }
  }

  /**
   * Learners often upload with Canvas OAuth; they may be unable to read the Prompt Manager Settings
   * assignment, so `configs[assignmentId]` is missing from the first blob read. Mirror getConfig: fall back
   * to the course-stored teacher token so sign-to-voice still resolves after the teacher enables it.
   */
  private async resolveSignToVoiceRequired(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<boolean> {
    const readCfg = async (tok: string) => {
      await this.ensureMigrated(courseId, domainOverride, tok);
      const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, tok);
      return this.loadPromptConfigForAssignment(courseId, assignmentId, domainOverride, tok, blob);
    };
    try {
      let cfg = await readCfg(token);
      if (!cfg) {
        const teacherTok = await this.courseSettings.getCourseStoredCanvasToken(courseId);
        if (teacherTok?.trim() && teacherTok !== token) {
          try {
            cfg = (await readCfg(teacherTok)) ?? null;
            if (cfg) {
              appendLtiLog('sign-to-voice', 'resolveSignToVoiceRequired: loaded config via course-stored teacher token', {
                assignmentId,
              });
            }
          } catch (e) {
            appendLtiLog('sign-to-voice', 'resolveSignToVoiceRequired: teacher token blob read failed', {
              assignmentId,
              error: String(e),
            });
          }
        }
      }
      return cfg?.signToVoiceRequired === true;
    } catch (e) {
      appendLtiLog('sign-to-voice', 'resolveSignToVoiceRequired: read failed', {
        assignmentId,
        error: String(e),
      });
      return false;
    }
  }

  private async rememberResourceLinkAssignmentMapping(
    courseId: string,
    resourceLinkId: string | undefined,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<void> {
    const rid = (resourceLinkId ?? '').trim();
    const aid = (assignmentId ?? '').trim();
    if (!rid || !aid) return;
    const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    const existingMap = blob?.resourceLinkAssignmentMap ?? {};
    if (existingMap[rid] === aid) return;
    const idSet = new Set([
      ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
      ...Object.keys(blob?.configs ?? {}),
    ]);
    idSet.add(aid);
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: blob?.v ?? 1,
      configs: { ...(blob?.configs ?? {}) },
      resourceLinkAssignmentMap: {
        ...existingMap,
        [rid]: aid,
      },
      configuredAssignmentIds: Array.from(idSet).filter((x) => /^\d+$/.test(x)),
      updatedAt: new Date().toISOString(),
    };
    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId,
      domainOverride,
      token,
      blob: payload,
    });
    appendLtiLog('prompt', 'rememberResourceLinkAssignmentMapping: saved', {
      resourceLinkId: rid,
      assignmentId: aid,
    });
  }

  /**
   * Guaranteed fallback: when Canvas performs a real LTI 1.1 launch and both
   * assignmentId/resourceLinkId are present, persist the mapping immediately.
   * Non-fatal by design; launch flow must never break because of mapping writes.
   */
  async rememberResourceLinkAssignmentMappingFromLaunch(ctx: LtiContext): Promise<void> {
    const courseId = (ctx.courseId ?? '').trim();
    const assignmentId = (ctx.assignmentId ?? '').trim();
    const resourceLinkId = (ctx.resourceLinkId ?? '').trim();
    if (!courseId || !assignmentId || !resourceLinkId) {
      // Suppressed: routine when launching from module without assignment id in LTI.
      // appendLtiLog('prompt-decks', 'real launch mapping skipped', { reason: 'missing_required_ids', ... });
      return;
    }

    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      // Suppressed: routine during student launch before token available.
      // appendLtiLog('prompt-decks', 'real launch mapping skipped', { reason: 'no_canvas_token_available', ... });
      return;
    }

    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    try {
      await this.rememberResourceLinkAssignmentMapping(
        courseId,
        resourceLinkId,
        assignmentId,
        domainOverride,
        token,
      );
      appendLtiLog('prompt-decks', 'real launch mapping saved', {
        courseId,
        assignmentId,
        resourceLinkId,
      });
    } catch (err) {
      appendLtiLog('prompt-decks', 'real launch mapping failed (non-fatal)', {
        courseId,
        assignmentId,
        resourceLinkId,
        error: String(err),
      });
    }
  }

  private async saveResourceLinkMappingViaSessionlessForm(
    courseId: string,
    moduleItemId: number,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<void> {
    try {
      const resolved = await this.canvas.resolveResourceLinkIdForModuleItemViaSessionlessForm(
        courseId,
        moduleItemId,
        domainOverride,
        token,
      );
      const resourceLinkId = (resolved.resourceLinkId ?? '').trim();
      if (!resourceLinkId) {
        appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from sessionless form', {
          reason: resolved.reason ?? 'not_found',
          source: resolved.source ?? '(none)',
          attempts: resolved.attempts ?? 0,
          assignmentId,
          moduleItemId,
        });
        return;
      }

      await this.rememberResourceLinkAssignmentMapping(
        courseId,
        resourceLinkId,
        assignmentId,
        domainOverride,
        token,
      );
      appendLtiLog('prompt-decks', 'resourceLink mapping saved via sessionless form', {
        resourceLinkId,
        assignmentId,
        moduleItemId,
        attempts: resolved.attempts ?? 0,
      });
    } catch (err) {
      appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from sessionless form', {
        reason: 'exception',
        error: String(err),
        assignmentId,
        moduleItemId,
      });
    }
  }

  /**
   * Place the assignment in a module and ensure the Prompter external tool row appears above it
   * (mirrors the happy path in putConfig).
   */
  private async ensurePrompterLtiAboveAssignmentInModule(
    ctx: LtiContext,
    args: {
      courseId: string;
      assignmentId: string;
      moduleId: string;
      assignmentDisplayName: string;
      domainOverride: string | undefined;
      token: string;
    },
  ): Promise<void> {
    const { courseId, assignmentId, moduleId, assignmentDisplayName, domainOverride, token } = args;
    const placementAttemptId = this.createPlacementAttemptId();
    const ltiVersion = this.detectLtiVersion(ctx);
    await this.canvas.addAssignmentToModule(courseId, moduleId, assignmentId, domainOverride, token);
    const nameTrim = assignmentDisplayName.trim();
    const linkTitle = nameTrim ? `${nameTrim} — Prompter` : 'ASL Express – Open Prompter (record here)';
    const ensuredTool = await this.canvas.syncPrompterLtiModuleItem(
      courseId,
      moduleId,
      assignmentId,
      domainOverride,
      token,
      {
        linkTitle,
        payloadVariant: 'content_id_only',
      },
    );
    if (!ensuredTool.itemId && ensuredTool.skippedReason && ensuredTool.skippedReason !== 'already_linked') {
      throw new BadRequestException(`Could not add Prompter to the module: ${ensuredTool.skippedReason}`);
    }
    if (ensuredTool.resourceLinkId) {
      try {
        await this.rememberResourceLinkAssignmentMapping(
          courseId,
          ensuredTool.resourceLinkId,
          assignmentId,
          domainOverride,
          token,
        );
      } catch (mapErr) {
        appendLtiLog('prompt', 'ensurePrompterLtiAboveAssignmentInModule: mapping save failed (non-fatal)', {
          assignmentId,
          error: String(mapErr),
        });
      }
    }
    if (ensuredTool.itemId) {
      await this.saveResourceLinkMappingViaSessionlessForm(courseId, ensuredTool.itemId, assignmentId, domainOverride, token);
    }
    appendLtiLog('prompt-import', 'ensurePrompterLtiAboveAssignmentInModule: done', {
      assignmentId,
      moduleId,
      ltiVersion,
      placementAttemptId,
      created: ensuredTool.created,
    });
  }

  private extractAssignmentIdFromLisResult(ctx: LtiContext): string | null {
    const raw = (ctx.lisResultSourcedid ?? '').trim();
    if (!raw) return null;
    const patterns = [
      /assignment[_:=/-](\d{3,})/i,
      /resource_link_(\d{3,})/i,
      /\/assignments\/(\d{3,})(?:\/|$)/i,
      /assignment_id=(\d{3,})/i,
    ];
    for (const re of patterns) {
      const m = raw.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  private extractAssignmentIdFromOutcomeUrl(ctx: LtiContext): string | null {
    const raw = (ctx.lisOutcomeServiceUrl ?? '').trim();
    if (!raw) return null;
    const m = raw.match(/\/assignments\/(\d{3,})(?:\/|$)/i);
    return m?.[1] ?? null;
  }

  private extractAssignmentIdFromExternalUrl(value: string | undefined): string | null {
    const raw = (value ?? '').trim();
    if (!raw) return null;
    try {
      const u = new URL(raw, 'https://example.invalid');
      const aid = (u.searchParams.get('assignment_id') ?? '').trim();
      if (aid) return aid;
    } catch {
      /* fall through */
    }
    const m = raw.match(/assignment_id=(\d{3,})/i);
    return m?.[1] ?? null;
  }

  private async resolveAssignmentIdFromModuleItems(
    ctx: LtiContext,
    token: string,
    domainOverride: string | undefined,
  ): Promise<string | null> {
    const moduleId = (ctx.moduleId ?? '').trim();
    if (!moduleId) return null;
    try {
      const items = await this.canvas.listModuleItems(ctx.courseId, moduleId, domainOverride, token);
      const matches = items
        .filter((i) => (i.type ?? '').toLowerCase() === 'externaltool')
        .map((i) => this.extractAssignmentIdFromExternalUrl(i.external_url))
        .filter((aid): aid is string => !!aid);
      const unique = Array.from(new Set(matches));
      if (unique.length === 1) return unique[0];
      return null;
    } catch (err) {
      appendLtiLog('prompt', 'resolveAssignmentIdFromModuleItems failed', {
        moduleId,
        error: String(err),
      });
      return null;
    }
  }

  private resolveAssignmentIdFromBlob(
    ctx: LtiContext,
    blob: PromptManagerSettingsBlob | null,
  ): {
    assignmentId: string | null;
    source: 'ctx' | 'map' | 'lis_result' | 'outcome_url' | 'module' | 'title' | 'single' | 'single_deck' | 'none';
  } {
    const assignmentIdFromCtx = (ctx.assignmentId ?? '').trim();
    if (assignmentIdFromCtx) return { assignmentId: assignmentIdFromCtx, source: 'ctx' };

    const resourceLinkId = (ctx.resourceLinkId ?? '').trim();
    const assignmentIdFromMap = (blob?.resourceLinkAssignmentMap?.[resourceLinkId] ?? '').trim();
    if (assignmentIdFromMap) return { assignmentId: assignmentIdFromMap, source: 'map' };

    const assignmentIdFromLisResult = this.extractAssignmentIdFromLisResult(ctx);
    if (assignmentIdFromLisResult) return { assignmentId: assignmentIdFromLisResult, source: 'lis_result' };

    const assignmentIdFromOutcomeUrl = this.extractAssignmentIdFromOutcomeUrl(ctx);
    if (assignmentIdFromOutcomeUrl) return { assignmentId: assignmentIdFromOutcomeUrl, source: 'outcome_url' };

    const configs = blob?.configs ?? {};
    const idSet = new Set([
      ...Object.keys(configs).filter((id) => String(id).trim().length > 0),
      ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
    ]);
    const configEntries: Array<[string, PromptConfigJson | undefined]> = Array.from(idSet).map((id) => [
      id,
      configs[id],
    ]);

    const moduleId = (ctx.moduleId ?? '').trim();
    if (moduleId) {
      const moduleMatches = configEntries
        .filter(([, c]) => (c?.moduleId ?? '').trim() === moduleId)
        .map(([id]) => id);
      if (moduleMatches.length === 1) {
        return { assignmentId: moduleMatches[0], source: 'module' };
      }
    }

    const title = (ctx.resourceLinkTitle ?? '').trim();
    const titleMatch = title.match(/^(.+?)\s+(?:—|–|-)\s+Prompter(?:\s*\(.*\))?\s*$/i);
    const assignmentNameHints = [titleMatch?.[1], title]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    for (const assignmentNameHint of assignmentNameHints) {
      const titleMatches = configEntries
        .filter(([, c]) => (c?.assignmentName ?? '').trim() === assignmentNameHint)
        .map(([id]) => id);
      if (titleMatches.length === 1) {
        return { assignmentId: titleMatches[0], source: 'title' };
      }
    }

    if (configEntries.length === 1) {
      return { assignmentId: configEntries[0][0], source: 'single' };
    }

    // Last-resort heuristic: if exactly one deck-mode config exists, prefer it.
    // This helps learner launches that omit assignment/module/title fields.
    const deckOnlyMatches = configEntries
      .filter(([, c]) => (c?.promptMode ?? 'text') === 'decks')
      .map(([id]) => id);
    if (deckOnlyMatches.length === 1) {
      return { assignmentId: deckOnlyMatches[0], source: 'single_deck' };
    }

    return { assignmentId: null, source: 'none' };
  }

  private async resolveAssignmentIdForContext(
    ctx: LtiContext,
    token: string,
    domainOverride: string | undefined,
    blobOverride?: PromptManagerSettingsBlob | null,
  ): Promise<{
    assignmentId: string | null;
    source:
      | 'ctx'
      | 'map'
      | 'lis_result'
      | 'outcome_url'
      | 'module'
      | 'title'
      | 'single'
      | 'single_deck'
      | 'resource_link_api'
      | 'module_item_url'
      | 'none';
  }> {
    const blob =
      blobOverride !== undefined
        ? blobOverride
        : await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const fromBlob = this.resolveAssignmentIdFromBlob(ctx, blob);
    // Blob / map / ctx / module+title heuristics first: they line up with Prompt Manager config + assignment
    // descriptions. Preferring lti_resource_links (below) can override with a *different* assignment and make
    // a rich ASL embed appear "missing" on GET /config. See 0ededa8 revert discussion.
    if (fromBlob.assignmentId) {
      return fromBlob;
    }
    const resourceLinkId = (ctx.resourceLinkId ?? '').trim();
    if (resourceLinkId) {
      const fromResourceLink = await this.canvas.resolveAssignmentIdForResourceLink(
        ctx.courseId,
        resourceLinkId,
        domainOverride,
        token,
      );
      if (fromResourceLink.assignmentId) {
        const assignmentName = await this.canvasAssignmentNameForLog(
          ctx.courseId,
          fromResourceLink.assignmentId,
          domainOverride,
          token,
        );
        appendLtiLog('prompt', 'resolveAssignmentIdForContext: resolved from resource link', {
          resourceLinkId,
          assignmentId: fromResourceLink.assignmentId,
          assignmentName,
          source: fromResourceLink.source ?? '(unknown)',
          matchedField: fromResourceLink.matchedField ?? '(unknown)',
        });
        return { assignmentId: fromResourceLink.assignmentId, source: 'resource_link_api' };
      }
    }
    const fromModuleItems = await this.resolveAssignmentIdFromModuleItems(ctx, token, domainOverride);
    if (fromModuleItems) return { assignmentId: fromModuleItems, source: 'module_item_url' };
    return fromBlob;
  }

  async getConfig(ctx: LtiContext): Promise<PromptConfigJson | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    // Suppressed: noisy repeat — hasToken is obvious from success/failure of getConfig.
    // appendLtiLog('prompt-decks', 'getConfig: token check', { hasToken: !!token });
    if (!token) {
      return null;
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    let resolvedToken = token;
    let blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, resolvedToken);
    let resolved = await this.resolveAssignmentIdForContext(ctx, resolvedToken, domainOverride, blob);
    let assignmentId = resolved.assignmentId ?? '';

    if (!assignmentId) {
      const teacherTok = await this.courseSettings.getCourseStoredCanvasToken(ctx.courseId);
      if (teacherTok?.trim() && teacherTok !== resolvedToken) {
        try {
          const teacherBlob = await this.readPromptManagerSettingsBlob(
            ctx.courseId,
            domainOverride,
            teacherTok,
          );
          const teacherResolved = await this.resolveAssignmentIdForContext(
            ctx,
            teacherTok,
            domainOverride,
            teacherBlob,
          );
          if (teacherResolved.assignmentId) {
            resolvedToken = teacherTok;
            blob = teacherBlob;
            resolved = teacherResolved;
            assignmentId = teacherResolved.assignmentId;
            const assignmentName = await this.canvasAssignmentNameForLog(
              ctx.courseId,
              teacherResolved.assignmentId,
              domainOverride,
              teacherTok,
            );
            appendLtiLog('prompt', 'getConfig: assignment resolution via course-stored token', {
              assignmentId,
              assignmentName,
              source: teacherResolved.source,
            });
          }
        } catch (e) {
          appendLtiLog('prompt', 'getConfig: course-stored token assignment resolution failed (non-fatal)', {
            error: String(e),
          });
        }
      }
    }

    if (assignmentId && resolved.source === 'resource_link_api') {
      await this.rememberResourceLinkAssignmentMapping(
        ctx.courseId,
        ctx.resourceLinkId,
        assignmentId,
        domainOverride,
        resolvedToken,
      );
    }
    let assignmentNameForLog = '(none)';
    if (assignmentId) {
      assignmentNameForLog = await this.canvasAssignmentNameForLog(
        ctx.courseId,
        assignmentId,
        domainOverride,
        resolvedToken,
      );
    }
    const resourceLinkIdTrim = (ctx.resourceLinkId ?? '').trim();
    if (resourceLinkIdTrim && assignmentId && resolved.source !== 'resource_link_api') {
      try {
        const liveRl = await this.canvas.resolveAssignmentIdForResourceLink(
          ctx.courseId,
          resourceLinkIdTrim,
          domainOverride,
          resolvedToken,
        );
        if (liveRl.assignmentId && liveRl.assignmentId !== assignmentId) {
          const liveRlName = await this.canvasAssignmentNameForLog(
            ctx.courseId,
            liveRl.assignmentId,
            domainOverride,
            resolvedToken,
          );
          appendLtiLog('student-prompt-type', 'getConfig: chosen assignmentId differs from Canvas lti_resource_links (blob/heuristic may be stale)', {
            chosenSource: resolved.source,
            chosenAssignmentId: assignmentId,
            chosenAssignmentName: assignmentNameForLog,
            liveResourceLinkAssignmentId: liveRl.assignmentId,
            liveResourceLinkAssignmentName: liveRlName,
            liveResourceLinkSource: liveRl.source ?? '(unknown)',
            resourceLinkId: resourceLinkIdTrim,
            blobUpdatedAt: blob?.updatedAt ?? '(none)',
          });
        }
      } catch (e) {
        appendLtiLog('student-prompt-type', 'getConfig: lti_resource_links cross-check failed (non-fatal)', {
          error: String(e),
        });
      }
    }
    const resolutionUsesCourseBlobHeuristic = ['map', 'module', 'title', 'single', 'single_deck'].includes(
      resolved.source,
    );
    appendLtiLog('prompt', 'getConfig: assignment resolution', {
      source: resolved.source,
      assignmentId: assignmentId || '(none)',
      assignmentName: assignmentNameForLog,
      resolutionUsesCourseBlobHeuristic,
      blobUpdatedAt: blob?.updatedAt ?? '(none)',
      assignmentIdFromCtx: (ctx.assignmentId ?? '').trim() || '(none)',
      assignmentIdFromMap: (blob?.resourceLinkAssignmentMap?.[(ctx.resourceLinkId ?? '').trim()] ?? '').trim() || '(none)',
      assignmentIdFromLisResult: this.extractAssignmentIdFromLisResult(ctx) ?? '(none)',
      assignmentIdFromOutcomeUrl: this.extractAssignmentIdFromOutcomeUrl(ctx) ?? '(none)',
      moduleId: (ctx.moduleId ?? '').trim() || '(none)',
      resourceLinkTitle: (ctx.resourceLinkTitle ?? '').trim() || '(none)',
      lisResultSourcedid: (ctx.lisResultSourcedid ?? '').trim() ? '(present)' : '(none)',
      lisOutcomeServiceUrl: (ctx.lisOutcomeServiceUrl ?? '').trim() ? '(present)' : '(none)',
      configCount: Object.keys(blob?.configs ?? {}).length,
      resourceLinkId: resourceLinkIdTrim || '(none)',
    });
    if (!assignmentId) {
      appendLtiLog('prompt-decks', 'getConfig: no assignment resolved', {
        source: resolved.source,
        resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
        moduleId: (ctx.moduleId ?? '').trim() || '(none)',
        resourceLinkTitle: (ctx.resourceLinkTitle ?? '').trim() || '(none)',
        configCount: Object.keys(blob?.configs ?? {}).length,
      });
      return null;
    }
    let config = await this.loadPromptConfigForAssignment(
      ctx.courseId,
      assignmentId,
      domainOverride,
      resolvedToken,
      blob,
    );

    /**
     * Learners often use session Canvas OAuth. They may be unable to read the Prompt Manager Settings
     * assignment, so the first blob read yields no per-assignment config. Without this, getConfig falls
     * through to Canvas assignment hydration only and returns promptMode "text" with no youtube/decks data.
     */
    if (!config) {
      const teacherTok = await this.courseSettings.getCourseStoredCanvasToken(ctx.courseId);
      if (teacherTok?.trim()) {
        try {
          const teacherBlob = await this.readPromptManagerSettingsBlob(
            ctx.courseId,
            domainOverride,
            teacherTok,
          );
          config = await this.loadPromptConfigForAssignment(
            ctx.courseId,
            assignmentId,
            domainOverride,
            teacherTok,
            teacherBlob,
          );
          if (config) {
            appendLtiLog('prompt', 'getConfig: assignment config from Prompt Manager via course-stored token', {
              assignmentId,
              assignmentName: assignmentNameForLog,
              promptMode: config.promptMode ?? '(unset)',
            });
          }
        } catch (e) {
          appendLtiLog('prompt', 'getConfig: course-stored token Prompt Manager read failed (non-fatal)', {
            assignmentId,
            assignmentName: assignmentNameForLog,
            error: String(e),
          });
        }
      }
    }

    // Missing promptMode: infer from videoPromptConfig / youtubePromptConfig (embed may omit the field).
    // Do not default to 'text' here — that skips the deck block below and breaks student GET /config for deck assignments.
    if (config && !config.promptMode) {
      const inferred = inferPromptModeFromStructuredConfig(config);
      config = { ...config, promptMode: inferred };
      appendLtiLog('student-prompt-type', 'getConfig: inferred promptMode (was absent on loaded config)', {
        assignmentId,
        assignmentName: assignmentNameForLog,
        inferred,
      });
    }
    if (config) {
      const liveModuleId = await this.resolveLiveModuleIdForAssignment(
        ctx.courseId,
        assignmentId,
        domainOverride,
        resolvedToken,
      );
      config = { ...config, moduleId: liveModuleId };
    }
    if (config?.promptMode === 'decks') {
      const rawTotal = Number(config.videoPromptConfig?.totalCards);
      const totalCards = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 10;
      const selectedDecks = Array.isArray(config.videoPromptConfig?.selectedDecks)
        ? config.videoPromptConfig?.selectedDecks
        : [];
      const existingBanks = Array.isArray(config.videoPromptConfig?.storedPromptBanks)
        ? config.videoPromptConfig?.storedPromptBanks
        : [];
      const normalizedBanks = existingBanks
        .map((bank) =>
          Array.isArray(bank)
            ? bank
                .map((p) => ({
                  title: String(p?.title ?? '').trim(),
                  ...(String(p?.videoId ?? '').trim() ? { videoId: String(p?.videoId).trim() } : {}),
                  duration:
                    Number.isFinite(Number(p?.duration)) && Number(p?.duration) > 0
                      ? Number(p?.duration)
                      : DECK_MIN_TOTAL_SECONDS,
                }))
                .filter((p) => p.title)
            : [],
        )
        .filter((bank) => bank.length > 0);
      const existingStatic = Array.isArray(config.videoPromptConfig?.staticFallbackPrompts)
        ? config.videoPromptConfig?.staticFallbackPrompts.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];
      config = {
        ...config,
        videoPromptConfig: {
          selectedDecks,
          totalCards,
          ...(normalizedBanks.length > 0 ? { storedPromptBanks: normalizedBanks } : {}),
          ...(existingStatic.length > 0 ? { staticFallbackPrompts: existingStatic } : {}),
        },
      };

      // Self-heal older deck configs that predate stored fallback fields.
      // This keeps learner prompt display resilient when live deck build fails.
      if (selectedDecks.length > 0 && normalizedBanks.length === 0 && existingStatic.length === 0) {
        try {
          appendLtiLog('prompt-decks', 'getConfig: generating missing fallback banks for legacy deck config', {
            assignmentId,
            assignmentName: assignmentNameForLog,
            selectedDeckCount: selectedDecks.length,
            totalCards,
          });
          const banks = await this.generateStoredDeckPromptBanks(selectedDecks, totalCards, 2);
          const staticFallbackPrompts = (banks[0] ?? []).map((p) => p.title).filter(Boolean);
          if (banks.length > 0 || staticFallbackPrompts.length > 0) {
            const updatedCfg: PromptConfigJson = {
              ...config,
              promptMode: 'decks',
              videoPromptConfig: {
                selectedDecks,
                totalCards,
                ...(banks.length > 0 ? { storedPromptBanks: banks } : {}),
                ...(staticFallbackPrompts.length > 0 ? { staticFallbackPrompts } : {}),
              },
            };
            let vis = (typeof config.instructions === 'string' ? config.instructions : '').trim();
            if (!vis) {
              const a = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
              if (a?.description && String(a.description).trim()) {
                vis = parseAssignmentDescriptionForPromptManager(a.description).visibleHtml;
              }
            }
            const fullD = mergeAssignmentDescriptionWithEmbeds(vis, updatedCfg, updatedCfg.prompts);
            await this.canvas.updateAssignment(
              ctx.courseId,
              assignmentId,
              { description: fullD },
              domainOverride,
              token,
            );
            config = {
              ...config,
              videoPromptConfig: {
                selectedDecks,
                totalCards,
                ...(banks.length > 0 ? { storedPromptBanks: banks } : {}),
                ...(staticFallbackPrompts.length > 0 ? { staticFallbackPrompts } : {}),
              },
            };
            appendLtiLog('prompt-decks', 'getConfig: persisted fallback banks for legacy deck config', {
              assignmentId,
              assignmentName: assignmentNameForLog,
              bankCount: banks.length,
              staticFallbackCount: staticFallbackPrompts.length,
            });
          }
        } catch (err) {
          appendLtiLog('prompt-decks', 'getConfig: failed to backfill fallback banks (non-fatal)', {
            assignmentId,
            assignmentName: assignmentNameForLog,
            error: String(err),
          });
        }
      }
    }
    appendLtiLog('prompt-decks', 'getConfig: deck mode snapshot', {
      assignmentId,
      assignmentName: assignmentNameForLog,
      promptMode: config?.promptMode ?? '(none)',
      selectedDeckCount: config?.videoPromptConfig?.selectedDecks?.length ?? 0,
      hasStoredBanks: Array.isArray(config?.videoPromptConfig?.storedPromptBanks),
      storedBankCount: config?.videoPromptConfig?.storedPromptBanks?.length ?? 0,
      staticFallbackCount: config?.videoPromptConfig?.staticFallbackPrompts?.length ?? 0,
    });

    if (config?.promptMode === 'youtube' && config.youtubePromptConfig) {
      const y = config.youtubePromptConfig as {
        videoId?: string;
        label?: string;
        clipStartSec?: number;
        clipEndSec?: number;
        durationSec?: number;
      };
      let clipStartSec = Math.floor(Number(y.clipStartSec));
      if (!Number.isFinite(clipStartSec) || clipStartSec < 0) clipStartSec = 0;
      let clipEndSec = Math.floor(Number(y.clipEndSec));
      if (!Number.isFinite(clipEndSec) || clipEndSec <= clipStartSec) {
        const legacy = Math.floor(Number(y.durationSec));
        if (Number.isFinite(legacy) && legacy >= 1) {
          clipEndSec = clipStartSec + legacy;
        } else {
          clipEndSec = clipStartSec + 60;
        }
      }
      const vid = String(y.videoId ?? '').trim();
      if (vid) {
        const yExt = y as {
          label?: string;
          allowStudentCaptions?: boolean;
          subtitleMask?: { enabled?: boolean; heightPercent?: number };
        };
        let heightPercent = Math.floor(Number(yExt.subtitleMask?.heightPercent));
        if (!Number.isFinite(heightPercent)) heightPercent = 15;
        heightPercent = Math.min(30, Math.max(5, heightPercent));
        const subtitleMask = {
          enabled: !!yExt.subtitleMask?.enabled,
          heightPercent,
        };
        config = {
          ...config,
          youtubePromptConfig: {
            videoId: vid,
            clipStartSec,
            clipEndSec,
            allowStudentCaptions: yExt.allowStudentCaptions === true,
            subtitleMask,
            ...(y.label != null && String(y.label).trim() ? { label: String(y.label).trim() } : {}),
          },
        };
      }
    }

    // Hydrate key assignment-backed fields directly from Canvas so UI reflects current assignment state.
    // Keep blob values as fallback when Canvas read is unavailable.
    try {
      const { assignment } = await this.getAssignmentForImportHydration(
        ctx,
        assignmentId,
        domainOverride,
        token,
      );
      if (assignment) {
        const canvasRid = (assignment.linkedRubricId ?? '').trim();
        const configRid =
          config?.rubricId != null && String(config.rubricId).trim() ? String(config.rubricId).trim() : '';
        // Prefer Canvas (current link); fall back to description embed (e.g. numeric id sanitized, or if Canvas payload omitted rubric).
        const effectiveRubricId = canvasRid || configRid;
        const hydrated: PromptConfigJson = {
          ...(config ?? { minutes: 5, prompts: [], accessCode: '' }),
          ...(assignment.name ? { assignmentName: String(assignment.name) } : {}),
          ...(assignment.assignment_group_id != null ? { assignmentGroupId: String(assignment.assignment_group_id) } : {}),
          ...(assignment.points_possible != null
            ? { pointsPossible: Math.max(0, Math.round(Number(assignment.points_possible) || 0)) }
            : {}),
          ...(assignment.allowed_attempts != null
            ? { allowedAttempts: Number(assignment.allowed_attempts) }
            : config?.allowedAttempts == null
              ? { allowedAttempts: 1 }
              : {}),
          // Surface Canvas-attached rubric id; embed fallback when GET omits rubric (see also sanitize numeric rubricId).
          ...(effectiveRubricId ? { rubricId: effectiveRubricId } : {}),
        };
        if (!hydrated.promptMode) {
          hydrated.promptMode = inferPromptModeFromStructuredConfig(hydrated);
        }
        return { ...hydrated, resolvedAssignmentId: assignmentId };
      }
    } catch {
      /* non-fatal: fall through to blob-only config */
    }

    return config ? { ...config, resolvedAssignmentId: assignmentId } : null;
  }

  async putConfig(ctx: LtiContext, dto: PutPromptConfigDto): Promise<void> {
    const assignmentId = ctx.assignmentId?.trim();
    if (!assignmentId) {
      throw new Error('Assignment ID required. In course_navigation, pass assignmentId as query parameter.');
    }
    appendLtiLog('prompt', 'putConfig: start', {
      assignmentId,
      moduleId: dto.moduleId ?? '(none)',
      assignmentGroupId: dto.assignmentGroupId ?? '(none)',
      promptMode: dto.promptMode ?? '(unset)',
      minutes: dto.minutes ?? '(unset)',
      promptsCount: Array.isArray(dto.prompts) ? dto.prompts.length : '(unset)',
    });
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    appendLtiLog('prompt', 'putConfig: token/domain resolved', {
      assignmentId,
      hasToken: !!token,
      domainOverride: domainOverride ?? '(none)',
    });

    appendLtiLog('prompt', 'putConfig: dto from dropdown', {
      assignmentGroupId: dto.assignmentGroupId,
      newGroupName: dto.newGroupName?.trim() || '(empty)',
    });

    // Handle creating a new assignment group if requested (matches PHP flow)
    let effectiveGroupId = dto.assignmentGroupId;
    if (dto.assignmentGroupId === '__new__' && dto.newGroupName?.trim()) {
      const newGroupName = dto.newGroupName.trim();
      appendLtiLog('prompt', 'create-group', {
        action: 'create-group',
        nameReceived: newGroupName,
        nameBeingSent: newGroupName,
      });
      const newGroup = await this.canvas.createAssignmentGroup(
        ctx.courseId,
        newGroupName,
        domainOverride,
        token,
      );
      effectiveGroupId = String(newGroup.id);
      appendLtiLog('prompt', 'assignment group created', { name: newGroup.name, id: newGroup.id });
    } else if (dto.assignmentGroupId === '__new__') {
      throw new Error('Assignment Group is required. Please select a group or create a new one with a valid name.');
    }

    appendLtiLog('prompt', 'putConfig: effectiveGroupId for assignment placement', {
      effectiveGroupId,
      source: dto.assignmentGroupId === '__new__' ? 'newly_created' : 'from_dropdown',
    });

    const existing = await this.getConfig(ctx);
    const rawDeckTotal = Number(dto.videoPromptConfig?.totalCards);
    const normalizedDeckTotal =
      Number.isFinite(rawDeckTotal) && rawDeckTotal > 0 ? Math.floor(rawDeckTotal) : 10;
    const base: PromptConfigJson = existing ?? { minutes: 5, prompts: [], accessCode: '' };
    const existingDeckConfig = base.videoPromptConfig;
    const merged: PromptConfigJson = {
      ...base,
      ...(dto.minutes != null && { minutes: dto.minutes }),
      ...(dto.prompts != null && { prompts: dto.prompts }),
      ...(dto.accessCode !== undefined && { accessCode: dto.accessCode }),
      ...(dto.assignmentName !== undefined && { assignmentName: dto.assignmentName }),
      ...(effectiveGroupId !== undefined && { assignmentGroupId: effectiveGroupId }),
      ...(dto.moduleId !== undefined && { moduleId: dto.moduleId }),
      ...(dto.pointsPossible !== undefined && {
        pointsPossible: Math.max(0, Math.round(Number(dto.pointsPossible) || 0)),
      }),
      ...(dto.rubricId !== undefined && { rubricId: dto.rubricId }),
      ...(dto.instructions !== undefined && { instructions: dto.instructions }),
      ...(dto.dueAt !== undefined && { dueAt: dto.dueAt }),
      ...(dto.unlockAt !== undefined && { unlockAt: dto.unlockAt }),
      ...(dto.lockAt !== undefined && { lockAt: dto.lockAt }),
      ...(dto.allowedAttempts !== undefined && { allowedAttempts: dto.allowedAttempts }),
      ...(dto.version !== undefined && { version: dto.version }),
      ...(dto.signToVoiceRequired !== undefined && { signToVoiceRequired: dto.signToVoiceRequired === true }),
      // NEW: Deck-based prompt configuration
      ...(dto.promptMode !== undefined && { promptMode: dto.promptMode }),
      ...(dto.videoPromptConfig !== undefined && {
        videoPromptConfig: dto.videoPromptConfig.selectedDecks
          ? {
              selectedDecks: dto.videoPromptConfig.selectedDecks.map(d => ({
                id: d.id ?? '',
                title: d.title ?? '',
              })),
              // Guard against legacy/invalid values that caused empty prompt lists.
              totalCards: normalizedDeckTotal,
              ...(Array.isArray(dto.videoPromptConfig.storedPromptBanks)
                ? { storedPromptBanks: dto.videoPromptConfig.storedPromptBanks as Array<Array<{ title: string; videoId?: string; duration: number }>> }
                : Array.isArray(existingDeckConfig?.storedPromptBanks)
                  ? { storedPromptBanks: existingDeckConfig.storedPromptBanks }
                  : {}),
              ...(Array.isArray(dto.videoPromptConfig.staticFallbackPrompts)
                ? {
                    staticFallbackPrompts: dto.videoPromptConfig.staticFallbackPrompts
                      .map((s) => String(s ?? '').trim())
                      .filter(Boolean),
                  }
                : Array.isArray(existingDeckConfig?.staticFallbackPrompts)
                  ? { staticFallbackPrompts: existingDeckConfig.staticFallbackPrompts }
                  : {}),
            }
          : undefined,
      }),
    };

    const mode = merged.promptMode ?? 'text';
    if (mode === 'youtube') {
      const y = dto.youtubePromptConfig;
      if (!y) {
        throw new BadRequestException('youtubePromptConfig is required when promptMode is youtube.');
      }
      const rawInput = String(y.urlOrId ?? y.videoId ?? '').trim();
      if (!rawInput) {
        throw new BadRequestException('YouTube URL or video ID is required.');
      }
      const videoId = normalizeYoutubeInputToVideoId(rawInput);
      let clipStartSec = Math.floor(Number(y.clipStartSec));
      if (!Number.isFinite(clipStartSec) || clipStartSec < 0) {
        clipStartSec = 0;
      }
      let clipEndSec = Math.floor(Number(y.clipEndSec));
      if (!Number.isFinite(clipEndSec)) {
        const legacyDur = Math.floor(Number(y.durationSec));
        if (Number.isFinite(legacyDur) && legacyDur >= 1) {
          clipEndSec = clipStartSec + legacyDur;
        } else {
          clipEndSec = NaN;
        }
      }
      if (!Number.isFinite(clipEndSec) || clipEndSec <= clipStartSec) {
        throw new BadRequestException(
          'YouTube clip end must be greater than clip start by at least 1 second (or send legacy durationSec).',
        );
      }
      const maxSpan = 86400;
      if (clipEndSec - clipStartSec > maxSpan) {
        throw new BadRequestException('YouTube clip window must be at most 24 hours.');
      }
      let maskHp = Math.floor(Number(y.subtitleMask?.heightPercent));
      if (!Number.isFinite(maskHp)) maskHp = 15;
      maskHp = Math.min(30, Math.max(5, maskHp));
      const subtitleMask = {
        enabled: !!y.subtitleMask?.enabled,
        heightPercent: maskHp,
      };
      merged.youtubePromptConfig = {
        videoId,
        clipStartSec,
        clipEndSec,
        allowStudentCaptions: y.allowStudentCaptions === true,
        subtitleMask,
        ...(y.label != null && String(y.label).trim() ? { label: String(y.label).trim() } : {}),
      };
      delete (merged as { videoPromptConfig?: unknown }).videoPromptConfig;
    } else {
      delete (merged as { youtubePromptConfig?: unknown }).youtubePromptConfig;
      if (mode === 'text') {
        delete (merged as { videoPromptConfig?: unknown }).videoPromptConfig;
      }
    }

    if (merged.promptMode === 'decks' && merged.videoPromptConfig?.selectedDecks?.length) {
      const selectedDecks = merged.videoPromptConfig.selectedDecks;
      const totalCards = merged.videoPromptConfig.totalCards ?? normalizedDeckTotal;
      appendLtiLog('prompt-decks', 'putConfig: generating stored prompt banks', {
        assignmentId,
        deckCount: selectedDecks.length,
        totalCards,
      });
      try {
        const banks = await this.generateStoredDeckPromptBanks(selectedDecks, totalCards, 3);
        const staticFallbackPrompts = (banks[0] ?? []).map((p) => p.title).filter(Boolean);
        merged.videoPromptConfig = {
          ...merged.videoPromptConfig,
          storedPromptBanks: banks,
          staticFallbackPrompts,
        };
        appendLtiLog('prompt-decks', 'putConfig: stored prompt banks generated', {
          assignmentId,
          bankCount: banks.length,
          firstBankPromptCount: banks[0]?.length ?? 0,
          staticFallbackCount: staticFallbackPrompts.length,
        });
      } catch (bankErr) {
        appendLtiLog('prompt-decks', 'putConfig: stored prompt bank generation failed (non-fatal)', {
          assignmentId,
          error: String(bankErr),
        });
      }
    }

    let blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const blobRichness = (b: PromptManagerSettingsBlob | null) =>
      Object.keys(b?.configs ?? {}).length +
      (Array.isArray(b?.configuredAssignmentIds) ? b.configuredAssignmentIds.length : 0);
    const initialRich = blobRichness(blob);
    if (!blob || initialRich === 0) {
      const teacherTok = await this.courseSettings.getCourseStoredCanvasToken(ctx.courseId);
      if (teacherTok?.trim() && teacherTok !== token) {
        try {
          const alt = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, teacherTok);
          if (alt && blobRichness(alt) > initialRich) {
            blob = alt;
            appendLtiLog('prompt', 'putConfig: merged against Prompt Manager blob from course-stored teacher token', {
              assignmentId,
              priorRich: initialRich,
              altRich: blobRichness(alt),
            });
          }
        } catch (e) {
          appendLtiLog('prompt', 'putConfig: course-stored teacher token blob read failed (non-fatal)', {
            assignmentId,
            error: String(e),
          });
        }
      }
    }
    const idSet = new Set<string>([
      ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
      ...Object.keys(blob?.configs ?? {}),
    ]);
    idSet.add(assignmentId);
    // Thin course index: per-assignment data lives in assignment `description` embeds, not in `configs`.
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs: {},
      configuredAssignmentIds: Array.from(idSet).filter((x) => /^\d+$/.test(x)),
      updatedAt: new Date().toISOString(),
    };
    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId: ctx.courseId,
      domainOverride,
      token,
      blob: payload,
    });
    appendLtiLog('sign-to-voice', 'config: Prompt Manager blob saved', {
      assignmentId,
      signToVoiceRequired: merged.signToVoiceRequired === true,
      promptMode: merged.promptMode ?? '(unset)',
    });

    const moduleId = merged.moduleId?.trim();
    if (moduleId) {
      const placementAttemptId = this.createPlacementAttemptId();
      const ltiVersion = this.detectLtiVersion(ctx);
      const assignAnchorSpike = ['1', 'true', 'yes', 'on'].includes(
        (
          this.config.get<string>('ASSIGN_ANCHOR_SPIKE') ??
          process.env.ASSIGN_ANCHOR_SPIKE ??
          ''
        )
          .trim()
          .toLowerCase(),
      );

      this.placementMarker({
        placementAttemptId,
        ltiVersion,
        path: 'assignment_anchor',
        marker: 'ltiVersionDetected',
        outcome: 'ok',
        assignmentId,
        moduleId,
        reason: ltiVersion,
      });
      if (ltiVersion === 'unknown') {
        this.placementMarker({
          placementAttemptId,
          ltiVersion,
          path: 'assignment_anchor',
          marker: 'ltiVersionUnknown',
          outcome: 'warn',
          assignmentId,
          moduleId,
          reason: 'routing_as_11_conservative',
        });
      }
      this.placementMarker({
        placementAttemptId,
        ltiVersion,
        path: 'assignment_anchor',
        marker: 'pathSelected',
        outcome: 'ok',
        assignmentId,
        moduleId,
      });

      try {
        const assignmentSync = await this.canvas.addAssignmentToModule(
          ctx.courseId,
          moduleId,
          assignmentId,
          domainOverride,
          token,
        );
        this.placementMarker({
          placementAttemptId,
          ltiVersion,
          path: 'assignment_anchor',
          marker: 'assignmentAnchorLaunchOk',
          outcome: 'ok',
          assignmentId,
          moduleId,
          reason: assignmentSync.created ? 'assignment_module_item_created' : 'assignment_module_item_already_present',
        });
        try {
          const nameTrim = (merged.assignmentName ?? '').trim();
          const linkTitle = nameTrim ? `${nameTrim} — Prompter` : 'ASL Express – Open Prompter (record here)';
          const ensuredTool = await this.canvas.syncPrompterLtiModuleItem(
            ctx.courseId,
            moduleId,
            assignmentId,
            domainOverride,
            token,
            {
              linkTitle,
              payloadVariant: 'content_id_only',
            },
          );
          if (ensuredTool.resourceLinkId) {
            try {
              await this.rememberResourceLinkAssignmentMapping(
                ctx.courseId,
                ensuredTool.resourceLinkId,
                assignmentId,
                domainOverride,
                token,
              );
            } catch (mapErr) {
              appendLtiLog('prompt', 'externalToolEnsure: mapping save failed (non-fatal)', {
                assignmentId,
                resourceLinkId: ensuredTool.resourceLinkId,
                error: String(mapErr),
              });
            }
          }
          if (ensuredTool.itemId) {
            await this.saveResourceLinkMappingViaSessionlessForm(
              ctx.courseId,
              ensuredTool.itemId,
              assignmentId,
              domainOverride,
              token,
            );
          } else {
            appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from sessionless form', {
              reason: 'missing_moduleItemId_after_externalToolEnsure',
              assignmentId,
            });
          }
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'assignment_anchor',
            marker: 'externalToolEnsure',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: ensuredTool.created
              ? `external_tool_module_item_created;moduleItemId=${ensuredTool.itemId ?? 'none'}`
              : `external_tool_module_item_present;moduleItemId=${ensuredTool.itemId ?? 'none'};state=${ensuredTool.skippedReason ?? 'ok'}`,
          });
        } catch (toolEnsureErr) {
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'assignment_anchor',
            marker: 'externalToolEnsure',
            outcome: 'warn',
            assignmentId,
            moduleId,
            reason: String(toolEnsureErr),
          });
        }

        if (assignAnchorSpike) {
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'assignment_anchor',
            marker: 'placementTerminal',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: 'assignment_anchor_spike_enabled',
          });
        } else {
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'assignment_anchor',
            marker: 'placementTerminal',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: 'assignment_anchor_primary',
          });
        }
      } catch (assignmentErr) {
        const canvasResponseCode = this.toCanvasResponseCode(assignmentErr);
        this.placementMarker({
          placementAttemptId,
          ltiVersion,
          path: 'assignment_anchor',
          marker: 'assignmentAnchorLaunchFail',
          outcome: 'fail',
          assignmentId,
          moduleId,
          reason: String(assignmentErr),
          canvasResponseCode,
        });

        if (ltiVersion === '1.3') {
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'template_clone_11',
            marker: 'templateCloneBlockedFor13',
            outcome: 'skip',
            assignmentId,
            moduleId,
            reason: 'template_clone_11_is_11_only',
          });
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'deep_link_13',
            marker: 'pathSelected',
            outcome: 'ok',
            assignmentId,
            moduleId,
          });
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'deep_link_13',
            marker: 'deepLink13NotImplemented',
            outcome: 'skip',
            assignmentId,
            moduleId,
            reason: 'deep_link_13_step_not_implemented',
          });
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'manual_hybrid',
            marker: 'placementTerminal',
            outcome: 'fail',
            assignmentId,
            moduleId,
            reason: 'assignment_anchor_failed_and_deep_link_13_unavailable',
            canvasResponseCode,
          });
          throw assignmentErr;
        }

        this.placementMarker({
          placementAttemptId,
          ltiVersion,
          path: 'template_clone_11',
          marker: 'pathSelected',
          outcome: 'ok',
          assignmentId,
          moduleId,
        });
        try {
          const nameTrim = (merged.assignmentName ?? '').trim();
          const linkTitle = nameTrim ? `${nameTrim} — Prompter` : 'ASL Express – Open Prompter (record here)';
          const ltiSync = await this.canvas.syncPrompterLtiModuleItem(
            ctx.courseId,
            moduleId,
            assignmentId,
            domainOverride,
            token,
            { linkTitle },
          );
          if (ltiSync.resourceLinkId) {
            try {
              await this.rememberResourceLinkAssignmentMapping(
                ctx.courseId,
                ltiSync.resourceLinkId,
                assignmentId,
                domainOverride,
                token,
              );
            } catch (mapErr) {
              appendLtiLog('prompt', 'templateClone11: mapping save failed (non-fatal)', {
                assignmentId,
                resourceLinkId: ltiSync.resourceLinkId,
                error: String(mapErr),
              });
            }
          }
          if (ltiSync.itemId) {
            await this.saveResourceLinkMappingViaSessionlessForm(
              ctx.courseId,
              ltiSync.itemId,
              assignmentId,
              domainOverride,
              token,
            );
          } else {
            appendLtiLog('prompt-decks', 'resourceLink mapping skipped: no resourceLinkId from sessionless form', {
              reason: 'missing_moduleItemId_after_templateClone11',
              assignmentId,
            });
          }
          if (ltiSync.skippedReason && ltiSync.skippedReason !== 'already_linked') {
            throw new Error(`Prompter LTI module item sync skipped: ${ltiSync.skippedReason}`);
          }
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'template_clone_11',
            marker: 'templateClone11Result',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: ltiSync.created ? 'external_tool_module_item_created' : 'external_tool_module_item_already_present',
          });
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'template_clone_11',
            marker: 'placementTerminal',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: 'template_clone_11_success',
          });
        } catch (cloneErr) {
          const cloneResponseCode = this.toCanvasResponseCode(cloneErr);
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'template_clone_11',
            marker: 'templateClone11Result',
            outcome: 'fail',
            assignmentId,
            moduleId,
            reason: String(cloneErr),
            canvasResponseCode: cloneResponseCode,
          });
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'manual_hybrid',
            marker: 'placementTerminal',
            outcome: 'fail',
            assignmentId,
            moduleId,
            reason: 'assignment_anchor_failed_and_template_clone_11_failed',
            canvasResponseCode: cloneResponseCode,
          });
          throw cloneErr;
        }
      }
    }

    // Update assignment in Canvas (name, description/instructions, points, dates, group, etc. — matches PHP)
    const agId = merged.assignmentGroupId?.trim();
    const rubricId = merged.rubricId?.trim();
    const assignmentName = (merged.assignmentName ?? '').trim() || undefined;
    const instructions = merged.instructions ?? '';
    const pointsPossible = Math.max(0, Math.round(Number(merged.pointsPossible ?? 100) || 100));
    const rawDueAt = merged.dueAt?.trim() || undefined;
    const rawUnlockAt = merged.unlockAt?.trim() || undefined;
    const rawLockAt = merged.lockAt?.trim() || undefined;
    const dueAt = toCanvasIso8601(rawDueAt);
    const unlockAt = toCanvasIso8601(rawUnlockAt);
    const lockAt = toCanvasIso8601(rawLockAt);
    const allowedAttemptsRaw = merged.allowedAttempts ?? 1;
    const allowedAttempts = Number.isFinite(Number(allowedAttemptsRaw))
      ? Math.round(Number(allowedAttemptsRaw)) === -1
        ? -1
        : Math.max(1, Math.round(Number(allowedAttemptsRaw)))
      : 1;
    const hasAssignmentUpdates = Boolean(
      agId ||
        assignmentName ||
        instructions !== '' ||
        pointsPossible !== 100 ||
        dueAt ||
        unlockAt ||
        lockAt ||
        allowedAttempts !== 1,
    );

    if (rawDueAt || dueAt) {
      appendLtiLog('prompt', 'update-due-at', {
        action: 'update-due-at',
        rawDueAt: rawDueAt ?? '(none)',
        formattedDueAt: dueAt ?? '(conversion failed or empty)',
      });
    }
    appendLtiLog('prompt', 'putConfig: updating assignment in Canvas', {
      assignmentId,
      assignmentGroupId: agId || '(none)',
      hasAssignmentUpdates,
    });
    {
      const fullDescription = mergeAssignmentDescriptionWithEmbeds(instructions, merged, merged.prompts);
      try {
        await this.canvas.updateAssignment(
          ctx.courseId,
          assignmentId,
          {
            ...(agId && { assignmentGroupId: agId }),
            ...(assignmentName && { name: assignmentName }),
            description: fullDescription,
            ...(hasAssignmentUpdates
              ? {
                  pointsPossible,
                  ...(dueAt && { dueAt }),
                  ...(unlockAt && { unlockAt }),
                  ...(lockAt && { lockAt }),
                  allowedAttempts,
                }
              : {}),
          },
          domainOverride,
          token,
        );
        if (rubricId) {
          await this.canvas.associateRubricWithAssignment(
            ctx.courseId,
            assignmentId,
            rubricId,
            domainOverride,
            token,
          );
        }
      } catch (agErr) {
        appendLtiLog('prompt', 'assignment group or rubric update failed', {
          assignmentId,
          error: agErr instanceof Error ? agErr.message : String(agErr),
        });
        throw agErr;
      }
    }
    appendLtiLog('prompt', 'putConfig: complete', {
      assignmentId,
      moduleId: merged.moduleId ?? '(none)',
      hasAssignmentUpdates,
      hadRubricUpdate: !!rubricId,
    });
  }

  /**
   * Build the prompt list for a deck-based prompt session.
   * Implements the round-robin selection algorithm with deduplication.
   */
  async buildDeckPromptList(
    selectedDecks: Array<{ id: string; title: string }>,
    totalCards: number,
  ): Promise<{
    prompts: Array<{ title: string; videoId?: string; securityToken?: string; duration: number }>;
    warning?: string;
  }> {
    // Suppressed: noisy on every deck build — controller logs request/result when needed.
    // appendLtiLog('prompt-decks', 'buildDeckPromptList start', { selectedDeckCount:..., totalCards });
    if (!selectedDecks || selectedDecks.length === 0) {
      return { prompts: [], warning: 'No decks selected' };
    }

    // Step 1: Fetch all cards from each deck (Sprout list includes duration; also persisted in DB on sync)
    const deckCards = new Map<
      string,
      Array<{ id: string; title: string; durationSeconds: number | null; securityToken: string | null }>
    >();
    for (const deck of selectedDecks) {
      try {
        const deduped = await this.getDeckCardsWithCache(deck.id);
        // Step 3: Shuffle each deck randomly
        for (let i = deduped.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [deduped[i], deduped[j]] = [deduped[j], deduped[i]];
        }
        deckCards.set(deck.id, deduped);
      } catch (err) {
        appendLtiLog('prompt-decks', `Failed to fetch deck ${deck.id}`, { error: String(err) });
        deckCards.set(deck.id, []);
      }
    }

    const requestedTotal = Number(totalCards);
    const totalToSelect =
      Number.isFinite(requestedTotal) && requestedTotal > 0 ? Math.floor(requestedTotal) : 10;

    // Step 4: Round-robin selection across decks
    const selected: Array<{
      title: string;
      videoId?: string;
      securityToken?: string;
      durationSeconds?: number | null;
    }> = [];
    const usedTitles = new Set<string>();
    const deckIndices = new Map<string, number>(); // Track current position in each deck
    selectedDecks.forEach(d => deckIndices.set(d.id, 0));

    let deckRound = 0;
    while (selected.length < totalToSelect) {
      let addedThisRound = false;
      for (const deck of selectedDecks) {
        if (selected.length >= totalToSelect) break;

        const cards = deckCards.get(deck.id) ?? [];
        let idx = deckIndices.get(deck.id) ?? 0;

        // Step 5: Skip duplicates - if title already in selected, take next from same deck
        while (idx < cards.length) {
          const card = cards[idx];
          const key = card.title.toLowerCase().trim();
          if (!usedTitles.has(key)) {
            const sec = (card.securityToken ?? '').trim();
            selected.push({
              title: card.title,
              videoId: card.id,
              ...(sec ? { securityToken: sec } : {}),
              durationSeconds: card.durationSeconds ?? null,
            });
            usedTitles.add(key);
            idx++;
            addedThisRound = true;
            break;
          }
          idx++; // Skip duplicate
        }

        deckIndices.set(deck.id, idx);
      }

      // Step 6b: If no cards added this round, all decks are exhausted
      if (!addedThisRound) break;
      deckRound++;
    }

    // Step 7: Warning if can't reach totalCards
    let warning: string | undefined;
    if (selected.length < totalToSelect) {
      warning = `Only ${selected.length} unique words available across selected decks — showing ${selected.length} instead of ${totalToSelect}.`;
    }

    // Step 8: Final shuffle of selected prompts
    for (let i = selected.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }

    // Timing: playlist response + batched video API + DB cache (sprout_playlist_videos.duration_seconds)
    const needsLookupIds = selected
      .filter(
        (s) =>
          s.videoId &&
          (s.durationSeconds == null ||
            !Number.isFinite(s.durationSeconds) ||
            s.durationSeconds <= 0),
      )
      .map((s) => s.videoId!);
    const fromApi = await this.sproutVideo.getVideoDurations(needsLookupIds);
    const fromDb = await this.loadVideoDurationsFromDb(needsLookupIds);

    const resolveVideoSeconds = (s: {
      videoId?: string;
      durationSeconds?: number | null;
    }): number | null => {
      if (
        typeof s.durationSeconds === 'number' &&
        Number.isFinite(s.durationSeconds) &&
        s.durationSeconds > 0
      ) {
        return s.durationSeconds;
      }
      if (s.videoId) {
        const a = fromApi.get(s.videoId);
        if (typeof a === 'number' && Number.isFinite(a) && a > 0) return a;
        const d = fromDb.get(s.videoId);
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
      }
      return null;
    };

    const prompts = selected.map((s) => ({
      title: s.title,
      videoId: s.videoId,
      ...(s.securityToken?.trim() ? { securityToken: s.securityToken.trim() } : {}),
      duration: this.deckCardTotalSeconds(resolveVideoSeconds(s)),
    }));

    const promptsMissingVideoId = prompts.filter((p) => !(p.videoId ?? '').trim()).length;
    if (promptsMissingVideoId > 0) {
      appendLtiLog('prompt-decks', 'buildDeckPromptList: prompts without Sprout videoId', {
        missingCount: promptsMissingVideoId,
        total: prompts.length,
      });
    }

    return { prompts, warning };
  }

  private async generateStoredDeckPromptBanks(
    selectedDecks: Array<{ id: string; title: string }>,
    totalCards: number,
    bankCount: number,
  ): Promise<Array<Array<{ title: string; videoId?: string; duration: number }>>> {
    const targetBanks = Math.max(1, Math.floor(bankCount));
    const banks: Array<Array<{ title: string; videoId?: string; duration: number }>> = [];
    for (let i = 0; i < targetBanks; i++) {
      const built = await this.buildDeckPromptList(selectedDecks, totalCards);
      if (Array.isArray(built.prompts) && built.prompts.length > 0) {
        banks.push(built.prompts);
      }
    }
    return banks;
  }

  async verifyAccess(
    ctx: LtiContext,
    accessCode: string,
    _fingerprint: string,
  ): Promise<{ success: boolean; blocked?: boolean; attemptCount?: number }> {
    /* Config (including accessCode) from assignment description only - same pattern as flashcards. No DB. */
    const config = await this.getConfig(ctx);
    const expected = (config?.accessCode ?? '').trim().toUpperCase();
    const given = (accessCode ?? '').trim().toUpperCase();

    if (expected && given !== expected) {
      return { success: false };
    }

    return { success: true };
  }

  async savePrompt(ctx: LtiContext, promptText: string): Promise<void> {
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    await this.promptDataRepo.saveAssignmentPrompt({
      courseId: ctx.courseId,
      assignmentId,
      userId: ctx.userId,
      resourceLinkId: ctx.resourceLinkId,
      promptText,
    });
  }

  /**
   * Normalize deck timeline for Canvas submission body / JSON comments.
   * Preserves optional Sprout `videoId` per row when present (non-empty string).
   */
  private sanitizeDeckTimelineInput(
    deckTimeline:
      | Array<{ title?: unknown; startSec?: unknown; videoId?: unknown; securityToken?: unknown }>
      | undefined,
  ): Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }> | undefined {
    if (!Array.isArray(deckTimeline) || deckTimeline.length === 0) return undefined;
    const rows = deckTimeline
      .map((e) => {
        const title = String(e?.title ?? '');
        const startSec = Number(e?.startSec);
        const vidRaw = (e as { videoId?: unknown }).videoId;
        const videoId =
          vidRaw != null && String(vidRaw).trim().length > 0 ? String(vidRaw).trim() : undefined;
        const stRaw = (e as { securityToken?: unknown }).securityToken;
        const securityToken =
          stRaw != null && String(stRaw).trim().length > 0 ? String(stRaw).trim() : undefined;
        return { title, startSec, videoId, securityToken };
      })
      .filter((r) => Number.isFinite(r.startSec));
    if (rows.length === 0) return undefined;
    rows.sort((a, b) => a.startSec - b.startSec);
    return rows.map((r) => ({
      title: r.title,
      startSec: Math.round(r.startSec * 1000) / 1000,
      ...(r.videoId ? { videoId: r.videoId } : {}),
      ...(r.securityToken ? { securityToken: r.securityToken } : {}),
    }));
  }

  /**
   * Normalize deck timeline rows for persistence. Sprout **video** ids must already be on each row
   * (from `buildDeckPromptList` / client session); we do not infer ids from deck titles or playlist ids.
   */
  private async enrichDeckTimelineVideoIds(
    ctx: LtiContext,
    rows: Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }> | undefined,
  ): Promise<Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }> | undefined> {
    if (!rows?.length) return rows;
    const missing = rows.filter((r) => !(r.videoId ?? '').trim());
    if (missing.length > 0) {
      appendLtiLog('prompt', 'deckTimeline: missing Sprout videoId on row(s) — source card embed needs id from build-deck / recording', {
        courseId: ctx.courseId,
        missingCount: missing.length,
        rowCount: rows.length,
        sample: missing.slice(0, 6).map((r) => ({
          startSec: r.startSec,
          titleHead: String(r.title ?? '').slice(0, 48),
        })),
      });
    }
    return rows.map((r) => ({
      title: r.title,
      startSec: Math.round(r.startSec * 1000) / 1000,
      ...(r.videoId?.trim() ? { videoId: r.videoId.trim() } : {}),
      ...(r.securityToken?.trim() ? { securityToken: r.securityToken.trim() } : {}),
    }));
  }

  /**
   * Fills missing Sprout `securityToken` (embed second segment) from DB `embed_code` for viewer source-card iframe.
   */
  private async enrichDeckTimelineWithSproutTokensFromDb(
    rows: Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }> | undefined,
  ): Promise<Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }> | undefined> {
    if (!rows?.length) return rows;
    const need = rows.filter((r) => (r.videoId ?? '').trim() && !(r.securityToken ?? '').trim());
    if (need.length === 0) return rows;
    const ids = [...new Set(need.map((r) => String(r.videoId).trim()))].filter(Boolean);
    if (ids.length === 0) return rows;
    const found = await this.sproutPlaylistVideoRepo.find({
      where: { videoId: In(ids) },
      select: ['videoId', 'embedCode'],
    });
    const tokenByVideoId = new Map<string, string>();
    for (const f of found) {
      const pair = parseSproutEmbedPairFromEmbedCode(f.embedCode);
      if (pair && pair.videoId === f.videoId) {
        tokenByVideoId.set(f.videoId, pair.securityToken);
      }
    }
    if (tokenByVideoId.size === 0) return rows;
    return rows.map((r) => {
      const vid = (r.videoId ?? '').trim();
      if (!vid) return r;
      const st = (r.securityToken ?? '').trim() || tokenByVideoId.get(vid);
      return { ...r, ...(st ? { securityToken: st } : {}) };
    });
  }

  /** v1: YouTube-only; extend with pdf|audio|video refs when media sequence ships. */
  private sanitizeMediaStimulusInput(
    raw: unknown,
  ): { kind: 'youtube'; videoId: string; clipStartSec: number; clipEndSec: number; label?: string } | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (o.kind !== 'youtube') return undefined;
    const videoId = String(o.videoId ?? '').trim();
    if (!/^[\w-]{6,20}$/.test(videoId)) return undefined;
    let clipStartSec = Math.floor(Number(o.clipStartSec));
    if (!Number.isFinite(clipStartSec) || clipStartSec < 0) clipStartSec = 0;
    let clipEndSec = Math.floor(Number(o.clipEndSec));
    if (!Number.isFinite(clipEndSec) || clipEndSec <= clipStartSec) return undefined;
    if (clipEndSec - clipStartSec > 86400) return undefined;
    const labelRaw = String(o.label ?? '').trim();
    const label = labelRaw ? labelRaw.slice(0, 500) : undefined;
    return { kind: 'youtube', videoId, clipStartSec, clipEndSec, ...(label ? { label } : {}) };
  }

  /** HTML blob for teacher list / legacy consumers: concatenated per-card titles from deck timeline. */
  private buildPromptHtmlFromDeckTimeline(
    deckTimeline: Array<{ title: string; startSec: number; videoId?: string }>,
  ): string {
    const parts: string[] = [];
    for (const row of deckTimeline) {
      const t = (row.title ?? '').trim();
      if (t) parts.push(t);
    }
    return parts.length > 0 ? parts.join('<hr class="fsasl-deck-prompt-sep" />') : '';
  }

  private estimateDurationFromDeckTimelineEntries(
    entries: Array<{ title: string; startSec: number; videoId?: string }>,
  ): number | null {
    if (!entries.length) return null;
    let lastStartSec: number | null = null;
    for (const row of entries) {
      const start = row.startSec;
      if (!Number.isFinite(start)) continue;
      if (lastStartSec == null || start > lastStartSec) lastStartSec = start;
    }
    if (lastStartSec == null) return null;
    return Math.round((lastStartSec + DECK_MIN_TOTAL_SECONDS) * 1000) / 1000;
  }

  async submit(
    ctx: LtiContext,
    promptSnapshotHtml: string | undefined,
    deckTimeline?: Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>,
  ): Promise<void> {
    const snap = (promptSnapshotHtml ?? '').trim();
    appendLtiLog('prompt-submit', 'submit ENTER', {
      assignmentId: ctx.assignmentId,
      snapshotLength: snap.length,
      deckTimelineIn: Array.isArray(deckTimeline) ? deckTimeline.length : 0,
    });
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      appendLtiLog('prompt-submit', 'submit FAIL: no token');
      throw new Error(
        'Canvas token required for this course: a teacher must complete Canvas OAuth or save a manual API token so it is stored for this course (no shared server token).',
      );
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverrideSubmit = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const submissionAssignmentName = await this.canvasAssignmentNameForLog(
      ctx.courseId,
      assignmentId,
      domainOverrideSubmit,
      token,
    );
    appendLtiLog('prompt-submit', 'submit: got assignmentId', { assignmentId, assignmentName: submissionAssignmentName });
    let sanitizedDeckTimeline = this.sanitizeDeckTimelineInput(deckTimeline);
    sanitizedDeckTimeline = await this.enrichDeckTimelineVideoIds(ctx, sanitizedDeckTimeline);
    const bodyString = buildHumanReadableSubmissionBodyText({
      deckTimeline: sanitizedDeckTimeline,
      promptSnapshotHtml: snap || undefined,
    });
    appendLtiLog('prompt-submit', 'submit: human-readable Canvas body', {
      assignmentId,
      assignmentName: submissionAssignmentName,
      deckRows: sanitizedDeckTimeline?.length ?? 0,
      bodyChars: bodyString.length,
    });
    const ctxWithToken: LtiContext = { ...ctx, canvasAccessToken: token };
    await this.canvas.writeSubmissionBody(ctxWithToken, assignmentId, bodyString, token);

    appendLtiLog('prompt-submit', 'submit DONE', {
      assignmentId,
      assignmentName: submissionAssignmentName,
      deckTimelineStored: sanitizedDeckTimeline?.length ?? 0,
    });
  }

  /**
   * Recover prompt HTML from submission body: legacy machine JSON, or human-readable text
   * from the forward `submit` path.
   */
  private extractPromptHtmlFromSubmissionBody(body: string | undefined): string | undefined {
    const raw = (body ?? '').trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { deckTimeline?: unknown; promptSnapshotHtml?: unknown };
      const deck = this.sanitizeDeckTimelineInput(
        Array.isArray(parsed.deckTimeline)
          ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
          : undefined,
      );
      if (deck?.length) {
        const html = this.buildPromptHtmlFromDeckTimeline(deck).trim();
        if (html) return html;
      }
      const snap = String(parsed.promptSnapshotHtml ?? '').trim();
      if (snap) return snap;
    } catch {
      if (raw.startsWith('{')) return undefined;
      const asHtml = humanSubmissionBodyToPromptHtml(raw);
      return asHtml.trim() ? asHtml : undefined;
    }
    return undefined;
  }

  /** Sum of card `duration` across all stored prompt banks (deck timing from prompt_configs). */
  private totalDurationSecondsFromStoredPromptBanks(config: PromptConfigJson | null | undefined): number | null {
    const banks = config?.videoPromptConfig?.storedPromptBanks;
    if (!Array.isArray(banks) || banks.length === 0) return null;
    let sum = 0;
    let any = false;
    for (const bank of banks) {
      if (!Array.isArray(bank)) continue;
      for (const card of bank) {
        const dur = Number((card as { duration?: unknown }).duration);
        if (Number.isFinite(dur) && dur > 0) {
          sum += dur;
          any = true;
        }
      }
    }
    return any ? Math.round(sum * 1000) / 1000 : null;
  }

  private promptHtmlAndDurationFromUploadRecord(
    parsed: Record<string, unknown>,
  ): { promptHtml?: string; videoDurationSeconds: number | null } {
    const deck = this.sanitizeDeckTimelineInput(
      Array.isArray(parsed.deckTimeline)
        ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
        : undefined,
    );
    let promptHtml: string | undefined;
    if (deck?.length) {
      const h = this.buildPromptHtmlFromDeckTimeline(deck).trim();
      if (h) promptHtml = h;
    }
    if (!promptHtml) {
      const snap = String(parsed.promptSnapshotHtml ?? '').trim();
      if (snap) promptHtml = snap;
    }
    const dur = Number(parsed.durationSeconds);
    const videoDurationSeconds =
      Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) / 1000 : null;
    return { promptHtml, videoDurationSeconds };
  }

  /**
   * When WebM `PROMPT_DATA` is unavailable, use submission body JSON + assignment prompt-bank duration hints only.
   */
  private computeAssignmentFallbackPromptRow(
    body: string | undefined,
    promptsFallbackDuration: number | null,
  ): {
    promptHtml?: string;
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'prompts' | 'unknown';
  } {
    let videoDurationSeconds: number | null = null;
    let durationSource: 'submission' | 'prompts' | 'unknown' = 'unknown';
    const raw = (body ?? '').trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { durationSeconds?: unknown; deckTimeline?: unknown };
        const d = Number(parsed.durationSeconds);
        if (Number.isFinite(d) && d > 0) {
          videoDurationSeconds = Math.round(d * 1000) / 1000;
          durationSource = 'submission';
        }
        const deck = this.sanitizeDeckTimelineInput(
          Array.isArray(parsed.deckTimeline)
            ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
            : undefined,
        );
        if (videoDurationSeconds == null && deck?.length) {
          const est = this.estimateDurationFromDeckTimelineEntries(deck);
          if (est != null) {
            videoDurationSeconds = est;
            durationSource = 'submission';
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (videoDurationSeconds == null && promptsFallbackDuration != null) {
      videoDurationSeconds = promptsFallbackDuration;
      durationSource = 'prompts';
    }
    const promptHtml = this.extractPromptHtmlFromSubmissionBody(body);
    return { promptHtml, videoDurationSeconds, durationSource };
  }

  /**
   * Legacy machine JSON in submission comments (same shapes as body). Forward scan matches
   * TeacherViewer `getPromptFromComments` JSON pass; tail pass matches legacy “Prompt used:” / markup.
   */
  private extractPromptHtmlFromSubmissionComments(
    comments: Array<{ comment: string }> | undefined,
  ): string | undefined {
    if (!comments?.length) return undefined;
    for (const c of comments) {
      const txt = (c.comment ?? '').trim();
      if (!txt) continue;
      try {
        const parsed = JSON.parse(txt) as { promptSnapshotHtml?: unknown; deckTimeline?: unknown };
        const snap = String(parsed.promptSnapshotHtml ?? '').trim();
        if (snap) return snap;
        const deck = this.sanitizeDeckTimelineInput(
          Array.isArray(parsed.deckTimeline)
            ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
            : undefined,
        );
        if (deck?.length) {
          const html = this.buildPromptHtmlFromDeckTimeline(deck).trim();
          if (html) return html;
        }
      } catch {
        /* not JSON */
      }
    }
    let lastIdx = -1;
    for (let i = 0; i < comments.length; i++) {
      const txt = (comments[i].comment ?? '').trim();
      const isLegacy = /^Prompt used:/i.test(txt);
      const hasMarkup = txt.includes('<') && txt.includes('>');
      if (isLegacy || hasMarkup) lastIdx = i;
    }
    if (lastIdx >= 0) {
      const raw = (comments[lastIdx].comment ?? '').trim();
      return /^Prompt used:/i.test(raw) ? raw.replace(/^Prompt used:\s*/i, '').trim() : raw;
    }
    return undefined;
  }

  /** Duration / deck hints from JSON comments; newest comment wins (multi-attempt), aligned with client deck comment order. */
  private computeCommentDerivedDurationRow(comments: Array<{ comment: string }> | undefined): {
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'unknown';
  } {
    let videoDurationSeconds: number | null = null;
    let durationSource: 'submission' | 'unknown' = 'unknown';
    if (!comments?.length) return { videoDurationSeconds, durationSource };
    for (let i = comments.length - 1; i >= 0; i--) {
      const txt = (comments[i]?.comment ?? '').trim();
      if (!txt) continue;
      try {
        const parsed = JSON.parse(txt) as { durationSeconds?: unknown; deckTimeline?: unknown };
        const d = Number(parsed.durationSeconds);
        if (Number.isFinite(d) && d > 0) {
          videoDurationSeconds = Math.round(d * 1000) / 1000;
          durationSource = 'submission';
          break;
        }
        const deck = this.sanitizeDeckTimelineInput(
          Array.isArray(parsed.deckTimeline)
            ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
            : undefined,
        );
        if (deck?.length) {
          const est = this.estimateDurationFromDeckTimelineEntries(deck);
          if (est != null) {
            videoDurationSeconds = est;
            durationSource = 'submission';
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { videoDurationSeconds, durationSource };
  }

  /**
   * Ordered fallback: body then comments, then assignment prompt-bank duration. Used when WebM is absent
   * or when WebM supplies only partial fields.
   */
  private extractYoutubeMediaStimulusFromSubmissionBody(body: string | undefined) {
    const raw = (body ?? '').trim();
    if (!raw || raw[0] !== '{') return undefined;
    try {
      const parsed = JSON.parse(raw) as { mediaStimulus?: unknown };
      return this.sanitizeMediaStimulusInput(parsed.mediaStimulus);
    } catch {
      return undefined;
    }
  }

  /** Latest JSON comment with valid `mediaStimulus` (newest-first; same validation as `sanitizeMediaStimulusInput`). */
  private extractYoutubeMediaStimulusFromSubmissionComments(comments: Array<{ comment: string }> | undefined) {
    if (!comments?.length) return undefined;
    for (let i = comments.length - 1; i >= 0; i--) {
      const txt = (comments[i]?.comment ?? '').trim();
      if (!txt || txt[0] !== '{') continue;
      try {
        const parsed = JSON.parse(txt) as { mediaStimulus?: unknown };
        const ms = this.sanitizeMediaStimulusInput(parsed.mediaStimulus);
        if (ms) return ms;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private mergeMediaStimulusFromBodyAndComments(
    body: string | undefined,
    comments: Array<{ comment: string }> | undefined,
  ): {
    mediaStimulus?: {
      kind: 'youtube';
      videoId: string;
      clipStartSec: number;
      clipEndSec: number;
      label?: string;
    };
    mediaStimulusSource: 'submission_body' | 'submission_comments' | 'none';
  } {
    const fromBody = this.extractYoutubeMediaStimulusFromSubmissionBody(body);
    if (fromBody) return { mediaStimulus: fromBody, mediaStimulusSource: 'submission_body' };
    const fromComments = this.extractYoutubeMediaStimulusFromSubmissionComments(comments);
    if (fromComments) return { mediaStimulus: fromComments, mediaStimulusSource: 'submission_comments' };
    return { mediaStimulus: undefined, mediaStimulusSource: 'none' };
  }

  private extractDeckTimelineFromSubmissionBody(
    body: string | undefined,
  ): Array<{ title: string; startSec: number; videoId?: string }> | undefined {
    const raw = (body ?? '').trim();
    if (!raw || raw[0] !== '{') return undefined;
    try {
      const parsed = JSON.parse(raw) as { deckTimeline?: unknown };
      return this.sanitizeDeckTimelineInput(
        Array.isArray(parsed.deckTimeline)
          ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
          : undefined,
      );
    } catch {
      return undefined;
    }
  }

  /** Newest JSON machine comment with a non-empty deck (matches client resolveDeckTimeline). */
  private extractDeckTimelineFromSubmissionComments(
    comments: Array<{ comment: string }> | undefined,
  ): Array<{ title: string; startSec: number; videoId?: string }> | undefined {
    if (!comments?.length) return undefined;
    for (let i = comments.length - 1; i >= 0; i--) {
      const txt = (comments[i]?.comment ?? '').trim();
      if (!txt || txt[0] !== '{') continue;
      try {
        const parsed = JSON.parse(txt) as { deckTimeline?: unknown };
        const deck = this.sanitizeDeckTimelineInput(
          Array.isArray(parsed.deckTimeline)
            ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
            : undefined,
        );
        if (deck?.length) return deck;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private mergeDeckTimelineFromBodyAndComments(
    body: string | undefined,
    comments: Array<{ comment: string }> | undefined,
  ): Array<{ title: string; startSec: number; videoId?: string }> | undefined {
    return (
      this.extractDeckTimelineFromSubmissionBody(body) ?? this.extractDeckTimelineFromSubmissionComments(comments)
    );
  }

  /** Readable grading HTML from PROMPT_DATA JSON (ordered list for decks; plain paragraphs for RTE snapshots). */
  private gradingDisplayPromptHtmlFromDecodedPayload(parsed: Record<string, unknown>): string | undefined {
    const deck = this.sanitizeDeckTimelineInput(
      Array.isArray(parsed.deckTimeline)
        ? (parsed.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
        : undefined,
    );
    if (deck?.length) {
      const html = gradingDisplayHtmlFromDeckTimelineRows(deck).trim();
      if (html) return html;
    }
    const snap = String(parsed.promptSnapshotHtml ?? '').trim();
    if (snap) {
      const g = gradingDisplayHtmlFromPromptSnapshotRte(snap).trim();
      if (g) return g;
    }
    return undefined;
  }

  private mergeBodyCommentAssignmentFallback(
    body: string | undefined,
    comments: Array<{ comment: string }> | undefined,
    promptsFallbackDuration: number | null,
  ): {
    promptHtml?: string;
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'prompts' | 'unknown';
  } {
    const bodyPart = this.computeAssignmentFallbackPromptRow(body, null);
    const commentPrompt = this.extractPromptHtmlFromSubmissionComments(comments);
    const commentDur = this.computeCommentDerivedDurationRow(comments);
    let promptHtml = bodyPart.promptHtml ?? commentPrompt;
    let videoDurationSeconds = bodyPart.videoDurationSeconds ?? commentDur.videoDurationSeconds;
    let durationSource: 'submission' | 'prompts' | 'unknown' =
      bodyPart.videoDurationSeconds != null
        ? bodyPart.durationSource
        : commentDur.videoDurationSeconds != null
          ? commentDur.durationSource
          : 'unknown';
    if (videoDurationSeconds == null && promptsFallbackDuration != null) {
      videoDurationSeconds = promptsFallbackDuration;
      durationSource = 'prompts';
    }
    return { promptHtml, videoDurationSeconds, durationSource };
  }

  /** Log line: where non-WebM prompt labeling comes from (body vs comments). */
  private classifyGradingViewerPromptSource(
    body: string | undefined,
    comments: Array<{ comment: string }> | undefined,
    metadataResolution: 'webm_metadata' | 'assignment_fallback',
  ):
    | 'webm_metadata'
    | 'submission_body_deck_timeline'
    | 'submission_body'
    | 'submission_comments_deck_timeline'
    | 'submission_comments'
    | 'none' {
    if (metadataResolution === 'webm_metadata') return 'webm_metadata';
    const rawBody = (body ?? '').trim();
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { deckTimeline?: unknown };
        if (Array.isArray(parsed.deckTimeline) && parsed.deckTimeline.length > 0) {
          return 'submission_body_deck_timeline';
        }
      } catch {
        /* ignore */
      }
    }
    if (this.extractPromptHtmlFromSubmissionBody(body)?.trim()) return 'submission_body';
    if (!comments?.length) return 'none';
    for (let i = comments.length - 1; i >= 0; i--) {
      const txt = (comments[i]?.comment ?? '').trim();
      if (!txt) continue;
      try {
        const parsed = JSON.parse(txt) as { deckTimeline?: unknown };
        if (Array.isArray(parsed.deckTimeline) && parsed.deckTimeline.length > 0) {
          return 'submission_comments_deck_timeline';
        }
      } catch {
        /* ignore */
      }
    }
    if (this.extractPromptHtmlFromSubmissionComments(comments)?.trim()) return 'submission_comments';
    return 'none';
  }

  private static readonly PROMPT_DATA_DECODE_MAX_UTF8 = 512_000;

  private async resolvePromptRowFromWebmMetadata(args: {
    assignmentId: string;
    userId: string;
    token: string;
    canvasVideoUrl: string | undefined;
    body: string | undefined;
    submissionComments?: Array<{ comment: string }>;
    promptsFallbackDuration: number | null;
  }): Promise<{
    promptHtml?: string;
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'prompts' | 'unknown';
    metadataPromptResolution: 'webm_metadata' | 'assignment_fallback';
    captionsVtt?: string;
    mediaStimulus?: {
      kind: 'youtube';
      videoId: string;
      clipStartSec: number;
      clipEndSec: number;
      label?: string;
    };
    mediaStimulusResolutionSource: 'webm_metadata' | 'submission_body' | 'submission_comments' | 'none';
    deckTimeline?: Array<{ title: string; startSec: number; videoId?: string }>;
  }> {
    const traceId = randomUUID();
    appendLtiLog('webm-prompt-trace', 'resolve:start', {
      traceId,
      assignmentId: args.assignmentId,
      userId: args.userId,
      hasCanvasVideoUrl: !!(args.canvasVideoUrl ?? '').trim(),
      bodyChars: (args.body ?? '').length,
      submissionCommentCount: args.submissionComments?.length ?? 0,
    });
    const merged = this.mergeBodyCommentAssignmentFallback(
      args.body,
      args.submissionComments,
      args.promptsFallbackDuration,
    );
    const mergedMs = this.mergeMediaStimulusFromBodyAndComments(args.body, args.submissionComments);
    const mergedDeckTimeline = this.mergeDeckTimelineFromBodyAndComments(args.body, args.submissionComments);
    const fallback = (captionsVtt?: string): {
      promptHtml?: string;
      videoDurationSeconds: number | null;
      durationSource: 'submission' | 'prompts' | 'unknown';
      metadataPromptResolution: 'assignment_fallback';
      captionsVtt?: string;
      mediaStimulus?: {
        kind: 'youtube';
        videoId: string;
        clipStartSec: number;
        clipEndSec: number;
        label?: string;
      };
      mediaStimulusResolutionSource: 'webm_metadata' | 'submission_body' | 'submission_comments' | 'none';
      deckTimeline?: Array<{ title: string; startSec: number; videoId?: string }>;
    } => ({
      promptHtml: merged.promptHtml,
      videoDurationSeconds: merged.videoDurationSeconds,
      durationSource: merged.durationSource,
      metadataPromptResolution: 'assignment_fallback',
      ...(captionsVtt ? { captionsVtt } : {}),
      ...(mergedMs.mediaStimulus ? { mediaStimulus: mergedMs.mediaStimulus } : {}),
      mediaStimulusResolutionSource: mergedMs.mediaStimulusSource,
      ...(mergedDeckTimeline?.length ? { deckTimeline: mergedDeckTimeline } : {}),
    });

    const url = (args.canvasVideoUrl ?? '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      appendLtiLog('webm-prompt-trace', 'resolve:no_http_video_url', { traceId, userId: args.userId });
      appendLtiLog('webm-prompt', 'read: FAIL (no_canvas_http_video_url)', {
        userId: args.userId,
        assignmentId: args.assignmentId,
        traceId,
      });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
      return fallback();
    }
    if (url.includes('external_tools/retrieve')) {
      appendLtiLog('webm-prompt-trace', 'resolve:lti_retrieve_url', { traceId, userId: args.userId });
      appendLtiLog('webm-prompt', 'read: FAIL (lti_retrieve_url)', { userId: args.userId, traceId });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
      return fallback();
    }

    let urlHost = '';
    try {
      urlHost = new URL(url).hostname;
    } catch {
      urlHost = '(unparsed)';
    }
    appendLtiLog('webm-prompt', 'read: attempt (download + ffprobe)', {
      userId: args.userId,
      assignmentId: args.assignmentId,
      urlHost,
      traceId,
    });

    const dl = await downloadAuthenticatedVideoToTempFile(
      url,
      args.token,
      DEFAULT_WEBM_PROBE_DOWNLOAD_MAX_BYTES,
    );
    if (!dl.ok) {
      appendLtiLog('webm-prompt-trace', 'resolve:download_fail', { traceId, error: dl.error });
      appendLtiLog('webm-prompt', 'read: FAIL (download)', {
        userId: args.userId,
        error: dl.error,
        traceId,
      });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
      return fallback();
    }
    try {
      const probe = await ffprobeWebmPromptDataJson(dl.path);
      if (!probe) {
        appendLtiLog('webm-prompt-trace', 'resolve:ffprobe_null', { traceId });
        appendLtiLog('webm-prompt', 'read: FAIL (ffprobe)', { userId: args.userId, traceId });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
        return fallback();
      }

      let captionsVtt: string | undefined;
      if (probe.hasSubtitleStream) {
        try {
          const vtt = await extractFirstSubtitleWebVttFromWebm(dl.path);
          if (vtt) {
            captionsVtt = vtt;
            appendLtiLog('webm-prompt', 'read: subtitle WebVTT extracted OK', {
              userId: args.userId,
              vttChars: vtt.length,
            });
          } else {
            appendLtiLog('webm-prompt', 'read: subtitle extract empty (open)', { userId: args.userId });
          }
        } catch (e) {
          appendLtiLog('webm-prompt', 'read: subtitle extract FAIL (open)', {
            userId: args.userId,
            error: String(e),
          });
        }
      }

      appendLtiLog('sign-to-voice', 'resolvePromptRowFromWebmMetadata: after subtitle extraction', {
        userId: args.userId,
        assignmentId: args.assignmentId,
        hasSubtitleStream: probe.hasSubtitleStream,
        captionsVttPopulated: !!captionsVtt,
        captionsVttCharLength: captionsVtt?.length ?? 0,
      });

      const tagRaw = probe.promptDataTag;
      if (!tagRaw) {
        appendLtiLog('webm-prompt-trace', 'resolve:missing_PROMPT_DATA_tag', { traceId });
        appendLtiLog('webm-prompt', 'read: FAIL (missing_PROMPT_DATA_tag)', { userId: args.userId, traceId });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
        return fallback(captionsVtt);
      }
      const decoded = decodePromptDataFromFfmpegMetadataTag(tagRaw, PromptService.PROMPT_DATA_DECODE_MAX_UTF8);
      if (!decoded.ok) {
        appendLtiLog('webm-prompt-trace', 'resolve:parse_PROMPT_DATA_fail', { traceId, error: decoded.error });
        appendLtiLog('webm-prompt', 'read: FAIL (parse_PROMPT_DATA)', {
          userId: args.userId,
          error: decoded.error,
          traceId,
        });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
        return fallback(captionsVtt);
      }
      if (String(decoded.obj.fsaslKind ?? '') !== FSASL_PROMPT_UPLOAD_KIND) {
        appendLtiLog('webm-prompt-trace', 'resolve:unexpected_fsaslKind', {
          traceId,
          kind: String(decoded.obj.fsaslKind ?? ''),
        });
        appendLtiLog('webm-prompt', 'read: FAIL (unexpected_fsaslKind)', {
          userId: args.userId,
          kind: String(decoded.obj.fsaslKind ?? ''),
          traceId,
        });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
        return fallback(captionsVtt);
      }
      const tagDeck = this.sanitizeDeckTimelineInput(
        Array.isArray(decoded.obj.deckTimeline)
          ? (decoded.obj.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }>)
          : undefined,
      );
      const deckTimeline =
        tagDeck?.length ? tagDeck : mergedDeckTimeline?.length ? mergedDeckTimeline : undefined;

      const displayPrompt = this.gradingDisplayPromptHtmlFromDecodedPayload(decoded.obj);
      const fromTag = this.promptHtmlAndDurationFromUploadRecord(decoded.obj);
      const tagPromptHtml = (displayPrompt ?? fromTag.promptHtml ?? '').trim() || undefined;
      const hasPromptHtml = !!tagPromptHtml;
      const hasDuration = fromTag.videoDurationSeconds != null;
      const tagMsRaw = (decoded.obj as { mediaStimulus?: unknown }).mediaStimulus;
      const tagMs = this.sanitizeMediaStimulusInput(tagMsRaw);
      if (tagMsRaw != null && typeof tagMsRaw === 'object' && !tagMs) {
        appendLtiLog('webm-prompt-trace', 'resolve:PROMPT_DATA_mediaStimulus_rejected', {
          traceId,
          userId: args.userId,
          keys: Object.keys(tagMsRaw as Record<string, unknown>).slice(0, 20).join(','),
        });
      }
      const hasTagMs = !!tagMs;
      const hasDeckInTag = !!(tagDeck?.length);
      if (!hasPromptHtml && !hasDuration && !hasTagMs && !hasDeckInTag) {
        appendLtiLog('webm-prompt-trace', 'resolve:FAIL_empty_tag_fields', {
          traceId,
          userId: args.userId,
          assignmentId: args.assignmentId,
        });
        appendLtiLog('webm-prompt', 'read: FAIL (empty_prompt_fields)', { userId: args.userId, traceId });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId, traceId });
        return fallback(captionsVtt);
      }

      appendLtiLog('webm-prompt', 'read: OK', {
        userId: args.userId,
        assignmentId: args.assignmentId,
        promptDataUtf8Bytes: decoded.utf8ByteLength,
        traceId,
      });

      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: webm_metadata', { userId: args.userId, traceId });
      appendLtiLog('webm-prompt-trace', 'resolve:webm_metadata_ok', {
        traceId,
        hasPromptHtml,
        hasDuration,
        hasTagMs,
        hasDeckInTag,
        deckTimelineOut: deckTimeline?.length ?? 0,
      });

      const mediaStimulus = hasTagMs ? tagMs : mergedMs.mediaStimulus;
      const mediaStimulusResolutionSource: 'webm_metadata' | 'submission_body' | 'submission_comments' | 'none' =
        hasTagMs ? 'webm_metadata' : mergedMs.mediaStimulusSource;

      return {
        promptHtml: tagPromptHtml ?? merged.promptHtml,
        videoDurationSeconds: hasDuration
          ? (fromTag.videoDurationSeconds as number)
          : merged.videoDurationSeconds,
        durationSource: hasDuration ? 'submission' : merged.durationSource,
        metadataPromptResolution: 'webm_metadata',
        ...(captionsVtt ? { captionsVtt } : {}),
        ...(mediaStimulus ? { mediaStimulus } : {}),
        mediaStimulusResolutionSource,
        ...(deckTimeline?.length ? { deckTimeline } : {}),
      };
    } finally {
      dl.cleanup();
    }
  }

  async uploadVideo(
    ctx: LtiContext,
    video: { buffer?: Buffer; filePath?: string; size: number },
    filename: string,
    options?: {
      deckTimeline?: Array<{ title: string; startSec: number; videoId?: string }>;
      /** Text / HTML snapshot for non-deck prompts; stored in WebM `PROMPT_DATA` metadata. */
      promptSnapshotHtml?: string;
      /** Pre-recording stimulus (e.g. YouTube clip) for grading replay; stored in WebM `PROMPT_DATA`. */
      mediaStimulus?: unknown;
      /** Client-measured recording length (seconds). */
      durationSeconds?: number;
      captureProfile?: {
        profileId?: string;
        requestedWidth?: number;
        requestedHeight?: number;
        requestedFps?: number;
        actualWidth?: number;
        actualHeight?: number;
        actualFps?: number;
        mimeType?: string;
        videoBitsPerSecond?: number;
        audioBitsPerSecond?: number;
      };
    },
  ): Promise<{
    fileId: string;
    courseId: string;
    assignmentId: string;
    studentUserId: string;
    studentIdSource: string | undefined;
    verify: {
      submissionFetched: boolean;
      workflow_state?: string;
      submission_type?: string;
      attachmentCount: number;
      hasPlaybackUrl: boolean;
      commentAttachmentCount?: number;
    };
  }> {
    if (!video.filePath && !video.buffer) {
      throw new Error('uploadVideo requires either filePath or buffer input');
    }
    appendLtiLog('prompt-upload', 'uploadVideo ENTER', {
      filename,
      size: video.size,
      source: video.filePath ? 'filepath' : 'buffer',
      captureProfile: options?.captureProfile ?? null,
    });
    appendLtiLog('duration', 'uploadVideo: durationSeconds in options', {
      present: options?.durationSeconds !== undefined,
      value: options?.durationSeconds ?? null,
      typeof:
        options?.durationSeconds === undefined
          ? 'undefined'
          : typeof options.durationSeconds,
      finitePositive:
        options?.durationSeconds != null &&
        typeof options.durationSeconds === 'number' &&
        Number.isFinite(options.durationSeconds) &&
        options.durationSeconds > 0,
    });
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      appendLtiLog('prompt-upload', 'upload-video FAIL: no token');
      throw new Error(
        'Canvas token required for video upload: a teacher must authorize Canvas OAuth or save a manual token for this course first.',
      );
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const oauth = ctx.canvasAccessToken?.trim() || '';
    const usingStudentOAuth = !!oauth && token === oauth;
    const selfNumeric = usingStudentOAuth
      ? await this.canvas.getCurrentCanvasUserId(domainOverride, token)
      : null;
    const customId = (ctx.canvasUserId ?? '').trim();
    const ltiSub = (ctx.userId ?? '').trim();

    let studentUserId: string | undefined;
    let studentIdSource: string | undefined;
    const fromResolver = resolveCanvasApiUserId(ctx);
    if (fromResolver && isCanvasNumericUserId(fromResolver)) {
      studentUserId = fromResolver;
      studentIdSource = customId ? 'lti.custom.user_id' : 'lti.numeric_principal';
    } else if (usingStudentOAuth && selfNumeric && isCanvasNumericUserId(selfNumeric)) {
      studentUserId = selfNumeric;
      studentIdSource = 'users/self';
    } else if (isCanvasNumericUserId(customId)) {
      studentUserId = customId;
      studentIdSource = 'lti.custom.user_id';
    } else if (isCanvasNumericUserId(ltiSub)) {
      studentUserId = ltiSub;
      studentIdSource = 'lti.sub';
    }

    if (!studentUserId) {
      appendLtiLog('prompt-upload', 'upload-video FAIL: no numeric Canvas user id for submission file path', {
        usingStudentOAuth,
        selfNumeric: selfNumeric ?? '(none)',
        canvasUserId: ctx.canvasUserId ?? '(none)',
        ltiSub: ltiSub || '(none)',
        hint: 'LTI 1.1: add Custom Field user_id=$Canvas.user.id (POST as custom_user_id) or custom_canvas_user_id in XML; LTI 1.3: user_id in JWT custom claims; or student Canvas OAuth for /api/v1/users/self.',
      });
      throw new Error(
        'Canvas file upload API requires a numeric Canvas user id in the URL. The launch is using an opaque LTI user id. Fix: in Canvas, add a tool Custom Field named user_id with value $Canvas.user.id (sends custom_user_id for LTI 1.1), or use custom_canvas_user_id in the cartridge, or complete Canvas OAuth as the student so /api/v1/users/self resolves.',
      );
    }

    const tokenHolderNumeric =
      usingStudentOAuth && selfNumeric
        ? selfNumeric
        : await this.canvas.getCurrentCanvasUserId(domainOverride, token);
    appendLtiLog('prompt-upload', 'uploadVideo: token actor vs submission user', {
      tokenHolderCanvasId: tokenHolderNumeric ?? '(unknown)',
      studentUserId,
      studentIdSource,
      sameActor:
        tokenHolderNumeric != null && String(tokenHolderNumeric).trim() === String(studentUserId).trim(),
      note:
        tokenHolderNumeric != null &&
        String(tokenHolderNumeric).trim() !== String(studentUserId).trim()
          ? 'Token holder differs from target student id; this flow requires as_user_id permission on submit.'
          : '(n/a)',
    });

    const assignmentId = await this.getPrompterAssignmentId(ctx);

    const optDur = options?.durationSeconds;
    const durationFinite =
      optDur != null && typeof optDur === 'number' && Number.isFinite(optDur) && optDur > 0;
    const durationRounded = durationFinite ? Math.round(optDur * 1000) / 1000 : null;

    let sanitizedCommentDeck = this.sanitizeDeckTimelineInput(
      options?.deckTimeline as Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }> | undefined,
    );
    sanitizedCommentDeck = await this.enrichDeckTimelineVideoIds(ctx, sanitizedCommentDeck);
    const sanitizedMediaStimulus = this.sanitizeMediaStimulusInput(options?.mediaStimulus);
    const promptSnapUpload = (options?.promptSnapshotHtml ?? '').trim();

    let promptDataPayload: Record<string, unknown> | null = null;
    if (sanitizedCommentDeck?.length || durationRounded != null || sanitizedMediaStimulus || promptSnapUpload) {
      const payload: Record<string, unknown> = {
        submittedAt: new Date().toISOString(),
        fsaslKind: FSASL_PROMPT_UPLOAD_KIND,
      };
      if (sanitizedCommentDeck?.length) {
        payload.deckTimeline = sanitizedCommentDeck;
      }
      if (durationRounded != null) {
        payload.durationSeconds = durationRounded;
      }
      if (sanitizedMediaStimulus) {
        payload.mediaStimulus = sanitizedMediaStimulus;
      }
      if (promptSnapUpload) {
        payload.promptSnapshotHtml = promptSnapUpload;
      }
      promptDataPayload = payload;
    }

    let muxTag: string | null = null;
    let muxUtf8ByteLength: number | null = null;
    if (promptDataPayload) {
      const enc = encodePromptDataForFfmpegMetadataTag(promptDataPayload);
      muxTag = enc.tag;
      muxUtf8ByteLength = enc.utf8ByteLength;
    }

    let uploadSize = video.size;
    let uploadInput: { filePath: string; size: number } | Buffer = video.filePath
      ? { filePath: video.filePath, size: video.size }
      : (video.buffer ?? Buffer.alloc(0));
    let muxOutputPath: string | null = null;
    let muxInputCleanup: (() => void) | null = null;

    if (muxTag) {
      let inputPathForMux: string | null = null;
      if (video.filePath) {
        inputPathForMux = video.filePath;
      } else if (video.buffer) {
        const t = writeBufferToTempWebmFile(video.buffer);
        inputPathForMux = t.path;
        muxInputCleanup = t.cleanup;
      }
      if (inputPathForMux) {
        const muxed = await muxWebmWithPromptDataTag({
          inputPath: inputPathForMux,
          promptDataTagValue: muxTag,
          timeoutMs: DEFAULT_WEBM_MUX_TIMEOUT_MS,
        });
        if (muxed.ok) {
          muxOutputPath = muxed.outputPath;
          uploadSize = muxed.size;
          uploadInput = { filePath: muxed.outputPath, size: muxed.size };
          appendLtiLog('webm-prompt', 'write: OK', {
            initiatedBytes: muxed.size,
            originalBytes: video.size,
            promptDataUtf8Bytes: muxUtf8ByteLength ?? 0,
          });
        } else {
          appendLtiLog('webm-prompt', 'write: FAIL (using_original)', { error: muxed.error });
        }
      }
      if (muxInputCleanup) muxInputCleanup();
    } else {
      appendLtiLog('webm-prompt', 'write: SKIP (no_prompt_data_payload)', {
        durationSecondsOption: options?.durationSeconds ?? null,
        hasMediaStimulusOption: options?.mediaStimulus != null,
      });
    }

    let signToVoiceMuxOutputPath: string | null = null;
    {
      let captionMaterializedCleanup: (() => void) | null = null;
      try {
        let pathForSignToVoice: string | null =
          typeof uploadInput === 'object' && uploadInput && 'filePath' in uploadInput ? uploadInput.filePath : null;
        if (!pathForSignToVoice && video.buffer) {
          const mat = writeBufferToTempWebmFile(video.buffer);
          pathForSignToVoice = mat.path;
          captionMaterializedCleanup = mat.cleanup;
        }
        if (pathForSignToVoice) {
          let sizeForCap = uploadSize;
          try {
            sizeForCap = statSync(pathForSignToVoice).size;
          } catch {
            /* keep uploadSize */
          }
          let signToVoiceRequired = false;
          let deepgramKey = '';
          try {
            signToVoiceRequired = await this.resolveSignToVoiceRequired(
              ctx.courseId,
              assignmentId,
              domainOverride,
              token,
            );
            deepgramKey = (this.config.get<string>('DEEPGRAM_API_KEY') ?? process.env.DEEPGRAM_API_KEY ?? '').trim();
          } catch (e) {
            appendLtiLog('sign-to-voice', 'preupload: resolve/config failed (using_original)', {
              error: String(e),
            });
          }
          const cap = await tryPreuploadSignToVoiceCaptionsMux({
            webmPath: pathForSignToVoice,
            originalSize: sizeForCap,
            signToVoiceRequired,
            deepgramApiKey: deepgramKey,
          });
          if (cap.muxOutputPathForCleanup) {
            signToVoiceMuxOutputPath = cap.muxOutputPathForCleanup;
            uploadSize = cap.nextSize;
            uploadInput = { filePath: cap.nextPath, size: cap.nextSize };
            appendLtiLog('sign-to-voice', 'preupload: using muxed WebM for upload', { uploadBytes: uploadSize });
          }
        }
      } finally {
        captionMaterializedCleanup?.();
      }
    }

    appendLtiLog('prompt-upload', 'uploadVideo: initiateSubmissionFileUploadForUser', {
      assignmentId,
      studentUserId,
      studentIdSource,
      uploadBytes: uploadSize,
    });
    let fileId: string;
    try {
      const { uploadUrl, uploadParams } = await this.canvas.initiateSubmissionFileUploadForUser(
        ctx.courseId,
        assignmentId,
        studentUserId,
        filename,
        uploadSize,
        'video/webm',
        domainOverride,
        token,
      );
      appendLtiLog('prompt-upload', 'uploadVideo: uploadFileToCanvas', {
        bufferSize: uploadSize,
        source: typeof uploadInput === 'object' && uploadInput && 'filePath' in uploadInput ? 'filepath' : 'buffer',
      });
      const up = await this.canvas.uploadFileToCanvas(uploadUrl, uploadParams, uploadInput, {
        tokenOverride: token,
      });
      fileId = up.fileId;
      appendLtiLog('prompt-upload', 'uploadVideo: attachFileToSubmission', {
        fileId,
        assignmentId,
        studentUserId,
      });
      await this.canvas.attachFileToSubmission(
        ctx.courseId,
        assignmentId,
        studentUserId,
        fileId,
        domainOverride,
        token,
      );
    } finally {
      if (signToVoiceMuxOutputPath) cleanupWebmVttMuxOutputPath(signToVoiceMuxOutputPath);
      if (muxOutputPath) cleanupMuxOutputPath(muxOutputPath);
    }

    const readVerify = (
      sub: Awaited<ReturnType<CanvasService['getSubmissionFull']>>,
    ): {
      submissionFetched: boolean;
      workflow_state: string | undefined;
      submission_type: string | undefined;
      attachmentCount: number;
      hasPlaybackUrl: boolean;
      commentAttachmentCount: number;
    } => {
      const subAny = sub as {
        workflow_state?: string;
        submission_type?: string;
        attachments?: unknown[];
        attachment?: unknown;
        submission_comments?: Array<{
          attachments?: Array<{ id?: number; url?: string; download_url?: string }>;
          attachment_ids?: number[];
        }>;
      } | null;
      const attachmentCount =
        (sub?.attachments?.length ?? 0) + (sub?.attachment ? 1 : 0);
      const commentAttachmentCount = (subAny?.submission_comments ?? []).reduce((count, c) => {
        const fromObjects = c?.attachments?.length ?? 0;
        const fromIds = c?.attachment_ids?.length ?? 0;
        return count + Math.max(fromObjects, fromIds);
      }, 0);
      const commentVideoUrl = (subAny?.submission_comments ?? [])
        .flatMap((c) => c?.attachments ?? [])
        .map((a) => (a?.url || a?.download_url || '').trim())
        .find((u) => !!u);
      const hasPlaybackUrl = !!(
        (sub && getVideoUrlFromCanvasSubmission(sub as Parameters<typeof getVideoUrlFromCanvasSubmission>[0])) ||
        commentVideoUrl
      );
      return {
        submissionFetched: !!sub,
        workflow_state: subAny?.workflow_state ?? undefined,
        submission_type: subAny?.submission_type ?? undefined,
        attachmentCount,
        hasPlaybackUrl,
        commentAttachmentCount,
      };
    };

    let verify = {
      submissionFetched: false,
      workflow_state: undefined as string | undefined,
      submission_type: undefined as string | undefined,
      attachmentCount: 0,
      hasPlaybackUrl: false,
      commentAttachmentCount: 0,
    };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const sub = await this.canvas.getSubmissionFull(
        ctx.courseId,
        assignmentId,
        studentUserId,
        domainOverride,
        token,
        { bridge: true, tag: `upload-video-verify-attempt-${attempt}` },
      );
      verify = readVerify(sub);
      appendLtiLog('prompt-upload', 'upload-video VERIFY after online_upload submit', {
        courseId: ctx.courseId,
        assignmentId,
        studentUserId,
        fileId,
        attempt,
        ...verify,
      });
      const hasSubmissionEvidence =
        verify.hasPlaybackUrl ||
        verify.attachmentCount > 0 ||
        verify.commentAttachmentCount > 0 ||
        String(verify.submission_type ?? '').toLowerCase() === 'online_upload';
      if (hasSubmissionEvidence) break;
      if (attempt < 4) {
        const waitMs = attempt === 1 ? 500 : attempt === 2 ? 1000 : 2000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    if (
      verify.submissionFetched &&
      !verify.hasPlaybackUrl &&
      verify.attachmentCount === 0 &&
      verify.commentAttachmentCount === 0 &&
      String(verify.submission_type ?? '').toLowerCase() !== 'online_upload'
    ) {
      appendLtiLog(
        'prompt-upload',
        'upload-video FAIL: no evidence of video on target student submission after retries',
        { assignmentId, studentUserId, fileId, verify },
      );
      throw new Error(
        'Canvas did not confirm a video attachment on the target student submission after upload retries. Submission not marked successful.',
      );
    }
    appendLtiLog('prompt-upload', 'uploadVideo DONE', { fileId, assignmentId, studentUserId, ...verify });
    return {
      fileId,
      courseId: ctx.courseId,
      assignmentId,
      studentUserId,
      studentIdSource,
      verify,
    };
  }

  /**
   * Deep Linking (e.g. homework_submission): store file for one-time GET, build LtiDeepLinkingResponse
   * JWT and return HTML form that auto-posts to Canvas deep_link_return_url.
   * In dev, returns { html, dev } so the client can console.log and delay before redirect.
   */
  async submitDeepLink(
    ctx: LtiContext,
    buffer: Buffer,
    contentType: string,
    filename?: string,
  ): Promise<
    string | { html: string; dev: { message: string; delayMs: number; contentItemTitle?: string; videoTitle?: string | null } }
  > {
    appendLtiLog('prompt-deeplink', 'submitDeepLink ENTER', {
      size: buffer.length,
      contentType,
      filename: filename ?? '(unnamed)',
      messageType: ctx.messageType,
      hasDeepLinkReturnUrl: !!ctx.deepLinkReturnUrl,
    });
    appendLtiLog('webm-prompt', 'scope: submitDeepLink uses shared sign-to-voice preupload (no_PROMPT_DATA_mux)', {
      bytes: buffer.length,
    });
    if (ctx.messageType !== 'LtiDeepLinkingRequest' || !ctx.deepLinkReturnUrl) {
      appendLtiLog('prompt-deeplink', 'submitDeepLink FAIL: missing context');
      throw new Error('Deep Linking context required (messageType LtiDeepLinkingRequest and deepLinkReturnUrl)');
    }

    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const canvasToken =
      (await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken)) ?? '';
    const submitUserId = await this.resolveCanvasUserIdForRestApi(ctx, canvasToken, domainOverride);

    let uploadBuffer = buffer;
    const tmp = writeBufferToTempWebmFile(buffer);
    try {
      let signToVoiceRequired = false;
      let deepgramKey = '';
      try {
        signToVoiceRequired = await this.resolveSignToVoiceRequired(
          ctx.courseId,
          ctx.assignmentId,
          domainOverride,
          canvasToken,
        );
        deepgramKey = (this.config.get<string>('DEEPGRAM_API_KEY') ?? process.env.DEEPGRAM_API_KEY ?? '').trim();
      } catch (e) {
        appendLtiLog('sign-to-voice', 'preupload (deeplink): resolve/config failed (using_original)', {
          error: String(e),
        });
      }
      const cap = await tryPreuploadSignToVoiceCaptionsMux({
        webmPath: tmp.path,
        originalSize: buffer.length,
        signToVoiceRequired,
        deepgramApiKey: deepgramKey,
      });
      if (cap.muxOutputPathForCleanup) {
        try {
          uploadBuffer = readFileSync(cap.nextPath);
          appendLtiLog('sign-to-voice', 'preupload (deeplink): using muxed WebM bytes', {
            bytes: uploadBuffer.length,
          });
        } finally {
          cleanupWebmVttMuxOutputPath(cap.muxOutputPathForCleanup);
        }
      }
    } finally {
      tmp.cleanup();
    }

    const token = this.deepLinkFileStore.set(uploadBuffer, contentType);
    this.deepLinkFileStore.registerSubmissionToken(ctx.courseId, ctx.assignmentId, submitUserId, token);
    const contentItemTitle = 'ASL Express Video Submission';
    appendLtiLog('prompt-deeplink', 'DeepLink content item title set', {
      contentItemTitle,
      note: 'Title is included in content_items[0].title in the deep link JWT.',
    });
    appendLtiLog('prompt-deeplink', 'submitDeepLink: calling buildResponseHtml (adds title to content item sent to Canvas)', {
      titlePassed: contentItemTitle,
      whatGetsSent: 'JWT with content_items[0].title = contentItemTitle; form POST to deep_link_return_url',
    });
    const html = await this.deepLinkResponse.buildResponseHtml(ctx, token, contentItemTitle);
    appendLtiLog('prompt-deeplink', 'submitDeepLink DONE (HTML form ready for Canvas)', {
      tokenPreview: token.slice(0, 8) + '...',
      contentItemTitlePassed: contentItemTitle,
    });

    if (process.env.NODE_ENV !== 'production') {
      return {
        html,
        dev: {
          message: 'Redirecting to Canvas.',
          delayMs: 2500,
          contentItemTitle,
          videoTitle: null,
        },
      };
    }
    return html;
  }

  /** Submission count for the visible assignment (for teacher UI). Uses ctx.assignmentId when present. */
  async getSubmissionCount(ctx: LtiContext): Promise<number> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return 0;
    const assignmentId = ctx.assignmentId?.trim() || (await this.getPrompterAssignmentId(ctx));
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const list = await this.canvas.listSubmissions(
      ctx.courseId,
      assignmentId,
      domainOverride,
      token,
    );
    return list.filter(
      (s) =>
        submissionHasFile(s) || !!this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, String(s.user_id ?? '')),
    ).length;
  }

  async getSubmissions(ctx: LtiContext): Promise<
    Array<{
      userId: string;
      userName?: string;
      body?: string;
      score?: number;
      grade?: string;
      submissionComments?: Array<{ id: number; comment: string }>;
      videoUrl?: string;
      promptHtml?: string;
      videoDurationSeconds: number | null;
      durationSource: 'submission' | 'prompts' | 'unknown';
      rubricAssessment?: Record<string, unknown>;
      captionsVtt?: string;
      mediaStimulus?: {
        kind: 'youtube';
        videoId: string;
        clipStartSec: number;
        clipEndSec: number;
        label?: string;
      };
      deckTimeline?: Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }>;
    }>
  > {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error(
        'Canvas token required: a teacher must complete OAuth or save a course API token (stored per course, not from server env).',
      );
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const list = await this.canvas.listSubmissions(
      ctx.courseId,
      assignmentId,
      domainOverride,
      token,
    );
    appendLtiLog('viewer', 'getSubmissions', { assignmentId });
    // Same filter as getSubmissionCount: only include actual submissions (submitted/graded or have video token)
    const submittedList = list.filter(
      (s) =>
        submissionHasFile(s) ||
        !!this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, String(s.user_id ?? '')),
    );
    appendLtiLog('viewer', 'getSubmissions result', { assignmentId, submittedCount: submittedList.length });
    const videoSubmittedAtByUser = new Map<string, number>();
    const baseRows = submittedList.map((s) => {
      const userId = String(s.user_id);
      const submittedAtRaw = (s as { submitted_at?: string }).submitted_at;
      const submittedAtMs = submittedAtRaw ? Date.parse(submittedAtRaw) : NaN;
      if (Number.isFinite(submittedAtMs)) {
        videoSubmittedAtByUser.set(userId, submittedAtMs);
      }
      const canvasVideoUrlRaw = getVideoUrlFromCanvasSubmission(s);
      let videoUrl = canvasVideoUrlRaw;
      if (!videoUrl) {
        const submissionToken = this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, userId);
        if (submissionToken) {
          videoUrl = `/api/prompt/submission/${encodeURIComponent(submissionToken)}`;
        }
      }
      videoUrl = this.toViewerVideoUrl(videoUrl, ctx) ?? videoUrl;
      const rubricAssessment = normalizeCanvasRubricAssessment(
        (s as { rubric_assessment?: Record<string, unknown> }).rubric_assessment,
      );
      return {
        userId,
        userName: s.user?.name,
        body: s.body,
        score: s.score,
        grade: s.grade,
        submissionComments:
          s.submission_comments
            ?.filter((c) => c.id != null && c.comment != null)
            .map((c) => ({ id: c.id!, comment: c.comment! })) ?? [],
        videoUrl,
        canvasVideoUrlRaw,
        ...(rubricAssessment ? { rubricAssessment } : {}),
      };
    });
    if (process.env.NODE_ENV !== 'production') {
      appendLtiLog('viewer', 'getSubmissions: video state', {
        rows: baseRows.map((r) => ({
          userId: r.userId,
          hasVideoUrl: !!r.videoUrl,
        })),
      });
    }
    let promptsFallbackDuration: number | null = null;
    try {
      const cfg = await this.getConfig(ctx);
      promptsFallbackDuration = this.totalDurationSecondsFromStoredPromptBanks(cfg);
    } catch {
      promptsFallbackDuration = null;
    }
    const webmLimit = this.getWebmProbeMaxConcurrent();
    const rowsWithPrompts = await mapWithConcurrency(
      baseRows,
      webmLimit,
      async (row) => {
        const { canvasVideoUrlRaw, ...publicRow } = row;
        const resolved = await this.resolvePromptRowFromWebmMetadata({
          assignmentId,
          userId: row.userId,
          token,
          canvasVideoUrl: canvasVideoUrlRaw,
          body: typeof row.body === 'string' ? row.body : undefined,
          submissionComments: row.submissionComments,
          promptsFallbackDuration,
        });
        const viewerSource = this.classifyGradingViewerPromptSource(
          typeof row.body === 'string' ? row.body : undefined,
          row.submissionComments,
          resolved.metadataPromptResolution,
        );
        appendLtiLog('viewer', 'getSubmissions: prompt-resolution-source', {
          userId: row.userId,
          assignmentId,
          promptTextSource: viewerSource,
          mediaStimulusSource: resolved.mediaStimulusResolutionSource,
          hasMediaStimulus: !!resolved.mediaStimulus,
        });
        let finalDeck = resolved.deckTimeline;
        if (finalDeck?.length) {
          finalDeck = (await this.enrichDeckTimelineWithSproutTokensFromDb(finalDeck)) ?? finalDeck;
        }
        return {
          ...publicRow,
          promptHtml: resolved.promptHtml,
          videoDurationSeconds: resolved.videoDurationSeconds,
          durationSource: resolved.durationSource,
          ...(resolved.captionsVtt ? { captionsVtt: resolved.captionsVtt } : {}),
          ...(resolved.mediaStimulus ? { mediaStimulus: resolved.mediaStimulus } : {}),
          ...(finalDeck?.length ? { deckTimeline: finalDeck } : {}),
        };
      },
    );
    for (const row of rowsWithPrompts) {
      appendLtiLog('duration', 'getSubmissions: submission row', {
        userId: row.userId,
        videoDurationSeconds: row.videoDurationSeconds,
        durationSource: row.durationSource,
      });
    }
    return rowsWithPrompts;
  }

  /**
   * Convert external Canvas video URL to our proxy URL for &lt;video src&gt; (no Bearer on requests).
   * Includes course_id and optional canvas_base for SSRF + per-course Canvas token lookup.
   * Our own /api/prompt/submission/ URLs are returned as-is. Resolves relative Canvas URLs.
   */
  toViewerVideoUrl(videoUrl: string | undefined, ctx?: LtiContext): string | undefined {
    if (!videoUrl) return undefined;
    if (videoUrl.startsWith('/api/prompt/')) return videoUrl; // our own endpoints
    if (videoUrl.startsWith('/')) {
      const base = ctx
        ? canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'))
        : undefined;
      if (base) {
        videoUrl = new URL(videoUrl, base).href;
      } else {
        return videoUrl; // can't resolve, return as-is (may 404)
      }
    }
    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) return videoUrl;
    const cid = (ctx?.courseId ?? '').trim();
    if (!cid) {
      return `/api/prompt/video-proxy?url=${encodeURIComponent(videoUrl)}`;
    }
    const canvasBase = ctx
      ? canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'))
      : undefined;
    let out = `/api/prompt/video-proxy?url=${encodeURIComponent(videoUrl)}&course_id=${encodeURIComponent(cid)}`;
    if (canvasBase) {
      out += `&canvas_base=${encodeURIComponent(canvasBase)}`;
    }
    return out;
  }

  async grade(
    ctx: LtiContext,
    userId: string,
    score: number,
    scoreMaximum: number,
    resultContent?: string,
    rubricAssessment?: Record<string, unknown>,
  ): Promise<{ score?: number; grade?: string }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const assignmentId = await this.getPrompterAssignmentId(ctx);

    if (rubricAssessment && Object.keys(rubricAssessment).length > 0) {
      return await this.canvas.putSubmissionGrade(
        ctx.courseId,
        assignmentId,
        userId,
        { rubricAssessment },
        domainOverride,
        token,
      );
    }
    const scoreMax = scoreMaximum > 0 ? scoreMaximum : 100;
    await this.ltiAgs.submitGradeViaAgs(ctx, {
      score,
      scoreMaximum: scoreMax,
      resultContent: resultContent ?? undefined,
      userId,
    });
    return { score };
  }

  /** Teacher only - guard applied at controller. */
  async addComment(
    ctx: LtiContext,
    userId: string,
    time: number,
    text: string,
    attempt?: number,
  ): Promise<{ commentId?: number }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const m = Math.floor(time / 60);
    const s = time % 60;
    const commentLine = `[${m}:${s < 10 ? '0' : ''}${s}] ${text}`;
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.addSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentLine,
      { attempt },
      domainOverride,
      token,
    );
  }

  async editComment(
    ctx: LtiContext,
    userId: string,
    commentId: string,
    time: number,
    text: string,
  ): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const m = Math.floor(time / 60);
    const s = time % 60;
    const commentLine = `[${m}:${s < 10 ? '0' : ''}${s}] ${text}`;
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.canvas.editSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentId,
      commentLine,
      domainOverride,
      token,
    );
  }

  /** Teacher only - guard applied at controller. */
  async deleteComment(ctx: LtiContext, userId: string, commentId: string): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.canvas.deleteSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentId,
      domainOverride,
      token,
    );
  }

  /** Teacher-only: inspect legacy machine JSON comments for student-visible cleanup (no auto-delete). */
  async getMachinePromptCommentCleanupStatus(
    ctx: LtiContext,
    userId: string,
  ): Promise<{
    userId: string;
    hasSubmissionVideo: boolean;
    bodyLooksLikeLegacyMachineJson: boolean;
    machinePromptCommentCandidates: Array<{ id: number; preview: string }>;
    wouldLosePromptIfAllMachineCommentsRemoved: boolean;
    hint: string;
  }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const sub = await this.canvas.getSubmissionFull(
      ctx.courseId,
      assignmentId,
      userId,
      domainOverride,
      token,
    );
    if (!sub) throw new BadRequestException('Submission not found');
    const canvasVideoUrlRaw = getVideoUrlFromCanvasSubmission(sub);
    const hasSubmissionVideo = !!(canvasVideoUrlRaw && String(canvasVideoUrlRaw).trim());
    const body = typeof sub.body === 'string' ? sub.body : undefined;
    let bodyLooksLikeLegacyMachineJson = false;
    const rawBody = (body ?? '').trim();
    if (rawBody.startsWith('{')) {
      try {
        const p = JSON.parse(rawBody) as Record<string, unknown>;
        bodyLooksLikeLegacyMachineJson = !!(
          (Array.isArray(p.deckTimeline) && p.deckTimeline.length > 0) ||
          (typeof p.promptSnapshotHtml === 'string' && p.promptSnapshotHtml.trim().length > 0) ||
          p.fsaslKind != null
        );
      } catch {
        bodyLooksLikeLegacyMachineJson = false;
      }
    }
    const comments =
      sub.submission_comments
        ?.filter((c) => c.id != null && c.comment != null)
        .map((c) => ({ id: c.id!, comment: c.comment! })) ?? [];
    const machinePromptCommentCandidates = comments
      .filter((c) => isMachinePromptJsonComment(c.comment))
      .map((c) => ({
        id: c.id,
        preview: (c.comment ?? '').trim().slice(0, 120),
      }));
    let promptsFallbackDuration: number | null = null;
    try {
      const cfg = await this.getConfig(ctx);
      promptsFallbackDuration = this.totalDurationSecondsFromStoredPromptBanks(cfg);
    } catch {
      promptsFallbackDuration = null;
    }
    const fullMerge = this.mergeBodyCommentAssignmentFallback(body, comments, promptsFallbackDuration);
    const withoutMachineComments = comments.filter((c) => !isMachinePromptJsonComment(c.comment));
    const withoutMachine = this.mergeBodyCommentAssignmentFallback(
      body,
      withoutMachineComments,
      promptsFallbackDuration,
    );
    const fullHas = (fullMerge.promptHtml ?? '').trim().length > 0;
    const withoutHas = (withoutMachine.promptHtml ?? '').trim().length > 0;
    const wouldLosePromptIfAllMachineCommentsRemoved = !hasSubmissionVideo && fullHas && !withoutHas;
    const hint =
      'You may delete only comments that look like machine prompt JSON (never [mm:ss] teacher feedback). Open this submission in the grading viewer first and confirm the prompt still displays. Usually safe when legacy JSON remains on the submission body or the video includes prompt metadata (PROMPT_DATA).';
    return {
      userId,
      hasSubmissionVideo,
      bodyLooksLikeLegacyMachineJson,
      machinePromptCommentCandidates,
      wouldLosePromptIfAllMachineCommentsRemoved,
      hint,
    };
  }

  /**
   * Teacher-only: remove machine prompt JSON comments after explicit confirmation.
   * Refuses if removal would leave no body/comment fallback prompt while the submission has no video.
   */
  async deleteMachinePromptSubmissionComments(
    ctx: LtiContext,
    userId: string,
    options: { teacherConfirmed: boolean; commentIds?: number[] },
  ): Promise<{ deletedIds: number[] }> {
    if (!options.teacherConfirmed) {
      throw new BadRequestException('teacherConfirmed must be true');
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const sub = await this.canvas.getSubmissionFull(
      ctx.courseId,
      assignmentId,
      userId,
      domainOverride,
      token,
    );
    if (!sub) throw new BadRequestException('Submission not found');
    const canvasVideoUrlRaw = getVideoUrlFromCanvasSubmission(sub);
    const hasSubmissionVideo = !!(canvasVideoUrlRaw && String(canvasVideoUrlRaw).trim());
    const body = typeof sub.body === 'string' ? sub.body : undefined;
    const comments =
      sub.submission_comments
        ?.filter((c) => c.id != null && c.comment != null)
        .map((c) => ({ id: c.id!, comment: c.comment! })) ?? [];
    const candidates = comments.filter((c) => isMachinePromptJsonComment(c.comment));
    let toDelete = candidates;
    if (options.commentIds?.length) {
      const want = new Set(options.commentIds);
      toDelete = candidates.filter((c) => want.has(c.id));
    }
    if (toDelete.length === 0) return { deletedIds: [] };

    let promptsFallbackDuration: number | null = null;
    try {
      const cfg = await this.getConfig(ctx);
      promptsFallbackDuration = this.totalDurationSecondsFromStoredPromptBanks(cfg);
    } catch {
      promptsFallbackDuration = null;
    }
    const fullMerge = this.mergeBodyCommentAssignmentFallback(body, comments, promptsFallbackDuration);
    const removeSet = new Set(toDelete.map((c) => c.id));
    const afterComments = comments.filter((c) => !removeSet.has(c.id));
    const afterMerge = this.mergeBodyCommentAssignmentFallback(body, afterComments, promptsFallbackDuration);
    const fullHas = (fullMerge.promptHtml ?? '').trim().length > 0;
    const afterHas = (afterMerge.promptHtml ?? '').trim().length > 0;
    if (!hasSubmissionVideo && fullHas && !afterHas) {
      throw new BadRequestException(
        'Refusing delete: the prompt may only exist in these machine comments. Ensure legacy JSON remains on the submission body or attach a video with prompt metadata before deleting.',
      );
    }

    const deletedIds: number[] = [];
    for (const c of toDelete) {
      await this.canvas.deleteSubmissionComment(
        ctx.courseId,
        assignmentId,
        userId,
        String(c.id),
        domainOverride,
        token,
      );
      deletedIds.push(c.id);
    }
    return { deletedIds };
  }

  async resetAttempt(ctx: LtiContext, userId: string): Promise<void> {
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    await this.promptDataRepo.recordStudentReset(ctx.courseId, assignmentId, userId);
  }

  /** Returns current user's submission for an assignment (student viewer via assignment comment link). */
  async getMySubmission(ctx: LtiContext): Promise<{
    userId: string;
    userName?: string;
    body?: string;
    score?: number;
    grade?: string;
    submissionComments?: Array<{ id: number; comment: string }>;
    videoUrl?: string;
    attempt?: number;
    rubricAssessment?: Record<string, unknown>;
    promptHtml?: string;
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'prompts' | 'unknown';
    /** From Canvas assignment `allowed_attempts` (-1 = unlimited). */
    allowedAttempts?: number;
    captionsVtt?: string;
    mediaStimulus?: {
      kind: 'youtube';
      videoId: string;
      clipStartSec: number;
      clipEndSec: number;
      label?: string;
    };
    deckTimeline?: Array<{ title: string; startSec: number; videoId?: string; securityToken?: string }>;
  } | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return null;
    const assignmentId = ctx.assignmentId?.trim();
    if (!assignmentId) return null;
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    let userId = resolveCanvasApiUserId(ctx);
    if (!userId) {
      userId = (await this.canvas.getCurrentCanvasUserId(domainOverride, token)) ?? undefined;
    }
    if (!userId) return null;
    const sub = await this.canvas.getSubmissionFull(
      ctx.courseId,
      assignmentId,
      userId,
      domainOverride,
      token,
    );
    if (!sub || (!ctx.roles?.toLowerCase().includes('instructor') && !sub.submitted_at)) return null;
    const canvasVideoUrlRaw = getVideoUrlFromCanvasSubmission(sub);
    let videoUrl = canvasVideoUrlRaw;
    if (!videoUrl) {
      const tok = this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, userId);
      if (tok) videoUrl = `/api/prompt/submission/${encodeURIComponent(tok)}`;
    }
    videoUrl = this.toViewerVideoUrl(videoUrl, ctx) ?? videoUrl;
    const mappedComments =
      sub.submission_comments
        ?.filter((c) => c.id != null && c.comment != null)
        .map((c) => ({ id: c.id!, comment: c.comment! })) ?? [];
    let allowedAttempts: number | undefined;
    try {
      const am = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
      if (am?.allowed_attempts != null && Number.isFinite(Number(am.allowed_attempts))) {
        allowedAttempts = Number(am.allowed_attempts);
      }
    } catch {
      allowedAttempts = undefined;
    }
    let promptsFallbackDuration: number | null = null;
    try {
      const cfg = await this.getConfig(ctx);
      promptsFallbackDuration = this.totalDurationSecondsFromStoredPromptBanks(cfg);
    } catch {
      promptsFallbackDuration = null;
    }
    const resolved = await this.resolvePromptRowFromWebmMetadata({
      assignmentId,
      userId,
      token,
      canvasVideoUrl: canvasVideoUrlRaw,
      body: typeof sub.body === 'string' ? sub.body : undefined,
      submissionComments: mappedComments,
      promptsFallbackDuration,
    });
    const viewerSource = this.classifyGradingViewerPromptSource(
      typeof sub.body === 'string' ? sub.body : undefined,
      mappedComments,
      resolved.metadataPromptResolution,
    );
    appendLtiLog('viewer', 'getMySubmission: prompt-resolution-source', {
      userId,
      assignmentId,
      promptTextSource: viewerSource,
      mediaStimulusSource: resolved.mediaStimulusResolutionSource,
      hasMediaStimulus: !!resolved.mediaStimulus,
    });
    let finalDeck = resolved.deckTimeline;
    if (finalDeck?.length) {
      finalDeck = (await this.enrichDeckTimelineWithSproutTokensFromDb(finalDeck)) ?? finalDeck;
    }
    return {
      userId,
      body: sub.body,
      score: sub.score,
      grade: sub.grade,
      submissionComments: mappedComments,
      videoUrl,
      attempt: sub.attempt ?? 1,
      rubricAssessment: normalizeCanvasRubricAssessment(
        sub.rubric_assessment as Record<string, unknown> | undefined,
      ),
      promptHtml: resolved.promptHtml,
      videoDurationSeconds: resolved.videoDurationSeconds,
      durationSource: resolved.durationSource,
      ...(allowedAttempts !== undefined ? { allowedAttempts } : {}),
      ...(resolved.captionsVtt ? { captionsVtt: resolved.captionsVtt } : {}),
      ...(resolved.mediaStimulus ? { mediaStimulus: resolved.mediaStimulus } : {}),
      ...(finalDeck?.length ? { deckTimeline: finalDeck } : {}),
    };
  }

  /** Teacher only - guard applied at controller. */
  async getAssignmentForGrading(ctx: LtiContext): Promise<{
    name?: string;
    pointsPossible?: number;
    rubric?: Array<unknown>;
    /** Course rubric template id when Canvas has a rubric association (mirrors hydrated prompt config). */
    rubricId?: string;
    /** Sprout account id for embed URLs (same source as flashcard / course settings). */
    sproutAccountId?: string;
    allowedAttempts?: number;
    promptMode?: 'text' | 'decks' | 'youtube';
    textPrompts?: string[];
    youtubeLabel?: string;
    /** Subset of youtube prompt config for stimulus UI (mask + student caption policy). */
    youtubePromptConfig?: {
      allowStudentCaptions: boolean;
      subtitleMask: { enabled: boolean; heightPercent: number };
    };
    signToVoiceRequired?: boolean;
  } | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return null;
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    const raw = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    if (!raw) return null;
    let rubric = Array.isArray(raw.rubric) && raw.rubric.length > 0 ? raw.rubric : null;
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const cfg =
      (await this.loadPromptConfigForAssignment(ctx.courseId, assignmentId, domainOverride, token, blob)) ?? undefined;
    if (!rubric) {
      const rubricIdForFetch =
        (raw.linkedRubricId ?? '').trim() || (cfg?.rubricId ?? '').trim();
      if (rubricIdForFetch) {
        const fetched = await this.canvas.getRubric(ctx.courseId, rubricIdForFetch, domainOverride, token);
        if (fetched?.length) rubric = fetched;
      }
    }
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
    const sproutAccountId = getSproutAccountId(this.config);
    const allowedAttempts =
      raw.allowed_attempts != null && Number.isFinite(Number(raw.allowed_attempts))
        ? Number(raw.allowed_attempts)
        : undefined;
    const promptMode = cfg?.promptMode;
    const textPrompts = Array.isArray(cfg?.prompts) ? cfg.prompts.map((p) => String(p ?? '')) : undefined;
    const youtubeLabel =
      cfg?.youtubePromptConfig?.label != null && String(cfg.youtubePromptConfig.label).trim()
        ? String(cfg.youtubePromptConfig.label).trim()
        : undefined;
    let youtubePromptConfigViewer:
      | {
          allowStudentCaptions: boolean;
          subtitleMask: { enabled: boolean; heightPercent: number };
        }
      | undefined;
    if (cfg?.promptMode === 'youtube' && cfg.youtubePromptConfig) {
      const y = cfg.youtubePromptConfig as {
        allowStudentCaptions?: boolean;
        subtitleMask?: { enabled?: boolean; heightPercent?: number };
      };
      let maskHp = Math.floor(Number(y.subtitleMask?.heightPercent));
      if (!Number.isFinite(maskHp)) maskHp = 15;
      maskHp = Math.min(30, Math.max(5, maskHp));
      youtubePromptConfigViewer = {
        allowStudentCaptions: y.allowStudentCaptions === true,
        subtitleMask: {
          enabled: !!y.subtitleMask?.enabled,
          heightPercent: maskHp,
        },
      };
    }
    const resolvedRubricId =
      (raw.linkedRubricId ?? '').trim() || (cfg?.rubricId ?? '').trim() || undefined;
    appendLtiLog('viewer', 'getAssignmentForGrading: sprout embed config snapshot', {
      assignmentId,
      hasSproutAccountId: !!sproutAccountId,
      sproutAccountIdLen: sproutAccountId ? sproutAccountId.length : 0,
      sproutAccountIdSuffix: sproutAccountId ? sproutAccountId.slice(-4) : '(none)',
      hasRubric: !!(rubric && Array.isArray(rubric) && rubric.length > 0),
      rubricId: resolvedRubricId ?? '(none)',
    });
    return {
      name,
      pointsPossible: raw.points_possible,
      rubric: rubric ?? undefined,
      ...(resolvedRubricId ? { rubricId: resolvedRubricId } : {}),
      sproutAccountId,
      ...(allowedAttempts !== undefined ? { allowedAttempts } : {}),
      ...(promptMode ? { promptMode } : {}),
      ...(textPrompts?.length ? { textPrompts } : {}),
      ...(youtubeLabel ? { youtubeLabel } : {}),
      ...(youtubePromptConfigViewer ? { youtubePromptConfig: youtubePromptConfigViewer } : {}),
      ...(cfg?.signToVoiceRequired === true ? { signToVoiceRequired: true } : {}),
    };
  }

  /** Teacher only. One Canvas assignment index fetch; configured rows + optional import lists for the client. */
  async getConfiguredAssignments(
    ctx: LtiContext,
    options?: { omitCanvasImport?: boolean },
  ): Promise<{
    configured: Array<{ id: string; name: string; submissionCount: number; ungradedCount: number }>;
    canvasImport?: { allAssignments: CanvasAssignmentBrief[]; settingsTitleCandidates: CanvasAssignmentBrief[] };
  }> {
    const omitCanvasImport = options?.omitCanvasImport === true;
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      return omitCanvasImport
        ? { configured: [] }
        : { configured: [], canvasImport: { allAssignments: [], settingsTitleCandidates: [] } };
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = blob?.configs ?? {};
    const assignmentIds = Array.from(
      new Set([
        ...Object.keys(configs).filter(Boolean),
        ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
      ]),
    );
    const result: Array<{ id: string; name: string; submissionCount: number; ungradedCount: number }> = [];
    let assignmentNamesById: Map<string, string> | null = null;
    let fullCourseList: CanvasAssignmentBrief[] = [];
    try {
      fullCourseList = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
      if (fullCourseList.length > 0) {
        assignmentNamesById = new Map(
          fullCourseList.map((a) => [String(a.id).trim(), String(a.name ?? '').trim()]),
        );
      } else {
        appendLtiLog('prompt', 'getConfiguredAssignments: assignment list empty; using per-assignment fallback to avoid false negatives', {
          configCount: assignmentIds.length,
        });
      }
    } catch (err) {
      appendLtiLog('prompt', 'getConfiguredAssignments: listAssignmentsForPromptImport failed; falling back to per-assignment checks', {
        error: String(err),
      });
    }
    type SubRow = {
      user_id?: number;
      attachment?: { url?: string; download_url?: string };
      attachments?: Array<{ url?: string; download_url?: string }>;
      versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
      workflow_state?: string;
    };
    const configuredRows = await Promise.all(
      assignmentIds.map(async (aid) => {
        let assignmentExists = false;
        let assignmentNameFromCanvas: string | undefined;
        if (assignmentNamesById) {
          assignmentNameFromCanvas = assignmentNamesById.get(aid);
          assignmentExists = assignmentNameFromCanvas != null;
        } else {
          const assign = await this.canvas.getAssignment(ctx.courseId, aid, domainOverride, token);
          assignmentExists = !!assign;
          assignmentNameFromCanvas = assign?.name;
        }
        if (!assignmentExists) return null;
        let list: SubRow[] = [];
        try {
          list = await this.canvas.listSubmissions(ctx.courseId, aid, domainOverride, token);
        } catch {
          /* assignment exists but submissions may fail; use empty list */
        }
        const name = assignmentNameFromCanvas ?? configs[aid]?.assignmentName ?? `Assignment ${aid}`;
        const withFiles = list.filter(
          (s) => submissionHasFile(s) || !!this.deepLinkFileStore.getSubmissionToken(ctx.courseId, aid, String(s.user_id ?? '')),
        );
        const submissionCount = withFiles.length;
        const ungradedCount = withFiles.filter((s) => s.workflow_state !== 'graded').length;
        return { id: aid, name, submissionCount, ungradedCount };
      }),
    );
    for (const row of configuredRows) {
      if (row) result.push(row);
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    appendLtiLog('viewer', 'getConfiguredAssignments', {
      count: result.length,
      assignments: result.map((a) => ({ id: a.id, name: a.name, submissionCount: a.submissionCount })),
    });
    const canvasImport = omitCanvasImport ? undefined : buildCanvasImportListsFromAssignments(fullCourseList);
    return canvasImport ? { configured: result, canvasImport } : { configured: result };
  }

  /**
   * Teacher only. Remove assignment from Prompt Manager course settings blob only.
   * The Canvas assignment is not deleted.
   */
  async removeConfiguredAssignmentFromPrompts(ctx: LtiContext, assignmentId: string): Promise<void> {
    const aid = (assignmentId ?? '').trim();
    if (!aid) throw new Error('assignmentId is required');
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    appendLtiLog('prompt', 'remove-from-prompts: start', {
      assignmentId: aid,
      courseId: ctx.courseId,
    });
    await this.removeConfiguredAssignmentFromPromptManagerBlob(ctx.courseId, aid, domainOverride, token);
    appendLtiLog('prompt', 'remove-from-prompts: done', { assignmentId: aid });
  }

  private async removeConfiguredAssignmentFromPromptManagerBlob(
    courseId: string,
    assignmentId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<void> {
    const aid = assignmentId.trim();
    const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    if (!blob) {
      appendLtiLog('prompt', 'configured-assignment-blob: no blob', { assignmentId: aid });
      return;
    }
    const configs = { ...(blob?.configs ?? {}) };
    const hadMonolithic = configs[aid] !== undefined;
    if (hadMonolithic) {
      delete configs[aid];
    }
    const priorIds = Array.isArray(blob.configuredAssignmentIds) ? blob.configuredAssignmentIds : [];
    const hadInIndex = priorIds.map(String).includes(aid);
    const nextIds = priorIds.filter((x) => String(x) !== aid);
    const rlmPrev = blob.resourceLinkAssignmentMap ?? {};
    const rlm = { ...rlmPrev };
    let rlmTouched = false;
    for (const k of Object.keys(rlm)) {
      if (String(rlm[k]) === aid) {
        delete rlm[k];
        rlmTouched = true;
      }
    }
    if (hadMonolithic || hadInIndex || rlmTouched) {
      const payload: PromptManagerSettingsBlob = {
        ...blob,
        v: 1,
        configs,
        configuredAssignmentIds: nextIds,
        resourceLinkAssignmentMap: rlm,
        updatedAt: new Date().toISOString(),
      };
      await writePromptManagerSettingsBlobToCanvas(this.canvas, {
        courseId,
        domainOverride,
        token,
        blob: payload,
        allowConfigShrink: true,
      });
      appendLtiLog('prompt', 'configured-assignment-blob: cleaned', { assignmentId: aid });
    } else {
      appendLtiLog('prompt', 'configured-assignment-blob: no entry', { assignmentId: aid });
    }
  }

  /** Teacher only. Delete a configured assignment in Canvas and remove it from Prompt Manager Settings blob. */
  async deleteConfiguredAssignment(ctx: LtiContext, assignmentId: string): Promise<void> {
    const aid = (assignmentId ?? '').trim();
    if (!aid) throw new Error('assignmentId is required');
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    appendLtiLog('prompt', 'delete-assignment: start', {
      assignmentId: aid,
      courseId: ctx.courseId,
    });

    try {
      await this.canvas.deleteAssignment(ctx.courseId, aid, domainOverride, token);
      appendLtiLog('prompt', 'delete-assignment: Canvas assignment deleted', { assignmentId: aid });
    } catch (err) {
      // 404 means assignment already gone; still clean settings blob.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('404')) throw err;
      appendLtiLog('prompt', 'delete-assignment: Canvas assignment already missing', { assignmentId: aid });
    }

    await this.removeConfiguredAssignmentFromPromptManagerBlob(ctx.courseId, aid, domainOverride, token);
  }

  /** Teacher only. Returns course assignment groups for teacher config. */
  async getAssignmentGroups(ctx: LtiContext): Promise<Array<{ id: number; name: string }>> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return [];
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.listAssignmentGroups(ctx.courseId, domainOverride, token);
  }

  /** Teacher only. Returns course rubrics for teacher config. */
  async getRubrics(ctx: LtiContext): Promise<Array<{ id: string; title: string; pointsPossible: number }>> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return [];
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.listRubrics(ctx.courseId, domainOverride, token);
  }

  /** Teacher only. Create a new assignment group in the course. */
  async createAssignmentGroup(
    ctx: LtiContext,
    name: string,
  ): Promise<{ id: number; name: string }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.createAssignmentGroup(ctx.courseId, name.trim() || 'New Group', domainOverride, token);
  }

  /** Teacher only. Returns course modules for module selector. */
  async getModules(ctx: LtiContext): Promise<Array<{ id: number; name: string; position: number }>> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return [];
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.listModules(ctx.courseId, domainOverride, token);
  }

  /** Teacher only. Create a new module in the course. Position is 1-based. */
  async createModule(
    ctx: LtiContext,
    name: string,
    position?: number,
  ): Promise<{ id: number; name: string; position: number }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.createModule(
      ctx.courseId,
      name.trim() || 'New Module',
      position != null ? { position } : undefined,
      domainOverride,
      token,
    );
  }

  /** Defaults for a Canvas assignment that should appear in Prompt Manager but has no blob entry yet. */
  private async buildDefaultPromptConfigForCanvasAssignment(
    courseId: string,
    assignmentId: string,
    canvasAssignmentName: string,
    moduleIdTrim: string,
    domainOverride: string | undefined,
    token: string,
    seedFromCanvas?: Awaited<ReturnType<CanvasService['getAssignment']>> | null,
  ): Promise<PromptConfigJson> {
    let name = canvasAssignmentName.trim() || 'ASL Express Assignment';
    let assignmentGroupId: string | undefined;
    let rubricId: string | undefined;
    const applyCanvasFields = (assign: Awaited<ReturnType<CanvasService['getAssignment']>> | null) => {
      if (!assign) return;
      if (assign.name && String(assign.name).trim()) name = String(assign.name).trim();
      if (assign.assignment_group_id != null) {
        assignmentGroupId = String(assign.assignment_group_id);
      }
      const linkedRid = (assign.linkedRubricId ?? '').trim();
      if (linkedRid) rubricId = linkedRid;
    };
    applyCanvasFields(seedFromCanvas ?? null);
    const needFetch = assignmentGroupId === undefined || rubricId === undefined;
    if (needFetch) {
      try {
        const assign = await this.canvas.getAssignment(courseId, assignmentId, domainOverride, token);
        applyCanvasFields(assign);
      } catch {
        /* keep seeded / name */
      }
    }
    return {
      minutes: 5,
      prompts: [],
      accessCode: '',
      assignmentName: name,
      ...(assignmentGroupId ? { assignmentGroupId } : {}),
      ...(rubricId ? { rubricId } : {}),
      moduleId: moduleIdTrim,
      promptMode: 'text',
    };
  }

  /** Teacher only. Creates a Canvas assignment (file + text submission types) and adds entry to configs map.
   * Pass assignmentGroupId (or create via newGroupName) to place in correct group (matches PHP). */
  async createPromptManagerAssignment(
    ctx: LtiContext,
    name: string,
    options?: { assignmentGroupId?: string; newGroupName?: string; moduleId?: string },
  ): Promise<{ assignmentId: string }> {
    appendLtiLog('prompt', 'create-assignment: createPromptManagerAssignment called', {
      name,
      optionsAssignmentGroupId: options?.assignmentGroupId ?? '(none)',
      optionsNewGroupName: options?.newGroupName ?? '(none)',
      optionsModuleId: options?.moduleId?.trim() ?? '(none)',
    });
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);

    let assignmentGroupId: number | undefined;
    if (options?.assignmentGroupId === '__new__' && options?.newGroupName?.trim()) {
      const newGroupName = options.newGroupName.trim();
      appendLtiLog('prompt', 'create-group', {
        action: 'create-group',
        nameReceived: newGroupName,
        nameBeingSent: newGroupName,
      });
      const newGroup = await this.canvas.createAssignmentGroup(
        ctx.courseId,
        newGroupName,
        domainOverride,
        token,
      );
      assignmentGroupId = newGroup.id;
      appendLtiLog('prompt', 'create-assignment: new group created', { name: newGroup.name, id: newGroup.id });
    } else if (options?.assignmentGroupId?.trim() && options.assignmentGroupId !== '__new__') {
      assignmentGroupId = parseInt(options.assignmentGroupId, 10);
      appendLtiLog('prompt', 'create-assignment: using group from dropdown', { assignmentGroupId });
    }

    appendLtiLog('prompt', 'create-assignment: calling canvas.createAssignment', {
      name,
      assignmentGroupId: assignmentGroupId ?? '(none - will use Canvas default)',
    });
    const assignmentId = await this.canvas.createAssignment(
      ctx.courseId,
      name.trim() || 'ASL Express Assignment',
      {
        // Match PHP / legacy behavior: file + structured prompt snapshot (body uses online_text_entry; file via upload).
        submissionTypes: ['online_upload', 'online_text_entry'],
        pointsPossible: 100,
        published: true,
        description: 'ASL video submission via ASL Express',
        assignmentGroupId,
        tokenOverride: token,
      },
      domainOverride,
    );
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const moduleIdTrim = (options?.moduleId ?? '').trim();
    const defaultCfg: PromptConfigJson = {
      minutes: 5,
      prompts: [],
      accessCode: '',
      assignmentName: name,
      ...(assignmentGroupId != null ? { assignmentGroupId: String(assignmentGroupId) } : {}),
      ...(moduleIdTrim ? { moduleId: moduleIdTrim } : {}),
      promptMode: 'text',
    };
    const defaultVisible = 'ASL video submission via ASL Express';
    const fullDesc = mergeAssignmentDescriptionWithEmbeds(defaultVisible, defaultCfg, defaultCfg.prompts);
    await this.canvas.updateAssignment(
      ctx.courseId,
      assignmentId,
      { description: fullDesc },
      domainOverride,
      token,
    );
    const newIdSet = new Set<string>([
      ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
      ...Object.keys(blob?.configs ?? {}),
    ]);
    newIdSet.add(assignmentId);
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs: {},
      configuredAssignmentIds: Array.from(newIdSet).filter((x) => /^\d+$/.test(x)),
      updatedAt: new Date().toISOString(),
    };
    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId: ctx.courseId,
      domainOverride,
      token,
      blob: payload,
    });
    if (moduleIdTrim) {
      try {
        await this.canvas.addAssignmentToModule(
          ctx.courseId,
          moduleIdTrim,
          assignmentId,
          domainOverride,
          token,
        );
      } catch (modErr) {
        appendLtiLog('prompt', 'create-assignment: addAssignmentToModule failed (assignment exists; fix in Canvas)', {
          assignmentId,
          moduleId: moduleIdTrim,
          error: String(modErr),
        });
        throw modErr;
      }
    }
    appendLtiLog('prompt', 'create-assignment: completed successfully', {
      assignmentId,
      courseId: ctx.courseId,
    });
    return { assignmentId };
  }

  private normalizePromptImportPayload(
    blob: NonNullable<ImportPromptManagerBlobDto['blob']>,
  ): PromptManagerSettingsBlob {
    const { blob: repaired, notes } = repairPromptManagerSettingsBlobFromUnknown(blob as unknown);
    if (notes.length > 0) {
      appendLtiLog('prompt-import', 'normalizePromptImportPayload: repaired blob', {
        noteCount: notes.length,
        notes: notes.slice(0, 12),
      });
    }
    return repaired;
  }

  private clearCrossCoursePromptFields(cfg: PromptConfigJson): PromptConfigJson {
    const n = { ...cfg } as PromptConfigJson & { resolvedAssignmentId?: string };
    delete n.moduleId;
    delete n.assignmentGroupId;
    delete n.rubricId;
    delete n.rubricTitle;
    delete n.rubricPointsPossible;
    delete n.resolvedAssignmentId;
    return n;
  }

  /**
   * When importing into Prompt Manager, prefer the Canvas assignment's student-facing description as
   * `instructions`.
   *
   * Important: when Canvas explicitly returns an empty string, we preserve that and clear any
   * inherited/source instructions so imported config matches the actual assignment description.
   */
  private canvasDescriptionForInstructionsImport(description: string | null | undefined): string | undefined {
    if (typeof description !== 'string') return undefined;
    return description.trim();
  }

  /**
   * Prefer fields from the course assignment index (`listAssignmentsForPromptImport`)
   * over a single-assignment GET so import uses the same payload as the teacher's first fetch.
   */
  private mergeCourseAssignmentListRowWithFetchedAssignment(
    row:
      | {
          id: string;
          name: string;
          description?: string;
          linkedRubricId?: string;
          pointsPossible?: number;
          allowedAttempts?: number;
          assignmentGroupId?: string;
        }
      | undefined,
    fetched: Awaited<ReturnType<CanvasService['getAssignment']>>,
  ): Awaited<ReturnType<CanvasService['getAssignment']>> | null {
    if (!row && !fetched) return null;
    const base = fetched ?? {};
    const name =
      (row?.name ?? '').trim() || (typeof base.name === 'string' ? base.name.trim() : '') || undefined;
    // For import hydration, prefer the direct assignment GET description when present.
    // Assignment list rows can occasionally carry empty/trimmed descriptions.
    const fetchedDescription =
      typeof base.description === 'string' ? base.description : undefined;
    const rowDescription =
      row && typeof row.description === 'string' ? row.description : undefined;
    const description =
      fetchedDescription !== undefined &&
      fetchedDescription.trim().length > 0
        ? fetchedDescription
        : rowDescription !== undefined
          ? rowDescription
          : fetchedDescription;
    const rubricFromRow = (row?.linkedRubricId ?? '').trim();
    const linkedRubricId = rubricFromRow || base.linkedRubricId;
    const points_possible =
      row?.pointsPossible != null && Number.isFinite(row.pointsPossible)
        ? row.pointsPossible
        : base.points_possible;
    const allowed_attempts =
      row?.allowedAttempts != null && Number.isFinite(row.allowedAttempts)
        ? row.allowedAttempts
        : base.allowed_attempts;
    const groupFromRow =
      row?.assignmentGroupId != null && `${row.assignmentGroupId}`.trim() !== ''
        ? Number.parseInt(String(row.assignmentGroupId), 10)
        : NaN;
    const assignment_group_id = Number.isFinite(groupFromRow)
      ? groupFromRow
      : base.assignment_group_id;
    return {
      ...base,
      ...(name ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(linkedRubricId ? { linkedRubricId } : {}),
      ...(points_possible != null ? { points_possible } : {}),
      ...(allowed_attempts != null ? { allowed_attempts } : {}),
      ...(assignment_group_id != null && !Number.isNaN(assignment_group_id)
        ? { assignment_group_id }
        : {}),
    };
  }

  /**
   * Enrich imported config with Canvas-backed fields so Prompt Manager data reflects attached
   * rubric/instructions immediately after import.
   */
  private applyCanvasAssignmentImportHydration(
    cfg: PromptConfigJson,
    assign: Awaited<ReturnType<CanvasService['getAssignment']>>,
  ): PromptConfigJson {
    if (!assign) return cfg;
    let next = { ...cfg };
    const fromCanvas = this.canvasDescriptionForInstructionsImport(assign.description);
    if (fromCanvas !== undefined) {
      next = { ...next, instructions: fromCanvas };
    }
    const linkedRubricId = (assign.linkedRubricId ?? '').trim();
    if (linkedRubricId) {
      next = { ...next, rubricId: linkedRubricId };
    }
    appendLtiLog('prompt-import', 'applyCanvasAssignmentImportHydration', {
      assignmentSnapshot: {
        name: assign.name ?? '(none)',
        pointsPossible: assign.points_possible ?? '(none)',
        allowedAttempts: assign.allowed_attempts ?? '(none)',
        descriptionLen: typeof assign.description === 'string' ? assign.description.length : 0,
        linkedRubricId: assign.linkedRubricId ?? '(none)',
      },
      resultingConfig: {
        assignmentName: next.assignmentName ?? '(none)',
        pointsPossible: next.pointsPossible ?? '(none)',
        allowedAttempts: next.allowedAttempts ?? '(none)',
        instructionsLen: typeof next.instructions === 'string' ? next.instructions.length : 0,
        rubricId: next.rubricId ?? '(none)',
      },
    });
    return next;
  }

  /**
   * Import hydration must not silently miss assignment descriptions.
   * Try the effective token first, then fall back to the course-stored teacher token when different.
   */
  private async getAssignmentForImportHydration(
    ctx: LtiContext,
    assignmentId: string,
    domainOverride: string | undefined,
    effectiveToken: string,
  ): Promise<{
    assignment: Awaited<ReturnType<CanvasService['getAssignment']>> | null;
    tokenSource: 'effective' | 'course_stored' | 'none';
  }> {
    const primary = await this.canvas.getAssignment(
      ctx.courseId,
      assignmentId,
      domainOverride,
      effectiveToken,
    );
    if (primary) return { assignment: primary, tokenSource: 'effective' };

    const courseStoredToken = await this.courseSettings.getCourseStoredCanvasToken(ctx.courseId);
    if (courseStoredToken?.trim() && courseStoredToken !== effectiveToken) {
      try {
        const fallback = await this.canvas.getAssignment(
          ctx.courseId,
          assignmentId,
          domainOverride,
          courseStoredToken,
        );
        if (fallback) {
          appendLtiLog('prompt-import', 'import hydration: assignment read via course-stored token fallback', {
            assignmentId,
          });
          return { assignment: fallback, tokenSource: 'course_stored' };
        }
      } catch (e) {
        appendLtiLog('prompt-import', 'import hydration: course-stored token fallback read failed', {
          assignmentId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { assignment: null, tokenSource: 'none' };
  }

  /** Teacher: full Prompt Manager settings blob for backup / cross-course import. */
  async exportPromptManagerSettingsBlob(ctx: LtiContext): Promise<PromptManagerSettingsBlob> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const blob = await readPromptManagerSettingsBlobWithEmbedsResolved(
      this.canvas,
      ctx.courseId,
      domainOverride,
      token,
    );
    return (
      blob ?? {
        v: 1,
        configs: {},
        updatedAt: new Date().toISOString(),
      }
    );
  }

  /**
   * Teacher: merge or replace_selected Prompt Manager configs from JSON or another course.
   * Drops resourceLinkAssignmentMap; clears module/group/rubric on imported configs.
   */
  async importPromptManagerSettingsBlob(
    ctx: LtiContext,
    dto: ImportPromptManagerBlobDto,
  ): Promise<
    | { dryRun: true; conflicts: Array<{ oldId: string; name: string; candidates: CanvasAssignmentBrief[] }>; unmatched: Array<{ oldId: string; name: string }>; map: Record<string, string> }
    | {
        dryRun?: false;
        imported: number;
        staleAssignmentIds: string[];
        removedSourceSettingsAssignment?: boolean;
        removeSourceAssignmentError?: string;
        submissionTypeUpdateFailures?: Array<{ assignmentId: string; error: string }>;
        ltiPlacementFailures?: Array<{ assignmentId: string; error: string }>;
      }
  > {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    const skip = new Set((dto.skipSourceAssignmentIds ?? []).map((s) => s.trim()).filter(Boolean));

    let sourceBlob: PromptManagerSettingsBlob;
    const sourceCourseTrim = (dto.sourceCourseId ?? '').trim();
    const sourceAssignmentTrim = (dto.sourceAssignmentId ?? '').trim();
    const sourceCount =
      (sourceCourseTrim ? 1 : 0) + (sourceAssignmentTrim ? 1 : 0) + (dto.blob != null ? 1 : 0);
    if (sourceCount !== 1) {
      throw new BadRequestException('Provide exactly one of: blob, sourceCourseId, or sourceAssignmentId');
    }
    if (sourceCourseTrim) {
      try {
        const b = await readPromptManagerSettingsBlobWithEmbedsResolved(
          this.canvas,
          sourceCourseTrim,
          domainOverride,
          token,
        );
        const { blob: rb } = repairPromptManagerSettingsBlobFromUnknown(b ?? {});
        if (!rb.configs || Object.keys(rb.configs).length === 0) {
          throw new BadRequestException('No Prompt Manager settings found in source course');
        }
        sourceBlob = {
          v: 1,
          configs: { ...rb.configs },
          updatedAt: new Date().toISOString(),
        };
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: source course read failed', {
          sourceCourseId: sourceCourseTrim,
          error: String(e),
        });
        throw new BadRequestException(
          `Could not read Prompt Manager settings from course ${sourceCourseTrim}. Ensure your Canvas token can access that course.`,
        );
      }
    } else if (sourceAssignmentTrim) {
      try {
        const b = await readPromptManagerSettingsBlobFromCanvasAssignmentDescription(
          this.canvas,
          ctx.courseId,
          sourceAssignmentTrim,
          domainOverride,
          token,
        );
        const { blob: rb } = repairPromptManagerSettingsBlobFromUnknown(b ?? {});
        if (!rb.configs || Object.keys(rb.configs).length === 0) {
          throw new BadRequestException(
            'No Prompt Manager settings JSON found in that assignment description. Pick an assignment whose description contains the exported settings.',
          );
        }
        sourceBlob = {
          v: 1,
          configs: { ...rb.configs },
          updatedAt: new Date().toISOString(),
        };
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: source assignment read failed', {
          sourceAssignmentId: sourceAssignmentTrim,
          error: String(e),
        });
        throw new BadRequestException(
          'Could not read Prompt Manager settings from the selected Canvas assignment. Check the assignment id and OAuth access.',
        );
      }
    } else if (dto.blob) {
      sourceBlob = this.normalizePromptImportPayload(dto.blob);
    } else {
      throw new BadRequestException('Provide blob, sourceCourseId, or sourceAssignmentId');
    }

    const sourceConfigs = { ...sourceBlob.configs };
    for (const sid of skip) {
      delete sourceConfigs[sid];
    }
    const sourceKeys = Object.keys(sourceConfigs);
    if (sourceKeys.length === 0) {
      throw new BadRequestException('Nothing to import after skip list');
    }

    const targetList = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
    const targetIds = new Set(targetList.map((a) => a.id));
    let sourceList: CanvasAssignmentBrief[] | null = null;
    if (sourceCourseTrim) {
      sourceList = await this.listAssignmentsForPromptImportCached(sourceCourseTrim, domainOverride, token);
    } else if (sourceAssignmentTrim) {
      sourceList = targetList;
    }

    const manual = { ...(dto.assignmentIdMap ?? {}) };
    const conflicts: Array<{ oldId: string; name: string; candidates: CanvasAssignmentBrief[] }> = [];
    const unmatched: Array<{ oldId: string; name: string }> = [];
    const map: Record<string, string> = {};

    for (const oldId of sourceKeys) {
      if (manual[oldId]) {
        map[oldId] = manual[oldId];
        continue;
      }
      if (targetIds.has(oldId)) {
        map[oldId] = oldId;
        continue;
      }
      const name =
        (sourceList?.find((a) => a.id === oldId)?.name ?? '').trim() ||
        (sourceConfigs[oldId]?.assignmentName ?? '').trim();
      if (!name) {
        unmatched.push({ oldId, name: '' });
        continue;
      }
      const r = resolveAssignmentIdByName(name, targetList);
      if (r.status === 'matched') map[oldId] = r.newId;
      else if (r.status === 'conflict') conflicts.push({ oldId, name, candidates: r.candidates });
      else unmatched.push({ oldId, name });
    }

    if (dto.dryRun) {
      return { dryRun: true, conflicts, unmatched, map };
    }
    if (conflicts.length > 0 || unmatched.length > 0) {
      throw new HttpException(
        {
          message: 'Resolve name conflicts and unmatched assignments (use assignmentIdMap or skipSourceAssignmentIds), or call with dryRun to preview.',
          conflicts,
          unmatched,
          partialMap: map,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const targetModuleTrim = (dto.targetModuleId ?? '').trim();
    if (!targetModuleTrim) {
      throw new BadRequestException(
        'targetModuleId is required when applying an import. Choose the Canvas module where each imported assignment and the Prompter tool placement should appear.',
      );
    }

    const remappedConfigs: Record<string, PromptConfigJson> = {};
    for (const oldId of sourceKeys) {
      const nid = map[oldId];
      if (!nid) continue;
      const base = sourceConfigs[oldId];
      if (!base) continue;
      remappedConfigs[nid] = {
        ...this.clearCrossCoursePromptFields({ ...base }),
        moduleId: targetModuleTrim,
      };
    }

    const targetBlob = await readPromptManagerSettingsBlobFromCanvas(this.canvas, ctx.courseId, domainOverride, token);
    const existingConfigs = { ...(targetBlob?.configs ?? {}) };
    let mergedConfigs: Record<string, PromptConfigJson>;
    if (dto.mode === 'replace_selected') {
      const replaceKeys =
        dto.replaceSourceAssignmentIds && dto.replaceSourceAssignmentIds.length > 0
          ? dto.replaceSourceAssignmentIds
          : sourceKeys;
      mergedConfigs = { ...existingConfigs };
      for (const oldId of replaceKeys) {
        const nid = map[oldId];
        if (nid && remappedConfigs[nid]) mergedConfigs[nid] = remappedConfigs[nid];
      }
    } else {
      mergedConfigs = { ...existingConfigs, ...remappedConfigs };
    }

    const importedAssignmentIds = Object.keys(remappedConfigs).filter((id) => targetIds.has(id));
    const instructionHydrationFailures: Array<{ assignmentId: string; reason: string }> = [];
    await Promise.all(
      importedAssignmentIds.map(async (aid) => {
        try {
          const { assignment: assign } = await this.getAssignmentForImportHydration(
            ctx,
            aid,
            domainOverride,
            token,
          );
          if (!assign) {
            instructionHydrationFailures.push({
              assignmentId: aid,
              reason: 'assignment_unreadable',
            });
            appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: assignment unreadable; instructions hydration skipped', {
              assignmentId: aid,
            });
            return;
          }
          if (mergedConfigs[aid]) {
            mergedConfigs[aid] = this.applyCanvasAssignmentImportHydration(mergedConfigs[aid], assign);
            appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: hydrated assignment config', {
              assignmentId: aid,
              hydratedConfig: {
                assignmentName: mergedConfigs[aid].assignmentName ?? '(none)',
                pointsPossible: mergedConfigs[aid].pointsPossible ?? '(none)',
                allowedAttempts: mergedConfigs[aid].allowedAttempts ?? '(none)',
                instructionsLen:
                  typeof mergedConfigs[aid].instructions === 'string'
                    ? mergedConfigs[aid].instructions.length
                    : 0,
                rubricId: mergedConfigs[aid].rubricId ?? '(none)',
              },
            });
          }
        } catch (e) {
          appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: Canvas hydration skipped', {
            assignmentId: aid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );

    for (const aid of Object.keys(mergedConfigs)) {
      if (!targetIds.has(aid)) continue;
      const c0 = mergedConfigs[aid];
      if (!c0) continue;
      const pm = c0.promptMode;
      if (pm !== 'text' && pm !== 'decks' && pm !== 'youtube') {
        mergedConfigs[aid] = { ...c0, promptMode: inferPromptModeFromStructuredConfig(c0) };
      }
    }

    for (const aid of Object.keys(mergedConfigs)) {
      if (!targetIds.has(aid)) continue;
      const c = mergedConfigs[aid];
      if (!c) continue;
      const inst = typeof c.instructions === 'string' ? c.instructions : '';
      const fullD = mergeAssignmentDescriptionWithEmbeds(inst, c, c.prompts);
      try {
        await this.canvas.updateAssignment(ctx.courseId, aid, { description: fullD }, domainOverride, token);
      } catch (e) {
        appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: assignment description embed write failed', {
          assignmentId: aid,
          error: String(e),
        });
        throw e;
      }
    }
    const allConfigured = new Set<string>([
      ...Object.keys(mergedConfigs).filter((x) => targetIds.has(x)),
      ...(Array.isArray(targetBlob?.configuredAssignmentIds) ? targetBlob.configuredAssignmentIds : []),
    ]);
    const outBlob: PromptManagerSettingsBlob = {
      ...targetBlob,
      v: 1,
      configs: {},
      resourceLinkAssignmentMap: {},
      configuredAssignmentIds: Array.from(allConfigured).filter((x) => /^\d+$/.test(x)),
      updatedAt: new Date().toISOString(),
    };
    appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: about to write course index blob', {
      importedCount: importedAssignmentIds.length,
      configuredIdCount: outBlob.configuredAssignmentIds?.length ?? 0,
      sampleImportedConfigs: importedAssignmentIds.slice(0, 10).map((aid) => {
        const c = mergedConfigs[aid] ?? {};
        return {
          assignmentId: aid,
          assignmentName: c.assignmentName ?? '(none)',
          pointsPossible: c.pointsPossible ?? '(none)',
          allowedAttempts: c.allowedAttempts ?? '(none)',
          instructionsLen: typeof c.instructions === 'string' ? c.instructions.length : 0,
          rubricId: c.rubricId ?? '(none)',
        };
      }),
    });

    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId: ctx.courseId,
      domainOverride,
      token,
      blob: outBlob,
      allowConfigShrink: true,
    });

    const submissionTypeUpdateFailures: Array<{ assignmentId: string; error: string }> = [];
    for (const aid of Object.keys(remappedConfigs)) {
      if (!targetIds.has(aid)) continue;
      try {
        await this.canvas.ensureAssignmentExpressSubmissionTypes(ctx.courseId, aid, domainOverride, token);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        submissionTypeUpdateFailures.push({ assignmentId: aid, error: err });
        appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: submission_types update failed', {
          assignmentId: aid,
          error: err,
        });
      }
    }

    const ltiPlacementFailures: Array<{ assignmentId: string; error: string }> = [];
    for (const aid of importedAssignmentIds) {
      const c = mergedConfigs[aid];
      const displayName = (c?.assignmentName ?? '').trim() || targetList.find((a) => a.id === aid)?.name || aid;
      try {
        await this.ensurePrompterLtiAboveAssignmentInModule(ctx, {
          courseId: ctx.courseId,
          assignmentId: aid,
          moduleId: targetModuleTrim,
          assignmentDisplayName: displayName,
          domainOverride,
          token,
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        ltiPlacementFailures.push({ assignmentId: aid, error: err });
        appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: Prompter module placement failed', {
          assignmentId: aid,
          moduleId: targetModuleTrim,
          error: err,
        });
      }
    }

    let removedSourceSettingsAssignment = false;
    let removeSourceAssignmentError: string | undefined;
    if (sourceAssignmentTrim) {
      const canonicalId = await this.canvas.findAssignmentByTitle(
        ctx.courseId,
        PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
        domainOverride,
        token,
      );
      if (canonicalId && sourceAssignmentTrim !== canonicalId) {
        try {
          await this.canvas.deleteAssignment(ctx.courseId, sourceAssignmentTrim, domainOverride, token);
          removedSourceSettingsAssignment = true;
          appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: removed source settings assignment', {
            sourceAssignmentId: sourceAssignmentTrim,
          });
        } catch (delErr) {
          removeSourceAssignmentError = delErr instanceof Error ? delErr.message : String(delErr);
          appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob: delete source assignment failed', {
            sourceAssignmentId: sourceAssignmentTrim,
            error: removeSourceAssignmentError,
          });
        }
      }
    }

    appendLtiLog('prompt-import', 'importPromptManagerSettingsBlob applied', {
      courseId: ctx.courseId,
      mode: dto.mode,
      sourceCourseId: sourceCourseTrim || null,
      sourceAssignmentId: sourceAssignmentTrim || null,
      importedKeys: Object.keys(remappedConfigs).length,
      targetModuleId: targetModuleTrim,
      ltiPlacementFailureCount: ltiPlacementFailures.length,
      removedSourceSettingsAssignment,
    });

    const staleAssignmentIds = Object.keys(mergedConfigs).filter((id) => !targetIds.has(id));
    return {
      imported: Object.keys(remappedConfigs).length,
      staleAssignmentIds,
      ...(instructionHydrationFailures.length > 0 ? { instructionHydrationFailures } : {}),
      ...(submissionTypeUpdateFailures.length > 0 ? { submissionTypeUpdateFailures } : {}),
      ...(ltiPlacementFailures.length > 0 ? { ltiPlacementFailures } : {}),
      ...(sourceAssignmentTrim
        ? { removedSourceSettingsAssignment, ...(removeSourceAssignmentError ? { removeSourceAssignmentError } : {}) }
        : {}),
    };
  }

  private findSourceConfigKeyForTargetAssignment(
    sourceConfigs: Record<string, PromptConfigJson>,
    targetAssignmentId: string,
    targetAssignmentName: string,
  ): string | undefined {
    if (sourceConfigs[targetAssignmentId]) return targetAssignmentId;
    const tName = targetAssignmentName.trim();
    if (!tName) return undefined;
    const onlyTarget: CanvasAssignmentBrief[] = [{ id: targetAssignmentId, name: tName }];
    for (const k of Object.keys(sourceConfigs)) {
      const cfgName = (sourceConfigs[k]?.assignmentName ?? '').trim();
      if (!cfgName) continue;
      const r = resolveAssignmentIdByName(cfgName, onlyTarget);
      if (r.status === 'matched' && r.newId === targetAssignmentId) return k;
    }
    return undefined;
  }

  /** Brief assignment lists for Prompt Manager import UI (same course). Prefer bundled `canvasImport` from GET configured-assignments. */
  async getCanvasAssignmentsForImport(ctx: LtiContext): Promise<{
    allAssignments: CanvasAssignmentBrief[];
    settingsTitleCandidates: CanvasAssignmentBrief[];
  }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const all = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
    return buildCanvasImportListsFromAssignments(all);
  }

  /**
   * Partition current-course assignments for the single-assignment import dropdown:
   * prioritized = Canvas ids that appear as keys in the source blob; other = the rest.
   */
  async getAssignmentImportOptionsForImport(
    ctx: LtiContext,
    sourceSettingsAssignmentId: string,
    targetAssignmentId?: string,
  ): Promise<{
    prioritizedAssignments: CanvasAssignmentBrief[];
    otherAssignments: CanvasAssignmentBrief[];
    sourceConfigCount: number;
    targetCanvasModuleId: string | null;
  }> {
    const sourceId = (sourceSettingsAssignmentId ?? '').trim();
    if (!sourceId) {
      throw new BadRequestException('sourceSettingsAssignmentId is required');
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const { assignment: sourceAssignRow } = await this.getAssignmentForImportHydration(ctx, sourceId, domainOverride, token);
    const blob = promptManagerBlobFromAssignmentDescription(sourceAssignRow);
    const keys = new Set(Object.keys(blob?.configs ?? {}));
    const all = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
    const byName = (a: CanvasAssignmentBrief, b: CanvasAssignmentBrief) => a.name.localeCompare(b.name);
    const tid = (targetAssignmentId ?? '').trim();
    const targetCanvasModuleId = tid
      ? await this.canvas.findFirstModuleIdContainingAssignment(ctx.courseId, tid, domainOverride, token)
      : null;
    return {
      prioritizedAssignments: all.filter((a) => keys.has(a.id)).sort(byName),
      otherAssignments: all.filter((a) => !keys.has(a.id)).sort(byName),
      sourceConfigCount: keys.size,
      targetCanvasModuleId,
    };
  }

  /**
   * Merge one assignment's prompt config from a chosen "settings" assignment description into the
   * canonical Prompt Manager Settings blob for this course.
   */
  async importSinglePromptAssignmentFromSourceAssignment(
    ctx: LtiContext,
    dto: ImportSinglePromptAssignmentDto,
  ): Promise<{
    imported: true;
    sourceKey: string | null;
    targetAssignmentId: string;
    moduleId: string;
    strategy: 'from_source' | 'from_source_assignment' | 'kept_existing' | 'created_defaults';
  }> {
    const sourceAid = (dto.sourceAssignmentId ?? dto.sourceSettingsAssignmentId ?? '').trim();
    const targetAid = (dto.targetAssignmentId ?? '').trim() || sourceAid;
    if (!sourceAid) {
      throw new BadRequestException('sourceAssignmentId is required');
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    const assignmentImportList = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
    const { assignment: sourceFetchedRaw, tokenSource: sourceAssignTokenSource } =
      await this.getAssignmentForImportHydration(ctx, sourceAid, domainOverride, token);
    if (!sourceFetchedRaw) {
      throw new BadRequestException('Could not resolve source assignment fields for import');
    }
    const rawSourcePm = promptManagerBlobFromAssignmentDescription(sourceFetchedRaw);
    const { blob: sourceBlob } = repairPromptManagerSettingsBlobFromUnknown(rawSourcePm ?? {});
    const sourceConfigs = sourceBlob.configs ?? {};
    const sourceListRow = assignmentImportList.find((a) => a.id === sourceAid);
    if (!sourceListRow) {
      throw new BadRequestException('Source assignment not found in this course');
    }
    const targetListRow = assignmentImportList.find((a) => a.id === targetAid);
    if (!targetListRow) {
      throw new BadRequestException('Target assignment not found in this course');
    }
    const targetRow: CanvasAssignmentBrief = targetListRow;
    const sourceAssign = this.mergeCourseAssignmentListRowWithFetchedAssignment(sourceListRow, sourceFetchedRaw);
    if (!sourceAssign) {
      throw new BadRequestException('Could not resolve source assignment fields for import');
    }
    const targetBlob = await readPromptManagerSettingsBlobFromCanvas(this.canvas, ctx.courseId, domainOverride, token);
    const priorFromDescription =
      targetAid === sourceAid
        ? this.promptConfigFromAssignmentDescriptionString(sourceFetchedRaw.description)
        : await this.readPromptConfigFromAssignmentDescription(ctx.courseId, targetAid, domainOverride, token);
    const priorInBlob = targetBlob?.configs?.[targetAid];
    const priorTarget = priorInBlob ?? priorFromDescription;
    const priorExists =
      priorTarget !== undefined &&
      priorTarget !== null &&
      typeof priorTarget === 'object' &&
      !Array.isArray(priorTarget) &&
      Object.keys(priorTarget as object).length > 0;

    const sourceKeyFromSourceId =
      sourceConfigs[sourceAid] !== undefined ? sourceAid : undefined;
    const sourceKey =
      sourceKeyFromSourceId ??
      this.findSourceConfigKeyForTargetAssignment(sourceConfigs, targetAid, targetRow.name);
    const base = sourceKey ? sourceConfigs[sourceKey] : undefined;
    const resolveStrategy = (): 'from_source' | 'from_source_assignment' | 'kept_existing' | 'created_defaults' => {
      if (sourceKey && base) return 'from_source';
      if (sourceAssign) return 'from_source_assignment';
      if (priorExists) return 'kept_existing';
      return 'created_defaults';
    };
    const strategy = resolveStrategy();

    const manualModuleId = (dto.moduleId ?? '').trim();
    if (!manualModuleId) {
      throw new BadRequestException(
        'moduleId is required. Select the Canvas module where this assignment should appear and where the Prompter tool will be placed above it.',
      );
    }
    const moduleIdTrim = manualModuleId;
    let merged: PromptConfigJson;
    if (sourceKey && base) {
      merged = this.clearCrossCoursePromptFields({ ...base });
    } else if (sourceAssign) {
      // Primary single-import path: seed config from the selected source assignment details.
      merged = await this.buildDefaultPromptConfigForCanvasAssignment(
        ctx.courseId,
        sourceAid,
        sourceListRow.name,
        moduleIdTrim,
        domainOverride,
        token,
        sourceAssign,
      );
      merged = this.applyCanvasAssignmentImportHydration(merged, sourceAssign);
      appendLtiLog(
        'prompt-import',
        'importSinglePromptAssignmentFromSourceAssignment: using source assignment details',
        {
          sourceAssignmentId: sourceAid,
          sourceTokenSource: sourceAssignTokenSource,
          hydratedConfig: {
            assignmentName: merged.assignmentName ?? '(none)',
            pointsPossible: merged.pointsPossible ?? '(none)',
            allowedAttempts: merged.allowedAttempts ?? '(none)',
            instructionsLen:
              typeof merged.instructions === 'string' ? merged.instructions.length : 0,
            rubricId: merged.rubricId ?? '(none)',
          },
        },
      );
    } else if (priorExists) {
      merged = { ...(priorTarget as PromptConfigJson) };
    } else {
      merged = await this.buildDefaultPromptConfigForCanvasAssignment(
        ctx.courseId,
        targetAid,
        targetRow.name,
        moduleIdTrim,
        domainOverride,
        token,
      );
    }
    merged.moduleId = moduleIdTrim;
    if (strategy === 'from_source') {
      // Legacy/source-blob path: still hydrate from target assignment so target-side Canvas metadata wins.
      try {
        let targetAssign: NonNullable<Awaited<ReturnType<CanvasService['getAssignment']>>>;
        let tokenSource: 'effective' | 'course_stored' | 'none';
        if (targetAid === sourceAid) {
          targetAssign = sourceFetchedRaw;
          tokenSource = sourceAssignTokenSource;
        } else {
          const h = await this.getAssignmentForImportHydration(ctx, targetAid, domainOverride, token);
          if (!h.assignment) {
            throw new BadRequestException(
              'Could not read the target assignment from Canvas, so assignment description could not be imported into Instructions. Re-authorize Canvas token and retry.',
            );
          }
          targetAssign = h.assignment;
          tokenSource = h.tokenSource;
        }
        merged = this.applyCanvasAssignmentImportHydration(merged, targetAssign);
        appendLtiLog('prompt-import', 'importSinglePromptAssignmentFromSourceAssignment: instructions hydrated from assignment description', {
          targetAssignmentId: targetAid,
          tokenSource,
          hydratedConfig: {
            assignmentName: merged.assignmentName ?? '(none)',
            pointsPossible: merged.pointsPossible ?? '(none)',
            allowedAttempts: merged.allowedAttempts ?? '(none)',
            instructionsLen: typeof merged.instructions === 'string' ? merged.instructions.length : 0,
            rubricId: merged.rubricId ?? '(none)',
          },
        });
      } catch (e) {
        appendLtiLog('prompt-import', 'importSinglePromptAssignmentFromSourceAssignment: Canvas hydration skipped', {
          targetAssignmentId: targetAid,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }

    const fromSourceEmbed = this.promptConfigFromAssignmentDescriptionString(sourceFetchedRaw.description);
    if (fromSourceEmbed) {
      merged = mergeSourceEmbedForImport(merged, fromSourceEmbed, moduleIdTrim);
      appendLtiLog('prompt-import', 'importSingle: merged ASL embed from source assignment description', {
        sourceAssignmentId: sourceAid,
        embedPromptMode: fromSourceEmbed.promptMode ?? '(none)',
      });
    }

    const dtoMode = (dto.promptMode ?? '').toString().trim().toLowerCase();
    if (dtoMode && dtoMode !== 'text' && dtoMode !== 'decks' && dtoMode !== 'youtube') {
      throw new BadRequestException('promptMode must be text, decks, or youtube when provided.');
    }
    const chosenMode: 'text' | 'decks' | 'youtube' =
      dtoMode === 'text' || dtoMode === 'decks' || dtoMode === 'youtube'
        ? dtoMode
        : inferPromptModeFromStructuredConfig(merged);
    merged = { ...merged, promptMode: chosenMode };
    appendLtiLog('prompt-import', 'importSingle: resolved promptMode', {
      targetAssignmentId: targetAid,
      promptMode: chosenMode,
      teacherOverride: dtoMode === 'text' || dtoMode === 'decks' || dtoMode === 'youtube',
    });

    const inst = typeof merged.instructions === 'string' ? merged.instructions : '';
    const fullD = mergeAssignmentDescriptionWithEmbeds(inst, merged, merged.prompts);
    try {
      await this.canvas.updateAssignment(ctx.courseId, targetAid, { description: fullD }, domainOverride, token);
    } catch (e) {
      appendLtiLog('prompt-import', 'importSinglePromptAssignment: assignment description update failed', {
        targetAssignmentId: targetAid,
        error: String(e),
      });
      throw e;
    }
    const newIdSet = new Set<string>([
      ...(Array.isArray(targetBlob?.configuredAssignmentIds) ? targetBlob.configuredAssignmentIds : []),
      ...Object.keys(targetBlob?.configs ?? {}),
    ]);
    newIdSet.add(targetAid);
    const outBlob: PromptManagerSettingsBlob = {
      ...(targetBlob ?? {}),
      v: 1,
      configs: {},
      configuredAssignmentIds: Array.from(newIdSet).filter((x) => /^\d+$/.test(x)),
      resourceLinkAssignmentMap: targetBlob?.resourceLinkAssignmentMap ?? {},
      updatedAt: new Date().toISOString(),
    };
    appendLtiLog('prompt-import', 'importSinglePromptAssignmentFromSourceAssignment: about to write course index', {
      targetAssignmentId: targetAid,
      configuredIdCount: outBlob.configuredAssignmentIds?.length ?? 0,
      targetConfig: {
        assignmentName: merged.assignmentName ?? '(none)',
        promptMode: merged.promptMode ?? '(none)',
        pointsPossible: merged.pointsPossible ?? '(none)',
        allowedAttempts: merged.allowedAttempts ?? '(none)',
        instructionsLen: typeof merged.instructions === 'string' ? merged.instructions.length : 0,
        rubricId: merged.rubricId ?? '(none)',
      },
    });
    try {
      await this.canvas.ensureAssignmentExpressSubmissionTypes(ctx.courseId, targetAid, domainOverride, token);
    } catch (e) {
      throw new BadRequestException(
        `Could not set this assignment to file upload + text submission (required for ASL Express): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId: ctx.courseId,
      domainOverride,
      token,
      blob: outBlob,
      allowConfigShrink: true,
    });
    await this.ensurePrompterLtiAboveAssignmentInModule(ctx, {
      courseId: ctx.courseId,
      assignmentId: targetAid,
      moduleId: moduleIdTrim,
      assignmentDisplayName: (merged.assignmentName ?? targetRow.name).trim() || targetRow.name,
      domainOverride,
      token,
    });
    appendLtiLog('prompt-import', 'importSinglePromptAssignmentFromSourceAssignment', {
      courseId: ctx.courseId,
      sourceKey: sourceKey ?? null,
      targetAssignmentId: targetAid,
      moduleId: moduleIdTrim,
      strategy,
    });
    return {
      imported: true,
      sourceKey: sourceKey ?? null,
      targetAssignmentId: targetAid,
      moduleId: moduleIdTrim,
      strategy,
    };
  }

  /** Teacher: scan for TRUE+WAY-style assignment titles and merge default Prompt Manager fields. */
  async applyTrueWayTemplates(ctx: LtiContext): Promise<{ updated: number; matches: TrueWayTemplateMatch[] }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    await this.ensureMigrated(ctx.courseId, domainOverride, token);
    const list = await this.listAssignmentsForPromptImportCached(ctx.courseId, domainOverride, token);
    const matches = scanTrueWayAssignments(list);
    if (matches.length === 0) {
      return { updated: 0, matches: [] };
    }
    const blob = await readPromptManagerSettingsBlobFromCanvas(this.canvas, ctx.courseId, domainOverride, token);
    const idSet = new Set<string>([
      ...(Array.isArray(blob?.configuredAssignmentIds) ? blob.configuredAssignmentIds : []),
      ...Object.keys(blob?.configs ?? {}),
    ]);
    let updated = 0;
    for (const m of matches) {
      const assign = await this.canvas.getAssignment(ctx.courseId, m.assignmentId, domainOverride, token);
      const desc = assign?.description ?? '';
      const parsed = parseAssignmentDescriptionForPromptManager(desc);
      const fromBlob = blob?.configs?.[m.assignmentId];
      const base: PromptConfigJson = { minutes: 5, prompts: [], accessCode: '', ...(fromBlob ?? {}), ...(parsed.config ?? {}) };
      const partial = buildPartialPromptConfigForTrueWay(m.kind, m.name, desc);
      const merged: PromptConfigJson = { ...base, ...partial };
      const vis =
        (typeof merged.instructions === 'string' && merged.instructions.trim() ? merged.instructions : null) ??
        parsed.visibleHtml;
      const fullD = mergeAssignmentDescriptionWithEmbeds(vis, merged, merged.prompts);
      await this.canvas.updateAssignment(ctx.courseId, m.assignmentId, { description: fullD }, domainOverride, token);
      idSet.add(m.assignmentId);
      updated++;
    }
    const outBlob: PromptManagerSettingsBlob = {
      ...(blob ?? {}),
      v: 1,
      configs: {},
      configuredAssignmentIds: Array.from(idSet).filter((x) => /^\d+$/.test(x)),
      resourceLinkAssignmentMap: blob?.resourceLinkAssignmentMap,
      updatedAt: new Date().toISOString(),
    };
    await writePromptManagerSettingsBlobToCanvas(this.canvas, {
      courseId: ctx.courseId,
      domainOverride,
      token,
      blob: outBlob,
      allowConfigShrink: true,
    });
    appendLtiLog('prompt-import', 'applyTrueWayTemplates', { courseId: ctx.courseId, updated, matchCount: matches.length });
    return { updated, matches };
  }
}
