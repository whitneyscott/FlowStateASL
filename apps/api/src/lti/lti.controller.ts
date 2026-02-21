import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  UseGuards,
  NotImplementedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LtiService } from './lti.service';
import { LtiLaunchGuard } from './guards/lti-launch.guard';
import { AssessmentService } from '../assessment/assessment.service';

@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly assessmentService: AssessmentService,
  ) {}

  @Post('launch/flashcards')
  async launchFlashcards(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = this.ltiService.extractContext(body);
    if (!ctx) {
      return res.status(400).send('Missing LTI parameters');
    }
    ctx.toolType = 'flashcards';
    req.session!.ltiContext = ctx;
    req.session!.save((err) => {
      if (err) return res.status(500).send('Session save failed');
      const base = process.env.FRONTEND_URL ?? '';
      res.redirect(`${base}/flashcards`);
    });
  }

  @Post('launch/prompter')
  async launchPrompter(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = this.ltiService.extractContext(body);
    if (!ctx) {
      return res.status(400).send('Missing LTI parameters');
    }
    ctx.toolType = 'prompter';
    if (this.ltiService.isTeacherRole(ctx.roles) && ctx.assignmentId && ctx.resourceLinkTitle) {
      try {
        ctx.assignmentNameSynced = await this.assessmentService.syncAssignmentNameIfNeeded(
          ctx.courseId,
          ctx.assignmentId,
          ctx.resourceLinkId || '',
          ctx.resourceLinkTitle,
        );
      } catch {
        ctx.assignmentNameSynced = false;
      }
    }
    req.session!.ltiContext = ctx;
    req.session!.save((err) => {
      if (err) return res.status(500).send('Session save failed');
      const base = process.env.FRONTEND_URL ?? '';
      res.redirect(`${base}/prompter`);
    });
  }

  @Get('context')
  @UseGuards(LtiLaunchGuard)
  getContext(@Req() req: Request) {
    return req.session!.ltiContext!;
  }

  @Get('oidc/login')
  oidcLogin() {
    throw new NotImplementedException('LTI 1.3 not implemented');
  }

  @Post('oidc/redirect')
  oidcRedirect() {
    throw new NotImplementedException('LTI 1.3 not implemented');
  }
}
