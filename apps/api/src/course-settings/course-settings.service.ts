import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { appendLtiLog, getLastCanvasApiResponse } from '../common/last-error.store';
import { CanvasService, CanvasTokenExpiredError } from '../canvas/canvas.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { resolveCanvasApiBaseUrl } from '../common/utils/canvas-base-url.util';
import { CourseSettingsEntity } from './entities/course-settings.entity';

const FLASHCARD_SETTINGS_ASSIGNMENT_TITLE = 'Flashcard Settings';
const FLASHCARD_PROGRESS_TITLE = 'Flashcard Progress';
const SETTINGS_CACHE_TTL_MS = 60_000; // 1 minute - reduces Canvas API calls across student-units/sections/playlists

// In-memory cache: courseId -> { data, expiresAt }
const settingsCache = new Map<
  string,
  { data: { selectedCurriculums: string[]; selectedUnits: string[] }; expiresAt: number }
>();

interface SettingsAssignmentDescriptionData {
  v?: number;
  selectedCurriculums?: string[];
  selectedUnits?: string[];
  updatedAt?: string;
}

/** Extract JSON from Canvas content (assignment description or announcement message). Canvas Rich Content Editor often wraps plain JSON in <p> tags. */
function extractJsonFromCanvasContent(raw: string): SettingsAssignmentDescriptionData | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as SettingsAssignmentDescriptionData;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Canvas may return HTML-wrapped content; extract JSON object
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as SettingsAssignmentDescriptionData;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/** Alias for assignment description parsing */
function parseAssignmentDescription(description: string): SettingsAssignmentDescriptionData | null {
  return extractJsonFromCanvasContent(description);
}

@Injectable()
export class CourseSettingsService {
  constructor(
    @InjectRepository(CourseSettingsEntity)
    private readonly repo: Repository<CourseSettingsEntity>,
    private readonly canvas: CanvasService,
    private readonly config: ConfigService,
  ) {}

  /** Canvas API host from LTI launch (iss / consumer URL / domain); env only as dev fallback. */
  private canvasOverrideFromLaunchHints(opts: {
    canvasBaseUrl?: string;
    canvasDomain?: string;
    platformIss?: string;
  }): string | undefined {
    return resolveCanvasApiBaseUrl({
      canvasBaseUrl: opts.canvasBaseUrl,
      canvasDomain: opts.canvasDomain,
      platformIss: opts.platformIss,
      envFallback: this.config.get<string>('CANVAS_API_BASE_URL'),
    });
  }

