import { Inject, Injectable } from '@nestjs/common';
import { ASSESSMENT_REPOSITORY, PROMPT_DATA_REPOSITORY } from '../data/tokens';
import type { IAssessmentRepository } from '../data/interfaces/assessment-repository.interface';
import type { IPromptDataRepository } from '../data/interfaces/prompt-data-repository.interface';
import {
  appendLtiLog,
  appendPlacementMarker,
  type PlacementLtiVersion,
  type PlacementPath,
} from '../common/last-error.store';
import { ConfigService } from '@nestjs/config';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { LtiAgsService } from '../lti/lti-ags.service';
import { LtiDeepLinkFileStore } from '../lti/lti-deep-link-file.store';
import { LtiDeepLinkResponseService } from '../lti/lti-deep-link-response.service';
import { QuizService } from '../quiz/quiz.service';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { PromptFallbackStore } from './prompt-fallback.store';
import { PromptVideoTitleStore } from './prompt-video-title.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { canvasApiBaseFromLtiContext } from '../common/utils/canvas-base-url.util';
import type { PromptConfigJson, PutPromptConfigDto } from './dto/prompt-config.dto';
import { randomUUID } from 'crypto';

const PROMPT_MANAGER_SETTINGS_ASSIGNMENT_TITLE = 'Prompt Manager Settings';
const PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE = 'ASL Express Prompt Manager Settings';
const PROMPT_LEDGER_ASSIGNMENT_TITLE = 'ASL Express Prompt Ledger';

interface PromptManagerSettingsBlob {
  v?: number;
  configs?: Record<string, PromptConfigJson>;
  /** Maps LTI resource_link_id -> Canvas assignment id for launches where assignment_id is absent. */
  resourceLinkAssignmentMap?: Record<string, string>;
  updatedAt?: string;
  /** SproutVideo folder id for PromptSubmissions (dev fallback). Env SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID checked first. NEVER delete this when writing the blob; always merge with existing blob so it persists. */
  sproutPromptSubmissionsFolderId?: string;
  /** Canvas assignment id for assignment-based prompt ledger. */
  promptLedgerAssignmentId?: string;
}

interface PromptLedgerPayload {
  eventId: string;
  assignmentId: string;
  promptHtml: string;
  studentCanvasUserId: string;
  submittedAt: string;
}

interface PromptLedgerRecord extends PromptLedgerPayload {
  parsedSubmittedAtMs: number;
}

