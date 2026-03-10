import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasModule } from '../canvas/canvas.module';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';
import { LtiModule } from '../lti/lti.module';
import { CanvasOAuthController } from '../canvas/canvas-oauth.controller';
import { CourseSettingsController } from './course-settings.controller';
import { CourseSettingsService } from './course-settings.service';
import { CourseSettingsEntity } from './entities/course-settings.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CourseSettingsEntity]),
    CanvasModule,
    SproutVideoModule,
    LtiModule,
  ],
  controllers: [CourseSettingsController, CanvasOAuthController],
  providers: [CourseSettingsService],
  exports: [CourseSettingsService],
})
export class CourseSettingsModule {}