  /** Initial assignment description as JSON so GET parses cleanly before first teacher save. */
  private emptySettingsDescription(): string {
    return JSON.stringify({
      v: 1,
      selectedCurriculums: [] as string[],
      selectedUnits: [] as string[],
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Find or create the "Flashcard Settings" assignment (teacher backup).
   * Uses an assignment group like other auto-created assignments so Canvas accepts the POST reliably.
   */
  private async ensureFlashcardSettingsAssignment(
    courseId: string,
    canvasDomain?: string,
    tokenOverride?: string | null,
  ): Promise<string> {
    const existing = await this.canvas.findAssignmentByTitle(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      canvasDomain,
      tokenOverride,
    );
    if (existing) return existing;

    const assignmentGroupId = await this.canvas.ensureAssignmentGroup(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      0,
      canvasDomain,
      tokenOverride,
    );

    return this.canvas.createAssignment(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      {
        submissionTypes: ['online_text_entry'],
        pointsPossible: 0,
        published: true,
        description: this.emptySettingsDescription(),
        assignmentGroupId,
        omitFromFinalGrade: true,
        tokenOverride,
      },
      canvasDomain,
    );
  }

  /** Ensure announcement exists with the same payload as the assignment (students read announcement only). */
  private async upsertFlashcardSettingsAnnouncement(
    courseId: string,
    payload: { selectedCurriculums: string[]; selectedUnits: string[] },
    token: string | null,
    canvasOverride?: string,
  ): Promise<void> {
    const existing = await this.canvas.findFlashcardSettingsAnnouncement(courseId, token, canvasOverride);
    if (existing) {
      await this.canvas.updateFlashcardSettingsAnnouncement(
        courseId,
        existing.id,
        payload,
        token,
        canvasOverride,
      );
    } else {
      await this.canvas.createFlashcardSettingsAnnouncement(courseId, payload, token, canvasOverride);
    }
  }

  async get(
    courseId: string,
    options?: {
      isTeacher?: boolean;
      canvasDomain?: string;
      canvasBaseUrl?: string;
      platformIss?: string;
      canvasAccessToken?: string;
    },
  ): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
    sproutAccountId?: string;
    progressAssignmentId: string | null;
    hasCanvasToken: boolean;
    /** Debug: which assignment/course/domain was used (visible in Bridge log) */
    _debug?: {
      assignmentTitle: string;
      courseIdUsed: string;
      canvasDomainUsed: string;
      flashcardSettingsAssignmentId: string | null;
      findResult: 'found' | 'not_found' | 'error';
      requestFindByTitle: string;
      requestGetAssignment: string | null;
      tokenStatus: string;
      canvasApiResponse: string | null;
    };
  } | null> {
    // Bypass cache for teachers so they always get fresh data from Canvas assignment
    const cached = !options?.isTeacher && settingsCache.get(courseId);
    appendLtiLog('course-settings', 'get() called', {
      courseId,
      isTeacher: options?.isTeacher ?? false,
      cacheBypassed: !!options?.isTeacher,
      cacheHit: !!(cached && Date.now() < cached.expiresAt),
    });
    if (cached && Date.now() < cached.expiresAt) {
      appendLtiLog('course-settings', 'Returning from cache', cached.data);
      return {
        ...cached.data,
        sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
        progressAssignmentId: null,
        hasCanvasToken: !!options?.canvasAccessToken,
      };
    }

    // Data from Canvas assignments only (no DB). OAuth access token from session (LTI flow).
    const tokenOverride = options?.canvasAccessToken?.trim() || null;
    const tokenStatus =
      tokenOverride === null
        ? 'null (OAuth token required)'
        : typeof tokenOverride === 'string'
          ? `present, length=${tokenOverride.length}, masked=${tokenOverride.slice(0, 4)}...${tokenOverride.slice(-4)}`
          : String(tokenOverride);
    const domainOverride = options?.canvasDomain;
    const canvasOverride = this.canvasOverrideFromLaunchHints({
      canvasBaseUrl: options?.canvasBaseUrl,
      canvasDomain: options?.canvasDomain,
      platformIss: options?.platformIss,
    });
    const domainForUrl = (val: string | undefined) => {
      if (!val) return '[not-set]';
      const m = val.match(/^https?:\/\/([^/]+)/);
      return m ? m[1] : val.replace(/\/.*$/, '');
    };
    const domain = (domainForUrl(canvasOverride ?? domainOverride) || domainOverride) ?? '[not-set]';
    const requestFindByTitle = canvasOverride?.startsWith('http')
      ? `GET ${canvasOverride.replace(/\/$/, '')}/api/v1/courses/${courseId}/assignments?per_page=100&page=1`
      : `GET https://${domain}/api/v1/courses/${courseId}/assignments?per_page=100&page=1`;
    const emptyResult = {
      selectedCurriculums: [] as string[],
      selectedUnits: [] as string[],
      sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
      progressAssignmentId: null as string | null,
      hasCanvasToken: !!tokenOverride,
    };

    let settingsAssignmentId: string | null = null;
    try {
      appendLtiLog('course-settings', 'Fetching Flashcard Settings assignment from Canvas', {
        courseId,
        domainOverride: domainOverride ?? '(env)',
        hasToken: !!tokenOverride,
      });
      settingsAssignmentId = await this.canvas.findAssignmentByTitle(
        courseId,
        FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
        canvasOverride,
        tokenOverride,
      );
      appendLtiLog('course-settings', 'findAssignmentByTitle result', {
        found: !!settingsAssignmentId,
        assignmentId: settingsAssignmentId ?? 'none',
      });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) throw err;
      appendLtiLog('course-settings', 'findAssignmentByTitle failed', {
        error: err instanceof Error ? err.message : String(err),
        courseIdUsed: courseId,
        canvasDomainUsed: domain,
      });
      const canvasResp = getLastCanvasApiResponse();
      return {
        ...emptyResult,
        _debug: {
          assignmentTitle: FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
          courseIdUsed: courseId,
          canvasDomainUsed: domain,
          flashcardSettingsAssignmentId: null,
          findResult: 'error',
          requestFindByTitle,
          requestGetAssignment: null,
          tokenStatus,
          canvasApiResponse: canvasResp ? `status=${canvasResp.status} ${canvasResp.statusText} | body: ${canvasResp.bodyPreview}` : null,
        },
      };
    }

    if (!settingsAssignmentId) {
      appendLtiLog('course-settings', 'No Flashcard Settings assignment found, returning empty', {
        courseIdUsed: courseId,
        canvasDomainUsed: domainOverride ?? '(env)',
        assignmentId: null,
      });
      const canvasResp = getLastCanvasApiResponse();
      return {
        ...emptyResult,
        _debug: {
          assignmentTitle: FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
          courseIdUsed: courseId,
          canvasDomainUsed: domain,
          flashcardSettingsAssignmentId: null,
          findResult: 'not_found',
          requestFindByTitle,
          requestGetAssignment: null,
          tokenStatus,
          canvasApiResponse: canvasResp ? `status=${canvasResp.status} ${canvasResp.statusText} | body: ${canvasResp.bodyPreview}` : null,
        },
      };
    }

    const requestGetAssignment = canvasOverride?.startsWith('http')
      ? `GET ${canvasOverride.replace(/\/$/, '')}/api/v1/courses/${courseId}/assignments/${settingsAssignmentId}`
      : `GET https://${domain}/api/v1/courses/${courseId}/assignments/${settingsAssignmentId}`;
    try {
      appendLtiLog('course-settings', 'Fetching assignment description from Canvas', { assignmentId: settingsAssignmentId, requestUrl: requestGetAssignment });
      const assignment = await this.canvas.getAssignment(
        courseId,
        settingsAssignmentId,
        canvasOverride,
        tokenOverride,
      );
      const rawDesc = assignment?.description?.trim() ?? '';
      const parsed = rawDesc ? parseAssignmentDescription(rawDesc) : null;
      const selectedCurriculums = Array.isArray(parsed?.selectedCurriculums) ? parsed.selectedCurriculums : [];
      const selectedUnits = Array.isArray(parsed?.selectedUnits) ? parsed.selectedUnits : [];

      appendLtiLog('course-settings', 'Parsed Flashcard Settings from assignment', {
        descLength: rawDesc.length,
        parsedOk: !!parsed,
        selectedCurriculums,
        selectedUnits,
      });

      settingsCache.set(courseId, {
        data: { selectedCurriculums, selectedUnits },
        expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
      });

      return {
        selectedCurriculums,
        selectedUnits,
        sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
        progressAssignmentId: null,
        hasCanvasToken: !!tokenOverride,
        _debug: {
          assignmentTitle: FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
          courseIdUsed: courseId,
          canvasDomainUsed: domain,
          flashcardSettingsAssignmentId: settingsAssignmentId,
          findResult: 'found',
          requestFindByTitle,
          requestGetAssignment,
          tokenStatus,
          canvasApiResponse: null,
        },
      };
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) throw err;
      appendLtiLog('course-settings', 'getAssignment or parse failed', {
        error: err instanceof Error ? err.message : String(err),
        assignmentId: settingsAssignmentId,
      });
      const canvasResp = getLastCanvasApiResponse();
      return {
        ...emptyResult,
        _debug: {
          assignmentTitle: FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
          courseIdUsed: courseId,
          canvasDomainUsed: domain,
          flashcardSettingsAssignmentId: settingsAssignmentId,
          findResult: 'error',
          requestFindByTitle,
          requestGetAssignment: canvasOverride?.startsWith('http')
            ? `GET ${canvasOverride.replace(/\/$/, '')}/api/v1/courses/${courseId}/assignments/${settingsAssignmentId}`
            : `GET https://${domain}/api/v1/courses/${courseId}/assignments/${settingsAssignmentId}`,
          tokenStatus,
          canvasApiResponse: canvasResp ? `status=${canvasResp.status} ${canvasResp.statusText} | body: ${canvasResp.bodyPreview}` : null,
        },
      };
    }
  }