function parsePromptLedgerPayload(rawBody: string | undefined): PromptLedgerRecord | null {
  const raw = (rawBody ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PromptLedgerPayload>;
    const eventId = (parsed.eventId ?? '').toString().trim();
    const assignmentId = (parsed.assignmentId ?? '').toString().trim();
    const promptHtml = (parsed.promptHtml ?? '').toString();
    const studentCanvasUserId = (parsed.studentCanvasUserId ?? '').toString().trim();
    const submittedAt = (parsed.submittedAt ?? '').toString().trim();
    if (!eventId || !assignmentId || !promptHtml || !studentCanvasUserId || !submittedAt) return null;
    const submittedAtMs = Date.parse(submittedAt);
    if (!Number.isFinite(submittedAtMs)) return null;
    return {
      eventId,
      assignmentId,
      promptHtml,
      studentCanvasUserId,
      submittedAt,
      parsedSubmittedAtMs: submittedAtMs,
    };
  } catch {
    return null;
  }
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
  constructor(
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessmentRepo: IAssessmentRepository,
    @Inject(PROMPT_DATA_REPOSITORY) private readonly promptDataRepo: IPromptDataRepository,
    private readonly config: ConfigService,
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiAgs: LtiAgsService,
    private readonly deepLinkFileStore: LtiDeepLinkFileStore,
    private readonly deepLinkResponse: LtiDeepLinkResponseService,
    private readonly quiz: QuizService,
    private readonly sproutVideo: SproutVideoService,
    private readonly promptFallbackStore: PromptFallbackStore,
    private readonly promptVideoTitleStore: PromptVideoTitleStore,
  ) {}

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
    throw new Error('Assignment ID required. In course_navigation, pass assignmentId as query parameter.');
  }

  /**
   * Resolve SproutVideo PromptSubmissions folder id: .env first, then Settings blob.
   * One-time fix: if missing from both, look up folder by name "PromptSubmissions" (or create it),
   * persist to Settings description with sproutPromptSubmissionsFolderId first, then return id.
   * Never delete or overwrite sproutPromptSubmissionsFolderId when merging blob elsewhere.
   */
  private async getPromptSubmissionsFolderId(
    courseId: string,
    domainOverride: string | undefined,
    token: string | null,
  ): Promise<string | null> {
    appendLtiLog('prompt-deeplink', 'SproutVideo: getPromptSubmissionsFolderId called', { hasToken: !!token });
    const fromEnv = (this.config.get<string>('SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID') ?? '').trim();
    if (fromEnv) {
      appendLtiLog('prompt-deeplink', 'SproutVideo: using folder id from .env (SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID)', { id: fromEnv.slice(0, 8) + '...' });
      return fromEnv;
    }
    if (!token) {
      appendLtiLog('prompt-deeplink', 'SproutVideo: no Canvas token, skipping folder lookup', {});
      return null;
    }
    let blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    const fromBlob = (blob?.sproutPromptSubmissionsFolderId ?? '').trim();
    if (fromBlob) {
      appendLtiLog('prompt-deeplink', 'SproutVideo: using folder id from Settings blob', { id: fromBlob.slice(0, 8) + '...' });
      return fromBlob;
    }

    // One-time fix: look up by name, or create, then persist to Settings (folder id first so it survives and can be copied to .env)
    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(courseId, domainOverride, token);
    const folderName = 'PromptSubmissions';
    const listFoldersUrl = 'https://api.sproutvideo.com/v1/folders?per_page=100';
    appendLtiLog('prompt-deeplink', `SproutVideo: GET ${listFoldersUrl} to find folder by name "${folderName}"`, { request: 'GET', url: listFoldersUrl, folderName });
    let folderId: string | null = await this.sproutVideo.findFolderByName(folderName);
    appendLtiLog('prompt-deeplink', 'SproutVideo: findFolderByName result', { folderName, foundId: folderId ?? null, found: !!folderId });
    if (!folderId) {
      try {
        appendLtiLog('prompt-deeplink', 'SproutVideo: creating folder (not found by name)', { folderName });
        folderId = await this.sproutVideo.createFolder(folderName);
        appendLtiLog('prompt-deeplink', 'SproutVideo: created folder PromptSubmissions', { id: folderId });
      } catch (err) {
        appendLtiLog('prompt-deeplink', 'SproutVideo: createFolder failed', { error: String(err) });
        return null;
      }
    } else {
      appendLtiLog('prompt-deeplink', 'SproutVideo: using existing folder found by name', { id: folderId });
    }
    blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    const payload: PromptManagerSettingsBlob = {
      sproutPromptSubmissionsFolderId: folderId,
      ...blob,
      v: blob?.v ?? 1,
      configs: blob?.configs ?? {},
      updatedAt: new Date().toISOString(),
    };
    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(courseId, settingsAssignmentId, description, domainOverride, token);
    appendLtiLog('prompt-deeplink', 'SproutVideo: persisted folder id to Settings (copy to SPROUT_PROMPT_SUBMISSIONS_FOLDER_ID in .env)', { id: folderId });
    return folderId;
  }

  private async ensureLedgerAssignment(
    courseId: string,
    domainOverride: string | undefined,
    token: string,
  ): Promise<string> {
    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(courseId, domainOverride, token);
    const blob = await this.readPromptManagerSettingsBlob(courseId, domainOverride, token);
    const fromBlob = (blob?.promptLedgerAssignmentId ?? '').trim();
    if (fromBlob) {
      appendLtiLog('ledger', 'ensureLedgerAssignment: using assignment id from Prompt Manager Settings blob', { assignmentId: fromBlob });
      return fromBlob;
    }

    let ledgerAssignmentId = await this.canvas.findAssignmentByTitle(
      courseId,
      PROMPT_LEDGER_ASSIGNMENT_TITLE,
      domainOverride,
      token,
    );
    if (!ledgerAssignmentId) {
      ledgerAssignmentId = await this.canvas.createAssignment(
        courseId,
        PROMPT_LEDGER_ASSIGNMENT_TITLE,
        {
          submissionTypes: ['online_text_entry'],
          pointsPossible: 0,
          published: true,
          description: 'ASL Express append-only prompt ledger (auto-created).',
          omitFromFinalGrade: true,
          hideInGradebook: true,
          gradingType: 'not_graded',
          tokenOverride: token,
        },
        domainOverride,
      );
      appendLtiLog('ledger', 'ensureLedgerAssignment: created ledger assignment', { assignmentId: ledgerAssignmentId });
    } else {
      appendLtiLog('ledger', 'ensureLedgerAssignment: found existing ledger assignment by title', { assignmentId: ledgerAssignmentId });
    }

    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: blob?.v ?? 1,
      configs: blob?.configs ?? {},
      promptLedgerAssignmentId: ledgerAssignmentId,
      updatedAt: new Date().toISOString(),
    };
    await this.canvas.updateAssignmentDescription(
      courseId,
      settingsAssignmentId,
      JSON.stringify(payload),
      domainOverride,
      token,
    );
    appendLtiLog('ledger', 'ensureLedgerAssignment: persisted assignment id to Prompt Manager Settings blob', {
      assignmentId: ledgerAssignmentId,
    });
    return ledgerAssignmentId;
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
    if (settingsAssignmentId) {
      const assignment = await this.canvas.getAssignment(courseId, settingsAssignmentId, domainOverride, token);
      const raw = assignment?.description?.trim() ?? '';
      const blob = extractJsonBlob(raw);
      if (blob) return blob;
    }
    const ann = await this.canvas.findSettingsAnnouncementByTitle(
      courseId,
      PROMPT_MANAGER_SETTINGS_ANNOUNCEMENT_TITLE,
      token,
      domainOverride,
    );
    if (ann?.message) {
      return extractJsonBlob(ann.message);
    }
    return null;
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

  async getConfig(ctx: LtiContext): Promise<PromptConfigJson | null> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) {
      return null;
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const assignmentIdFromCtx = (ctx.assignmentId ?? '').trim();
    const assignmentIdFromMap = (blob?.resourceLinkAssignmentMap?.[(ctx.resourceLinkId ?? '').trim()] ?? '').trim();
    let assignmentResolutionSource: 'ctx' | 'map' | 'title' | 'none' = assignmentIdFromCtx ? 'ctx' : assignmentIdFromMap ? 'map' : 'none';
    let assignmentId = assignmentIdFromCtx || assignmentIdFromMap;
    if (!assignmentId) {
      const title = (ctx.resourceLinkTitle ?? '').trim();
      const titleMatch = title.match(/^(.+?)\s+—\s+Prompter(?:\s*\(.*\))?\s*$/i);
      const assignmentNameHint = (titleMatch?.[1] ?? '').trim();
      if (assignmentNameHint) {
        const configs = blob?.configs ?? {};
        const candidates = Object.entries(configs)
          .filter(([, c]) => (c?.assignmentName ?? '').trim() === assignmentNameHint)
          .map(([id]) => id);
        if (candidates.length === 1) {
          assignmentId = candidates[0];
          assignmentResolutionSource = 'title';
          appendLtiLog('prompt', 'getConfig: resolved assignmentId from resourceLinkTitle', {
            assignmentId,
            assignmentNameHint,
            resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
          });
        }
      }
    }
    appendLtiLog('prompt', 'getConfig: assignment resolution', {
      source: assignmentResolutionSource,
      assignmentId: assignmentId || '(none)',
      assignmentIdFromCtx: assignmentIdFromCtx || '(none)',
      assignmentIdFromMap: assignmentIdFromMap || '(none)',
      resourceLinkId: (ctx.resourceLinkId ?? '').trim() || '(none)',
    });
    if (!assignmentId) {
      return null;
    }
    let config = blob?.configs?.[assignmentId] ?? null;

    // Backward compatibility: default promptMode to 'text' if not present
    if (config && !config.promptMode) {
      config = { ...config, promptMode: 'text' };
    }
    if (config?.promptMode === 'decks') {
      const rawTotal = Number(config.videoPromptConfig?.totalCards);
      const totalCards = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 10;
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
                  duration: Number.isFinite(Number(p?.duration)) && Number(p?.duration) > 0 ? Number(p?.duration) : 3,
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
          selectedDecks: config.videoPromptConfig?.selectedDecks ?? [],
          totalCards,
          ...(normalizedBanks.length > 0 ? { storedPromptBanks: normalizedBanks } : {}),
          ...(existingStatic.length > 0 ? { staticFallbackPrompts: existingStatic } : {}),
        },
      };
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
        return hydrated;
      }
    } catch (err) {
      appendLtiLog('prompt', 'getConfig: assignment hydration failed (non-fatal)', {
        assignmentId,
        error: String(err),
      });
    }

    return config ?? null;
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

    try {
      await this.quiz.ensurePromptStorageQuiz(ctx);
    } catch (quizErr) {
      appendLtiLog('prompt', 'putConfig: ensurePromptStorageQuiz failed (non-fatal)', { error: String(quizErr) });
    }

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

    const assignmentTitle = (merged.assignmentName ?? '').trim() || `Assignment ${assignmentId}`;
    try {
      await this.quiz.ensureQuestionForAssignment(ctx, assignmentId, assignmentTitle);
    } catch (qErr) {
      appendLtiLog('prompt', 'putConfig: ensureQuestionForAssignment failed (non-fatal)', { error: String(qErr) });
    }

    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(
      ctx.courseId,
      domainOverride,
      token,
    );
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = { ...(blob?.configs ?? {}), [assignmentId]: merged };
    let sproutFolderId = await this.getPromptSubmissionsFolderId(ctx.courseId, domainOverride, token);
    if (!sproutFolderId) {
      try {
        sproutFolderId = await this.sproutVideo.createFolder('PromptSubmissions');
        appendLtiLog('prompt', 'putConfig: created SproutVideo folder PromptSubmissions', { id: sproutFolderId });
      } catch (err) {
        appendLtiLog('prompt', 'putConfig: SproutVideo createFolder failed (non-fatal)', { error: String(err) });
      }
    }
    // Read → merge → write: never overwrite entire blob; preserve existing fields (e.g. sproutPromptSubmissionsFolderId)
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs,
      updatedAt: new Date().toISOString(),
      ...((blob?.sproutPromptSubmissionsFolderId ?? sproutFolderId) && {
        sproutPromptSubmissionsFolderId: blob?.sproutPromptSubmissionsFolderId ?? sproutFolderId ?? undefined,
      }),
    };
    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(
      ctx.courseId,
      settingsAssignmentId,
      description,
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
          const cleanup = await this.canvas.prunePrompterExternalToolModuleItems(
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
            marker: 'externalToolCleanup',
            outcome: 'ok',
            assignmentId,
            moduleId,
            reason: `checked=${cleanup.checked};deleted=${cleanup.deleted};kept=${cleanup.keptItemId ?? 'none'};moduleItemId=${assignmentSync.itemId ?? 'none'}${cleanup.skippedReason ? `;skip=${cleanup.skippedReason}` : ''}`,
          });
        } catch (cleanupErr) {
          this.placementMarker({
            placementAttemptId,
            ltiVersion,
            path: 'assignment_anchor',
            marker: 'externalToolCleanup',
            outcome: 'warn',
            assignmentId,
            moduleId,
            reason: String(cleanupErr),
          });
        }
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
      ? Math.max(1, Math.round(Number(allowedAttemptsRaw)))
      : 1;
    const hasAssignmentUpdates = Boolean(
      agId || assignmentName || instructions !== '' || pointsPossible !== 100 || dueAt || unlockAt || lockAt || allowedAttempts !== 1,
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
          try {
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
          } catch (attemptErr) {
            const msg = String(attemptErr);
            if (msg.toLowerCase().includes('allowed_attempts') && msg.toLowerCase().includes('greater than 0')) {
              appendLtiLog('prompt', 'putConfig: allowed_attempts rejected, retrying with fallback=1', {
                assignmentId,
                attemptedAllowedAttempts: allowedAttempts,
              });
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
                  allowedAttempts: 1,
                },
                domainOverride,
                token,
              );
            } else {
              throw attemptErr;
            }
          }
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
    appendLtiLog('prompt-decks', 'buildDeckPromptList start', {
      selectedDeckCount: selectedDecks?.length ?? 0,
      totalCards,
    });
    if (!selectedDecks || selectedDecks.length === 0) {
      return { prompts: [], warning: 'No decks selected' };
    }

    // Step 1: Fetch all cards from each deck
    const deckCards = new Map<string, Array<{ id: string; title: string }>>();
    for (const deck of selectedDecks) {
      try {
        const videos = await this.sproutVideo.fetchVideosByPlaylistId(deck.id);
        // Step 2: Deduplicate within each deck by English title (case-insensitive)
        const seen = new Set<string>();
        const deduped: Array<{ id: string; title: string }> = [];
        for (const v of videos) {
          const key = (v.title ?? '').trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push({ id: v.id, title: v.title.trim() });
        }
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
    const selected: Array<{ title: string; videoId?: string }> = [];
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
            selected.push({ title: card.title, videoId: card.id });
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

    // Step 3 (Timing): Fetch video durations
    const videoIds = selected.filter(s => s.videoId).map(s => s.videoId!);
    const durations = await this.sproutVideo.getVideoDurations(videoIds);
    const prompts = selected.map(s => ({
      title: s.title,
      videoId: s.videoId,
      // totalPromptTime = 1.5s + videoDuration, fallback 3s
      duration: 1.5 + (durations.get(s.videoId!) ?? 3),
    }));

    appendLtiLog('prompt-decks', 'buildDeckPromptList result', {
      selectedDeckCount: selectedDecks.length,
      totalRequested: totalToSelect,
      promptCount: prompts.length,
      warning: warning ?? '(none)',
    });

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

  async submit(ctx: LtiContext, promptSnapshotHtml: string): Promise<void> {
    appendLtiLog('prompt-submit', 'submit ENTER', { assignmentId: ctx.assignmentId, bodyLength: promptSnapshotHtml?.length ?? 0 });
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) {
      appendLtiLog('prompt-submit', 'submit FAIL: no token');
      throw new Error(
        'Canvas token required for submission (complete OAuth as student/teacher, or set CANVAS_API_TOKEN / CANVAS_ACCESS_TOKEN on the server)',
      );
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    appendLtiLog('prompt-submit', 'submit: got assignmentId', { assignmentId });
    const bodyString = JSON.stringify({
      promptSnapshotHtml,
      submittedAt: new Date().toISOString(),
    });
    const ctxWithToken: LtiContext = { ...ctx, canvasAccessToken: token };
    await this.canvas.writeSubmissionBody(ctxWithToken, assignmentId, bodyString, token);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const userId = (ctx.canvasUserId ?? '').trim() || ctx.userId;

    // Phase 1: Assignment-based prompt ledger write (append-only row per prompt event).
    // TODO SECURITY PHASE 2: Add signed server token validation before writing ledger row.
    // Issue HMAC/JWT during assignment load with claims: courseId, assignmentId,
    // studentCanvasUserId, resourceLinkId, exp, nonce.
    // Verify signature, TTL, and nonce uniqueness before accepting ledger write.
    // Reject invalid/expired/replayed tokens. See Assignment-Based Prompt Ledger Plan doc.
    try {
      const ledgerAssignmentId = await this.ensureLedgerAssignment(ctx.courseId, domainOverride, token);
      const payload: PromptLedgerPayload = {
        eventId: randomUUID(),
        assignmentId,
        promptHtml: promptSnapshotHtml,
        studentCanvasUserId: userId,
        submittedAt: new Date().toISOString(),
      };
      const payloadJson = JSON.stringify(payload);
      let wroteAsUser = false;
      try {
        await this.canvas.createSubmissionWithBody(
          ctx.courseId,
          ledgerAssignmentId,
          userId,
          payloadJson,
          domainOverride,
          token,
          true,
        );
        wroteAsUser = true;
      } catch (err) {
        appendLtiLog('ledger', 'submit: ledger write with as_user_id failed; retrying self-submit', {
          assignmentId,
          ledgerAssignmentId,
          userId,
          error: String(err),
        });
        await this.canvas.createSubmissionWithBody(
          ctx.courseId,
          ledgerAssignmentId,
          userId,
          payloadJson,
          domainOverride,
          token,
          false,
        );
      }
      appendLtiLog('ledger', 'submit: ledger row written', {
        assignmentId,
        ledgerAssignmentId,
        studentCanvasUserId: userId,
        eventId: payload.eventId,
        writeMode: wroteAsUser ? 'as_user_id' : 'self-submit',
      });
    } catch (ledgerErr) {
      appendLtiLog('ledger', 'submit: ledger write failed (non-fatal)', {
        assignmentId,
        studentCanvasUserId: userId,
        error: String(ledgerErr),
      });
    }

    await this.canvas.addSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      promptSnapshotHtml,
      undefined,
      domainOverride,
      token,
    );

    try {
      const assign = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
      const assignmentTitle = (assign?.name ?? '').trim() || assignmentId;
      await this.quiz.storePrompt(ctx, assignmentId, assignmentTitle, promptSnapshotHtml, userId);
    } catch (quizErr) {
      appendLtiLog('prompt-submit', 'submit: storePrompt in quiz failed (non-fatal)', { error: String(quizErr) });
    }

    appendLtiLog('prompt-submit', 'submit DONE (body + comment + quiz storage written to Canvas)', { assignmentId });
  }

  async uploadVideo(
    ctx: LtiContext,
    buffer: Buffer,
    filename: string,
  ): Promise<{ fileId: string }> {
    appendLtiLog('prompt-upload', 'uploadVideo ENTER', { filename, size: buffer.length });
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) {
      appendLtiLog('prompt-upload', 'uploadVideo FAIL: no token');
      throw new Error(
        'Canvas token required for video upload (OAuth or server CANVAS_API_TOKEN / CANVAS_ACCESS_TOKEN)',
      );
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const studentUserId = ((ctx.canvasUserId ?? '').trim() || ctx.userId).trim();
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    appendLtiLog('prompt-upload', 'uploadVideo: initiateSubmissionFileUploadForUser', {
      assignmentId,
      studentUserId,
    });
    const { uploadUrl, uploadParams } = await this.canvas.initiateSubmissionFileUploadForUser(
      ctx.courseId,
      assignmentId,
      studentUserId,
      filename,
      buffer.length,
      'video/webm',
      domainOverride,
      token,
    );
    appendLtiLog('prompt-upload', 'uploadVideo: uploadFileToCanvas', { bufferSize: buffer.length });
    const { fileId } = await this.canvas.uploadFileToCanvas(uploadUrl, uploadParams, buffer, {
      tokenOverride: token,
    });
    appendLtiLog('prompt-upload', 'uploadVideo: attachFileToSubmission', { fileId, assignmentId, studentUserId });
    await this.canvas.attachFileToSubmission(
      ctx.courseId,
      assignmentId,
      studentUserId,
      fileId,
      domainOverride,
      token,
    );
    appendLtiLog('prompt-upload', 'uploadVideo DONE', { fileId });
    return { fileId };
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
    if (ctx.messageType !== 'LtiDeepLinkingRequest' || !ctx.deepLinkReturnUrl) {
      appendLtiLog('prompt-deeplink', 'submitDeepLink FAIL: missing context');
      throw new Error('Deep Linking context required (messageType LtiDeepLinkingRequest and deepLinkReturnUrl)');
    }

    // Use Canvas numeric user id when present so teacher viewer (Canvas submissions user_id)
    // can resolve in-memory mappings reliably.
    const submitUserId = (ctx.canvasUserId ?? '').trim() || ctx.userId;

    // In dev: create SproutVideo title first; use it as content item title so Canvas stores it for lookup. Do not wait for upload.
    const videoTitle =
      process.env.NODE_ENV !== 'production'
        ? `asl_${ctx.courseId}_${ctx.assignmentId}_${submitUserId}_${Date.now()}`
        : '';
    appendLtiLog('prompt-deeplink', 'video title created (dev only)', {
      hasVideoTitle: !!videoTitle,
      videoTitle: videoTitle || '(none)',
      length: videoTitle?.length ?? 0,
      submitUserId,
      ltiUserId: ctx.userId,
      canvasUserId: ctx.canvasUserId ?? '(none)',
    });
    if (process.env.NODE_ENV !== 'production' && videoTitle) {
      this.promptVideoTitleStore.set(ctx.courseId, ctx.assignmentId ?? '', submitUserId, videoTitle);
      const canvasToken = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
      const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
      const folderId = await this.getPromptSubmissionsFolderId(ctx.courseId, domainOverride, canvasToken);
      if (folderId) {
        const courseId = ctx.courseId;
        const assignmentId = ctx.assignmentId ?? '';
        const userId = submitUserId;
        this.sproutVideo
          .uploadVideo(buffer, filename ?? 'asl_submission.webm', { folderId, title: videoTitle })
          .then(({ embedUrl }) => {
            this.promptFallbackStore.set(courseId, assignmentId, userId, embedUrl);
            appendLtiLog('prompt-deeplink', 'SproutVideo: upload complete (background), fallback store set', {
              key: `${courseId}:${assignmentId}:${userId}`,
            });
          })
          .catch((err) => {
            appendLtiLog('prompt-deeplink', 'SproutVideo upload failed (background, non-fatal)', { error: String(err) });
          });
      }
    }

    const token = this.deepLinkFileStore.set(buffer, contentType);
    this.deepLinkFileStore.registerSubmissionToken(ctx.courseId, ctx.assignmentId, submitUserId, token);
    const contentItemTitle = process.env.NODE_ENV !== 'production' && videoTitle ? videoTitle : 'ASL Express Video Submission';
    appendLtiLog('prompt-deeplink', 'SproutVideo title → content item: ONLY place we set what Canvas shows', {
      contentItemTitle,
      length: contentItemTitle.length,
      isDevTitle: process.env.NODE_ENV !== 'production' && !!videoTitle,
      note: 'buildResponseHtml puts this in the LTI content item; Canvas decides where it appears (body/title).',
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
          message: 'Redirecting to Canvas. (SproutVideo upload runs in background for teacher fallback.)',
          delayMs: 2500,
          contentItemTitle,
          videoTitle: videoTitle || null,
        },
      };
    }
    return html;
  }

  /** Submission count for the visible assignment (for teacher UI). Uses ctx.assignmentId when present. */
  async getSubmissionCount(ctx: LtiContext): Promise<number> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
      /** When in-memory video is missing (dev), SproutVideo embed URL for iframe fallback. */
      fallbackVideoUrl?: string;
      promptHtml?: string;
    }>
  > {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas token required (OAuth or server CANVAS_API_TOKEN / CANVAS_ACCESS_TOKEN)');
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
      let videoUrl = getVideoUrlFromCanvasSubmission(s);
      let fallbackVideoUrl: string | undefined;
      if (!videoUrl) {
        const submissionToken = this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, userId);
        if (submissionToken) {
          videoUrl = `/api/prompt/submission/${encodeURIComponent(submissionToken)}`;
          const fileStillPresent = this.deepLinkFileStore.get(submissionToken);
          const fromFallbackStore = this.promptFallbackStore.get(ctx.courseId, assignmentId, userId) ?? undefined;
          if (fromFallbackStore) {
            if (process.env.NODE_ENV !== 'production') {
              fallbackVideoUrl = fromFallbackStore;
              appendLtiLog('viewer', 'getSubmissions: dev — SproutVideo fallback set for Teacher Viewer', {
                userId,
                assignmentId,
                inMemoryMissing: !fileStillPresent,
              });
            } else if (!fileStillPresent) {
              fallbackVideoUrl = fromFallbackStore;
              appendLtiLog('viewer', 'getSubmissions: using SproutVideo fallback (in-memory video missing)', {
                userId,
                assignmentId,
                fallbackUrlPreview: fromFallbackStore.slice(0, 50) + '...',
              });
            }
          }
        }
      }
      if (process.env.NODE_ENV !== 'production') {
        const fromStore = this.promptFallbackStore.get(ctx.courseId, assignmentId, userId) ?? undefined;
        if (fromStore) fallbackVideoUrl = fromStore;
        appendLtiLog('viewer', 'getSubmissions: fallback store lookup', {
          key: `${ctx.courseId}:${assignmentId}:${userId}`,
          found: !!fromStore,
        });
      }
      videoUrl = this.toViewerVideoUrl(videoUrl, ctx) ?? videoUrl;
      return {
        userId,
        userName: s.user?.name,
        body: s.body,
        score: s.score,
        grade: s.grade,
        submissionComments: s.submission_comments?.map((c) => ({ id: c.id, comment: c.comment })) ?? [],
        videoUrl,
        fallbackVideoUrl,
      };
    });
    const ledgerPromptByUser = new Map<string, string>();
    try {
      const ledgerAssignmentId = await this.ensureLedgerAssignment(ctx.courseId, domainOverride, token);
      const ledgerSubmissions = await this.canvas.listSubmissions(
        ctx.courseId,
        ledgerAssignmentId,
        domainOverride,
        token,
      );
      appendLtiLog('ledger', 'getSubmissions: fetched ledger submissions', {
        ledgerAssignmentId,
        count: ledgerSubmissions.length,
      });

      const eventsByUser = new Map<string, PromptLedgerRecord[]>();
      for (const s of ledgerSubmissions) {
        const top = parsePromptLedgerPayload(s.body);
        if (top) {
          const arr = eventsByUser.get(top.studentCanvasUserId) ?? [];
          arr.push(top);
          eventsByUser.set(top.studentCanvasUserId, arr);
        }
        const history = Array.isArray((s as { submission_history?: unknown[] }).submission_history)
          ? ((s as { submission_history?: Array<{ body?: string }> }).submission_history ?? [])
          : [];
        for (const h of history) {
          const fromHistory = parsePromptLedgerPayload((h as { body?: string }).body);
          if (!fromHistory) continue;
          const arr = eventsByUser.get(fromHistory.studentCanvasUserId) ?? [];
          arr.push(fromHistory);
          eventsByUser.set(fromHistory.studentCanvasUserId, arr);
        }
      }

      for (const row of baseRows) {
        const allForUser = (eventsByUser.get(row.userId) ?? []).filter((ev) => ev.assignmentId === assignmentId);
        if (allForUser.length === 0) {
          appendLtiLog('ledger', 'getSubmissions ledger correlation: no-ledger-match', {
            userId: row.userId,
            assignmentId,
          });
          continue;
        }
        allForUser.sort((a, b) => b.parsedSubmittedAtMs - a.parsedSubmittedAtMs);
        const videoSubmittedAtMs = videoSubmittedAtByUser.get(row.userId);
        const nearestAtOrBefore =
          videoSubmittedAtMs == null
            ? null
            : allForUser.find((ev) => ev.parsedSubmittedAtMs <= videoSubmittedAtMs) ?? null;
        const selected = nearestAtOrBefore ?? allForUser[0];
        const decision = nearestAtOrBefore ? 'matched' : 'fallback-latest';
        ledgerPromptByUser.set(row.userId, selected.promptHtml);
        appendLtiLog('ledger', `getSubmissions ledger correlation: ${decision}`, {
          userId: row.userId,
          assignmentId,
          eventId: selected.eventId,
          ledgerSubmittedAt: selected.submittedAt,
          candidateCount: allForUser.length,
        });
      }
    } catch (e) {
      appendLtiLog('ledger', 'getSubmissions: ledger retrieval failed (non-fatal)', {
        assignmentId,
        error: String(e),
      });
    }
    if (process.env.NODE_ENV !== 'production') {
      appendLtiLog('viewer', 'getSubmissions: load/resolve video (dev) — entry', { rowCount: baseRows.length });
      appendLtiLog('viewer', 'getSubmissions: submission bodies (for video title debug)', {
        bodies: baseRows.map((r) => ({
          userId: r.userId,
          bodyPreview: r.body == null ? '(null)' : r.body === '' ? '(empty)' : r.body.slice(0, 120) + (r.body.length > 120 ? '...' : ''),
          bodyLength: r.body?.length ?? 0,
          note: 'Deep Linking title lookup uses promptVideoTitleStore only (body ignored)',
        })),
      });
      const folderId = await this.getPromptSubmissionsFolderId(ctx.courseId, domainOverride, token);
      appendLtiLog('viewer', 'getSubmissions: SproutVideo folderId from Prompt Manager Settings (or .env)', {
        folderId: folderId ?? 'none',
        willLookupByTitle: !!folderId,
      });
      if (folderId) {
        let folderVideos: Array<{ id: string; title: string; embedUrl: string }> = [];
        try {
          appendLtiLog('viewer', 'getSubmissions: listVideosByFolderId called (fetch folder contents first)', { folderId });
          folderVideos = await this.sproutVideo.listVideosByFolderId(folderId);
          appendLtiLog('viewer', 'getSubmissions: listVideosByFolderId result', { folderId, videoCount: folderVideos.length });
        } catch (e) {
          appendLtiLog('viewer', 'getSubmissions: listVideosByFolderId failed', {
            folderId,
            error: String(e),
          });
        }
        for (const row of baseRows) {
          if (row.fallbackVideoUrl) {
            appendLtiLog('viewer', 'getSubmissions: skip SproutVideo (already have fallback)', { userId: row.userId });
            continue;
          }
          const titleFromStore = this.promptVideoTitleStore.get(ctx.courseId, assignmentId, row.userId);
          const title = titleFromStore ?? null;
          if (!title) {
            appendLtiLog('viewer', 'getSubmissions: skip SproutVideo by-title (no title in promptVideoTitleStore)', { userId: row.userId });
            continue;
          }
          appendLtiLog('viewer', 'getSubmissions: findVideoByTitleInFolder (folder id → list contents → match by title)', {
            folderId,
            userId: row.userId,
            title: title.slice(0, 50) + (title.length > 50 ? '...' : ''),
            titleSource: 'store',
          });
          const targetLower = title.trim().toLowerCase();
          const found = folderVideos.find((v) => (v.title ?? '').trim().toLowerCase() === targetLower);
          if (found) {
            row.fallbackVideoUrl = found.embedUrl;
            appendLtiLog('viewer', 'getSubmissions: findVideoByTitleInFolder result — found', {
              userId: row.userId,
              embedUrlPreview: found.embedUrl.slice(0, 60) + (found.embedUrl.length > 60 ? '...' : ''),
            });
          } else {
            appendLtiLog('viewer', 'getSubmissions: findVideoByTitleInFolder result — not found in folder', {
              userId: row.userId,
              title: title.slice(0, 40),
              folderVideoCount: folderVideos.length,
            });
          }
        }
      }
      appendLtiLog('viewer', 'getSubmissions: final video state per row', {
        rows: baseRows.map((r) => ({
          userId: r.userId,
          hasVideoUrl: !!r.videoUrl,
          hasFallbackVideoUrl: !!r.fallbackVideoUrl,
        })),
      });
    }
    const withQuizPrompts = await Promise.all(
      baseRows.map(async (row) => {
        const ledgerPrompt = ledgerPromptByUser.get(row.userId);
        if (ledgerPrompt) {
          appendLtiLog('viewer', 'getSubmissions: prompt source selected', {
            userId: row.userId,
            assignmentId,
            source: 'ledger',
          });
          return { ...row, promptHtml: ledgerPrompt };
        }
        try {
          const promptHtml = await this.quiz.getPromptForAssignment(ctx, row.userId, assignmentId);
          appendLtiLog('viewer', 'getSubmissions: prompt source selected', {
            userId: row.userId,
            assignmentId,
            source: promptHtml ? 'quiz-legacy' : 'none',
          });
          return { ...row, promptHtml: promptHtml ?? undefined };
        } catch {
          appendLtiLog('viewer', 'getSubmissions: prompt source selected', {
            userId: row.userId,
            assignmentId,
            source: 'none',
          });
          return row;
        }
      }),
    );
    return withQuizPrompts;
  }

  /**
   * Convert external Canvas video URL to our proxy URL so the frontend can load it
   * with auth. Our own /api/prompt/submission/ URLs are returned as-is. Resolves
   * relative Canvas URLs (e.g. /files/123/download) using ctx.canvasBaseUrl.
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
    return `/api/prompt/video-proxy?url=${encodeURIComponent(videoUrl)}`;
  }

  /**
   * Stream a Canvas video URL using the session's OAuth token (for cross-origin video playback).
   * Only allows proxying to Canvas instance URLs to prevent SSRF.
   */
  async streamVideoProxy(
    ctx: LtiContext,
    targetUrl: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const parsed = new URL(targetUrl);
    const canvasBase = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const canvasHost = canvasBase ? new URL(canvasBase).hostname : '';
    const isSameCanvas = canvasHost && parsed.hostname === canvasHost;
    const isInstructure =
      parsed.hostname === 'instructure.com' ||
      parsed.hostname.endsWith('.instructure.com') ||
      parsed.hostname === 'instructureusercontent.com' ||
      parsed.hostname.endsWith('.instructureusercontent.com');
    if (!isSameCanvas && !isInstructure) return null;
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) return null;
    const res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || 'video/mp4').split(';')[0].trim().toLowerCase();
    if (contentType.startsWith('text/html')) {
      appendLtiLog('viewer', 'video-proxy: got HTML (not a video), rejecting', { targetUrl: targetUrl.slice(0, 80) + '...' });
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }

  async grade(
    ctx: LtiContext,
    userId: string,
    score: number,
    scoreMaximum: number,
    resultContent?: string,
    rubricAssessment?: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required');
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const assignmentId = await this.getPrompterAssignmentId(ctx);

    if (rubricAssessment && Object.keys(rubricAssessment).length > 0) {
      await this.canvas.putSubmissionGrade(
        ctx.courseId,
        assignmentId,
        userId,
        { rubricAssessment },
        domainOverride,
        token,
      );
    } else {
      const scoreMax = scoreMaximum > 0 ? scoreMaximum : 100;
      await this.ltiAgs.submitGradeViaAgs(ctx, {
        score,
        scoreMaximum: scoreMax,
        resultContent: resultContent ?? undefined,
        userId,
      });
    }
  }

  /** Teacher only - guard applied at controller. */
  async addComment(
    ctx: LtiContext,
    userId: string,
    time: number,
    text: string,
    attempt?: number,
  ): Promise<{ commentId?: number }> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
  } | null> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) return null;
    const assignmentId = ctx.assignmentId?.trim();
    if (!assignmentId) return null;
    const userId = ctx.canvasUserId ?? ctx.userId;
    if (!userId) return null;
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const sub = await this.canvas.getSubmissionFull(
      ctx.courseId,
      assignmentId,
      userId,
      domainOverride,
      token,
    );
    if (!sub || (!ctx.roles?.toLowerCase().includes('instructor') && !sub.submitted_at)) return null;
    let videoUrl = getVideoUrlFromCanvasSubmission(sub);
    if (!videoUrl) {
      const tok = this.deepLinkFileStore.getSubmissionToken(ctx.courseId, assignmentId, userId);
      if (tok) videoUrl = `/api/prompt/submission/${encodeURIComponent(tok)}`;
    }
    videoUrl = this.toViewerVideoUrl(videoUrl, ctx) ?? videoUrl;
    let promptHtml: string | undefined;
    try {
      promptHtml = (await this.quiz.getPromptForAssignment(ctx, userId, assignmentId)) ?? undefined;
    } catch {
      // ignore
    }
    return {
      userId,
      body: sub.body,
      score: sub.score,
      grade: sub.grade,
      submissionComments: sub.submission_comments?.map((c) => ({ id: c.id, comment: c.comment })) ?? [],
      videoUrl,
      attempt: sub.attempt ?? 1,
      rubricAssessment: sub.rubric_assessment as Record<string, unknown> | undefined,
      promptHtml,
    };
  }

  /** Teacher only - guard applied at controller. */
  async getAssignmentForGrading(ctx: LtiContext): Promise<{
    pointsPossible?: number;
    rubric?: Array<unknown>;
  } | null> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) return null;
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const raw = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    if (!raw) return null;
    let rubric = Array.isArray(raw.rubric) && raw.rubric.length > 0 ? raw.rubric : null;
    if (!rubric) {
      const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
      const rubricId = blob?.configs?.[assignmentId]?.rubricId?.trim();
      if (rubricId) {
        const fetched = await this.canvas.getRubric(ctx.courseId, rubricId, domainOverride, token);
        if (fetched?.length) rubric = fetched;
      }
    }
    return { pointsPossible: raw.points_possible, rubric: rubric ?? undefined };
  }

  /** Teacher only. Returns configured assignments with names and counts from Canvas.
   * Purges any configs whose assignments have been deleted from Canvas (no DB - updates Prompt Manager Settings). */
  async getConfiguredAssignments(ctx: LtiContext): Promise<
    Array<{ id: string; name: string; submissionCount: number; ungradedCount: number }>
  > {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
      // Read → merge → write: only remove purged assignment configs; preserve rest of blob (e.g. sproutPromptSubmissionsFolderId)
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
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
    if (!token) return [];
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    return this.canvas.listAssignmentGroups(ctx.courseId, domainOverride, token);
  }

  /** Teacher only. Returns course rubrics for teacher config. */
  async getRubrics(ctx: LtiContext): Promise<Array<{ id: number; title: string; pointsPossible: number }>> {
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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
    const token = await this.courseSettings.getCanvasTokenForLtiBackedOps(ctx.canvasAccessToken);
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

  /** Teacher only. Creates a Canvas assignment with online_upload and adds entry to configs map.
   * Pass assignmentGroupId (or create via newGroupName) to place in correct group (matches PHP). */
  async createPromptManagerAssignment(
    ctx: LtiContext,
    name: string,
    options?: { assignmentGroupId?: string; newGroupName?: string },
  ): Promise<{ assignmentId: string }> {
    appendLtiLog('prompt', 'create-assignment: createPromptManagerAssignment called', {
      name,
      optionsAssignmentGroupId: options?.assignmentGroupId ?? '(none)',
      optionsNewGroupName: options?.newGroupName ?? '(none)',
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
        submissionTypes: ['online_upload'],
        pointsPossible: 100,
        published: true,
        description: 'ASL video submission via ASL Express',
        assignmentGroupId,
        tokenOverride: token,
      },
      domainOverride,
    );
    const settingsAssignmentId = await this.ensurePromptManagerSettingsAssignment(ctx.courseId, domainOverride, token);
    // Ensure SproutVideo PromptSubmissions folder id is resolved and persisted (one-time lookup/create + log in Bridge)
    await this.getPromptSubmissionsFolderId(ctx.courseId, domainOverride, token);
    const blob = await this.readPromptManagerSettingsBlob(ctx.courseId, domainOverride, token);
    const configs = {
      ...(blob?.configs ?? {}),
      [assignmentId]: {
        minutes: 5,
        prompts: [],
        accessCode: '',
        assignmentName: name,
        ...(assignmentGroupId != null ? { assignmentGroupId: String(assignmentGroupId) } : {}),
        promptMode: 'text',
      } as PromptConfigJson,
    };
    // Read → merge → write: only add new assignment to configs; preserve rest of blob (e.g. sproutPromptSubmissionsFolderId)
    const payload: PromptManagerSettingsBlob = {
      ...blob,
      v: 1,
      configs,
      updatedAt: new Date().toISOString(),
    };
    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(ctx.courseId, settingsAssignmentId, description, domainOverride, token);
    appendLtiLog('prompt', 'create-assignment: completed successfully', {
      assignmentId,
      courseId: ctx.courseId,
    });
    return { assignmentId };
  }
}
