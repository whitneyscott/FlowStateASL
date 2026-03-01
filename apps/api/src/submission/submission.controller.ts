import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { SubmitFlashcardDto } from './dto/submit-flashcard.dto';
import { SubmissionService } from './submission.service';

@Controller('submission')
@UseGuards(LtiLaunchGuard)
export class SubmissionController {
  constructor(private readonly submission: SubmissionService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SubmitFlashcardDto,
  ): Promise<{ synced: boolean; error?: string; debug?: { progressSaved: boolean; gradeSent?: boolean; details: string } }> {
    try {
      const ctx = req.session!.ltiContext! as LtiContext;
      const result = await this.submission.submitFlashcard(ctx, dto);
      if (result.synced) {
        res.status(HttpStatus.CREATED);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Submission POST] unhandled error:', msg);
      res.status(HttpStatus.ACCEPTED);
      return {
        synced: false,
        error: msg,
        debug: { progressSaved: false, details: `Progress failed to save. Reason: ${msg}` },
      };
    }
  }
}