  async save(
    courseId: string,
    selectedCurriculums: string[],
    selectedUnits: string[],
    canvasDomain?: string,
    canvasApiToken?: string,
    canvasBaseUrl?: string,
    platformIss?: string,
  ): Promise<void> {
    // OAuth access token from session only (no env fallback)
    const effectiveToken = (canvasApiToken ?? '').trim() || null;
    if (!effectiveToken) {
      throw new Error(
        'Canvas API token is required. Complete the Canvas OAuth flow (launch via LTI as teacher, or use Connect Canvas in Teacher Settings).',
      );
    }
    const canvasOverride = this.canvasOverrideFromLaunchHints({
      canvasBaseUrl,
      canvasDomain,
      platformIss,
    });
    const settingsAssignmentId = await this.ensureFlashcardSettingsAssignment(
      courseId,
      canvasOverride,
      effectiveToken,
    );

    const settingsPayload: SettingsAssignmentDescriptionData = {
      v: 1,
      selectedCurriculums: selectedCurriculums ?? [],
      selectedUnits: selectedUnits ?? [],
      updatedAt: new Date().toISOString(),
    };

    const description = JSON.stringify(settingsPayload);
    await this.canvas.updateAssignmentDescription(
      courseId,
      settingsAssignmentId,
      description,
      canvasOverride,
      effectiveToken,
    );

    settingsCache.set(courseId, {
      data: {
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
      },
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    });

    // Dual-write: announcement is primary for students — must succeed or save fails
    const announcementPayload = {
      selectedCurriculums: settingsPayload.selectedCurriculums ?? [],
      selectedUnits: settingsPayload.selectedUnits ?? [],
    };
    await this.upsertFlashcardSettingsAnnouncement(courseId, announcementPayload, effectiveToken, canvasOverride);

    // DB usage commented out - data flows from assignments only
    // await this.repo.upsert(
    //   { courseId, selectedCurriculums: selectedCurriculums ?? [], selectedUnits: selectedUnits ?? [], progressAssignmentId, canvasApiToken: tokenToSave },
    //   { conflictPaths: ['courseId'] },
    // );
  }

