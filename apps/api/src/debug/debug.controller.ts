import { Controller, Get, Post, Query, Body, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendLtiLog } from '../common/last-error.store';
import type { Request } from 'express';
import { getLastError, getLtiLog, clearLtiLog } from '../common/last-error.store';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { sanitizeLtiContext } from '../common/utils/lti-context-value.util';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { canvasApiBaseFromLtiContext } from '../common/utils/canvas-base-url.util';

@Controller('debug')
export class DebugController {
  constructor(
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Returns the complete raw Canvas API response from listSubmissions with zero filtering. */
  @Get('raw-submission')
  @UseGuards(LtiLaunchGuard)
  async getRawSubmission(
    @Query('courseId') courseId: string,
    @Query('assignmentId') assignmentId: string,
    @Req() req: Request,
  ) {
    const cid = (courseId ?? '').toString().trim();
    const aid = (assignmentId ?? '').toString().trim();
    if (!cid || !aid) {
      throw new ForbiddenException('courseId and assignmentId query params required');
    }
    const raw = req.session?.ltiContext as LtiContext | undefined;
    if (!raw) throw new ForbiddenException('LTI context required');
    const ctx = sanitizeLtiContext(raw) as LtiContext;
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const token = await this.courseSettings.getEffectiveCanvasToken(cid, canvasAccessToken);
    if (!token) throw new ForbiddenException('Canvas OAuth token required');
    const domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    const rawSubmissions = await this.canvas.listSubmissions(cid, aid, domainOverride, token);
    return { raw: rawSubmissions };
  }

  /** One-time temporary: raw Canvas listSubmissions for course 1, assignment 106. Uses DEBUG_CANVAS_TOKEN if set (no session), else requires LTI session. */
  @Get('submission-raw')
  async getSubmissionRaw(@Req() req: Request) {
    const cid = '1';
    const aid = '106';
    let token: string | null = null;
    let domainOverride: string | undefined;
    const debugToken = this.config.get<string>('DEBUG_CANVAS_TOKEN')?.trim();
    if (debugToken) {
      token = debugToken;
      domainOverride = this.config.get<string>('CANVAS_API_BASE_URL') ?? 'http://localhost';
    } else {
      const raw = req.session?.ltiContext as LtiContext | undefined;
      if (!raw) throw new ForbiddenException('LTI context or DEBUG_CANVAS_TOKEN required');
      const ctx = sanitizeLtiContext(raw) as LtiContext;
      const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
      token = await this.courseSettings.getEffectiveCanvasToken(cid, canvasAccessToken);
      if (!token) throw new ForbiddenException('Canvas OAuth token required');
      domainOverride = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    }
    const rawSubmissions = await this.canvas.listSubmissions(cid, aid, domainOverride, token);
    return rawSubmissions;
  }

  /**
   * Dev only: remove Canvas OAuth / manual API token from the session so the next action
   * triggers token entry (LTI 1.1) or OAuth again (LTI 1.3). LTI launch context is kept.
   */
  @Post('clear-canvas-auth')
  async clearCanvasAuth(@Req() req: Request) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('clear-canvas-auth is disabled in production');
    }
    const sess = req.session as { canvasAccessToken?: string; save: (cb: (err?: unknown) => void) => void } | undefined;
    if (!sess) {
      return { ok: true, cleared: false, message: 'No session' };
    }
    const had = !!(sess.canvasAccessToken ?? '').trim();
    delete sess.canvasAccessToken;
    await new Promise<void>((resolve, reject) => {
      sess.save((err) => (err ? reject(err) : resolve()));
    });
    appendLtiLog('debug', 'Session canvasAccessToken cleared (POST /api/debug/clear-canvas-auth)');
    return { ok: true, cleared: had };
  }

  /** Call this (e.g. open in browser) to verify Bridge Log is reading from this API process. */
  @Get('ping')
  ping() {
    appendLtiLog('debug', 'PING — if you see this in Bridge Log, API logging works');
    return { ok: true, ts: new Date().toISOString() };
  }

  @Get('last-error')
  getLastError() {
    try {
      const data = getLastError();
      return data ?? null;
    } catch (err) {
      console.error('[DebugController] getLastError failed:', err);
      return null;
    }
  }

  @Get('lti-log')
  getLtiLog(@Query('clear') clear?: string) {
    try {
      if (clear === '1' || clear === 'true') clearLtiLog();
      const lines = getLtiLog();
      return { lines: Array.isArray(lines) ? lines : [] };
    } catch (err) {
      console.error('[DebugController] getLtiLog failed:', err);
      return { lines: [] };
    }
  }

  /** Append a line to the LTI log (e.g. from frontend for Bridge Debug Log). Tag defaults to 'viewer'. */
  @Post('lti-log')
  appendLtiLogLine(@Body('message') message: string, @Body('tag') tag?: string) {
    const msg = typeof message === 'string' ? message : '';
    if (msg) appendLtiLog(tag ?? 'viewer', msg);
    return { ok: true };
  }
}
