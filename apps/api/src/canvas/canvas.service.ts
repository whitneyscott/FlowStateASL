import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openAsBlob } from 'node:fs';
import { appendLtiLog, setLastCanvasApiResponse } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import {
  canvasApiBaseFromLtiContext,
  resolveCanvasApiBaseUrl,
} from '../common/utils/canvas-base-url.util';
import { resolveCanvasApiUserId, toCanvasFileIdInt } from '../common/utils/canvas-api-user.util';

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
  private readonly circuitState = new Map<string, { failures: number; openUntil: number }>();

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

  private redactHeadersForLog(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = k.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : v;
    }
    return out;
  }

  private responseHeadersToObject(res: Response): Record<string, string> {
    const o: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      o[k] = k.toLowerCase() === 'authorization' ? '(redacted)' : v;
    });
    return o;
  }

  private get canvasTimeoutMs(): number {
    const raw = this.config.get<string>('CANVAS_HTTP_TIMEOUT_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
  }

  private get circuitFailureThreshold(): number {
    const raw = this.config.get<string>('CANVAS_CIRCUIT_FAILURES');
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  }

  private get circuitOpenMs(): number {
    const raw = this.config.get<string>('CANVAS_CIRCUIT_OPEN_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
  }

  private circuitKeyForUrl(url: string): string {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return 'canvas';
    }
  }

  private recordCanvasSuccess(key: string): void {
    this.circuitState.set(key, { failures: 0, openUntil: 0 });
  }

  private recordCanvasFailure(key: string): void {
    const now = Date.now();
    const prev = this.circuitState.get(key) ?? { failures: 0, openUntil: 0 };
    const failures = prev.failures + 1;
    const openUntil = failures >= this.circuitFailureThreshold ? now + this.circuitOpenMs : 0;
    this.circuitState.set(key, { failures, openUntil });
  }

  private assertCircuitClosed(url: string): void {
    const key = this.circuitKeyForUrl(url);
    const state = this.circuitState.get(key);
    if (state && state.openUntil > Date.now()) {
      throw new Error(`CANVAS_CIRCUIT_OPEN: Canvas temporarily unavailable for ${key}`);
    }
  }

  private async canvasFetch(url: string, init: RequestInit): Promise<Response> {
    this.assertCircuitClosed(url);
    const key = this.circuitKeyForUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.canvasTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status >= 500) {
        this.recordCanvasFailure(key);
      } else {
        this.recordCanvasSuccess(key);
      }
      return res;
    } catch (err) {
      this.recordCanvasFailure(key);
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`CANVAS_TIMEOUT: request timed out after ${this.canvasTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Video upload pipeline HTTP summary for Bridge (no full response bodies or headers).
   * Parses JSON when possible for fileId / workflow_state / submission id.
   */
  private appendVideoSubmissionFlowHttpLog(
    step: string,
    detail: {
      requestMethod: string;
      requestUrl: string;
      requestBodyDescription?: string;
      responseStatus: number;
      responseBody: string;
    },
  ): void {
    const summary = this.summarizeVideoSubmissionFlowResponse(detail.responseBody);
    appendLtiLog('canvas', `videoSubmissionFlow:${step}`, {
      requestMethod: detail.requestMethod,
      requestUrl: detail.requestUrl,
      requestBodyDescription: detail.requestBodyDescription,
      responseStatus: detail.responseStatus,
      ...summary,
    });
  }

  /** Extract small fields from Canvas JSON responses; never log raw body. */
  private summarizeVideoSubmissionFlowResponse(raw: string): Record<string, unknown> {
    const text = (raw ?? '').trim();
    if (!text) return { responseParsed: false };
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const out: Record<string, unknown> = { responseParsed: true };
      const idVal = data.id;
      const idStr =
        typeof idVal === 'number' || typeof idVal === 'string' ? String(idVal) : undefined;
      const looksLikeSubmission =
        data.workflow_state != null ||
        data.submission_type != null ||
        (Array.isArray(data.attachments) && data.attachments.length > 0);
      if (idStr) {
        if (looksLikeSubmission) out.submissionId = idStr;
        else out.fileId = idStr;
      }
      if (data.workflow_state != null) out.workflow_state = data.workflow_state;
      if (data.submission_type != null) out.submission_type = data.submission_type;
      if (data.upload_url != null) out.hasUploadUrl = true;
      if (data.upload_params != null) out.hasUploadParams = true;
      return out;
    } catch {
      return { responseParsed: false, responseBodyLength: text.length };
    }
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
    const res = await this.canvasFetch(url, {
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
    const res = await this.canvasFetch(url, {
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
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${encodeURIComponent(userId)}/files`;
    const authH = this.getAuthHeaders(tokenOverride);
    const reqHeaders = { Authorization: authH.Authorization };
    const form = new FormData();
    form.append('name', filename);
    form.append('size', String(size));
    form.append('content_type', contentType);
    const res = await this.canvasFetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: form,
    });
    const responseText = await res.text();
    this.appendVideoSubmissionFlowHttpLog('initiateSubmissionFileUploadForUser', {
      requestMethod: 'POST',
      requestUrl: url,
      requestBodyDescription: `multipart/form-data fields: name, size, content_type (${contentType}); file not yet sent`,
      responseStatus: res.status,
      responseBody: responseText,
    });
    if (!res.ok) {
      appendLtiLog('canvas', 'initiateSubmissionFileUploadForUser FAIL', { status: res.status, text: responseText.slice(0, 200) });
      throw new Error(`Canvas initiate submission file upload failed: ${res.status} ${responseText}`);
    }
    const data = JSON.parse(responseText) as {
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

  async uploadFileToCanvas(
    uploadUrl: string,
    uploadParams: Record<string, string>,
    input: Buffer | { filePath: string; size: number },
    options?: { resumeFromOffset?: number; tokenOverride?: string | null },
  ): Promise<{ fileId: string }> {
    const start = options?.resumeFromOffset ?? 0;
    const usingFilePath = !Buffer.isBuffer(input);
    const total = Buffer.isBuffer(input) ? input.length : input.size;
    let lastSuccessOffset = start;

    const form = new FormData();
    for (const [k, v] of Object.entries(uploadParams)) {
      form.append(k, v);
    }
    if (Buffer.isBuffer(input)) {
      form.append('file', new Blob([input], { type: 'application/octet-stream' }));
    } else {
      const blob = await openAsBlob(input.filePath, { type: 'application/octet-stream' });
      form.append('file', blob, 'upload.webm');
    }

    try {
      const res = await this.canvasFetch(uploadUrl, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });
      const postText = await res.text();
      const paramKeys = Object.keys(uploadParams).sort().join(',');
      this.appendVideoSubmissionFlowHttpLog('uploadFileToCanvas:POST_upload_url', {
        requestMethod: 'POST',
        requestUrl: uploadUrl,
        requestBodyDescription: `multipart: upload_params [${paramKeys}], file=${total} bytes application/octet-stream, source=${usingFilePath ? 'filepath' : 'buffer'}`,
        responseStatus: res.status,
        responseBody: postText,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect without Location');
        const authHeaders = this.getAuthHeaders(options?.tokenOverride);
        const confirmRes = await this.canvasFetch(location, {
          method: 'GET',
          headers: { Authorization: authHeaders.Authorization },
        });
        const confirmText = await confirmRes.text();
        this.appendVideoSubmissionFlowHttpLog('uploadFileToCanvas:GET_confirm_redirect', {
          requestMethod: 'GET',
          requestUrl: location,
          responseStatus: confirmRes.status,
          responseBody: confirmText,
        });
        if (!confirmRes.ok) {
          throw new Error(`Confirm success failed: ${confirmRes.status}`);
        }
        const confirmData = JSON.parse(confirmText) as { id?: string };
        const fileId = String(confirmData.id ?? '');
        if (!fileId) throw new Error('No file id in confirm response');
        return { fileId };
      }

      if (!res.ok) {
        throw new CanvasUploadChunkError(
          `Upload failed: ${res.status}`,
          lastSuccessOffset,
        );
      }

      const data = JSON.parse(postText) as { id?: string };
      const fileId = String(data.id ?? '');
      if (!fileId) throw new Error('No file id in response');
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
   * Submit the uploaded file as an online_upload submission in one request.
   * POST /courses/:course_id/assignments/:assignment_id/submissions with
   * submission_type, user_id, and file_ids — not PUT with file_ids alone (which
   * targets comment attachment behavior and can leave workflow_state unsubmitted).
   */
  async attachFileToSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const fid = toCanvasFileIdInt(fileId);
    const uid = Number.parseInt(String(userId).trim(), 10);
    if (!Number.isFinite(uid)) {
      throw new Error(`Invalid Canvas user id for submission POST: ${userId}`);
    }
    const body = {
      submission: {
        submission_type: 'online_upload' as const,
        user_id: uid,
        file_ids: [fid],
      },
    };
    const authHeaders = this.getAuthHeaders(tokenOverride);
    const bodyStr = JSON.stringify(body);
    const res = await this.canvasFetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: bodyStr,
    });
    const raw = await res.text();
    this.appendVideoSubmissionFlowHttpLog('attachFileToSubmission:POST', {
      requestMethod: 'POST',
      requestUrl: url,
      requestBodyDescription: bodyStr,
      responseStatus: res.status,
      responseBody: raw,
    });
    if (!res.ok) {
      appendLtiLog('canvas', 'attachFileToSubmission FAIL', {
        status: res.status,
        requestPath: `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
        text: raw.slice(0, 800),
      });
      throw new Error(`Canvas attach file to submission failed: ${res.status} ${raw}`);
    }
    let attachSummary: Record<string, unknown> = {};
    try {
      if (raw?.trim()) {
        const data = JSON.parse(raw) as {
          id?: number;
          user_id?: number;
          workflow_state?: string;
          submission_type?: string;
          attempt?: number;
          attachments?: Array<{ id?: number; display_name?: string }>;
          attachment?: { id?: number };
        };
        const attIds = [
          ...(data.attachments?.map((a) => a.id).filter((id): id is number => id != null) ?? []),
          ...(data.attachment?.id != null ? [data.attachment.id] : []),
        ];
        attachSummary = {
          responseUserId: data.user_id ?? '(none)',
          responseSubmissionId: data.id ?? '(none)',
          attempt: data.attempt ?? '(none)',
          workflow_state: data.workflow_state ?? '(none)',
          submission_type: data.submission_type ?? '(none)',
          attachmentCount: attIds.length,
          attachmentIds: attIds.slice(0, 8),
          uploadedFileIdInResponse: attIds.includes(fid),
          attachmentNamesSample: (data.attachments ?? [])
            .slice(0, 3)
            .map((a) => ({ id: a.id, name: a.display_name ?? '(no name)' })),
        };
      } else {
        attachSummary = { responseBody: 'empty' };
      }
    } catch (parseErr) {
      attachSummary = { parseBody: 'non-json', parseError: String(parseErr) };
    }
    appendLtiLog('canvas', 'attachFileToSubmission OK', { courseId, assignmentId, userId, fileId, ...attachSummary });
  }

  /**
   * Attach a file to a submission comment on the target student row.
   * This matches the Submissions update API parameter `comment[file_ids][]`.
   */
  async attachFileToSubmissionComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    options?: { textComment?: string },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_comments`;
    const textComment = options?.textComment?.trim() || 'ASL Express video attachment';
    const body = {
      comment: {
        text_comment: textComment,
        file_ids: [toCanvasFileIdInt(fileId)],
      },
    };
    appendLtiLog('canvas', 'attachFileToSubmissionComment', {
      courseId,
      assignmentId,
      userId,
      fileId,
      textCommentPreview: textComment.slice(0, 80),
    });
    const res = await this.canvasFetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      appendLtiLog('canvas', 'attachFileToSubmissionComment FAIL', {
        status: res.status,
        bodyPreview: raw.slice(0, 800),
      });
      throw new Error(`Canvas attach file to submission comment failed: ${res.status} ${raw}`);
    }
    appendLtiLog('canvas', 'attachFileToSubmissionComment OK', {
      courseId,
      assignmentId,
      userId,
      fileId,
      responsePreview: raw.slice(0, 1200),
    });
  }

  /**
   * Add a text-only submission comment.
   * PUT .../submissions/:userId with comment[text_comment] only.
   */
  async putSubmissionTextComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    textComment: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${encodeURIComponent(userId)}`;
    const body = {
      comment: {
        text_comment: textComment,
      },
    };
    const res = await this.canvasFetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      appendLtiLog('canvas', 'putSubmissionTextComment FAIL', {
        status: res.status,
        assignmentId,
        userId,
        preview: raw.slice(0, 400),
      });
      throw new Error(`Canvas submission text comment failed: ${res.status} ${raw.slice(0, 200)}`);
    }
    appendLtiLog('canvas', 'putSubmissionTextComment OK', {
      courseId,
      assignmentId,
      userId,
      textLength: textComment.length,
    });
  }

  async submitAssignmentWithFile(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    options?: { bodyHtml?: string; actAsUser?: boolean },
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const baseUrl = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const actAsUser = options?.actAsUser === true;
    const url = actAsUser ? `${baseUrl}?as_user_id=${encodeURIComponent(userId)}` : baseUrl;
    const body = {
      submission: {
        submission_type: 'online_upload',
        file_ids: [toCanvasFileIdInt(fileId)],
        ...(options?.bodyHtml ? { body: options.bodyHtml } : {}),
      },
    };
    appendLtiLog('canvas', 'submitAssignmentWithFile: POST request', {
      assignmentId,
      userId,
      fileId,
      actAsUser,
      requestUrl: actAsUser ? `${baseUrl}?as_user_id=<userId>` : baseUrl,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Canvas submit assignment failed: ${res.status} ${text}`);
    }
    appendLtiLog('canvas', 'submitAssignmentWithFile: POST response', {
      status: res.status,
      actAsUser,
      responsePreview: text.slice(0, 1200),
    });
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

  /** Paginated list of assignment id + name (e.g. import / remap). */
  async listAssignmentsBrief(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: string; name: string }>> {
    const base = this.getBaseUrl(domainOverride);
    const out: Array<{ id: string; name: string }> = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const url = `${base}/api/v1/courses/${courseId}/assignments?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
      const rawBody = await res.text();
      if (!res.ok) {
        if (res.status === 401) throw new CanvasTokenExpiredError(401);
        appendLtiLog('canvas', 'listAssignmentsBrief failed', {
          status: res.status,
          bodyPreview: rawBody.slice(0, 200),
        });
        throw new Error(`Canvas list assignments failed: ${res.status} ${rawBody.slice(0, 400)}`);
      }
      const data = (() => {
        try {
          return JSON.parse(rawBody) as Array<{ id?: number; name?: string }>;
        } catch {
          return [];
        }
      })();
      const list = data ?? [];
      for (const a of list) {
        if (a?.id != null) {
          out.push({ id: String(a.id), name: String(a.name ?? '') });
        }
      }
      if (list.length < perPage) break;
      page++;
    }
    return out;
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
  ): Promise<{
    name?: string;
    description?: string;
    points_possible?: number;
    rubric?: Array<unknown>;
    assignment_group_id?: number;
    allowed_attempts?: number;
    /** Canvas-allowed submission types, e.g. online_upload, online_text_entry */
    submission_types?: string[];
  } | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      return null;
    }
    const data = (await res.json()) as {
      name?: string;
      description?: string;
      points_possible?: number;
      rubric?: Array<unknown>;
      assignment_group_id?: number;
      allowed_attempts?: number;
      submission_types?: string[];
    };
    return {
      name: data.name,
      description: data.description,
      points_possible: data.points_possible,
      rubric: data.rubric,
      assignment_group_id: data.assignment_group_id,
      allowed_attempts: data.allowed_attempts,
      submission_types: Array.isArray(data.submission_types) ? data.submission_types : undefined,
    };
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
      /** Canvas submission_types, e.g. online_upload + online_text_entry for ASL Express. */
      submissionTypes?: string[];
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
    if (Array.isArray(updates.submissionTypes) && updates.submissionTypes.length > 0) {
      body.submission_types = updates.submissionTypes;
    }
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

  /**
   * ASL Express video flow expects file upload + online text (matches createPromptManagerAssignment).
   * No-op when already configured.
   */
  async ensureAssignmentExpressSubmissionTypes(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const cur = await this.getAssignment(courseId, assignmentId, domainOverride, tokenOverride);
    const raw = cur?.submission_types ?? [];
    const norm = raw.map((t) => String(t).toLowerCase());
    if (norm.includes('online_upload') && norm.includes('online_text_entry')) {
      appendLtiLog('canvas', 'ensureAssignmentExpressSubmissionTypes: already ok', { courseId, assignmentId });
      return;
    }
    await this.updateAssignment(
      courseId,
      assignmentId,
      { submissionTypes: ['online_upload', 'online_text_entry'] },
      domainOverride,
      tokenOverride,
    );
    appendLtiLog('canvas', 'ensureAssignmentExpressSubmissionTypes: updated', { courseId, assignmentId });
  }

  /** Delete an assignment from a course. */
  async deleteAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    appendLtiLog('canvas', 'deleteAssignment: DELETE from Canvas', {
      courseId,
      assignmentId,
    });
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getAuthHeaders(tokenOverride),
    });
    if (!res.ok) {
      if (res.status === 401) throw new CanvasTokenExpiredError(401);
      const text = await res.text();
      throw new Error(`Canvas delete assignment failed: ${res.status} ${text}`);
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

  /** List course modules for module selector (follows Canvas Link pagination until exhausted). */
  async listModules(
    courseId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<{ id: number; name: string; position: number }>> {
    const base = this.getBaseUrl(domainOverride);
    const out: Array<{ id: number; name: string; position: number }> = [];
    let nextUrl: string | null = `${base}/api/v1/courses/${courseId}/modules?per_page=100`;
    let pages = 0;
    const maxPages = 40;
    while (nextUrl && pages < maxPages) {
      const res = await fetch(nextUrl, { headers: this.getAuthHeaders(tokenOverride) });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Canvas list modules failed: ${res.status} ${text}`);
      }
      const data = (await res.json()) as Array<{ id: number; name: string; position: number }>;
      if (Array.isArray(data) && data.length > 0) out.push(...data);
      const linkHeader = res.headers.get('link') ?? '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
      nextUrl = nextMatch?.[1] ?? null;
      pages += 1;
    }
    return out;
  }

  /** Add an assignment to a module. Idempotent: no-op if assignment already in module. */
  async addAssignmentToModule(
    courseId: string,
    moduleId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ created: boolean; itemId?: number }> {
    appendLtiLog('canvas', 'addAssignmentToModule: start', {
      courseId,
      moduleId,
      assignmentId,
    });
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
      appendLtiLog('canvas', 'addAssignmentToModule: already present', {
        moduleId,
        assignmentId,
      });
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
      appendLtiLog('canvas', 'addAssignmentToModule FAIL', {
        moduleId,
        assignmentId,
        status: res.status,
        text: text.slice(0, 300),
      });
      throw new Error(`Canvas add assignment to module failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id?: number };
    appendLtiLog('canvas', 'addAssignmentToModule OK', {
      moduleId,
      assignmentId,
      moduleItemId: created?.id ?? null,
    });
    return { created: true, itemId: created?.id };
  }

  /**
   * If the assignment appears as an Assignment module item in any course module,
   * returns the first module id (string) in Canvas module position order.
   */
  async findFirstModuleIdContainingAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string | null> {
    const aid = parseInt(assignmentId, 10);
    if (Number.isNaN(aid)) return null;
    const modules = await this.listModules(courseId, domainOverride, tokenOverride);
    const sorted = [...modules].sort((a, b) => a.position - b.position);
    for (const m of sorted) {
      const items = await this.listModuleItems(courseId, String(m.id), domainOverride, tokenOverride);
      const hit = items.some((i) => i.type === 'Assignment' && i.content_id === aid);
      if (hit) return String(m.id);
    }
    return null;
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

  async deleteModuleItem(
    courseId: string,
    moduleId: string,
    itemId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getAuthHeaders(tokenOverride),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas delete module item failed: ${res.status} ${text}`);
    }
  }

  /**
   * Set module item visibility for students. Canvas documents `module_item[published]` on PUT update;
   * some instances also honor it on create — callers may set both for reliability.
   */
  async setModuleItemPublished(
    courseId: string,
    moduleId: string,
    itemId: number | string,
    published: boolean,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify({ module_item: { published } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas set module item published failed: ${res.status} ${text}`);
    }
  }

  async prunePrompterExternalToolModuleItems(
    courseId: string,
    moduleId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{
    checked: number;
    deleted: number;
    keptItemId?: number;
    skippedReason?: string;
  }> {
    const toolIdStr = await this.resolvePrompterContextExternalToolId(courseId, domainOverride, tokenOverride);
    if (!toolIdStr) {
      return { checked: 0, deleted: 0, skippedReason: 'prompter_tool_not_resolved' };
    }
    const toolIdNum = parseInt(toolIdStr, 10);
    if (Number.isNaN(toolIdNum)) {
      return { checked: 0, deleted: 0, skippedReason: 'invalid_prompter_tool_id' };
    }

    const items = await this.listModuleItems(courseId, moduleId, domainOverride, tokenOverride);
    const candidates = items.filter((i) => i.type === 'ExternalTool' && i.content_id === toolIdNum);
    if (candidates.length === 0) {
      return { checked: 0, deleted: 0, skippedReason: 'no_prompter_module_items' };
    }

    const matchesAssignmentId = (value: string | undefined): boolean => {
      if (!value) return false;
      try {
        const u = new URL(value, this.getBaseUrl(domainOverride));
        return u.searchParams.get('assignment_id') === assignmentId;
      } catch {
        return value.includes(`assignment_id=${assignmentId}`) || value.includes(`assignment_id=${encodeURIComponent(assignmentId)}`);
      }
    };

    let keptItemId: number | undefined;
    let deleted = 0;
    for (const item of candidates) {
      const sessionless = await this.getSessionlessLaunchForModuleItem(
        courseId,
        item.id,
        domainOverride,
        tokenOverride,
      );
      const sessionlessUrl = String(sessionless?.url ?? '').trim();
      const sessionlessHealthy = !!sessionlessUrl && !sessionless?.error;
      const assignmentMatch = matchesAssignmentId(item.external_url);
      const keep = !keptItemId && sessionlessHealthy && assignmentMatch;
      if (keep) {
        keptItemId = item.id;
        continue;
      }
      await this.deleteModuleItem(courseId, moduleId, item.id, domainOverride, tokenOverride);
      deleted += 1;
    }

    appendLtiLog('canvas', 'prunePrompterExternalToolModuleItems', {
      courseId,
      moduleId,
      assignmentId,
      checked: candidates.length,
      deleted,
      keptItemId: keptItemId ?? null,
      externalToolId: toolIdNum,
    });
    return { checked: candidates.length, deleted, ...(keptItemId ? { keptItemId } : {}) };
  }

  /** Read one module item with content details (best effort for launch-id diagnostics). */
  async getModuleItemDetails(
    courseId: string,
    moduleId: string,
    itemId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}?include[]=content_details`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    return raw && typeof raw === 'object' ? raw : null;
  }

  /** Read single external tool details for diagnostics. */
  async getExternalTool(
    courseId: string,
    externalToolId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/external_tools/${externalToolId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    return raw && typeof raw === 'object' ? raw : null;
  }

  /** Probe Canvas launch resolution for a module item (helps explain settings errors). */
  async getSessionlessLaunchForModuleItem(
    courseId: string,
    moduleItemId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const base = this.getBaseUrl(domainOverride);
    const url = new URL(`${base}/api/v1/courses/${courseId}/external_tools/sessionless_launch`);
    url.searchParams.set('launch_type', 'module_item');
    url.searchParams.set('module_item_id', String(moduleItemId));
    const res = await fetch(url.toString(), { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) {
      const text = await res.text();
      return {
        error: true,
        status: res.status,
        statusText: res.statusText,
        bodyPreview: text.slice(0, 600),
      };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return raw && typeof raw === 'object' ? raw : null;
  }

  /**
   * Best-effort resolver for resource_link_id right after module-item creation.
   * Uses Canvas sessionless launch URL, then parses hidden form inputs where
   * Canvas includes resource_link_id during real launch handoff.
   */
  async resolveResourceLinkIdForModuleItemViaSessionlessForm(
    courseId: string,
    moduleItemId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{
    resourceLinkId?: string;
    source?: 'sessionless_form';
    attempts: number;
    reason?: string;
  }> {
    const maxAttempts = 3;
    const waitMs = [0, 350, 900];
    const readInput = (html: string, name: string): string => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`<input[^>]*name=["']${escaped}["'][^>]*value=["']([^"']*)["']`, 'i');
      const m = html.match(re);
      return (m?.[1] ?? '').trim();
    };
    const readAnyResourceLinkId = (html: string): string => {
      const candidates = [
        'resource_link_id',
        'custom_resource_link_id',
        'custom_custom_resource_link_id',
        'lti_resource_link_id',
      ];
      for (const name of candidates) {
        const value = readInput(html, name);
        if (value) return value;
      }
      return '';
    };

    for (let i = 0; i < maxAttempts; i += 1) {
      const delay = waitMs[i] ?? waitMs[waitMs.length - 1];
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const sessionless = await this.getSessionlessLaunchForModuleItem(
        courseId,
        moduleItemId,
        domainOverride,
        tokenOverride,
      );
      const sessionlessUrl = String(sessionless?.url ?? '').trim();
      if (!sessionlessUrl) {
        continue;
      }

      try {
        const res = await fetch(sessionlessUrl, {
          method: 'GET',
          headers: this.getAuthHeaders(tokenOverride),
          redirect: 'follow',
        });
        const html = await res.text();
        const rid = readAnyResourceLinkId(html);
        if (rid) {
          return { resourceLinkId: rid, source: 'sessionless_form', attempts: i + 1 };
        }
      } catch {
        // Best-effort: ignore and retry
      }
    }

    return { attempts: maxAttempts, reason: 'not_found_in_sessionless_form' };
  }

  /** Find LTI resource-link records associated to a given module item. */
  async findResourceLinksForModuleItem(
    courseId: string,
    moduleItemId: number | string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    const base = this.getBaseUrl(domainOverride);
    const collectAll = async (): Promise<Array<Record<string, unknown>>> => {
      const out: Array<Record<string, unknown>> = [];
      let nextUrl: string | null = `${base}/api/v1/courses/${courseId}/lti_resource_links?per_page=100`;
      let pages = 0;
      while (nextUrl && pages < 10) {
        const res = await fetch(nextUrl, { headers: this.getAuthHeaders(tokenOverride) });
        if (!res.ok) break;
        const raw = (await res.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(raw) && raw.length > 0) out.push(...raw);
        const linkHeader = res.headers.get('link') ?? '';
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
        nextUrl = nextMatch?.[1] ?? null;
        pages += 1;
      }
      return out;
    };
    const all = await collectAll();
    if (!Array.isArray(all) || all.length === 0) return [];
    const itemIdNum = Number(moduleItemId);
    return all.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const associatedType = String(entry.associated_content_type ?? '');
      const associatedId = Number(entry.associated_content_id ?? NaN);
      return associatedType.toLowerCase().includes('moduleitem') && !Number.isNaN(associatedId) && associatedId === itemIdNum;
    });
  }

  /** Try to resolve assignmentId from a Canvas LTI resource link id/uuid. */
  async resolveAssignmentIdForResourceLink(
    courseId: string,
    resourceLinkId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{
    assignmentId?: string;
    source?: 'associated_assignment' | 'canvas_launch_url' | 'module_item_external_url';
    matchedField?: 'id' | 'lookup_uuid' | 'resource_link_uuid' | 'resource_link_id';
  }> {
    const rid = (resourceLinkId ?? '').trim();
    if (!rid) return {};
    const base = this.getBaseUrl(domainOverride);
    const collectAll = async (): Promise<Array<Record<string, unknown>>> => {
      const out: Array<Record<string, unknown>> = [];
      let nextUrl: string | null = `${base}/api/v1/courses/${courseId}/lti_resource_links?per_page=100`;
      let pages = 0;
      while (nextUrl && pages < 10) {
        const res = await fetch(nextUrl, { headers: this.getAuthHeaders(tokenOverride) });
        if (!res.ok) break;
        const raw = (await res.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(raw) && raw.length > 0) out.push(...raw);
        const linkHeader = res.headers.get('link') ?? '';
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
        nextUrl = nextMatch?.[1] ?? null;
        pages += 1;
      }
      return out;
    };
    const all = await collectAll();
    if (!Array.isArray(all) || all.length === 0) return {};

    const same = (v: unknown): boolean => String(v ?? '').trim() === rid;
    const entry =
      all.find((e) => same(e.id)) ??
      all.find((e) => same(e.lookup_uuid)) ??
      all.find((e) => same(e.resource_link_uuid)) ??
      all.find((e) => same(e.resource_link_id));
    if (!entry) return {};

    const matchedField: 'id' | 'lookup_uuid' | 'resource_link_uuid' | 'resource_link_id' =
      same(entry.id)
        ? 'id'
        : same(entry.lookup_uuid)
          ? 'lookup_uuid'
          : same(entry.resource_link_uuid)
            ? 'resource_link_uuid'
            : 'resource_link_id';

    const associatedType = String(entry.associated_content_type ?? '').toLowerCase();
    const associatedId = String(entry.associated_content_id ?? '').trim();
    if (associatedType.includes('assignment') && associatedId) {
      return { assignmentId: associatedId, source: 'associated_assignment', matchedField };
    }

    const launchUrl = String(entry.canvas_launch_url ?? '').trim();
    const parseAssignmentIdFromUrl = (value: string): string | null => {
      if (!value) return null;
      try {
        const u = new URL(value, base);
        return (u.searchParams.get('assignment_id') ?? '').trim() || null;
      } catch {
        const m = value.match(/assignment_id=(\d{3,})/i);
        return m?.[1] ?? null;
      }
    };
    if (launchUrl) {
      const aid = parseAssignmentIdFromUrl(launchUrl);
      if (aid) return { assignmentId: aid, source: 'canvas_launch_url', matchedField };
    }

    // Canvas may store module-item association without assignment id on lti_resource_links row.
    // In that case, resolve via associated module item external_url assignment_id.
    if (associatedType.includes('moduleitem') && associatedId) {
      try {
        const targetItemId = Number(associatedId);
        if (!Number.isNaN(targetItemId)) {
          const modules = await this.listModules(courseId, domainOverride, tokenOverride);
          for (const mod of modules) {
            const items = await this.listModuleItems(courseId, String(mod.id), domainOverride, tokenOverride);
            const item = items.find((i) => Number(i.id) === targetItemId);
            if (!item) continue;
            const aid = parseAssignmentIdFromUrl(String(item.external_url ?? ''));
            if (aid) {
              return { assignmentId: aid, source: 'module_item_external_url', matchedField };
            }
            break;
          }
        }
      } catch {
        // Best-effort fallback; ignore lookup failures here.
      }
    }
    return { matchedField };
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
    const launchPathCandidates = ranked.filter((r) =>
      r.reason.includes('launchPathMatch'),
    );
    if (launchPathCandidates.length === 1) {
      const only = launchPathCandidates[0];
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: fallback selected single launchPathMatch', {
        id: only.id,
        score: only.score,
        reason: only.reason,
        name: only.name,
      });
      return String(only.id);
    }
    if (ranked.length === 1 && ranked[0].score > 0) {
      const only = ranked[0];
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: fallback selected sole candidate', {
        id: only.id,
        score: only.score,
        reason: only.reason,
        name: only.name,
      });
      return String(only.id);
    }
    if (winner && winner.score >= 20) {
      appendLtiLog('canvas', 'resolvePrompterContextExternalToolId: fallback selected best candidate (low confidence)', {
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
    options?: {
      linkTitle?: string;
      payloadVariant?: 'content_id_only' | 'content_id_plus_external_url';
    },
  ): Promise<{
    created: boolean;
    skippedReason?: string;
    itemId?: number;
    resourceLinkId?: string | null;
    payloadVariant: 'content_id_only' | 'content_id_plus_external_url';
    diagnosisBucket?:
      | 'association_created'
      | 'association_missing_after_create'
      | 'tool_launch_mismatch'
      | 'sessionless_unresolvable';
  }> {
    const collectLaunchIdHints = (
      item: Record<string, unknown> | null | undefined,
    ): { resourceLinkId?: string | null; ltiResourceLinkId?: string | null; launchUrlResourceLinkId?: string | null } => {
      if (!item) return {};
      const asRecord = (v: unknown): Record<string, unknown> | null =>
        v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
      const readId = (v: unknown): string | null => {
        if (v == null) return null;
        const s = String(v).trim();
        return s.length ? s : null;
      };
      const parseResourceLinkFromUrl = (value: unknown): string | null => {
        const url = readId(value);
        if (!url) return null;
        try {
          const u = new URL(url);
          return readId(u.searchParams.get('resource_link_id') ?? u.searchParams.get('lti_resource_link_id'));
        } catch {
          const m = url.match(/[?&](?:resource_link_id|lti_resource_link_id)=([^&]+)/i);
          return m?.[1] ? decodeURIComponent(m[1]) : null;
        }
      };
      const contentDetails = asRecord(item.content_details);
      return {
        resourceLinkId:
          readId(item.resource_link_id) ??
          readId(item.resourceLinkId) ??
          readId(contentDetails?.resource_link_id) ??
          null,
        ltiResourceLinkId:
          readId(item.lti_resource_link_id) ??
          readId(item.ltiResourceLinkId) ??
          readId(contentDetails?.lti_resource_link_id) ??
          null,
        launchUrlResourceLinkId:
          parseResourceLinkFromUrl(item.external_url) ??
          parseResourceLinkFromUrl(item.html_url) ??
          parseResourceLinkFromUrl(item.url) ??
          parseResourceLinkFromUrl(contentDetails?.url) ??
          null,
      };
    };

    const payloadVariantEnv = (
      this.config.get<string>('CANVAS_PROMPTER_MODULE_PAYLOAD_MODE') ??
      process.env.CANVAS_PROMPTER_MODULE_PAYLOAD_MODE ??
      ''
    )
      .trim()
      .toLowerCase();
    const payloadVariant =
      options?.payloadVariant ??
      (payloadVariantEnv === 'content_id_plus_external_url'
        ? 'content_id_plus_external_url'
        : 'content_id_only');
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem: start', {
      courseId,
      moduleId,
      assignmentId,
      payloadVariant,
    });
    const toolIdStr = await this.resolvePrompterContextExternalToolId(courseId, domainOverride, tokenOverride);
    if (!toolIdStr) {
      return {
        created: false,
        skippedReason:
          'Prompter external tool not found (resolver returned no candidate). Check Bridge Log lines for resolvePrompterContextExternalToolId ranked candidates, ensure OAuth scope allows GET /courses/:course_id/external_tools, and verify tool launch URL targets /api/lti/launch.',
        payloadVariant,
      };
    }
    const toolIdNum = parseInt(toolIdStr, 10);
    if (Number.isNaN(toolIdNum)) {
      return { created: false, skippedReason: 'Invalid external tool id', payloadVariant };
    }

    const items = await this.listModuleItems(courseId, moduleId, domainOverride, tokenOverride);
    const aid = parseInt(assignmentId, 10);
    const assignmentItem = items.find((i) => i.type === 'Assignment' && i.content_id === aid);

    const base = this.getBaseUrl(domainOverride);
    const externalUrl = `${base}/courses/${courseId}/external_tools/${toolIdStr}?assignment_id=${encodeURIComponent(assignmentId)}`;
    const title =
      (options?.linkTitle ?? '').trim() ||
      'ASL Express – Open Prompter (record here)';

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

    const existing = items.find((i) =>
      i.type === 'ExternalTool' &&
      i.content_id === toolIdNum &&
      (
        payloadVariant === 'content_id_plus_external_url'
          ? urlMatchesAssignment(i.external_url)
          : String(i.title ?? '').trim() === title
      ),
    );

    /** Save path skips `lti_resource_links` list scan for latency; association = launch hints only. */
    const classifyDiagnosisBucket = (args: {
      launchIds: {
        resourceLinkId?: string | null;
        ltiResourceLinkId?: string | null;
        launchUrlResourceLinkId?: string | null;
      };
      sessionless: Record<string, unknown> | null;
    }): 'association_created' | 'association_missing_after_create' | 'tool_launch_mismatch' | 'sessionless_unresolvable' => {
      const hasAssociation = !!(
        args.launchIds.resourceLinkId ||
        args.launchIds.ltiResourceLinkId ||
        args.launchIds.launchUrlResourceLinkId
      );
      const sessionlessUrl = String(args.sessionless?.url ?? '').trim();
      const hasSessionlessUrl = !!sessionlessUrl;
      const sessionlessError = !!args.sessionless?.error;
      if (hasAssociation && hasSessionlessUrl) return 'association_created';
      if (!hasAssociation && hasSessionlessUrl) return 'tool_launch_mismatch';
      if ((hasAssociation && !hasSessionlessUrl) || sessionlessError) return 'sessionless_unresolvable';
      return 'association_missing_after_create';
    };

    if (existing) {
      const externalTool = await this.getExternalTool(courseId, toolIdNum, domainOverride, tokenOverride);
      const existingDetails = await this.getModuleItemDetails(
        courseId,
        moduleId,
        existing.id,
        domainOverride,
        tokenOverride,
      );
      const existingLaunchIds = collectLaunchIdHints(existingDetails);
      const sessionless = await this.getSessionlessLaunchForModuleItem(
        courseId,
        existing.id,
        domainOverride,
        tokenOverride,
      );
      const diagnosisBucket = classifyDiagnosisBucket({
        launchIds: existingLaunchIds,
        sessionless,
      });
      appendLtiLog('canvas', 'syncPrompterLtiModuleItem: already present', {
        externalToolId: toolIdNum,
        moduleItemId: existing.id,
        assignmentId,
        payloadVariant,
        diagnosisBucket,
        resourceLinkId: existingLaunchIds.resourceLinkId ?? null,
        ltiResourceLinkId: existingLaunchIds.ltiResourceLinkId ?? null,
        launchUrlResourceLinkId: existingLaunchIds.launchUrlResourceLinkId ?? null,
        moduleItemExternalUrl: existing.external_url ?? null,
        toolLaunchUrl: String(externalTool?.url ?? externalTool?.target_link_uri ?? '') || null,
        toolDomain: String(externalTool?.domain ?? '') || null,
        sessionlessLaunchUrl: String(sessionless?.url ?? '') || null,
        ltiResourceLinksLookup: 'skipped_for_save_latency',
      });
      try {
        await this.setModuleItemPublished(courseId, moduleId, existing.id, true, domainOverride, tokenOverride);
        appendLtiLog('canvas', 'syncPrompterLtiModuleItem: ensured published (existing item)', {
          moduleItemId: existing.id,
        });
      } catch (pubErr) {
        appendLtiLog('canvas', 'syncPrompterLtiModuleItem: publish existing item failed', {
          moduleItemId: existing.id,
          error: String(pubErr),
        });
        throw pubErr;
      }
      return {
        created: false,
        skippedReason: 'already_linked',
        itemId: existing.id,
        resourceLinkId:
          existingLaunchIds.resourceLinkId ??
          existingLaunchIds.ltiResourceLinkId ??
          existingLaunchIds.launchUrlResourceLinkId ??
          null,
        payloadVariant,
        diagnosisBucket,
      };
    }

    const position = assignmentItem?.position ?? (items.length ? Math.max(...items.map((i) => i.position)) + 1 : 1);

    const url = `${base}/api/v1/courses/${courseId}/modules/${moduleId}/items`;
    const moduleItemPayload: Record<string, unknown> = {
      type: 'ExternalTool',
      content_id: toolIdNum,
      position,
      title,
      new_tab: true,
      published: true,
    };
    if (payloadVariant === 'content_id_plus_external_url') {
      moduleItemPayload.external_url = externalUrl;
    }
    const body = {
      module_item: moduleItemPayload,
    };
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem: POST ExternalTool module item', {
      moduleItemPayload: body.module_item,
      position,
      assignmentId,
      externalToolId: toolIdStr,
      assignmentModuleItemId: assignmentItem?.id ?? null,
      externalUrl: payloadVariant === 'content_id_plus_external_url' ? externalUrl : null,
      payloadVariant,
      title,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      setLastCanvasApiResponse({
        status: res.status,
        statusText: res.statusText,
        bodyPreview: text.slice(0, 1200),
      });
      appendLtiLog('canvas', 'syncPrompterLtiModuleItem FAIL', { status: res.status, text: text.slice(0, 400) });
      throw new Error(`Canvas add ExternalTool module item failed: ${res.status} ${text}`);
    }
    const created = (await res.json()) as { id?: number; [key: string]: unknown };
    if (created?.id != null) {
      try {
        await this.setModuleItemPublished(courseId, moduleId, created.id, true, domainOverride, tokenOverride);
        appendLtiLog('canvas', 'syncPrompterLtiModuleItem: ensured published (after create)', {
          moduleItemId: created.id,
        });
      } catch (pubErr) {
        appendLtiLog('canvas', 'syncPrompterLtiModuleItem: publish after create failed', {
          moduleItemId: created.id,
          error: String(pubErr),
        });
        throw pubErr;
      }
    }
    const externalTool = await this.getExternalTool(courseId, toolIdNum, domainOverride, tokenOverride);
    const createdDetails = created?.id
      ? await this.getModuleItemDetails(courseId, moduleId, created.id, domainOverride, tokenOverride)
      : null;
    const sessionless = created?.id
      ? await this.getSessionlessLaunchForModuleItem(courseId, created.id, domainOverride, tokenOverride)
      : null;
    appendLtiLog('prompt-decks', 'syncPrompterLtiModuleItem: lti_resource_links scan skipped (save latency)', {
      moduleItemId: created?.id ?? null,
    });
    const createdLaunchIds = collectLaunchIdHints(createdDetails ?? created);
    const diagnosisBucket = classifyDiagnosisBucket({
      launchIds: createdLaunchIds,
      sessionless,
    });
    appendLtiLog('canvas', 'syncPrompterLtiModuleItem OK', {
      externalToolId: toolIdStr,
      moduleItemId: created?.id,
      assignmentModuleItemId: assignmentItem?.id ?? null,
      assignmentId,
      payloadVariant,
      diagnosisBucket,
      resourceLinkId: createdLaunchIds.resourceLinkId ?? null,
      ltiResourceLinkId: createdLaunchIds.ltiResourceLinkId ?? null,
      launchUrlResourceLinkId: createdLaunchIds.launchUrlResourceLinkId ?? null,
      moduleItemExternalUrl: String((createdDetails?.external_url ?? created.external_url) ?? '') || null,
      moduleItemHtmlUrl: String((createdDetails?.html_url ?? created.html_url) ?? '') || null,
      toolLaunchUrl: String(externalTool?.url ?? externalTool?.target_link_uri ?? '') || null,
      toolDomain: String(externalTool?.domain ?? '') || null,
      sessionlessLaunchUrl: String(sessionless?.url ?? '') || null,
      ltiResourceLinksLookup: 'skipped_for_save_latency',
    });
    return {
      created: true,
      itemId: created?.id,
      resourceLinkId:
        createdLaunchIds.resourceLinkId ??
        createdLaunchIds.ltiResourceLinkId ??
        createdLaunchIds.launchUrlResourceLinkId ??
        null,
      payloadVariant,
      diagnosisBucket,
    };
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
        published: true,
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
      const created = JSON.parse(responseText) as {
        body?: string;
        submission_type?: string;
        user_id?: number;
        id?: number;
        workflow_state?: string;
        attempt?: number;
        attachments?: unknown[];
      };
      appendLtiLog('canvas', 'createSubmissionWithBody POST response', {
        status: res.status,
        actAsUserRequested: !!actAsUser,
        canvasUserIdInResponse: created.user_id ?? '(missing)',
        submissionRowId: created.id ?? '(missing)',
        workflow_state: created.workflow_state ?? '(missing)',
        responseHasBody: !!created?.body,
        responseBodyLength: created?.body?.length ?? 0,
        submission_type: created.submission_type ?? '(missing)',
        attachmentCountInResponse: Array.isArray(created.attachments) ? created.attachments.length : 0,
      });
      appendLtiLog('canvas', 'createSubmissionWithBody POST response (raw preview)', {
        actAsUserRequested: !!actAsUser,
        preview: responseText.slice(0, 1200),
      });
    } catch {
      appendLtiLog('canvas', 'createSubmissionWithBody POST response', {
        status: res.status,
        parseError: true,
        rawPreview: responseText.slice(0, 800),
      });
    }
  }

  /**
   * Write submission body for an assignment. Uses tokenOverride (OAuth or service token).
   * When the assignment allows online text entry, updates the **target student's** submission row via
   * PUT .../submissions/:user_id (body). This matches PHP parity and avoids 403s where POST create
   * submission is rejected for the token (e.g. some roles / LTI + REST combinations).
   *
   * Target user id: LTI custom Canvas user id when present; else, if the token is the launcher's
   * OAuth token, Canvas /users/self (student self-submit). Static tokens without LTI custom id cannot
   * infer the student — callers must send user_id=$Canvas.user.id on the Developer Key.
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
        'Canvas access token required for writeSubmissionBody (session OAuth or per-course stored token)',
      );
    }
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const assign = await this.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    const types = assign?.submission_types;
    const allowsOnlineText =
      !types ||
      types.length === 0 ||
      types.some((t) => String(t).toLowerCase() === 'online_text_entry');
    if (!allowsOnlineText) {
      appendLtiLog('canvas', 'writeSubmissionBody: skip body write (assignment disallows online_text_entry)', {
        assignmentId,
        submission_types: types ?? [],
        note: 'Video prompt snapshots use WebM PROMPT_DATA at upload; text-only flow uses submission body when online_text_entry is allowed.',
      });
      // #region agent log
      appendLtiLog('agent-debug', 'writeSubmissionBody: SKIPPED online_text_entry disallowed (Bridge)', {
        hypothesisId: 'H5',
        assignmentId,
        submission_types: types ?? [],
      });
      // #endregion
      return;
    }
    const fromLti = resolveCanvasApiUserId(ctx)?.trim() || '';
    const tokenUserId = (await this.getCurrentCanvasUserId(domainOverride, token))?.trim() || '';
    const sessionOauth = (ctx.canvasAccessToken ?? '').trim();
    const tokenIsLauncherOauth = sessionOauth.length > 0 && token === sessionOauth;
    const submissionCanvasUserId = fromLti || (tokenIsLauncherOauth ? tokenUserId : '');
    if (!submissionCanvasUserId) {
      throw new Error(
        'Cannot resolve Canvas user id for submission body. Add LTI Custom Field user_id = $Canvas.user.id on the Developer Key, or complete Canvas OAuth as the submitting student so /users/self applies.',
      );
    }
    appendLtiLog('canvas', 'writeSubmissionBody (Step 10)', {
      assignmentId,
      bodyLength: bodyContent?.length ?? 0,
      ltiUserId: ctx.userId,
      fromLti: fromLti || '(none)',
      submissionCanvasUserId,
      tokenUserId: tokenUserId || '(unknown)',
      tokenIsLauncherOauth,
      writeMode: 'PUT_then_POST_if_no_submission_row',
      submission_types: types ?? '(unknown)',
      tokenPreview: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : 'MISSING',
    });
    const putOk = await this.putSubmissionBodyAllowMissing(
      ctx.courseId,
      assignmentId,
      submissionCanvasUserId,
      bodyContent,
      domainOverride,
      token,
    );
    if (putOk) {
      appendLtiLog('canvas', 'writeSubmissionBody: PUT submission body succeeded', {
        assignmentId,
        submissionCanvasUserId,
      });
      return;
    }
    appendLtiLog('canvas', 'writeSubmissionBody: PUT 404 (no row); POST create online_text_entry', {
      assignmentId,
      submissionCanvasUserId,
    });
    const actAsUser =
      !!submissionCanvasUserId && !!tokenUserId && submissionCanvasUserId !== tokenUserId;
    await this.createSubmissionWithBody(
      ctx.courseId,
      assignmentId,
      actAsUser ? submissionCanvasUserId : '',
      bodyContent,
      domainOverride,
      token,
      actAsUser,
    );
    appendLtiLog('canvas', 'writeSubmissionBody: POST create submission succeeded', {
      assignmentId,
      submissionCanvasUserId,
      actAsUser,
    });
  }

  /**
   * PUT submission body. Returns true if updated, false if Canvas returns 404 (no submission yet).
   * Throws on other errors.
   */
  async putSubmissionBodyAllowMissing(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<boolean> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body = { submission: { body: bodyText } };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    if (res.status === 404) {
      appendLtiLog('canvas', 'putSubmissionBodyAllowMissing: 404 (no submission row yet)', {
        courseId,
        assignmentId,
        userId,
      });
      return false;
    }
    const text = await res.text();
    throw new Error(`Canvas put submission body failed: ${res.status} ${text}`);
  }

  async putSubmissionBody(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const ok = await this.putSubmissionBodyAllowMissing(
      courseId,
      assignmentId,
      userId,
      bodyText,
      domainOverride,
      tokenOverride,
    );
    if (!ok) {
      throw new Error(
        'Canvas put submission body failed: 404 — no submission row for this user yet; use POST create or submit first',
      );
    }
  }

  /** Get a single user's submission with full details (for viewer - teacher or student). */
  async getSubmissionFull(
    courseId: string,
    assignmentId: string,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
    diagnostics?: { bridge?: boolean; tag?: string },
  ): Promise<{
    body?: string;
    score?: number;
    grade?: string;
    attempt?: number;
    submitted_at?: string;
    submission_comments?: Array<{
      id?: number;
      comment?: string;
      attachments?: Array<{ id?: number; url?: string; download_url?: string }>;
      attachment_ids?: number[];
    }>;
    attachment?: { url?: string; id?: number };
    attachments?: Array<{ url?: string; download_url?: string; id?: number; display_name?: string }>;
    versioned_attachments?: Array<Array<{ url?: string }>>;
    rubric_assessment?: Record<string, unknown>;
    user_id?: number;
    workflow_state?: string;
    submission_type?: string;
    id?: number;
  } | null> {
    const base = this.getBaseUrl(domainOverride);
    const includes = ['submission_history', 'submission_comments', 'rubric_assessment'];
    if (diagnostics?.bridge) includes.push('user');
    const q = includes.map((i) => `include[]=${encodeURIComponent(i)}`).join('&');
    const path = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const url = `${base}${path}?${q}`;
    if (diagnostics?.bridge) {
      appendLtiLog('canvas', 'getSubmissionFull diagnostics: request', {
        tag: diagnostics.tag ?? 'getSubmissionFull',
        path,
        includes,
      });
    }
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    const text = await res.text();
    if (!res.ok) {
      if (diagnostics?.bridge) {
        appendLtiLog('canvas', 'getSubmissionFull diagnostics: non-OK', {
          tag: diagnostics.tag ?? 'getSubmissionFull',
          status: res.status,
          bodyPreview: text.slice(0, 900),
        });
      }
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (diagnostics?.bridge) {
        appendLtiLog('canvas', 'getSubmissionFull diagnostics: JSON parse failed', {
          tag: diagnostics.tag ?? 'getSubmissionFull',
          error: String(e),
          textPreview: text.slice(0, 400),
        });
      }
      return null;
    }
    if (diagnostics?.bridge) {
      const atts = parsed.attachments;
      const attList = Array.isArray(atts) ? atts : [];
      const ids = attList
        .map((a) => (a && typeof a === 'object' ? (a as { id?: number }).id : undefined))
        .filter((id): id is number => id != null);
      const hist = parsed.submission_history;
      const histLen = Array.isArray(hist) ? hist.length : 0;
      const ver = parsed.versioned_attachments;
      const verLen = Array.isArray(ver) ? ver.length : 0;
      appendLtiLog('canvas', 'getSubmissionFull diagnostics: parsed summary', {
        tag: diagnostics.tag ?? 'getSubmissionFull',
        queriedUserId: userId,
        responseUserId: parsed.user_id ?? '(missing)',
        submissionRowId: parsed.id ?? '(missing)',
        workflow_state: parsed.workflow_state ?? '(missing)',
        submission_type: parsed.submission_type ?? '(missing)',
        attempt: parsed.attempt ?? '(missing)',
        submitted_at: parsed.submitted_at ?? '(missing)',
        bodyLength: typeof parsed.body === 'string' ? parsed.body.length : 0,
        attachmentCount: attList.length,
        attachmentIdsSample: ids.slice(0, 8),
        submissionHistoryLength: histLen,
        versionedAttachmentsDepth: verLen,
        topLevelKeys: Object.keys(parsed).sort().slice(0, 40),
      });
    }
    return parsed as {
      body?: string;
      score?: number;
      grade?: string;
      attempt?: number;
      submitted_at?: string;
      submission_comments?: Array<{
        id?: number;
        comment?: string;
        attachments?: Array<{ id?: number; url?: string; download_url?: string }>;
        attachment_ids?: number[];
      }>;
      attachment?: { url?: string; id?: number };
      attachments?: Array<{ url?: string; download_url?: string; id?: number; display_name?: string }>;
      versioned_attachments?: Array<Array<{ url?: string }>>;
      rubric_assessment?: Record<string, unknown>;
      user_id?: number;
      workflow_state?: string;
      submission_type?: string;
      id?: number;
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
      rubric_assessment?: Record<string, unknown>;
    }>
  > {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions?include[]=user&include[]=submission_comments&include[]=submission_history&include[]=rubric_assessment&per_page=100`;
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
  ): Promise<{ score?: number; grade?: string }> {
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
    const data = (await res.json()) as Record<string, unknown>;
    let score: number | undefined;
    if (typeof data.score === 'number' && Number.isFinite(data.score)) score = data.score;
    else if (typeof data.score === 'string') {
      const n = Number.parseFloat(data.score);
      if (Number.isFinite(n)) score = n;
    }
    const grade = typeof data.grade === 'string' ? data.grade : undefined;
    return { score, grade };
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

  /**
   * Generic: create announcement. Used by Flashcard and Prompt Manager settings.
   * Uses `delayed_post_at` (+10y UTC) so the topic does not surface as a new announcement immediately.
   * On a new Canvas host, run the discoverability pre-check from the student-feedback plan (POST delayed
   * topic, then find via `findSettingsAnnouncementByTitle` / student read path) before relying on this;
   * if listing fails for delayed topics on that host, stop sending `delayed_post_at` here until mitigated.
   */
  async createSettingsAnnouncement(
    courseId: string,
    title: string,
    messageBody: string,
    tokenOverride: string | null,
    domainOverride?: string,
  ): Promise<number> {
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/discussion_topics`;
    const delayedUntil = new Date();
    delayedUntil.setUTCFullYear(delayedUntil.getUTCFullYear() + 10);
    const body = {
      title,
      message: messageBody,
      is_announcement: true,
      delayed_post_at: delayedUntil.toISOString(),
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

  /**
   * Set submission to online_upload with exactly these file ids (replaces prior attachment list when Canvas accepts PUT).
   */
  async putSubmissionOnlineUploadFileIds(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileIds: string[],
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    if (!fileIds.length) {
      throw new Error('putSubmissionOnlineUploadFileIds: at least one file id required');
    }
    const base = this.getBaseUrl(domainOverride);
    const url = `${base}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${encodeURIComponent(userId)}`;
    const body = {
      submission: {
        submission_type: 'online_upload' as const,
        file_ids: fileIds.map(toCanvasFileIdInt),
      },
    };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    appendLtiLog('canvas', 'putSubmissionOnlineUploadFileIds', {
      courseId,
      assignmentId,
      userId,
      fileIdCount: fileIds.length,
      status: res.status,
      preview: raw.slice(0, 500),
    });
    if (!res.ok) {
      throw new Error(`Canvas put submission file_ids failed: ${res.status} ${raw.slice(0, 400)}`);
    }
  }

  /** Delete a Canvas file by id (fails open for 404). */
  async deleteCanvasFile(
    fileId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const base = this.getBaseUrl(domainOverride);
    const id = toCanvasFileIdInt(fileId);
    const url = `${base}/api/v1/files/${id}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.getAuthHeaders(tokenOverride),
    });
    if (!res.ok && res.status !== 404) {
      const raw = await res.text();
      appendLtiLog('canvas', 'deleteCanvasFile FAIL', { fileId, status: res.status, preview: raw.slice(0, 200) });
      throw new Error(`Canvas delete file failed: ${res.status}`);
    }
  }
}