  /**
   * Student-only: reads from Course Announcement (never assignment). Uses student's OAuth token.
   * Returns settings or { error: 'announcement_missing' }. Handles Canvas HTML-wrapping in message body.
   */
  async getForStudent(
    courseId: string,
    options: {
      canvasDomain?: string;
      canvasBaseUrl?: string;
      platformIss?: string;
      canvasAccessToken?: string | null;
    },
  ): Promise<
    | { selectedCurriculums: string[]; selectedUnits: string[] }
    | { selectedCurriculums: []; selectedUnits: []; error: 'announcement_missing' }
  > {
    const token = options?.canvasAccessToken?.trim() || null;
    const canvasOverride = this.canvasOverrideFromLaunchHints({
      canvasBaseUrl: options?.canvasBaseUrl,
      canvasDomain: options?.canvasDomain,
      platformIss: options?.platformIss,
    });
    if (!token) {
      appendLtiLog('course-settings', 'getForStudent: no token', { courseId });
      return { selectedCurriculums: [], selectedUnits: [], error: 'announcement_missing' };
    }
    try {
      const ann = await this.canvas.findFlashcardSettingsAnnouncement(courseId, token, canvasOverride);
      if (!ann || !ann.message?.trim()) {
        appendLtiLog('course-settings', 'getForStudent: announcement not found', { courseId });
        return { selectedCurriculums: [], selectedUnits: [], error: 'announcement_missing' };
      }
      // Canvas Rich Content Editor may wrap JSON in <p> tags; use same HTML-stripping as assignment
      const parsed = extractJsonFromCanvasContent(ann.message);
      if (!parsed) {
        appendLtiLog('course-settings', 'getForStudent: failed to parse announcement message', { courseId, msgLen: ann.message.length });
        return { selectedCurriculums: [], selectedUnits: [], error: 'announcement_missing' };
      }
      return {
        selectedCurriculums: Array.isArray(parsed.selectedCurriculums) ? parsed.selectedCurriculums : [],
        selectedUnits: Array.isArray(parsed.selectedUnits) ? parsed.selectedUnits : [],
      };
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) throw err;
      appendLtiLog('course-settings', 'getForStudent failed', {
        courseId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { selectedCurriculums: [], selectedUnits: [], error: 'announcement_missing' };
    }
  }

  /** Check if Flashcard Settings announcement exists (teacher use). */
  async announcementExists(
    courseId: string,
    options: {
      canvasDomain?: string;
      canvasBaseUrl?: string;
      platformIss?: string;
      canvasAccessToken?: string | null;
    },
  ): Promise<boolean> {
    const token = options?.canvasAccessToken?.trim() || null;
    const canvasOverride = this.canvasOverrideFromLaunchHints({
      canvasBaseUrl: options?.canvasBaseUrl,
      canvasDomain: options?.canvasDomain,
      platformIss: options?.platformIss,
    });
    if (!token) return false;
    try {
      const ann = await this.canvas.findFlashcardSettingsAnnouncement(courseId, token, canvasOverride);
      return !!ann;
    } catch {
      return false;
    }
  }

  /**
   * Recreate (or create) the Flashcard Settings announcement from the assignment backup.
   * If the assignment does not exist yet, creates assignment + announcement with the same settings payload.
   */
  async recreateAnnouncement(
    courseId: string,
    options: {
      canvasDomain?: string;
      canvasBaseUrl?: string;
      platformIss?: string;
      canvasAccessToken?: string | null;
    },
  ): Promise<void> {
    const token = options?.canvasAccessToken?.trim() || null;
    const canvasOverride = this.canvasOverrideFromLaunchHints({
      canvasBaseUrl: options?.canvasBaseUrl,
      canvasDomain: options?.canvasDomain,
      platformIss: options?.platformIss,
    });
    if (!token) throw new Error('Canvas OAuth token required');

    let assignmentId = await this.canvas.findAssignmentByTitle(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      canvasOverride,
      token,
    );
    if (!assignmentId) {
      appendLtiLog('course-settings', 'recreateAnnouncement: no assignment — creating Flashcard Settings assignment');
      assignmentId = await this.ensureFlashcardSettingsAssignment(courseId, canvasOverride, token);
    }

    const desc = await this.canvas.getAssignment(courseId, assignmentId, canvasOverride, token);
    const parsed = parseAssignmentDescription(desc?.description ?? '');
    const payload = {
      selectedCurriculums: Array.isArray(parsed?.selectedCurriculums) ? parsed.selectedCurriculums : [],
      selectedUnits: Array.isArray(parsed?.selectedUnits) ? parsed.selectedUnits : [],
    };

    await this.upsertFlashcardSettingsAnnouncement(courseId, payload, token, canvasOverride);
    appendLtiLog('course-settings', 'recreateAnnouncement: announcement upserted from assignment', {
      courseId,
      assignmentId,
      curriculumCount: payload.selectedCurriculums.length,
      unitCount: payload.selectedUnits.length,
    });
  }

  async getEffectiveCanvasToken(_courseId: string, tokenOverride?: string | null): Promise<string | null> {
    return (tokenOverride?.trim() || null) ?? null;
  }

  /**
   * Token for file upload operations (e.g. Prompter video). Mirrors PHP: prefer static
   * CANVAS_API_TOKEN / CANVAS_ACCESS_TOKEN when set; fallback to OAuth. Static token has
   * permission to initiate upload and attach files on behalf of students.
   */
  getTokenForFileUpload(oauthToken?: string | null): string | null {
    const staticToken =
      (this.config.get<string>('CANVAS_API_TOKEN') ?? this.config.get<string>('CANVAS_ACCESS_TOKEN'))?.trim() || null;
    return staticToken ?? (oauthToken?.trim() || null) ?? null;
  }

  async getProgressAssignmentId(
    courseId: string,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    tokenOverride?: string | null,
    platformIss?: string,
  ): Promise<string> {
    const token = (tokenOverride ?? '').trim() || null;
    const ctx: LtiContext = {
      courseId,
      assignmentId: '',
      userId: '',
      resourceLinkId: '',
      moduleId: '',
      toolType: 'flashcards',
      roles: '',
      canvasDomain,
      canvasBaseUrl,
      platformIss,
    };
    return this.canvas.ensureAssignmentForCourse(ctx, {
      title: FLASHCARD_PROGRESS_TITLE,
      description: 'Stores flashcard study progress and deck configuration (auto-created by ASL Express)',
      submissionTypes: ['online_text_entry'],
      pointsPossible: 0,
      published: true,
      omitFromFinalGrade: true,
    }, token);
  }
}
