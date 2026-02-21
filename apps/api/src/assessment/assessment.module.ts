import { Module } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { CanvasModule } from '../canvas/canvas.module';
import { AssessmentService } from './assessment.service';

@Module({
  imports: [DataModule, CanvasModule],
  providers: [AssessmentService],
  exports: [AssessmentService],
})
export class AssessmentModule {}
