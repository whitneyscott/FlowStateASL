import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { appendLtiLog, getLastCanvasApiResponse } from '../common/last-error.store';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsEntity } from './entities/course-settings.entity';

const FLASHCARD_SETTINGS_ASSIGNMENT_TITLE = 'Flashcard Settings';
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

/** Extract JSON from Canvas assignment description (may be HTML-wrapped or escaped) */
function parseAssignmentDescription(description: string): SettingsAssignmentDescriptionData | null {
  const trimmed = description?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as SettingsAssignmentDescriptionData;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Canvas may return HTML-wrapped content; try to extract JSON
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

@Injectable()
export class CourseSettingsService {
  constructor(
    @InjectRepository(CourseSettingsEntity)
    private readonly repo: Repository<CourseSettingsEntity>,
    private readonly canvas: CanvasService,
    private readonly config: ConfigService,
  ) {}

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

    return this.canvas.createAssignment(
      courseId,
      FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
      {
        submissionTypes: ['online_text_entry'],
        pointsPossible: 0,
        published: true,
        description: 'Stores flashcard curriculum and unit settings (auto-created by ASL Express)',
        omitFromFinalGrade: true,
        tokenOverride,
      },
      canvasDomain,
    );
  }

  async get(
    courseId: string,
    options?: { isTeacher?: boolean; canvasDomain?: string; canvasBaseUrl?: string; canvasAccessToken?: string },
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
        hasCanvasToken: false, // cache hit; token not rechecked
      };
    }

    // Use teacher's stored token for this course (keyed by courseId). Students never need OAuth.
    const tokenOverride = await this.getStoredCanvasToken(courseId);
    const tokenStatus =
      tokenOverride === null || !tokenOverride
        ? 'null (no stored token for course — teacher must complete OAuth)'
        : `stored by courseId, length=${tokenOverride.length}, masked=${tokenOverride.slice(0, 4)}...${tokenOverride.slice(-4)}`;
    // Canvas base URL and domain from LTI context (extracted from iss) — no env fallback
    const baseUrlOverride = options?.canvasBaseUrl ?? null;
    const domainOverride = options?.canvasDomain ?? null;
    const domain = (domainOverride ?? baseUrlOverride ?? '').trim() || '[LTI-iss-not-set]';
    const canvasOverride = baseUrlOverride ?? (domainOverride ? `https://${domainOverride.replace(/^https?:\/\//, '')}` : null);
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
        canvasOverride ?? domainOverride ?? undefined,
        tokenOverride,
      );
      appendLtiLog('course-settings', 'findAssignmentByTitle result', {
        found: !!settingsAssignmentId,
        assignmentId: settingsAssignmentId ?? 'none',
      });
    } catch (err) {
      appendLtiLog('course-settings', 'findAssignmentByTitle failed', {
        error: err instanceof Error ? err.message : String(err),
        courseIdUsed: courseId,
        canvasDomainUsed: domainOverride ?? '(env)',
      });
      const canvasResp = getLastCanvasApiResponse();
      return {
        ...emptyResult,
        _debug: {
          assignmentTitle: FLASHCARD_SETTINGS_ASSIGNMENT_TITLE,
          courseIdUsed: courseId,
          canvasDomainUsed: baseUrlOverride ?? domainOverride ?? '',
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
          canvasDomainUsed: baseUrlOverride ?? domainOverride ?? '',
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
        (canvasOverride ?? domainOverride) ?? undefined,
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
          canvasDomainUsed: baseUrlOverride ?? domainOverride ?? '',
          flashcardSettingsAssignmentId: settingsAssignmentId,
          findResult: 'found',
          requestFindByTitle,
          requestGetAssignment,
          tokenStatus,
          canvasApiResponse: null,
        },
      };
    } catch (err) {
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
          canvasDomainUsed: baseUrlOverride ?? domainOverride ?? '',
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
  ): Promise<void> {
    // OAuth session token or manual paste; no env fallback
    const effectiveToken = (canvasApiToken?.trim() || null) ?? null;
    if (!effectiveToken) {
      throw new Error(
        'Canvas API token is required to save deck configuration. Complete OAuth (Connect Canvas) or enter your token in Teacher Settings.',
      );
    }
    const canvasOverride = canvasBaseUrl ?? (canvasDomain ? `https://${canvasDomain.replace(/^https?:\/\//, '')}` : null);
    const settingsAssignmentId = await this.ensureFlashcardSettingsAssignment(
      courseId,
      canvasOverride ?? undefined,
      effectiveToken,
    );

    const payload: SettingsAssignmentDescriptionData = {
      v: 1,
      selectedCurriculums: selectedCurriculums ?? [],
      selectedUnits: selectedUnits ?? [],
      updatedAt: new Date().toISOString(),
    };

    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(
      courseId,
      settingsAssignmentId,
      description,
      canvasOverride ?? undefined,
      effectiveToken,
    );

    settingsCache.set(courseId, {
      data: {
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
      },
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    });

    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
        progressAssignmentId: null,
        canvasApiToken: effectiveToken,
      },
      { conflictPaths: ['courseId'] },
    );
  }

  /** Store teacher OAuth token keyed by courseId. Used when teacher completes OAuth and when teacher saves settings. */
  async storeCanvasTokenForCourse(courseId: string, token: string): Promise<void> {
    const t = (token?.trim() || null) ?? null;
    if (!t || !courseId) return;
    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: [],
        selectedUnits: [],
        progressAssignmentId: null,
        canvasApiToken: t,
      },
      { conflictPaths: ['courseId'] },
    );
  }

  /** Get stored Canvas token for a course (teacher's token). Used for both teachers and students. */
  async getStoredCanvasToken(courseId: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { courseId }, select: ['canvasApiToken'] });
    const t = row?.canvasApiToken?.trim() || null;
    return t ?? null;
  }

  /** Returns the Canvas token to use: tokenOverride (session) if provided, else stored token for courseId. */
  async getEffectiveCanvasToken(courseId: string, tokenOverride?: string | null): Promise<string | null> {
    const override = (tokenOverride?.trim() || null) ?? null;
    if (override) return override;
    return this.getStoredCanvasToken(courseId);
  }

  async getProgressAssignmentId(
    courseId: string,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<string> {
    const token = await this.getEffectiveCanvasToken(courseId, canvasAccessToken);
    const override = canvasBaseUrl ?? (canvasDomain ? `https://${canvasDomain.replace(/^https?:\/\//, '')}` : null);
    if (!override || !token) {
      throw new Error('Canvas base URL and access token required (complete OAuth after LTI launch).');
    }
    return this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      override,
      token,
    );
  }
}
