import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
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
import type { PromptConfigJson, PutPromptConfigDto } from './dto/prompt-config.dto';
import { SignToVoiceCaptionService } from './sign-to-voice-caption.service';
import type { PromptCaptionsStatus } from './entities/prompt-submission-captions.entity';
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
  ffprobeWebmPromptDataJson,
  muxWebmWithPromptDataTag,
  writeBufferToTempWebmFile,
} from './webm-prompt-metadata.util';
import { randomUUID } from 'crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';

const PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE = 'Prompt Manager Settings';
const PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE = 'ASL Express Prompt Manager Settings';
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

interface PromptManagerSettingsBlob {
  v?: number;
  configs?: Record<string, PromptConfigJson>;
  /** Maps LTI resource_link_id -> Canvas assignment id for launches where assignment_id is absent. */
  resourceLinkAssignmentMap?: Record<string, string>;
  updatedAt?: string;
}

interface DeckCardSource {
  id: string;
  title: string;
  durationSeconds: number | null;
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

/** Extract JSON from Canvas content. Canvas may wrap in HTML. */
function extractJsonBlob(raw: string): PromptManagerSettingsBlob | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as PromptManagerSettingsBlob;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as PromptManagerSettingsBlob;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

@Injectable()
export class PromptService {
  private readonly deckSourceCache = new Map<string, { cards: DeckCardSource[]; expiresAt: number }>();
  private readonly deckSourceInflight = new Map<string, Promise<DeckCardSource[]>>();

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
    private readonly signToVoiceCaptions: SignToVoiceCaptionService,
  ) {}

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
        deduped.push({
          id: v.id,
          title: v.title.trim(),
          durationSeconds:
            typeof ds === 'number' && Number.isFinite(ds) && ds > 0 ? ds : null,
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
      appendLtiLog('prompt', 'getPrompterAssignmentId: fallback resolution', {
        source: resolved.source,
        assignmentId: resolved.assignmentId ?? '(none)',
        resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
        moduleId: (ctx.moduleId ?? '').trim() || '(none)',
      });
      if (resolved.assignmentId) {
        return resolved.assignmentId;
      }
    }
    throw new Error('Assignment ID required. In course_navigation, pass assignmentId as query parameter.');
  }

