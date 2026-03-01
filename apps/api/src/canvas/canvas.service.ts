import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModuleInfoDto } from './dto/module-info.dto';

export class CanvasUploadChunkError extends Error {
  constructor(
    message: string,
    public readonly lastSuccessfulOffset: number,
  ) {
    super(message);
    this.name = 'CanvasUploadChunkError';
  }
}

@Injectable()
export class CanvasService {
  constructor(private readonly config: ConfigService) {}

  private getAuthHeaders(tokenOverride?: string | null): Record<string, string> {
    const token = tokenOverride ?? this.config.get('CANVAS_API_TOKEN');
    if (!token) throw new Error('Canvas not configured');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private getDomain(override?: string): string {
    const domain = (override?.trim() || this.config.get('CANVAS_DOMAIN')) as string | undefined;
    if (!domain) throw new Error('Canvas not configured');
    return domain;
  }

  buildFilterFromModuleName(moduleName: string, prefix = 'TWA'): string {
    const match = moduleName.match(/\bunit\s+([\d.]+)/i);
    if (!match) return '';
    const numericPart = match[1];
    const parts = numericPart.split('.');
    const padded = parts.map((p) => p.padStart(2, '0'));
    return `${prefix}.${padded.join('.')}`;
  }

  async getModuleInfo(
    courseId: string,
    moduleId: string,
    prefix = 'TWA',
    domainOverride?: string,
  ): Promise<ModuleInfoDto> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/modules/${moduleId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    const httpCode = res.status;
    const data = (await res.json().catch(() => ({}))) as { name?: string };
    const moduleName = data.name ?? 'Not Found';
    const filter = this.buildFilterFromModuleName(moduleName, prefix);
    const match = moduleName.match(/\bunit\s+([\d.]+)/i);
    let unit = '';
    let section = '';
    if (match) {
      const parts = match[1].split('.');
      unit = parts[0] ?? '';
      section = parts[1] ?? '';
    }
    return {
      module_name: moduleName,
      unit,
      section,
      filter,
      http_code: httpCode,
      prefix_used: prefix,
    };
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

  async initiateFileUpload(
    courseId: string,
    assignmentId: string,
    userId: string,
    filename: string,
    size: number,
    contentType: string,
    domainOverride?: string,
  ): Promise<{ uploadUrl: string; uploadParams: Record<string, string> }> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}/files`;
    const form = new FormData();
    form.append('name', filename);
    form.append('size', String(size));
    form.append('content_type', contentType);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: this.getAuthHeaders().Authorization },
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

  async uploadFileToCanvas(
    uploadUrl: string,
    uploadParams: Record<string, string>,
    buffer: Buffer,
    options?: { resumeFromOffset?: number },
  ): Promise<{ fileId: string }> {
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
        const authHeaders = this.getAuthHeaders();
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
      return { fileId };
    } catch (e) {
      if (e instanceof CanvasUploadChunkError) throw e;
      throw new CanvasUploadChunkError(
        e instanceof Error ? e.message : 'Upload failed',
        lastSuccessOffset,
      );
    }
  }

  async submitAssignmentWithFile(
    courseId: string,
    assignmentId: string,
    userId: string,
    fileId: string,
    bodyHtml: string,
    domainOverride?: string,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const body = {
      submission: {
        submission_type: 'online_upload',
        file_ids: [fileId],
        body: bodyHtml,
      },
    };
    const res = await fetch(url + '?as_user_id=' + encodeURIComponent(userId), {
      method: 'POST',
      headers: this.getAuthHeaders(),
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
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(),
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
    const domain = this.getDomain(domainOverride);
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    while (hasMore) {
      const url = `https://${domain}/api/v1/courses/${courseId}/assignments?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{ id: number; name?: string }>;
      const list = data ?? [];
      const found = list.find(
        (a) => String(a.name ?? '').trim() === assignmentTitle.trim(),
      );
      if (found) return String(found.id);
      hasMore = list.length === perPage;
      page++;
    }
    return null;
  }

  /** @deprecated Use findAssignmentByTitle */
  async findAssignmentByName(
    courseId: string,
    assignmentName: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<string | null> {
    return this.findAssignmentByTitle(courseId, assignmentName, domainOverride, tokenOverride);
  }

  async ensureAssignmentGroup(
    courseId: string,
    groupName: string,
    groupWeight: number,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<number> {
    const domain = this.getDomain(domainOverride);
    const listUrl = `https://${domain}/api/v1/courses/${courseId}/assignment_groups`;
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

    const createUrl = `https://${domain}/api/v1/courses/${courseId}/assignment_groups`;
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
      tokenOverride?: string | null;
    } = {},
    domainOverride?: string,
  ): Promise<string> {
    const domain = this.getDomain(domainOverride);
    const tokenOverride = options.tokenOverride;
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments`;
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
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create assignment failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: number };
    return String(data.id ?? '');
  }

  async getAssignment(
    courseId: string,
    assignmentId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ description?: string } | null> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { description?: string };
    return { description: data.description };
  }

  async updateAssignmentDescription(
    courseId: string,
    assignmentId: string,
    description: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
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

  async getSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ body?: string } | null> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { body?: string };
    return { body: data.body };
  }

  async createSubmissionWithBody(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const body = {
      submission: {
        submission_type: 'online_text_entry',
        body: bodyText,
        user_id: parseInt(userId, 10) || userId,
      },
    };
    const res = await fetch(url + '?as_user_id=' + encodeURIComponent(userId), {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create submission with body failed: ${res.status} ${text}`);
    }
  }

  /**
   * Create submission with body and comment in one POST (Comment-First pattern).
   * Mirrors submit_prompt_first.php exactly: no user_id in body, only as_user_id in URL.
   * Including user_id in body can trigger 403 "user not authorized" on some Canvas instances.
   */
  async createSubmissionWithBodyAndComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    commentText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const body = {
      submission: {
        submission_type: 'online_text_entry',
        body: bodyText,
      },
      comment: { text_comment: commentText },
    };
    const res = await fetch(url + '?as_user_id=' + encodeURIComponent(userId), {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create submission with body and comment failed: ${res.status} ${text}`);
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
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
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

  async getSubmissionWithComments(
    courseId: string,
    assignmentId: string,
    userId: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<{ comments?: Array<{ comment?: string }> } | null> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}?include[]=submission_comments`;
    const res = await fetch(url, { headers: this.getAuthHeaders(tokenOverride) });
    if (!res.ok) return null;
    const data = (await res.json()) as { submission_comments?: Array<{ comment?: string }> };
    return { comments: data.submission_comments ?? [] };
  }

  async putSubmissionComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    commentText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const body = { comment: { text_comment: commentText } };
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas put submission comment failed: ${res.status} ${text}`);
    }
  }

  /**
   * @deprecated Does not use as_user_id; submissions do not appear for students.
   * Use createSubmissionWithBodyAndComment instead.
   */
  async createSubmissionWithComment(
    courseId: string,
    assignmentId: string,
    userId: string,
    bodyText: string,
    commentText: string,
    domainOverride?: string,
    tokenOverride?: string | null,
  ): Promise<void> {
    const domain = this.getDomain(domainOverride);
    const url = `https://${domain}/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const body = {
      submission: {
        submission_type: 'online_text_entry',
        body: bodyText,
        user_id: parseInt(userId, 10) || userId,
      },
      comment: { text_comment: commentText },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(tokenOverride),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas create submission failed: ${res.status} ${text}`);
    }
  }
}
