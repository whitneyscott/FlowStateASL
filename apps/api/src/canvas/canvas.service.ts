import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendLtiLog, setLastCanvasApiResponse } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import {
  canvasApiBaseFromLtiContext,
  resolveCanvasApiBaseUrl,
} from '../common/utils/canvas-base-url.util';

export class CanvasUploadChunkError extends Error {
  constructor(
    message: string,
    public readonly lastSuccessfulOffset: number,
  ) {
    super(message);
    this.name = 'CanvasUploadChunkError';
  }
}

/** Thrown when Canvas API returns 401 — token expired or invalid; client should re-trigger OAuth */
export class CanvasTokenExpiredError extends Error {
  constructor(public readonly status = 401) {
    super('Canvas API token expired or invalid — re-trigger OAuth');
    this.name = 'CanvasTokenExpiredError';
  }
}

@Injectable()
export class CanvasService {
  constructor(private readonly config: ConfigService) {}

  private getAuthHeaders(tokenOverride?: string | null): Record<string, string> {
    const token = tokenOverride?.trim() || null;
    if (!token) {
      console.warn('[CanvasService] getAuthHeaders: no token — OAuth access token required (session.canvasAccessToken)');
      throw new Error('Canvas OAuth access token required');
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private getBaseUrl(override?: string): string {
    const resolved = resolveCanvasApiBaseUrl({
      canvasBaseUrl: override,
      envFallback: this.config.get<string>('CANVAS_API_BASE_URL'),
    });
    if (!resolved) {
      throw new Error(
        'Canvas base URL missing from session. Relaunch the tool from Canvas so the host can be captured from return_url or Referer (including canvas.instructure.com for Free-for-Teacher). If Referer is stripped, set Developer Key custom field canvas_api_domain = $Canvas.api.domain. For local tests, set CANVAS_API_BASE_URL.',
      );
    }
    return resolved;
  }

  async submitGrade(
    outcomeUrl: string,
    sourcedid: string,
    score: number,
    scoreTotal: number,
  ): Promise<void> {
    const result = scoreTotal > 0 ? score / scoreTotal : 0;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/lis/oms1p0/pox">
  <imsx_POXHeader>
    <imsx_POXRequestHeaderInfo>
      <imsx_version>V1.0</imsx_version>
      <imsx_messageIdentifier>${Date.now()}</imsx_messageIdentifier>
    </imsx_POXRequestHeaderInfo>
  </imsx_POXHeader>
  <imsx_POXBody>
    <replaceResultRequest>
      <resultRecord>
        <sourcedGUID>
          <sourcedId>${this.escapeXml(sourcedid)}</sourcedId>
        </sourcedGUID>
        <result>
          <resultScore>
            <language>en</language>
            <textString>${result}</textString>
          </resultScore>
        </result>
      </resultRecord>
    </replaceResultRequest>
  </imsx_POXBody>
</imsx_POXEnvelopeRequest>`;
    const res = await fetch(outcomeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LTI Outcomes API failed: ${res.status} ${text}`);
    }
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Initiate file upload to the token owner's personal files (users/self/files).
   * Use for Option 1: student uploads to their files, then we attach via submission[file_ids][].
   */
  async initiateUserFileUpload(
    filename: string,
    size: number,
    contentType: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ uploadUrl: string; uploadParams: Record<string, string> }> {
    appendLtiLog('canvas', 'initiateUserFileUpload', { filename, size, contentType });
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/users/self/files`;
    const form = new FormData();
    form.append('name', filename);
    form.append('size', String(size));
    form.append('content_type', contentType);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.getAuthHeaders(tokenOverride).Authorization },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      appendLtiLog('canvas', 'initiateUserFileUpload FAIL', { status: res.status, text: text.slice(0, 200) });
      throw new Error(`Canvas initiate user file upload failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      upload_url?: string;
      upload_params?: Record<string, string>;
    };
    if (!data.upload_url || !data.upload_params) {
      appendLtiLog('canvas', 'initiateUserFileUpload FAIL: no upload_url/params');
      throw new Error('Canvas did not return upload_url and upload_params');
    }
    appendLtiLog('canvas', 'initiateUserFileUpload OK');
    return {
      uploadUrl: data.upload_url,
      uploadParams: data.upload_params,
    };
  }

