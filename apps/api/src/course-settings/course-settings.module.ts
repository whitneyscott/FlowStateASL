import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasModule } from '../canvas/canvas.module';
import { LtiModule } from '../lti/lti.module';
import { CourseSettingsController } from './course-settings.controller';
import { CourseSettingsService } from './course-settings.service';
import { CourseSettingsEntity } from './entities/course-settings.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseSettingsEntity]),
    CanvasModule,
    LtiModule,
  ],
  controllers: [CourseSettingsController],
  providers: [CourseSettingsService],
  exports: [CourseSettingsService],
})
export class CourseSettingsModule {}
