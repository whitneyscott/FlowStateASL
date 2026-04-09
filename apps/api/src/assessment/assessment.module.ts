import { Module, forwardRef } from '@nestjs/common';
import { DataModule } from '../data/data.module';
import { CanvasModule } from '../canvas/canvas.module';
import { AssessmentService } from './assessment.service';

@Module({
  // Breaks CanvasModule -> CourseSettingsModule -> LtiModule -> AssessmentModule -> CanvasModule cycle (Render/Nest bootstrap).
  imports: [DataModule, forwardRef(() => CanvasModule)],
  providers: [AssessmentService],
  exports: [AssessmentService],
})
export class AssessmentModule {}