  private async ensurePromptManagerSettingsAssignment(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<string> {
    const existing = await this.canvas.findAssignmentByTitle(
      courseId,
      PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
      domainOverride,
      token,
    );
    if (existing) return existing;
    return this.canvas.createAssignment(
      courseId,
      PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
      {
        submissionTypes: ['online_text_entry'],
        pointsPossible: 0,
        published: true,
        description: 'Stores Prompt Manager config per assignment (auto-created by ASL Express)',
        omitFromFinalGrade: true,
        tokenOverride: token,
      },
      domainOverride,
    );
  }

  private async readPromptManagerSettingsBlob(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<PromptManagerSettingsBlob | null> {
    const settingsAssignmentId = await this.canvas.findAssignmentByTitle(
      courseId,
      PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE,
      domainOverride,
      token,
    );
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlob: after findAssignmentByTitle', {
      courseId,
      settingsAssignmentId: settingsAssignmentId ?? null,
    });
    if (settingsAssignmentId) {
      const assignment = await this.canvas.getAssignment(courseId, settingsAssignmentId, domainOverride, token);
      appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlob: after getAssignment', {
        courseId,
        settingsAssignmentId,
        assignmentFound: !!assignment,
        descriptionNonEmpty: Boolean((assignment?.description ?? '').trim()),
      });
      const raw = assignment?.description?.trim() ?? '';
      const blob = extractJsonBlob(raw);
      const configCount =
        blob?.configs && typeof blob.configs === 'object' ? Object.keys(blob.configs).length : 0;
      appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlob: after extractJsonBlob (assignment description)', {
        courseId,
        source: 'assignment_description',
        blobParsed: !!blob,
        configCount,
      });
      if (blob) return blob;
    }
    const ann = await this.canvas.findSettingsAnnouncementByTitle(
      courseId,
      PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
      token,
      domainOverride,
    );
    appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlob: after findSettingsAnnouncementByTitle', {
      courseId,
      announcementFound: !!ann,
      hasMessage: Boolean((ann?.message ?? '').trim()),
    });
    if (ann?.message) {
      const annBlob = extractJsonBlob(ann.message);
      const annConfigCount =
        annBlob?.configs && typeof annBlob.configs === 'object' ? Object.keys(annBlob.configs).length : 0;
      appendLtiLog('prompt-decks', 'readPromptManagerSettingsBlob: after extractJsonBlob (announcement)', {
        courseId,
        source: 'announcement',
        blobParsed: !!annBlob,
        configCount: annConfigCount,
      });
      return annBlob;
    }
    return null;
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
      const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, tok);
      return blob?.configs?.[assignmentId] ?? null;
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
    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(courseId, domainOverride, token);
    const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    const existingMap = blob?.resourceLinkAssignmentMap ?? {};
    if (existingMap[rid] === aid) return;
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: blob?.v ?? 1,
      configs: blob?.configs ?? {},
      resourceLinkAssignmentMap: {
        ...existingMap,
        [rid]: aid,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.canvas.updateAssignmentDescription(
      courseId,
      settingsAssignmentId,
      JSON.stringify(payload),
      domainOverride,
      token,
    );
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
    const configEntries = Object.entries(configs).filter(([id]) => String(id).trim().length > 0);

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
    if (fromBlob.assignmentId) return fromBlob;
    const resourceLinkId = (ctx.resourceLinkId ?? '').trim();
    if (resourceLinkId) {
      const fromResourceLink = await this.canvas.resolveAssignmentIdForResourceLink(
        ctx.courseId,
        resourceLinkId,
        domainOverride,
        token,
      );
      if (fromResourceLink.assignmentId) {
        appendLtiLog('prompt', 'resolveAssignmentIdForContext: resolved from resource link', {
          resourceLinkId,
          assignmentId: fromResourceLink.assignmentId,
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
            appendLtiLog('prompt', 'getConfig: assignment resolution via course-stored token', {
              assignmentId,
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
    appendLtiLog('prompt', 'getConfig: assignment resolution', {
      source: resolved.source,
      assignmentId: assignmentId || '(none)',
      assignmentIdFromCtx: (ctx.assignmentId ?? '').trim() || '(none)',
      assignmentIdFromMap: (blob?.resourceLinkAssignmentMap?.[(ctx.resourceLinkId ?? '').trim()] ?? '').trim() || '(none)',
      assignmentIdFromLisResult: this.extractAssignmentIdFromLisResult(ctx) ?? '(none)',
      assignmentIdFromOutcomeUrl: this.extractAssignmentIdFromOutcomeUrl(ctx) ?? '(none)',
      moduleId: (ctx.moduleId ?? '').trim() || '(none)',
      resourceLinkTitle: (ctx.resourceLinkTitle ?? '').trim() || '(none)',
      lisResultSourcedid: (ctx.lisResultSourcedid ?? '').trim() ? '(present)' : '(none)',
      lisOutcomeServiceUrl: (ctx.lisOutcomeServiceUrl ?? '').trim() ? '(present)' : '(none)',
      configCount: Object.keys(blob?.configs ?? {}).length,
      resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
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
    let config = blob?.configs?.[assignmentId] ?? null;

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
          config = teacherBlob?.configs?.[assignmentId] ?? null;
          if (config) {
            appendLtiLog('prompt', 'getConfig: assignment config from Prompt Manager via course-stored token', {
              assignmentId,
              promptMode: config.promptMode ?? '(unset)',
            });
          }
        } catch (e) {
          appendLtiLog('prompt', 'getConfig: course-stored token Prompt Manager read failed (non-fatal)', {
            assignmentId,
            error: String(e),
          });
        }
      }
    }

    // Backward compatibility: default promptMode to 'text' if not present
    if (config && !config.promptMode) {
      config = { ...config, promptMode: 'text' };
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
            selectedDeckCount: selectedDecks.length,
            totalCards,
          });
          const banks = await this.generateStoredDeckPromptBanks(selectedDecks, totalCards, 2);
          const staticFallbackPrompts = (banks[0] ?? []).map((p) => p.title).filter(Boolean);
          if (banks.length > 0 || staticFallbackPrompts.length > 0) {
            const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(ctx.courseId, domainOverride, token);
            const payload: PromptManagerSettingsBlob = {
              ...blob,
              v: blob?.v ?? 1,
              configs: {
                ...(blob?.configs ?? {}),
                [assignmentId]: {
                  ...(blob?.configs?.[assignmentId] ?? config),
                  promptMode: 'decks',
                  videoPromptConfig: {
                    selectedDecks,
                    totalCards,
                    ...(banks.length > 0 ? { storedPromptBanks: banks } : {}),
                    ...(staticFallbackPrompts.length > 0 ? { staticFallbackPrompts } : {}),
                  },
                },
              },
              updatedAt: new Date().toISOString(),
            };
            await this.canvas.updateAssignmentDescription(
              ctx.courseId,
              settingsAssignmentId,
              JSON.stringify(payload),
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
              bankCount: banks.length,
              staticFallbackCount: staticFallbackPrompts.length,
            });
          }
        } catch (err) {
          appendLtiLog('prompt-decks', 'getConfig: failed to backfill fallback banks (non-fatal)', {
            assignmentId,
            error: String(err),
          });
        }
      }
    }
    appendLtiLog('prompt-decks', 'getConfig: deck mode snapshot', {
      assignmentId,
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
      const assignment = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
      if (assignment) {
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
        };
        if (!hydrated.promptMode) hydrated.promptMode = 'text';
        return { ...hydrated, resolvedAssignmentId: assignmentId };
      }
    } catch (err) {
      appendLtiLog('prompt', 'getConfig: assignment hydration failed (non-fatal)', {
        assignmentId,
        error: String(err),
      });
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

    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(
      ctx.courseId,
      domainOverride,
      token,
    );
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = { ...(blob?.configs ?? {}), [assignmentId]: merged };
    // Read → merge → write: never overwrite entire blob; preserve existing fields.
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs,
      updatedAt: new Date().toISOString(),
    };
    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(
      ctx.courseId,
      settingsAssignmentId,
      description,
      domainOverride,
      token,
    );
    appendLtiLog('sign-to-voice', 'config: Prompt Manager blob saved', {
      assignmentId,
      signToVoiceRequired: merged.signToVoiceRequired === true,
      promptMode: merged.promptMode ?? '(unset)',
    });

    try {
      const ann = await this.canvas.findSettingsAnnouncementByTitle(
        ctx.courseId,
        PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
        token,
        domainOverride,
      );
      if (ann) {
        await this.canvas.updateSettingsAnnouncement(
          ctx.courseId,
          ann.id,
          description,
          token,
          domainOverride,
        );
      } else {
        await this.canvas.createSettingsAnnouncement(
          ctx.courseId,
          `⚠️ DO NOT DELETE — ${PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE}`,
          description,
          token,
          domainOverride,
        );
      }
    } catch (annErr) {
      appendLtiLog('prompt', 'putConfig: settings announcement sync failed (non-fatal)', {
        assignmentId,
        error: String(annErr),
      });
    }


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
    if (hasAssignmentUpdates || rubricId) {
      try {
        if (hasAssignmentUpdates) {
          await this.canvas.updateAssignment(
            ctx.courseId,
            assignmentId,
            {
              ...(agId && { assignmentGroupId: agId }),
              ...(assignmentName && { name: assignmentName }),
              description: instructions,
              pointsPossible,
              ...(dueAt && { dueAt }),
              ...(unlockAt && { unlockAt }),
              ...(lockAt && { lockAt }),
              allowedAttempts,
            },
            domainOverride,
            token,
          );
        }
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
    prompts: Array<{ title: string; videoId?: string; duration: number }>;
    warning?: string;
  }> {
    // Suppressed: noisy on every deck build — controller logs request/result when needed.
    // appendLtiLog('prompt-decks', 'buildDeckPromptList start', { selectedDeckCount:..., totalCards });
    if (!selectedDecks || selectedDecks.length === 0) {
      return { prompts: [], warning: 'No decks selected' };
    }

    // Step 1: Fetch all cards from each deck (Sprout list includes duration; also persisted in DB on sync)
    const deckCards = new Map<string, Array<{ id: string; title: string; durationSeconds: number | null }>>();
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
    const selected: Array<{ title: string; videoId?: string; durationSeconds?: number | null }> = [];
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
            selected.push({
              title: card.title,
              videoId: card.id,
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
      duration: this.deckCardTotalSeconds(resolveVideoSeconds(s)),
    }));

    // appendLtiLog('prompt-decks', 'buildDeckPromptList result', { ... });

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
    deckTimeline: Array<{ title?: unknown; startSec?: unknown; videoId?: unknown }> | undefined,
  ): Array<{ title: string; startSec: number; videoId?: string }> | undefined {
    if (!Array.isArray(deckTimeline) || deckTimeline.length === 0) return undefined;
    const rows = deckTimeline
      .map((e) => {
        const title = String(e?.title ?? '');
        const startSec = Number(e?.startSec);
        const vidRaw = (e as { videoId?: unknown }).videoId;
        const videoId =
          vidRaw != null && String(vidRaw).trim().length > 0 ? String(vidRaw).trim() : undefined;
        return { title, startSec, videoId };
      })
      .filter((r) => Number.isFinite(r.startSec));
    if (rows.length === 0) return undefined;
    rows.sort((a, b) => a.startSec - b.startSec);
    return rows.map((r) => ({
      title: r.title,
      startSec: Math.round(r.startSec * 1000) / 1000,
      ...(r.videoId ? { videoId: r.videoId } : {}),
    }));
  }

  /**
   * Fill missing Sprout `videoId` on deck timeline rows using teacher config + Sprout playlist data.
   * Server-side so grading/viewer does not depend on the student client calling flashcard APIs.
   */
  private async enrichDeckTimelineVideoIds(
    ctx: LtiContext,
    rows: Array<{ title: string; startSec: number; videoId?: string }> | undefined,
  ): Promise<Array<{ title: string; startSec: number; videoId?: string }> | undefined> {
    if (!rows?.length) return rows;
    if (rows.every((r) => (r.videoId ?? '').trim().length > 0)) return rows;

    let cfg: PromptConfigJson | null;
    try {
      cfg = await this.getConfig(ctx);
    } catch (e) {
      appendLtiLog('prompt', 'enrichDeckTimelineVideoIds: getConfig failed', { error: String(e) });
      return rows;
    }

    /**
     * Learners often use Canvas OAuth (`ctx.canvasAccessToken`). `getConfig` then reads the Prompt Manager
     * blob with that token and may get no blob + assignment hydration only → missing `videoPromptConfig`.
     * Deck enrichment must still see teacher `selectedDecks` / banks; use per-course stored teacher token.
     */
    let vpc = cfg?.videoPromptConfig;
    const vpcHasDecksOrBanks = (v: typeof vpc): boolean =>
      !!v &&
      ((Array.isArray(v.selectedDecks) && v.selectedDecks.length > 0) ||
        (Array.isArray(v.storedPromptBanks) && v.storedPromptBanks.length > 0));

    if (!vpcHasDecksOrBanks(vpc)) {
      const teacherTok = await this.courseSettings.getCourseStoredCanvasToken(ctx.courseId);
      if (teacherTok?.trim()) {
        const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
        try {
          const aid = await this.getPrompterAssignmentId(ctx);
          const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, teacherTok);
          const sub = blob?.configs?.[aid];
          if (sub?.videoPromptConfig && vpcHasDecksOrBanks(sub.videoPromptConfig)) {
            vpc = sub.videoPromptConfig;
            // #region agent log
            appendLtiLog('agent-debug', 'enrichDeckTimelineVideoIds: videoPromptConfig from teacher blob (Bridge)', {
              hypothesisId: 'H3-fallback',
              assignmentId: aid,
            });
            // #endregion
          }
        } catch (e) {
          appendLtiLog('prompt', 'enrichDeckTimelineVideoIds: teacher-token settings read failed', {
            error: String(e),
          });
        }
      }
    }

    if (!vpcHasDecksOrBanks(vpc)) {
      // #region agent log
      appendLtiLog('agent-debug', 'enrichDeckTimelineVideoIds: no videoPromptConfig after getConfig+fallback (Bridge)', {
        hypothesisId: 'H3',
        cfgNull: cfg == null,
        hasCfg: !!cfg,
        hadVpcFromGetConfig: !!cfg?.videoPromptConfig,
      });
      // #endregion
      return rows;
    }

    const deckCfg = vpc!;

    const titleToVideoId = new Map<string, string>();
    const norm = (t: string) => t.toLowerCase().trim();

    const decks = Array.isArray(deckCfg.selectedDecks) ? deckCfg.selectedDecks : [];
    for (const d of decks) {
      const deckId = String(d?.id ?? '').trim();
      if (!deckId) continue;
      try {
        const cards = await this.getDeckCardsWithCache(deckId);
        for (const c of cards) {
          const title = (c.title ?? '').trim();
          const vid = String(c.id ?? '').trim();
          const key = norm(title);
          if (!key || !vid) continue;
          if (!titleToVideoId.has(key)) titleToVideoId.set(key, vid);
        }
      } catch (e) {
        appendLtiLog('prompt', 'enrichDeckTimelineVideoIds: getDeckCardsWithCache failed', {
          deckId,
          error: String(e),
        });
      }
    }

    const banks = deckCfg.storedPromptBanks ?? [];
    for (const bank of banks) {
      if (!Array.isArray(bank)) continue;
      for (const card of bank) {
        const title = String((card as { title?: unknown }).title ?? '').trim();
        const vid = String((card as { videoId?: unknown }).videoId ?? '').trim();
        const key = norm(title);
        if (!key || !vid) continue;
        if (!titleToVideoId.has(key)) titleToVideoId.set(key, vid);
      }
    }

    if (titleToVideoId.size === 0) {
      // #region agent log
      appendLtiLog('agent-debug', 'enrichDeckTimelineVideoIds: title map empty after decks+banks (Bridge)', {
        hypothesisId: 'H3',
        rowCount: rows.length,
        selectedDeckCount: decks.length,
        bankOuterCount: banks.length,
        sampleRowTitles: rows.slice(0, 3).map((r) => r.title?.slice(0, 40)),
      });
      // #endregion
      return rows;
    }

    let filled = 0;
    const out = rows.map((r) => {
      const existing = (r.videoId ?? '').trim();
      if (existing) return r;
      const vid = titleToVideoId.get(norm(r.title));
      if (!vid) return r;
      filled++;
      return { ...r, videoId: vid };
    });
    if (filled > 0) {
      appendLtiLog('prompt', 'enrichDeckTimelineVideoIds: filled missing videoIds', {
        filled,
        rowCount: rows.length,
      });
    }
    // #region agent log
    appendLtiLog('agent-debug', 'enrichDeckTimelineVideoIds: enrich pass complete (Bridge)', {
      hypothesisId: 'H4',
      titleMapSize: titleToVideoId.size,
      filled,
      rowCount: rows.length,
      unmatchedAfter: out.filter((r) => !(r.videoId ?? '').trim()).length,
    });
    // #endregion
    return out.map((r) => ({
      title: r.title,
      startSec: Math.round(r.startSec * 1000) / 1000,
      ...(r.videoId ? { videoId: r.videoId } : {}),
    }));
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
    appendLtiLog('prompt-submit', 'submit: got assignmentId', { assignmentId });
    let sanitizedDeckTimeline = this.sanitizeDeckTimelineInput(deckTimeline);
    sanitizedDeckTimeline = await this.enrichDeckTimelineVideoIds(ctx, sanitizedDeckTimeline);
    const deckDerived =
      sanitizedDeckTimeline?.length && sanitizedDeckTimeline.length > 0
        ? this.buildPromptHtmlFromDeckTimeline(sanitizedDeckTimeline).trim()
        : '';
    const bodyPayload: Record<string, unknown> = {
      submittedAt: new Date().toISOString(),
    };
    if (sanitizedDeckTimeline?.length) {
      bodyPayload.deckTimeline = sanitizedDeckTimeline;
    } else if (snap) {
      bodyPayload.promptSnapshotHtml = snap;
    }
    const bodyString = JSON.stringify(bodyPayload);
    // #region agent log
    try {
      const dbg = JSON.parse(bodyString) as Record<string, unknown>;
      appendLtiLog('agent-debug', 'submit: Canvas body JSON before writeSubmissionBody (Bridge)', {
        hypothesisId: 'H2',
        keys: Object.keys(dbg),
        hasBothFields: !!(dbg.promptSnapshotHtml && dbg.deckTimeline),
        deckRowCount: Array.isArray(dbg.deckTimeline) ? dbg.deckTimeline.length : 0,
        firstDeckRowKeys:
          Array.isArray(dbg.deckTimeline) && dbg.deckTimeline[0]
            ? Object.keys(dbg.deckTimeline[0] as object)
            : [],
      });
    } catch {
      /* ignore */
    }
    // #endregion
    const ctxWithToken: LtiContext = { ...ctx, canvasAccessToken: token };
    await this.canvas.writeSubmissionBody(ctxWithToken, assignmentId, bodyString, token);

    appendLtiLog('prompt-submit', 'submit DONE', {
      assignmentId,
      deckTimelineStored: sanitizedDeckTimeline?.length ?? 0,
    });
  }

  /** Recover prompt HTML from submission body JSON (same shape as submit writeSubmissionBody). */
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
      /* ignore */
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

  /** Classify prompt shape from submission body JSON only (prompt snapshot for grading comes from WebM metadata). */
  private classifyAssignmentPromptKindFromBody(body: string | undefined): 'deck' | 'body' | 'none' {
    const raw = (body ?? '').trim();
    if (!raw) return 'none';
    try {
      const parsed = JSON.parse(raw) as { deckTimeline?: unknown };
      if (Array.isArray(parsed.deckTimeline) && parsed.deckTimeline.length > 0) return 'deck';
    } catch {
      return 'none';
    }
    return this.extractPromptHtmlFromSubmissionBody(body) ? 'body' : 'none';
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

  private static readonly PROMPT_DATA_DECODE_MAX_UTF8 = 512_000;

  private async resolvePromptRowFromWebmMetadata(args: {
    assignmentId: string;
    userId: string;
    token: string;
    canvasVideoUrl: string | undefined;
    body: string | undefined;
    promptsFallbackDuration: number | null;
  }): Promise<{
    promptHtml?: string;
    videoDurationSeconds: number | null;
    durationSource: 'submission' | 'prompts' | 'unknown';
    metadataPromptResolution: 'webm_metadata' | 'assignment_fallback';
  }> {
    const derived = this.computeAssignmentFallbackPromptRow(args.body, args.promptsFallbackDuration);
    const fallback = (): {
      promptHtml?: string;
      videoDurationSeconds: number | null;
      durationSource: 'submission' | 'prompts' | 'unknown';
      metadataPromptResolution: 'assignment_fallback';
    } => ({
      promptHtml: derived.promptHtml,
      videoDurationSeconds: derived.videoDurationSeconds,
      durationSource: derived.durationSource,
      metadataPromptResolution: 'assignment_fallback',
    });

    const url = (args.canvasVideoUrl ?? '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      appendLtiLog('webm-prompt', 'read: FAIL (no_canvas_http_video_url)', {
        userId: args.userId,
        assignmentId: args.assignmentId,
      });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
      return fallback();
    }
    if (url.includes('external_tools/retrieve')) {
      appendLtiLog('webm-prompt', 'read: FAIL (lti_retrieve_url)', { userId: args.userId });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
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
    });

    const dl = await downloadAuthenticatedVideoToTempFile(
      url,
      args.token,
      DEFAULT_WEBM_PROBE_DOWNLOAD_MAX_BYTES,
    );
    if (!dl.ok) {
      appendLtiLog('webm-prompt', 'read: FAIL (download)', {
        userId: args.userId,
        error: dl.error,
      });
      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
      return fallback();
    }
    try {
      const tagRaw = await ffprobeWebmPromptDataJson(dl.path);
      if (!tagRaw) {
        appendLtiLog('webm-prompt', 'read: FAIL (missing_PROMPT_DATA_tag)', { userId: args.userId });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
        return fallback();
      }
      const decoded = decodePromptDataFromFfmpegMetadataTag(tagRaw, PromptService.PROMPT_DATA_DECODE_MAX_UTF8);
      if (!decoded.ok) {
        appendLtiLog('webm-prompt', 'read: FAIL (parse_PROMPT_DATA)', {
          userId: args.userId,
          error: decoded.error,
        });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
        return fallback();
      }
      if (String(decoded.obj.fsaslKind ?? '') !== FSASL_PROMPT_UPLOAD_KIND) {
        appendLtiLog('webm-prompt', 'read: FAIL (unexpected_fsaslKind)', {
          userId: args.userId,
          kind: String(decoded.obj.fsaslKind ?? ''),
        });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
        return fallback();
      }
      const fromTag = this.promptHtmlAndDurationFromUploadRecord(decoded.obj);
      const hasPromptHtml = !!(fromTag.promptHtml ?? '').trim();
      const hasDuration = fromTag.videoDurationSeconds != null;
      if (!hasPromptHtml && !hasDuration) {
        appendLtiLog('webm-prompt', 'read: FAIL (empty_prompt_fields)', { userId: args.userId });
        appendLtiLog('webm-prompt', 'PROMPT_SOURCE: assignment_fallback', { userId: args.userId });
        return fallback();
      }

      appendLtiLog('webm-prompt', 'read: OK', {
        userId: args.userId,
        assignmentId: args.assignmentId,
        promptDataUtf8Bytes: decoded.utf8ByteLength,
      });

      appendLtiLog('webm-prompt', 'PROMPT_SOURCE: webm_metadata', { userId: args.userId });

      return {
        promptHtml: hasPromptHtml ? fromTag.promptHtml : derived.promptHtml,
        videoDurationSeconds: hasDuration
          ? (fromTag.videoDurationSeconds as number)
          : derived.videoDurationSeconds,
        durationSource: hasDuration ? 'submission' : derived.durationSource,
        metadataPromptResolution: 'webm_metadata',
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
    void (async () => {
      try {
        const signToVoiceRequired = await this.resolveSignToVoiceRequired(
          ctx.courseId,
          assignmentId,
          domainOverride,
          token,
        );
        this.signToVoiceCaptions.scheduleAfterSuccessfulUpload({
          signToVoiceRequired,
          courseId: ctx.courseId,
          assignmentId,
          studentUserId,
          initialCanvasFileId: fileId,
          filename,
          domainOverride,
          canvasToken: token,
        });
      } catch (e) {
        appendLtiLog('sign-to-voice', 'scheduleAfterSuccessfulUpload: resolve failed', { error: String(e) });
      }
    })();
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
    appendLtiLog(
      'webm-prompt',
      'scope: submitDeepLink bypasses uploadVideo (no_PROMPT_DATA_mux until wired to shared mux)',
      { bytes: buffer.length },
    );
    if (ctx.messageType !== 'LtiDeepLinkingRequest' || !ctx.deepLinkReturnUrl) {
      appendLtiLog('prompt-deeplink', 'submitDeepLink FAIL: missing context');
      throw new Error('Deep Linking context required (messageType LtiDeepLinkingRequest and deepLinkReturnUrl)');
    }

    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const canvasToken =
      (await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken)) ?? '';
    const submitUserId = await this.resolveCanvasUserIdForRestApi(ctx, canvasToken, domainOverride);

    const token = this.deepLinkFileStore.set(buffer, contentType);
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
      captionsStatus?: PromptCaptionsStatus;
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
    const rowsWithPrompts = await Promise.all(
      baseRows.map(async (row) => {
        const { canvasVideoUrlRaw, ...publicRow } = row;
        const resolved = await this.resolvePromptRowFromWebmMetadata({
          assignmentId,
          userId: row.userId,
          token,
          canvasVideoUrl: canvasVideoUrlRaw,
          body: typeof row.body === 'string' ? row.body : undefined,
          promptsFallbackDuration,
        });
        const kind = this.classifyAssignmentPromptKindFromBody(
          typeof row.body === 'string' ? row.body : undefined,
        );
        const viewerSource =
          resolved.metadataPromptResolution === 'webm_metadata'
            ? 'webm_metadata'
            : kind === 'deck'
              ? 'submission_body_deck_timeline'
              : kind === 'body'
                ? 'submission_body'
                : 'none';
        appendLtiLog('viewer', 'getSubmissions: prompt source selected', {
          userId: row.userId,
          assignmentId,
          source: viewerSource,
        });
        return {
          ...publicRow,
          promptHtml: resolved.promptHtml,
          videoDurationSeconds: resolved.videoDurationSeconds,
          durationSource: resolved.durationSource,
        };
      }),
    );
    for (const row of rowsWithPrompts) {
      appendLtiLog('duration', 'getSubmissions: submission row', {
        userId: row.userId,
        videoDurationSeconds: row.videoDurationSeconds,
        durationSource: row.durationSource,
      });
    }
    const capMap = await this.signToVoiceCaptions.getStatusesForUsers(
      ctx.courseId,
      assignmentId,
      rowsWithPrompts.map((r) => r.userId),
    );
    return rowsWithPrompts.map((r) => {
      const st = capMap.get(r.userId);
      return st ? { ...r, captionsStatus: st } : r;
    });
  }

  /** Teacher grading: WebVTT for a student when captions pipeline finished (`captionsStatus === 'ready'`). */
  async getSubmissionCaptionsVtt(ctx: LtiContext, studentUserId: string): Promise<string | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new ForbiddenException('Canvas token required');
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const list = await this.canvas.listSubmissions(ctx.courseId, assignmentId, domainOverride, token);
    const visible = list.filter(
      (s) =>
        submissionHasFile(s) ||
        !!this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, String(s.user_id ?? '')),
    );
    const ok = visible.some((s) => String(s.user_id) === String(studentUserId));
    if (!ok) {
      throw new ForbiddenException('Submission not found for this user');
    }
    const got = await this.signToVoiceCaptions.getVttIfReady(ctx.courseId, assignmentId, studentUserId);
    return got?.vtt ?? null;
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
      promptsFallbackDuration,
    });
    const kind = this.classifyAssignmentPromptKindFromBody(
      typeof sub.body === 'string' ? sub.body : undefined,
    );
    const viewerSource =
      resolved.metadataPromptResolution === 'webm_metadata'
        ? 'webm_metadata'
        : kind === 'deck'
          ? 'submission_body_deck_timeline'
          : kind === 'body'
            ? 'submission_body'
            : 'none';
    appendLtiLog('viewer', 'getMySubmission: prompt source selected', {
      userId,
      assignmentId,
      source: viewerSource,
    });
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
    };
  }

  /** Teacher only - guard applied at controller. */
  async getAssignmentForGrading(ctx: LtiContext): Promise<{
    name?: string;
    pointsPossible?: number;
    rubric?: Array<unknown>;
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
    const raw = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    if (!raw) return null;
    let rubric = Array.isArray(raw.rubric) && raw.rubric.length > 0 ? raw.rubric : null;
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    if (!rubric) {
      const rubricId = blob?.configs?.[assignmentId]?.rubricId?.trim();
      if (rubricId) {
        const fetched = await this.canvas.getRubric(ctx.courseId, rubricId, domainOverride, token);
        if (fetched?.length) rubric = fetched;
      }
    }
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
    const sproutAccountId = getSproutAccountId(this.config);
    const cfg = blob?.configs?.[assignmentId];
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
    appendLtiLog('viewer', 'getAssignmentForGrading: sprout embed config snapshot', {
      assignmentId,
      hasSproutAccountId: !!sproutAccountId,
      sproutAccountIdLen: sproutAccountId ? sproutAccountId.length : 0,
      sproutAccountIdSuffix: sproutAccountId ? sproutAccountId.slice(-4) : '(none)',
      hasRubric: !!(rubric && Array.isArray(rubric) && rubric.length > 0),
    });
    return {
      name,
      pointsPossible: raw.points_possible,
      rubric: rubric ?? undefined,
      sproutAccountId,
      ...(allowedAttempts !== undefined ? { allowedAttempts } : {}),
      ...(promptMode ? { promptMode } : {}),
      ...(textPrompts?.length ? { textPrompts } : {}),
      ...(youtubeLabel ? { youtubeLabel } : {}),
      ...(youtubePromptConfigViewer ? { youtubePromptConfig: youtubePromptConfigViewer } : {}),
      ...(cfg?.signToVoiceRequired === true ? { signToVoiceRequired: true } : {}),
    };
  }

  /** Teacher only. Returns configured assignments with names and counts from Canvas.
   * Purges any configs whose assignments have been deleted from Canvas (no DB - updates Prompt Manager Settings). */
  async getConfiguredAssignments(ctx: LtiContext): Promise<
    Array<{ id: string; name: string; submissionCount: number; ungradedCount: number }>
  > {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      return [];
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = blob?.configs ?? {};
    const assignmentIds = Object.keys(configs).filter(Boolean);
    const result: Array<{ id: string; name: string; submissionCount: number; ungradedCount: number }> = [];
    const validIds = new Set<string>();
    for (const aid of assignmentIds) {
      const assign = await this.canvas.getAssignment(ctx.courseId, aid, domainOverride, token);
      if (!assign) {
        continue;
      }
      validIds.add(aid);
      let list: Array<{ user_id?: number; attachment?: { url?: string; download_url?: string }; attachments?: Array<{ url?: string; download_url?: string }>; versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>; workflow_state?: string }> = [];
      try {
        list = await this.canvas.listSubmissions(ctx.courseId, aid, domainOverride, token);
      } catch {
        /* assignment exists but submissions may fail; use empty list */
      }
      const name = assign?.name ?? configs[aid]?.assignmentName ?? `Assignment ${aid}`;
      const withFiles = list.filter(
        (s) => submissionHasFile(s) || !!this.deepLinkFileStore.getSubmissionToken(ctx.courseId, aid, String(s.user_id ?? ''))
      );
      const submissionCount = withFiles.length;
      const ungradedCount = withFiles.filter((s) => s.workflow_state !== 'graded').length;
      result.push({ id: aid, name, submissionCount, ungradedCount });
    }
    const purgedCount = assignmentIds.length - validIds.size;
    if (purgedCount > 0) {
      const purged = assignmentIds.filter((id) => !validIds.has(id));
      appendLtiLog('prompt', 'purgeDeletedAssignments', {
        purged,
        count: purgedCount,
      });
      const newConfigs: Record<string, PromptConfigJson> = {};
      for (const id of validIds) {
        const c = configs[id];
        if (c) newConfigs[id] = c;
      }
      const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(ctx.courseId, domainOverride, token);
      // Read → merge → write: only remove purged assignment configs; preserve rest of blob.
      const payload: PromptManagerSettingsBlob = {
        ...blob,
        v: 1,
        configs: newConfigs,
        updatedAt: new Date().toISOString(),
      };
      await this.canvas.updateAssignmentDescription(
        ctx.courseId,
        settingsAssignmentId,
        JSON.stringify(payload),
        domainOverride,
        token,
      );
      try {
        const ann = await this.canvas.findSettingsAnnouncementByTitle(
          ctx.courseId,
          PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
          token,
          domainOverride,
        );
        if (ann) {
          await this.canvas.updateSettingsAnnouncement(
            ctx.courseId,
            ann.id,
            JSON.stringify(payload),
            token,
            domainOverride,
          );
        }
      } catch {
        /* optional announcement sync */
      }
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    appendLtiLog('viewer', 'getConfiguredAssignments', {
      count: result.length,
      assignments: result.map((a) => ({ id: a.id, name: a.name, submissionCount: a.submissionCount })),
    });
    return result;
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

    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = { ...(blob?.configs ?? {}) };
    if (configs[aid] !== undefined) {
      delete configs[aid];
      const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(ctx.courseId, domainOverride, token);
      const payload: PromptManagerSettingsBlob = {
        ...blob,
        v: 1,
        configs,
        updatedAt: new Date().toISOString(),
      };
      await this.canvas.updateAssignmentDescription(
        ctx.courseId,
        settingsAssignmentId,
        JSON.stringify(payload),
        domainOverride,
        token,
      );
      try {
        const ann = await this.canvas.findSettingsAnnouncementByTitle(
          ctx.courseId,
          PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
          token,
          domainOverride,
        );
        if (ann) {
          await this.canvas.updateSettingsAnnouncement(
            ctx.courseId,
            ann.id,
            JSON.stringify(payload),
            token,
            domainOverride,
          );
        }
      } catch {
        // optional announcement sync
      }
      appendLtiLog('prompt', 'delete-assignment: settings blob cleaned', { assignmentId: aid });
    } else {
      appendLtiLog('prompt', 'delete-assignment: no settings blob entry to remove', { assignmentId: aid });
    }
  }

  /** Teacher only. Returns course assignment groups for teacher config. */
  async getAssignmentGroups(ctx: LtiContext): Promise<Array<{ id: number; name: string }>> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return [];
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.listAssignmentGroups(ctx.courseId, domainOverride, token);
  }

  /** Teacher only. Returns course rubrics for teacher config. */
  async getRubrics(ctx: LtiContext): Promise<Array<{ id: number; title: string; pointsPossible: number }>> {
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
    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(ctx.courseId, domainOverride, token);
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const moduleIdTrim = (options?.moduleId ?? '').trim();
    const configs = {
      ...(blob?.configs ?? {}),
      [assignmentId]: {
        minutes: 5,
        prompts: [],
        accessCode: '',
        assignmentName: name,
        ...(assignmentGroupId != null ? { assignmentGroupId: String(assignmentGroupId) } : {}),
        ...(moduleIdTrim ? { moduleId: moduleIdTrim } : {}),
        promptMode: 'text',
      } as PromptConfigJson,
    };
    // Read → merge → write: only add new assignment to configs; preserve rest of blob.
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs,
      updatedAt: new Date().toISOString(),
    };
    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(ctx.courseId, settingsAssignmentId, description, domainOverride, token);
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
}