  async initiateFileUpload(
    courseId: string,
    assignmentId: string,
    userId: string,
    filename: string,
    size: number,
    contentType: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ uploadUrl: string; uploadParams: Record<string, string> }> {
    const base = this.getBaseUrl(domainOverride);
    // Use "self" so Canvas treats the token owner as the submitter (student token allowed per Canvas file upload docs).
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`;
    const form = new FormData();
    form.append('name', filename);
    form.append('size', String(size));
    form.append('content_type', contentType);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.getAuthHeaders(tokenOverride).Authorization },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas initiate upload failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      upload_url?: string;
      upload_params?: Record<string, string>;
    };
    if (!data.upload_url || !data.upload_params) {
      throw new Error('Canvas did not return upload_url and upload_params');
    }
    return {
      uploadUrl: data.upload_url,
      uploadParams: data.upload_params,
    };
  }

  /**
   * Initiate file upload for a specific user's assignment submission (PHP upload_handler.php path).
   * POST .../courses/:courseId/assignments/:assignmentId/submissions/:userId/files
   * Use with a service token + student Canvas user id; avoids uploading to the token holder's personal files.
   */
  async initiateSubmissionFileUploadForUser(
    courseId: string,
    assignmentId: string,
    userId: string,
    filename: string,
    size: number,
    contentType: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ uploadUrl: string; uploadParams: Record<string, string> }> {
    appendLtiLog('canvas', 'initiateSubmissionFileUploadForUser', {
      assignmentId,
      userId,
      filename,
      size,
      contentType,
    });
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${encodeURIComponent(userId)}/files`;
    const form = new FormData();
    form.append('name', filename);
    form.append('size', String(size));
    form.append('content_type', contentType);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.getAuthHeaders(tokenOverride).Authorization },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      appendLtiLog('canvas', 'initiateSubmissionFileUploadForUser FAIL', { status: res.status, text: text.slice(0, 200) });
      throw new Error(`Canvas initiate submission file upload failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      upload_url?: string;
      upload_params?: Record<string, string>;
    };
    if (!data.upload_url || !data.upload_params) {
      throw new Error('Canvas did not return upload_url and upload_params');
    }
    appendLtiLog('canvas', 'initiateSubmissionFileUploadForUser OK');
    return {
      uploadUrl: data.upload_url,
      uploadParams: data.upload_params,
    };
  }

  async uploadFileToCanvas(
    uploadUrl: string,
    uploadParams: Record<string, string>,
    buffer: Buffer,
    options?: { resumeFromOffset?: number; tokenOverride?: string | null },
  ): Promise<{ fileId: string }> {
    appendLtiLog('canvas', 'uploadFileToCanvas', { bufferSize: buffer.length });
    const start = options?.resumeFromOffset ?? 0;
    const total = buffer.length;
    let lastSuccessOffset = start;

    const form = new FormData();
    for (const [k, v] of Object.entries(uploadParams)) {
      form.append(k, v);
    }
    form.append('file', new Blob([buffer], { type: 'application/octet-stream' }));

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect without Location');
        const authHeaders = this.getAuthHeaders(options?.tokenOverride);
        const confirmRes = await fetch(location, {
          method: 'GET',
          headers: { Authorization: authHeaders.Authorization },
        });
        if (!confirmRes.ok) {
          throw new Error(`Confirm success failed: ${confirmRes.status}`);
        }
        const confirmData = (await confirmRes.json()) as { id?: string };
        const fileId = String(confirmData.id ?? '');
        if (!fileId) throw new Error('No file id in confirm response');
        appendLtiLog('canvas', 'uploadFileToCanvas OK (redirect path)', { fileId });
        return { fileId };
      }

      if (!res.ok) {
        throw new CanvasUploadChunkError(
          `Upload failed: ${res.status}`,
          lastSuccessOffset,
        );
      }

      const data = (await res.json()) as { id?: string };
      const fileId = String(data.id ?? '');
      if (!fileId) throw new Error('No file id in response');
      appendLtiLog('canvas', 'uploadFileToCanvas OK', { fileId });
      return { fileId };
    } catch (e) {
      if (e instanceof CanvasUploadChunkError) throw e;
      throw new CanvasUploadChunkError(
        e instanceof Error ? e.message : 'Upload failed',
        lastSuccessOffset,
      );
    }
  }

  /**
   * Attach an uploaded file to an existing submission (PUT file_ids).
   * Mirrors PHP upload_handler.php: same endpoint and body.
   * Use a token with permission to act on behalf of the user (e.g. CANVAS_API_TOKEN).
   */
  async attachFileToSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    appendLtiLog('canvas', 'attachFileToSubmission', { courseId, assignmentId, userId, fileId });
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body = { submission: { file_ids: [fileId] } };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      appendLtiLog('canvas', 'attachFileToSubmission FAIL', { status: res.status, text: text.slice(0, 200) });
      throw new Error(`Canvas attach file to submission failed: ${res.status} ${text}`);
    }
    appendLtiLog('canvas', 'attachFileToSubmission OK');
  }

  async submitAssignmentWithFile(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    bodyHtml: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const body = {
      submission: {
        submission_type: 'online_upload',
        file_ids: [fileId],
        body: bodyHtml,
      },
    };
    const res = await fetch(url + '?as_user_id=' + encodeURIComponent(userId), {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas submit assignment failed: ${res.status} ${text}`);
    }
  }

  async renameAssignment(
    courseId: string,
    assignmentId: string,
    newName: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ assignment: { name: newName } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas rename failed: ${res.status} ${text}`);
    }
  }

  async findAssignmentByTitle(
    courseId: string,
    assignmentTitle: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string | null> {
    const base = this.getBaseUrl(domainOverride);
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    while (hasMore) {
      const url = `${base}/api/v1/courses/${courseId}/assignments?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
      const rawBody = await res.text();
      if (!res.ok) {
        const info = { status: res.status, statusText: res.statusText, bodyPreview: rawBody.slice(0, 200) };
        setLastCanvasApiResponse(info);
        appendLtiLog('canvas', 'findAssignmentByTitle failed', { ...info, url });
        if (res.status === 401) throw new CanvasTokenExpiredError(401);
        return null;
      }
      const data = (() => {
        try {
          return JSON.parse(rawBody) as Array<{ id: number; name?: string }>;
        } catch {
          return [];
        }
      })();
      const list = data ?? [];
      const found = list.find(
        (a) => String(a.name ?? '').trim() === assignmentTitle.trim(),
      );
      if (found) {
        setLastCanvasApiResponse(null);
        return String(found.id);
      }
      hasMore = list.length === perPage;
      page++;
    }
    setLastCanvasApiResponse(null);
    return null;
  }

  async ensureAssignmentGroup(
    courseId: string,
    groupName: string,
    groupWeight: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<number> {
    const base = this.getBaseUrl(domainOverride);
    const listUrl = `${base}/api/v1/courses/${courseId}/assignment_groups`;
    const listRes = await fetch(listUrl, { headers: this.getAuthHeaders(tokenOverride) });
    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Canvas list assignment groups failed: ${listRes.status} ${text}`);
    }
    const groups = (await listRes.json()) as Array<{ id: number; name?: string }>;
    const existing = (groups ?? []).find(
      (g) => String(g.name ?? '').trim() === groupName.trim(),
    );
    if (existing) return existing.id;

    const createUrl = `${base}/api/v1/courses/${courseId}/assignment_groups`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({
        assignment_group: { name: groupName, group_weight: groupWeight },
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Canvas create assignment group failed: ${createRes.status} ${text}`);
    }
    const created = (await createRes.json()) as { id?: number };
    const id = created.id ?? 0;
    if (!id) throw new Error('Canvas did not return assignment group id');
    return id;
  }

  async createAssignment(
    courseId: string,
    name: string,
    options: {
      submissionTypes?: string[];
      pointsPossible?: number;
      published?: boolean;
      description?: string;
      assignmentGroupId?: number;
      omitFromFinalGrade?: boolean;
      hideInGradebook?: boolean;
      gradingType?: string;
      onlyVisibleToOverrides?: boolean;
      tokenOverride?: string | null;
    } = {},
    domainOverride?: string,
  ): Promise<string> {
    const base = this.getBaseUrl(domainOverride);
    const tokenOverride = options.tokenOverride;
    const url = `${base}/api/v1/courses/${courseId}/assignments`;
    const body: Record<string, unknown> = {
      assignment: {
        name,
        submission_types: options.submissionTypes ?? ['online_text_entry'],
        points_possible: options.pointsPossible ?? 0,
        published: options.published ?? true,
        description: options.description ?? '',
      },
    };
    const assignment = body.assignment as Record<string, unknown>;
    if (typeof options.assignmentGroupId === 'number') {
      assignment.assignment_group_id = options.assignmentGroupId;
    }
    if (options.omitFromFinalGrade === true) {
      assignment.omit_from_final_grade = true;
    }
    if (options.hideInGradebook === true) {
      assignment.hide_in_gradebook = true;
    }
    if (typeof options.gradingType === 'string' && options.gradingType.trim()) {
      assignment.grading_type = options.gradingType.trim();
    }
    if (options.onlyVisibleToOverrides === true) {
      assignment.only_visible_to_overrides = true;
    }
    appendLtiLog('canvas', 'createAssignment: POST to Canvas', {
      courseId,
      name,
      assignment_group_id: assignment.assignment_group_id ?? '(none - Canvas default)',
      url,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      appendLtiLog('canvas', 'createAssignment: Canvas API failed', { status: res.status, text: text.slice(0, 300) });
      throw new Error(`Canvas create assignment failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: number };
    const id = String(data.id ?? '');
    appendLtiLog('canvas', 'createAssignment: Canvas responded', { status: res.status, assignmentId: id });
    return id;
  }

  async getAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ name?: string; description?: string; points_possible?: number; rubric?: Array<unknown> } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      return null;
    }
    const data = (await res.json()) as { name?: string; description?: string; points_possible?: number; rubric?: Array<unknown> };
    return { name: data.name, description: data.description, points_possible: data.points_possible, rubric: data.rubric };
  }

  /** List assignment groups for teacher config. */
  async listAssignmentGroups(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; name: string }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignment_groups?per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas list assignment groups failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Array<{ id: number; name?: string }>;
    return Array.isArray(data) ? data.map((g) => ({ id: g.id, name: g.name ?? '' })) : [];
  }

  /** Create a new assignment group. Returns the created group.
   * Canvas API expects top-level "name" (not nested under assignment_group). */
  async createAssignmentGroup(
    courseId: string,
    name: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number; name: string }> {
    const nameToSend = (name ?? '').trim() || 'New Group';
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignment_groups`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ name: nameToSend }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas create assignment group failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id?: number; name?: string };
    const id = created.id ?? 0;
    if (!id) throw new Error('Canvas did not return assignment group id');
    return { id, name: created.name ?? nameToSend };
  }

  /** Get a single rubric by ID. Returns criteria array in viewer format. */
  async getRubric(
    courseId: string,
    rubricId: string | number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: string; description?: string; points?: number; ratings?: Array<{ id: string; description?: string; points?: number }> }> | null> {
    const base = this.getBaseUrl(domainOverride);
    const rid = typeof rubricId === 'string' ? rubricId : String(rubricId);
    const url = `${base}/api/v1/courses/${courseId}/rubrics/${rid}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      return null;
    }
    const rubric = (await res.json()) as { data?: Array<{ id?: string; description?: string; long_description?: string; points?: number; ratings?: Array<{ id?: string; description?: string; long_description?: string; points?: number }> }> };
    const raw = rubric?.data;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((c) => ({
      id: String(c.id ?? ''),
      description: c.description ?? c.long_description ?? '',
      points: c.points ?? 0,
      ratings: Array.isArray(c.ratings)
        ? c.ratings.map((r) => ({
            id: String(r.id ?? ''),
            description: r.description ?? r.long_description ?? '',
            points: r.points ?? 0,
          }))
        : [],
    }));
  }

  /** List course rubrics for teacher config. */
  async listRubrics(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; title: string; pointsPossible: number }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/rubrics?per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas list rubrics failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Array<{ id: number; title?: string; points_possible?: number }>;
    return Array.isArray(data)
      ? data.map((r) => ({
          id: r.id,
          title: r.title ?? '',
          pointsPossible: r.points_possible ?? 0,
        }))
      : [];
  }

  /** Update assignment (name, description, points, dates, group, etc.).
   * When description is not in updates, the current assignment description is fetched and
   * included in the PUT so Canvas does not wipe it (e.g. Prompt Manager config blob).
   */
  async updateAssignment(
    courseId: string,
    assignmentId: string,
    updates: {
      assignmentGroupId?: number | string;
      name?: string;
      description?: string;
      pointsPossible?: number;
      dueAt?: string;
      unlockAt?: string;
      lockAt?: string;
      allowedAttempts?: number;
    },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const body: Record<string, unknown> = {};
    if (updates.assignmentGroupId != null) {
      body.assignment_group_id = typeof updates.assignmentGroupId === 'string'
        ? parseInt(updates.assignmentGroupId, 10)
        : updates.assignmentGroupId;
    }
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.description !== undefined) {
      body.description = updates.description;
    } else {
      // Preserve existing description so PUT does not wipe it (e.g. config JSON blob)
      const current = await this.getAssignment(courseId, assignmentId, domainOverride, tokenOverride);
      if (current?.description !== undefined) body.description = current.description;
    }
    if (updates.pointsPossible !== undefined) body.points_possible = updates.pointsPossible;
    if (updates.dueAt !== undefined) body.due_at = updates.dueAt || null;
    if (updates.unlockAt !== undefined) body.unlock_at = updates.unlockAt || null;
    if (updates.lockAt !== undefined) body.lock_at = updates.lockAt || null;
    if (updates.allowedAttempts !== undefined) body.allowed_attempts = updates.allowedAttempts;
    if (Object.keys(body).length === 0) return;
    appendLtiLog('canvas', 'updateAssignment: PUT to Canvas', {
      courseId,
      assignmentId,
      assignment_group_id: body.assignment_group_id,
      preservingDescription: updates.description === undefined && body.description !== undefined,
    });
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ assignment: body }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas update assignment failed: ${res.status} ${text}`);
    }
  }

  /** Associate a rubric with an assignment for grading. */
  async associateRubricWithAssignment(
    courseId: string,
    assignmentId: string,
    rubricId: string | number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/rubric_associations`;
    const rid = typeof rubricId === 'string' ? parseInt(rubricId, 10) : rubricId;
    const aid = typeof assignmentId === 'string' ? parseInt(assignmentId, 10) : assignmentId;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({
        rubric_association: {
          rubric_id: rid,
          association_id: aid,
          association_type: 'Assignment',
          use_for_grading: true,
          purpose: 'grading',
        },
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas associate rubric failed: ${res.status} ${text}`);
    }
  }

  /** List course modules for module selector. */
  async listModules(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; name: string; position: number }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/modules?per_page=50`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas list modules failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Array<{ id: number; name: string; position: number }>;
    return Array.isArray(data) ? data : [];
  }

  /** Add an assignment to a module. Idempotent: no-op if assignment already in module. */
  async addAssignmentToModule(
    courseId: string,
    moduleId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ created: boolean; itemId?: number }> {
    const base = this.getBaseUrl(domainOverride);
    const listUrl = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items?per_page=50`;
    const listRes = await fetch(listUrl, { headers: this.getAuthHeaders(tokenOverride) });
    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Canvas list module items failed: ${listRes.status} ${text}`);
    }
    const items = (await listRes.json()) as Array<{ content_id?: number; id?: number }>;
    const aid = parseInt(assignmentId, 10);
    const existing = Array.isArray(items) && items.some((i) => i.content_id === aid);
    if (existing) {
      return { created: false };
    }
    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items`;
    const body = { module_item: { type: 'Assignment', content_id: aid } };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas add assignment to module failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id?: number };
    return { created: true, itemId: created?.id };
  }

  /** List module items (positions, types) for LTI + assignment sync. */
  async listModuleItems(
    courseId: string,
    moduleId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<
    Array<{
      id: number;
      position: number;
      type: string;
      title?: string;
      content_id?: number;
      external_url?: string;
    }>
  > {
    const base = this.getBaseUrl(domainOverride);
    const listUrl = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items?per_page=100`;
    const listRes = await fetch(listUrl, { headers: this.getAuthHeaders(tokenOverride) });
    if (!listRes.ok) {
      const text = await listRes.text();
      throw new Error(`Canvas list module items failed: ${listRes.status} ${text}`);
    }
    const raw = (await listRes.json()) as Array<{
      id?: number;
      position?: number;
      type?: string;
      title?: string;
      content_id?: number;
      external_url?: string;
    }>;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((i) => i.id != null && i.position != null && i.type)
      .map((i) => ({
        id: i.id!,
        position: i.position!,
        type: String(i.type),
        title: i.title,
        content_id: i.content_id,
        external_url: i.external_url,
      }));
  }

  /**
   * Course Context External Tool id for the Prompter LTI app (module item content_id).
   * Prefer env CANVAS_PROMPTER_EXTERNAL_TOOL_ID / LTI_PROMPTER_EXTERNAL_TOOL_ID when set;
   * else match GET .../external_tools by client_id === LTI_PROMPTER_CLIENT_ID.
   */
  async resolvePrompterContextExternalToolId(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string | null> {
    const base = this.getBaseUrl(domainOverride);
    appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: start', { courseId });
    const envId =
      (this.config.get<string>('CANVAS_PROMPTER_EXTERNAL_TOOL_ID') ??
        this.config.get<string>('LTI_PROMPTER_EXTERNAL_TOOL_ID') ??
        '')
        .trim() || null;
    if (envId && /^\d+$/.test(envId)) {
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: using env external tool id', { id: envId });
      return envId;
    }

    const prompterClientId = (
      this.config.get<string>('LTI_PROMPTER_CLIENT_ID') ??
      process.env.LTI_PROMPTER_CLIENT_ID ??
      ''
    )
      .trim();
    const defaultClientId = (
      this.config.get<string>('LTI_CLIENT_ID') ??
      process.env.LTI_CLIENT_ID ??
      ''
    )
      .trim();
    const clientCandidates = [prompterClientId, defaultClientId].filter(Boolean);

    const listUrl = `${base}/api/v1/courses/${courseId}/external_tools?per_page=100&include_parents=true`;
    const listRes = await fetch(listUrl, { headers: this.getAuthHeaders(tokenOverride) });
    if (!listRes.ok) {
      const text = await listRes.text();
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: list external_tools failed', {
        status: listRes.status,
        text: text.slice(0, 200),
      });
      return null;
    }
    const tools = (await listRes.json()) as Array<{
      id?: number;
      client_id?: string | number;
      name?: string;
      text?: string;
      tool_id?: string;
      domain?: string;
      url?: string;
      target_link_uri?: string;
      homework_submission?: unknown;
      link_selection?: unknown;
      course_navigation?: unknown;
    }>;
    if (!Array.isArray(tools)) return null;
    appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: fetched tools', {
      toolCount: tools.length,
      sample: tools.slice(0, 3).map((t) => ({
        id: t.id,
        client_id: t.client_id,
        name: t.name ?? t.text ?? null,
        tool_id: t.tool_id ?? null,
      })),
    });
    const configuredName = (this.config.get<string>('CANVAS_PROMPTER_TOOL_NAME') ?? 'Prompt Manager').trim().toLowerCase();
    const expectedLaunchPath = '/api/lti/launch';
    const expectedHost = (() => {
      try {
        const v = (this.config.get<string>('LTI_REDIRECT_URI') ?? '').trim();
        if (!v) return '';
        return new URL(v).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();

    type RankedTool = {
      id: number;
      score: number;
      reason: string[];
      name: string;
      clientId: string;
      toolId: string;
      launchUrl: string;
      domain: string;
    };

    const ranked: RankedTool[] = [];
    for (const t of tools) {
      if (t.id == null) continue;
      const id = Number(t.id);
      const name = `${t.name ?? t.text ?? ''}`.trim();
      const toolId = `${t.tool_id ?? ''}`.trim();
      const clientId = `${t.client_id ?? ''}`.trim();
      const launchUrl = `${t.target_link_uri ?? t.url ?? ''}`.trim();
      const domain = `${t.domain ?? ''}`.trim();
      const blob = `${name} ${toolId}`.toLowerCase();
      const hasRelevantPlacement = !!(t.homework_submission || t.link_selection || t.course_navigation);

      let score = 0;
      const reason: string[] = [];

      if (hasRelevantPlacement) {
        score += 10;
        reason.push('relevantPlacement');
      }
      if (blob.includes('prompter') || blob.includes(configuredName)) {
        score += 25;
        reason.push('namePrompterLike');
      }
      if (toolId.toLowerCase().includes('prompter')) {
        score += 20;
        reason.push('toolIdPrompterLike');
      }
      if (launchUrl && launchUrl.includes(expectedLaunchPath)) {
        score += 35;
        reason.push('launchPathMatch');
      }
      if (expectedHost) {
        try {
          const u = launchUrl ? new URL(launchUrl) : null;
          const launchHost = u?.hostname?.toLowerCase() ?? '';
          if (launchHost && launchHost === expectedHost) {
            score += 20;
            reason.push('launchHostMatch');
          }
        } catch {
          // ignore invalid launch URL
        }
        if (domain && domain.toLowerCase() === expectedHost) {
          score += 12;
          reason.push('domainMatch');
        }
      }
      if (clientCandidates.length > 0 && clientCandidates.includes(clientId)) {
        score += clientId === prompterClientId ? 90 : 60;
        reason.push(clientId === prompterClientId ? 'prompterClientIdMatch' : 'defaultClientIdMatch');
      }

      ranked.push({
        id,
        score,
        reason,
        name: name || '(unnamed)',
        clientId,
        toolId,
        launchUrl,
        domain,
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: ranked candidates', {
      top: ranked.slice(0, 5).map((r) => ({
        id: r.id,
        score: r.score,
        reason: r.reason,
        name: r.name,
        clientId: r.clientId || null,
        toolId: r.toolId || null,
      })),
      clientCandidates: clientCandidates.map((id) => `${id.slice(0, 6)}…`),
      expectedHost: expectedHost || null,
    });

    const winner = ranked[0];
    if (winner && winner.score >= 35) {
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: selected tool', {
        id: winner.id,
        score: winner.score,
        reason: winner.reason,
        name: winner.name,
      });
      return String(winner.id);
    }
    appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: no confident match', {
      topScore: winner?.score ?? null,
      toolCount: tools.length,
      hint: 'Set CANVAS_PROMPTER_EXTERNAL_TOOL_ID as override, or ensure course has Prompter tool with expected launch URL/placements.',
    });
    return null;
  }

  /**
   * Ensure a module contains an ExternalTool row for the Prompter, linked to this assignment (assignment_id in launch URL).
   * Inserts immediately before the assignment row when possible so students see Prompter then submission assignment.
   */
  async syncPrompterLtiModuleItem(
    courseId: string,
    moduleId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
    options?: { linkTitle?: string },
  ): Promise<{ created: boolean; skippedReason?: string; itemId?: number }> {
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem: start', { courseId, moduleId, assignmentId });
    const toolIdStr = await this.resolvePrompterContextExternalToolId(courseId, domainOverride, tokenOverride);
    if (!toolIdStr) {
      return {
        created: false,
        skippedReason:
          'Prompter external tool not found: install ASL Express – Prompt Manager in the course and/or set CANVAS_PROMPTER_EXTERNAL_TOOL_ID or LTI_PROMPTER_CLIENT_ID',
      };
    }
    const toolIdNum = parseInt(toolIdStr, 10);
    if (Number.isNaN(toolIdNum)) {
      return { created: false, skippedReason: 'Invalid external tool id' };
    }

    const items = await this.listModuleItems(courseId, moduleId, domainOverride, tokenOverride);
    const aid = parseInt(assignmentId, 10);
    const assignmentItem = items.find((i) => i.type === 'Assignment' && i.content_id === aid);

    const base = this.getBaseUrl(domainOverride);
    const externalUrl = `${base}/courses/${courseId}/external_tools/${toolIdStr}?assignment_id=${encodeURIComponent(assignmentId)}`;

    const urlMatchesAssignment = (url: string | undefined): boolean => {
      if (!url) return false;
      try {
        const u = new URL(url, base);
        const q = u.searchParams.get('assignment_id');
        return q === assignmentId;
      } catch {
        return url.includes(`assignment_id=${assignmentId}`) || url.includes(`assignment_id=${encodeURIComponent(assignmentId)}`);
      }
    };

    const existing = items.find(
      (i) => i.type === 'ExternalTool' && i.content_id === toolIdNum && urlMatchesAssignment(i.external_url),
    );
    if (existing) {
      appendLtiLog('canvas', 'syncPrompterLtiModuleItem: already present', {
        externalToolId: toolIdNum,
        moduleItemId: existing.id,
        assignmentId,
      });
      return { created: false, skippedReason: 'already_linked', itemId: existing.id };
    }

    const position = assignmentItem?.position ?? (items.length ? Math.max(...items.map((i) => i.position)) + 1 : 1);
    const title =
      (options?.linkTitle ?? '').trim() ||
      'ASL Express – Open Prompter (record here)';

    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items`;
    const body = {
      module_item: {
        type: 'ExternalTool',
        content_id: toolIdNum,
        external_url: externalUrl,
        position,
        title,
        new_tab: true,
      },
    };
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem: POST ExternalTool module item', {
      position,
      assignmentId,
      externalToolId: toolIdStr,
      assignmentModuleItemId: assignmentItem?.id ?? null,
      externalUrl,
      title,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      appendLtiLog('canvas', 'syncPrompterLtiModuleItem FAIL', { status: res.status, text: text.slice(0, 400) });
      throw new Error(`Canvas add ExternalTool module item failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id?: number };
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem OK', {
      externalToolId: toolIdStr,
      moduleItemId: created?.id,
      assignmentModuleItemId: assignmentItem?.id ?? null,
      assignmentId,
    });
    return { created: true, itemId: created?.id };
  }

  /** Create a course module. Position is 1-based; pass 1 for first, or modules.length+1 for end. */
  async createModule(
    courseId: string,
    name: string,
    options: { position?: number } | undefined,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number; name: string; position: number }> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/modules`;
    const body = {
      module: {
        name: name.trim() || 'New Module',
        ...(options?.position != null && { position: options.position }),
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create module failed: ${res.status} ${text}`);
    }
    return res.json() as Promise<{ id: number; name: string; position: number }>;
  }

  async updateAssignmentDescription(
    courseId: string,
    assignmentId: string,
    description: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ assignment: { description } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas update assignment description failed: ${res.status} ${text}`);
    }
  }

  /**
   * Find or create an assignment for a course. Shared by Flashcards, Prompter, etc.
   * Token is the Canvas OAuth token (callers pass from session / CourseSettingsService.getEffectiveCanvasToken).
   */
  async ensureAssignmentForCourse(
    ctx: LtiContext,
    config: {
      title: string;
      description?: string;
      submissionTypes?: string[];
      pointsPossible?: number;
      published?: boolean;
      omitFromFinalGrade?: boolean;
    },
    tokenOverride?: string | null,
  ): Promise<string> {
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));

    const existing = await this.findAssignmentByTitle(ctx.courseId, config.title, domainOverride, tokenOverride);
    if (existing) {
      appendLtiLog('canvas', 'ensureAssignmentForCourse (Step 7)', { title: config.title, result: 'found', assignmentId: existing });
      return existing;
    }

    const assignmentGroupId = await this.ensureAssignmentGroup(
      ctx.courseId,
      config.title,
      0,
      domainOverride,
      tokenOverride,
    );

    const created = await this.createAssignment(
      ctx.courseId,
      config.title,
      {
        submissionTypes: config.submissionTypes ?? ['online_text_entry'],
        pointsPossible: config.pointsPossible ?? 0,
        published: config.published ?? true,
        description: config.description ?? '',
        assignmentGroupId,
        omitFromFinalGrade: config.omitFromFinalGrade ?? false,
        tokenOverride,
      },
      domainOverride,
    );
    appendLtiLog('canvas', 'ensureAssignmentForCourse (Step 7)', { title: config.title, result: 'created', assignmentId: created });
    return created;
  }

  /** Find or create the "Prompt Manager – Grades" shadow assignment for gradebook column (grades only; video stays on visible assignment). */
  async ensureShadowAssignment(
    ctx: LtiContext,
    config: { pointsPossible?: number },
    tokenOverride?: string | null,
  ): Promise<string> {
    const title = 'Prompt Manager – Grades';
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const existing = await this.findAssignmentByTitle(ctx.courseId, title, domainOverride, tokenOverride);
    if (existing) return existing;
    const assignmentGroupId = await this.ensureAssignmentGroup(
      ctx.courseId,
      title,
      config.pointsPossible ?? 100,
      domainOverride,
      tokenOverride,
    );
    return this.createAssignment(
      ctx.courseId,
      title,
      {
        submissionTypes: ['on_paper'],
        pointsPossible: config.pointsPossible ?? 100,
        published: true,
        description: 'ASL Express Prompt Manager – grades only (video submitted on the main assignment).',
        assignmentGroupId,
        omitFromFinalGrade: false,
        tokenOverride,
      },
      domainOverride,
    );
  }

  async ensureFlashcardProgressAssignment(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string> {
    const existing = await this.findAssignmentByTitle(
      courseId,
      'Flashcard Progress',
      domainOverride,
      tokenOverride,
    );
    if (existing) return existing;

    const assignmentGroupId = await this.ensureAssignmentGroup(
      courseId,
      'Flashcard Progress',
      0,
      domainOverride,
      tokenOverride,
    );

    return this.createAssignment(
      courseId,
      'Flashcard Progress',
      {
        submissionTypes: ['online_text_entry'],
        pointsPossible: 0,
        published: true,
        description: 'Stores flashcard study progress and deck configuration (auto-created by ASL Express)',
        assignmentGroupId,
        omitFromFinalGrade: true,
        tokenOverride,
      },
      domainOverride,
    );
  }

  /**
   * Resolve the numeric Canvas user ID for the current user (token holder).
   * Use when LTI ctx.canvasUserId is unavailable (e.g. $Canvas.user.id not substituted).
   */
  async getCurrentCanvasUserId(
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/users/self`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    const id = data?.id;
    return id != null ? String(id) : null;
  }

  async getSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ body?: string } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { body?: string; submission?: { body?: string } };
    const body = data.body ?? data.submission?.body ?? undefined;
    appendLtiLog('canvas', 'getSubmission response', {
      responseKeys: Object.keys(data),
      hasBody: !!body,
      bodyLength: body?.length ?? 0,
    });
    return { body };
  }

  /**
   * Get the current user's submission (token holder). Use when canvasUserId is unavailable
   * and the single-user GET fails (e.g. LTI sub is opaque, not Canvas numeric ID).
   */
  async getSubmissionForCurrentUser(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ body?: string } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ body?: string }> | { body?: string };
    const list = Array.isArray(data) ? data : [data];
    const submission = list[0];
    const body = submission?.body ?? undefined;
    appendLtiLog('canvas', 'getSubmissionForCurrentUser response', {
      listLength: list.length,
      hasBody: !!body,
      bodyLength: body?.length ?? 0,
    });
    return body != null ? { body } : null;
  }

  /**
   * Create or update a submission body for an assignment.
   * When the token belongs to the submitting user (student self-submit), do not use as_user_id:
   * Canvas requires grading permission for as_user_id and returns 401 Invalid as_user_id for students.
   * The submission is created for the authenticated user (token holder) when as_user_id is omitted.
   */
  async createSubmissionWithBody(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
    /** Omit as_user_id when token belongs to the submitting user (student self-submit). Default false = self-submit. */
    actAsUser?: boolean,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const baseUrl = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const url = actAsUser ? `${baseUrl}?as_user_id=${encodeURIComponent(userId)}` : baseUrl;
    const urlContainsAsUserId = actAsUser === true;
    const tokenPreview = tokenOverride ? `${String(tokenOverride).slice(0, 4)}...${String(tokenOverride).slice(-4)} (len=${String(tokenOverride).length})` : 'MISSING';
    appendLtiLog('canvas', 'createSubmissionWithBody HTTP request', {
      userId,
      actAsUser: !!actAsUser,
      as_user_idInRequest: urlContainsAsUserId,
      requestUrl: urlContainsAsUserId ? `${baseUrl}?as_user_id=<userId>` : baseUrl,
      tokenPreview,
    });
    const params = new URLSearchParams();
    params.append('submission[submission_type]', 'online_text_entry');
    params.append('submission[body]', bodyText);
    appendLtiLog('canvas', 'createSubmissionWithBody POST body', {
      contentType: 'application/x-www-form-urlencoded',
      bodyLength: bodyText?.length ?? 0,
      paramKeys: ['submission[submission_type]', 'submission[body]'],
    });
    const authHeaders = this.getAuthHeaders(tokenOverride);
    const headers = {
      ...authHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    const responseText = await res.text();
    if (!res.ok) {
      throw new Error(`Canvas create submission with body failed: ${res.status} ${responseText}`);
    }
    try {
      const created = JSON.parse(responseText) as { body?: string; submission_type?: string };
      appendLtiLog('canvas', 'createSubmissionWithBody POST response', {
        status: res.status,
        responseHasBody: !!created?.body,
        responseBodyLength: created?.body?.length ?? 0,
        submission_type: created?.submission_type,
      });
    } catch {
      appendLtiLog('canvas', 'createSubmissionWithBody POST response', { status: res.status, parseError: true });
    }
  }

  /**
   * Write submission body for an assignment. Uses tokenOverride (OAuth or service token).
   * When the token holder is not the submitting student, uses as_user_id (service account / PHP parity).
   * Callers pass token from session or CourseSettingsService.getCanvasTokenForLtiBackedOps.
   * Tools that need to merge with existing must call getSubmission first, then writeSubmissionBody with the final body.
   */
  async writeSubmissionBody(
    ctx: LtiContext,
    assignmentId: string,
    bodyContent: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const token = tokenOverride?.trim() || null;
    if (!token) {
      throw new Error(
        'Canvas access token required for writeSubmissionBody (OAuth session or CANVAS_API_TOKEN / CANVAS_ACCESS_TOKEN)',
      );
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const studentCanvasId = ((ctx.canvasUserId ?? '').trim() || ctx.userId).trim();
    const tokenUserId = await this.getCurrentCanvasUserId(domainOverride, token);
    const preferActAs = tokenUserId ? String(tokenUserId) !== String(studentCanvasId) : true;
    appendLtiLog('canvas', 'writeSubmissionBody (Step 10)', {
      assignmentId,
      bodyLength: bodyContent?.length ?? 0,
      studentCanvasId,
      tokenUserId: tokenUserId ?? '(unknown)',
      preferActAs,
      tokenPreview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : 'MISSING',
    });
    const postBody = (actAsUser: boolean) =>
      this.createSubmissionWithBody(
        ctx.courseId,
        assignmentId,
        studentCanvasId,
        bodyContent,
        domainOverride,
        token,
        actAsUser,
      );
    try {
      await postBody(preferActAs);
    } catch (firstErr) {
      const msg = String(firstErr);
      const authLike = /401|403|invalid as_user_id/i.test(msg);
      if (!authLike) throw firstErr;
      appendLtiLog('canvas', 'writeSubmissionBody: retry with flipped actAsUser', {
        preferActAs,
        error: msg.slice(0, 120),
      });
      await postBody(!preferActAs);
    }
  }

  async putSubmissionBody(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body = { submission: { body: bodyText } };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas put submission body failed: ${res.status} ${text}`);
    }
  }

  /** Get a single user's submission with full details (for viewer - teacher or student). */
  async getSubmissionFull(
    courseId: string,
    assignmentId: string,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{
    body?: string;
    score?: number;
    grade?: string;
    attempt?: number;
    submitted_at?: string;
    submission_comments?: Array<{ id: number; comment: string }>;
    attachment?: { url?: string };
    attachments?: Array<{ url?: string; download_url?: string }>;
    versioned_attachments?: Array<Array<{ url?: string }>>;
    rubric_assessment?: Record<string, unknown>;
  } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_history&include[]=submission_comments&include[]=rubric_assessment`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    return (await res.json()) as {
      body?: string;
      score?: number;
      grade?: string;
      attempt?: number;
      submitted_at?: string;
      submission_comments?: Array<{ id: number; comment: string }>;
      attachment?: { url?: string };
      attachments?: Array<{ url?: string; download_url?: string }>;
      versioned_attachments?: Array<Array<{ url?: string }>>;
      rubric_assessment?: Record<string, unknown>;
    };
  }

  /** List submissions for an assignment (teacher). Include submission_comments for grading UI. */
  async listSubmissions(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<
    Array<{
      user_id: number;
      user?: { id: number; name?: string };
      body?: string;
      score?: number;
      grade?: string;
      workflow_state?: string;
      submission_type?: string;
      submission_comments?: Array<{ id: number; comment: string; author?: { display_name?: string } }>;
      attachment?: { url?: string; download_url?: string };
      attachments?: Array<{ url?: string; download_url?: string; id?: number }>;
      versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
      submission_history?: Array<{
        attachment?: { url?: string; download_url?: string };
        attachments?: Array<{ url?: string; download_url?: string }>;
        versioned_attachments?: Array<Array<{ url?: string; download_url?: string }>>;
        submission_type?: string;
      }>;
    }>
  > {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions?include[]=user&include[]=submission_comments&include[]=submission_history&per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas list submissions failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as unknown;
    const arr = Array.isArray(data) ? data : [];
    appendLtiLog('canvas', 'listSubmissions', { courseId, assignmentId, count: arr.length });
    return arr;
  }

  /** Add a comment to a submission. Teacher grading flow. */
  async addSubmissionComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    textComment: string,
    options?: { attempt?: number },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ commentId?: number }> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_comments`;
    const body: { comment: { text_comment: string; attempt?: number } } = {
      comment: { text_comment: textComment },
    };
    if (options?.attempt != null) body.comment.attempt = options.attempt;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ comment: body.comment }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas add comment failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { submission_comments?: Array<{ id?: number; comment?: string }> };
    const comments = data.submission_comments ?? [];
    const match = comments.find((c) => c.comment?.includes(textComment.slice(0, 50)));
    return { commentId: match?.id ?? comments[comments.length - 1]?.id };
  }

  /** Edit a submission comment. */
  async editSubmissionComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    commentId: string,
    textComment: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}/comments/${commentId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ comment: textComment }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas edit comment failed: ${res.status} ${text}`);
    }
  }

  /** Delete a submission comment. */
  async deleteSubmissionComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    commentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}/comments/${commentId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getAuthHeaders(tokenOverride),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas delete comment failed: ${res.status} ${text}`);
    }
  }

  /** Put grade and/or rubric on a submission (teacher). Uses Canvas REST; for AGS use LtiAgsService.submitGradeViaAgs. */
  async putSubmissionGrade(
    courseId: string,
    assignmentId: string,
    userId: string,
    options: { postedGrade?: string | null; rubricAssessment?: Record<string, unknown> },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ score?: number }> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body: { submission?: { posted_grade?: string | null }; rubric_assessment?: Record<string, unknown> } = {};
    if (options.postedGrade !== undefined) body.submission = { posted_grade: options.postedGrade };
    if (options.rubricAssessment) body.rubric_assessment = options.rubricAssessment;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas put grade failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { score?: number };
    return { score: data.score };
  }

  // --- Announcement API (Settings storage: Flashcard + Prompt Manager) ---

  private static readonly FLASHCARD_SETTINGS_ANNOUNCEMENT_TITLE = 'ASL Express Flashcard Settings';
  private static readonly FLASHCARD_SETTINGS_ANNOUNCEMENT_TITLE_FULL =
    '⚠️ DO NOT DELETE — ASL Express Flashcard Settings';

  /** Generic: find announcement by title substring. Used by Flashcard and Prompt Manager settings. */
  async findSettingsAnnouncementByTitle(
    courseId: string,
    titleSubstring: string,
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<{ id: number; title: string; message: string } | null> {
    const base = this.getBaseUrl(domainOverride);
    let page = 1;
    const perPage = 50;
    while (true) {
      const url = `${base}/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
      const rawBody = await res.text();
      if (!res.ok) {
        if (res.status === 401) throw new CanvasTokenExpiredError(401);
        const info = { status: res.status, bodyPreview: rawBody.slice(0, 200) };
        setLastCanvasApiResponse({ status: res.status, statusText: res.statusText, bodyPreview: rawBody.slice(0, 200) });
        appendLtiLog('canvas', 'findSettingsAnnouncementByTitle failed', info);
        return null;
      }
      const data = (() => {
        try {
          return JSON.parse(rawBody) as Array<{ id: number; title?: string; message?: string }>;
        } catch {
          return [];
        }
      })();
      const list = data ?? [];
      const found = list.find((t) => String(t.title ?? '').includes(titleSubstring));
      if (found) {
        setLastCanvasApiResponse(null);
        return { id: found.id, title: found.title ?? '', message: found.message ?? '' };
      }
      if (list.length < perPage) break;
      page++;
    }
    setLastCanvasApiResponse(null);
    return null;
  }

  /** Generic: create announcement. Used by Flashcard and Prompt Manager settings. */
  async createSettingsAnnouncement(
    courseId: string,
    title: string,
    messageBody: string,
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<number> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/discussion_topics`;
    const body = {
      title,
      message: messageBody,
      is_announcement: true,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create announcement failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: number };
    const id = data.id ?? 0;
    if (!id) throw new Error('Canvas did not return announcement id');
    return id;
  }

  /** Generic: update announcement message. Used by Flashcard and Prompt Manager settings. */
  async updateSettingsAnnouncement(
    courseId: string,
    topicId: number,
    messageBody: string,
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/discussion_topics/${topicId}`;
    const body = { message: messageBody };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas update announcement failed: ${res.status} ${text}`);
    }
  }

  async findFlashcardSettingsAnnouncement(
    courseId: string,
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<{ id: number; title: string; message: string } | null> {
    return this.findSettingsAnnouncementByTitle(
      courseId,
      CanvasService.FLASHCARD_SETTINGS_ANNOUNCEMENT_TITLE,
      tokenOverride,
      domainOverride,
    );
  }

  async createFlashcardSettingsAnnouncement(
    courseId: string,
    settings: { selectedCurriculums: string[]; selectedUnits: string[] },
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<number> {
    return this.createSettingsAnnouncement(
      courseId,
      CanvasService.FLASHCARD_SETTINGS_ANNOUNCEMENT_TITLE_FULL,
      JSON.stringify(settings),
      tokenOverride,
      domainOverride,
    );
  }

  async updateFlashcardSettingsAnnouncement(
    courseId: string,
    topicId: number,
    settings: { selectedCurriculums: string[]; selectedUnits: string[] },
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<void> {
    return this.updateSettingsAnnouncement(
      courseId,
      topicId,
      JSON.stringify(settings),
      tokenOverride,
      domainOverride,
    );
  }

  // ---- Classic Quizzes (prompt storage) ----

  static readonly PROMPT_STORAGE_QUIZ_TITLE = 'ASL Express Prompt Storage';

  /** List quizzes in a course. */
  async listQuizzes(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; title?: string }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes?per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas list quizzes failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Array<{ id: number; title?: string }>;
    return Array.isArray(data) ? data : [];
  }

  /** Find a quiz by exact title. */
  async findQuizByTitle(
    courseId: string,
    title: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number; title: string } | null> {
    const list = await this.listQuizzes(courseId, domainOverride, tokenOverride);
    const found = list.find((q) => (q.title ?? '').trim() === title.trim());
    return found ? { id: found.id, title: found.title ?? title } : null;
  }

  /** Create a Classic Quiz. */
  async createQuiz(
    courseId: string,
    options: {
      title: string;
      description?: string;
      quizType?: 'practice_quiz' | 'assignment' | 'graded_survey' | 'survey';
      published?: boolean;
    },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number; title: string }> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes`;
    const quizBody: Record<string, unknown> = {
      title: options.title,
      quiz_type: options.quizType ?? 'assignment',
      published: options.published ?? false,
    };
    if (options.description != null) quizBody.description = options.description;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ quiz: quizBody }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas create quiz failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: number; title?: string };
    const id = data.id ?? 0;
    if (!id) throw new Error('Canvas did not return quiz id');
    return { id, title: (data.title as string) ?? options.title };
  }

  /** List questions in a quiz. */
  async listQuizQuestions(
    courseId: string,
    quizId: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; question_name?: string; question_text?: string }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes/${quizId}/questions?per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas list quiz questions failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Array<{ id?: number; question_name?: string; question_text?: string }>;
    return (Array.isArray(data) ? data : [])
      .filter((q): q is { id: number; question_name?: string; question_text?: string } => typeof q?.id === 'number')
      .map((q) => ({ id: q.id, question_name: q.question_name, question_text: q.question_text }));
  }

  /** Create a quiz question. */
  async createQuizQuestion(
    courseId: string,
    quizId: number,
    options: {
      questionText: string;
      questionName?: string;
      questionType?: string;
      pointsPossible?: number;
    },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number }> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes/${quizId}/questions`;
    const body = {
      question: {
        question_text: options.questionText,
        question_name: options.questionName ?? options.questionText.slice(0, 80),
        question_type: options.questionType ?? 'essay_question',
        points_possible: options.pointsPossible ?? 0,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas create quiz question failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: number };
    const id = data.id ?? 0;
    if (!id) throw new Error('Canvas did not return question id');
    return { id };
  }

  /** Create a quiz submission (start quiz - do not complete). */
  async createQuizSubmission(
    courseId: string,
    quizId: number,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
    actAsUser?: boolean,
  ): Promise<{ id: number; validation_token?: string; attempt?: number }> {
    const base = this.getBaseUrl(domainOverride);
    const baseUrl = `${base}/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`;
    const url = actAsUser ? `${baseUrl}?as_user_id=${encodeURIComponent(userId)}` : baseUrl;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      if (res.status === 409) {
        const data = (await res.json()) as { quiz_submissions?: Array<{ id?: number; validation_token?: string; attempt?: number }> };
        const sub = data.quiz_submissions?.[0];
        if (sub?.id) return { id: sub.id, validation_token: sub.validation_token, attempt: sub.attempt ?? 1 };
      }
      const text = await res.text();
      throw new Error(`Canvas create quiz submission failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { quiz_submissions?: Array<{ id?: number; validation_token?: string; attempt?: number }> };
    const sub = data.quiz_submissions?.[0];
    const id = sub?.id ?? 0;
    if (!id) throw new Error('Canvas did not return quiz submission id');
    return { id, validation_token: sub?.validation_token, attempt: sub?.attempt ?? 1 };
  }

  /** Answer quiz questions (provide answers for one or more questions). */
  async answerQuizQuestions(
    quizSubmissionId: number,
    options: { attempt: number; validationToken: string; quizQuestions: Array<{ id: string; answer: unknown }> },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/quiz_submissions/${quizSubmissionId}/questions`;
    const body = {
      attempt: options.attempt,
      validation_token: options.validationToken,
      quiz_questions: options.quizQuestions.map((q) => ({ id: String(q.id), answer: q.answer })),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas answer quiz questions failed: ${res.status} ${text}`);
    }
  }

  /** List quiz submissions (teacher view). */
  async listQuizSubmissions(
    courseId: string,
    quizId: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; user_id: number; attempt?: number; workflow_state?: string }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes/${quizId}/submissions?include[]=user&per_page=100`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas list quiz submissions failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { quiz_submissions?: Array<{ id?: number; user_id?: number; attempt?: number; workflow_state?: string }> };
    const raw = data.quiz_submissions ?? [];
    return raw
      .filter((s): s is { id: number; user_id: number; attempt?: number; workflow_state?: string } => typeof s?.id === 'number' && typeof s?.user_id === 'number')
      .map((s) => ({ id: s.id, user_id: s.user_id, attempt: s.attempt, workflow_state: s.workflow_state }));
  }

  /** Get a single quiz submission by ID (for validation_token). */
  async getQuizSubmission(
    courseId: string,
    quizId: number,
    submissionId: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ id: number; validation_token?: string; attempt?: number } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { quiz_submissions?: Array<{ id?: number; validation_token?: string; attempt?: number }> };
    const sub = data.quiz_submissions?.[0];
    if (!sub?.id) return null;
    return { id: sub.id, validation_token: sub.validation_token, attempt: sub.attempt ?? 1 };
  }

  /** Get a single user's quiz submission by listing and filtering; create if none exists. */
  async getOrCreateQuizSubmission(
    courseId: string,
    quizId: number,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
    actAsUser?: boolean,
  ): Promise<{ id: number; validation_token?: string; attempt?: number }> {
    const list = await this.listQuizSubmissions(courseId, quizId, domainOverride, tokenOverride);
    const match = list.find((s) => String(s.user_id) === String(userId));
    if (match?.id) {
      const existing = await this.getQuizSubmission(courseId, quizId, match.id, domainOverride, tokenOverride);
      if (existing?.validation_token) return existing;
      return { id: match.id, attempt: match.attempt ?? 1 };
    }
    return this.createQuizSubmission(courseId, quizId, userId, domainOverride, tokenOverride, actAsUser);
  }

  /** Get quiz submission questions with answers. */
  async getQuizSubmissionQuestions(
    quizSubmissionId: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; quiz_question_id?: number; question_name?: string; question_text?: string; answer?: unknown }>> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/quiz_submissions/${quizSubmissionId}/questions?include[]=quiz_question`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas get quiz submission questions failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      quiz_submission_questions?: Array<{
        id?: number;
        quiz_question_id?: number;
        question_name?: string;
        question_text?: string;
        answer?: unknown;
      }>;
    };
    return (data.quiz_submission_questions ?? []).map((q) => ({
      id: q.id ?? 0,
      quiz_question_id: q.quiz_question_id,
      question_name: q.question_name,
      question_text: q.question_text,
      answer: q.answer,
    }));
  }
}

