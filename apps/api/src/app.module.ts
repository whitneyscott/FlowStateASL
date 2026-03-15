import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join, resolve } from 'path';
import { RoutingLogMiddleware } from './common/routing-log.middleware';
import { DataModule } from './data/data.module';
import { CanvasModule } from './canvas/canvas.module';
import { SproutVideoModule } from './sproutvideo/sproutvideo.module';
import { FlashcardModule } from './flashcard/flashcard.module';
import { LtiModule } from './lti/lti.module';
import { DebugModule } from './debug/debug.module';
import { SubmissionModule } from './submission/submission.module';
import { CourseSettingsModule } from './course-settings/course-settings.module';
import { PromptModule } from './prompt/prompt.module';
import { QuizModule } from './quiz/quiz.module';
import { PromptConfigEntity } from './assessment/entities/prompt-config.entity';
import { BlockedAttemptEntity } from './assessment/entities/blocked-attempt.entity';
import { AssessmentSessionEntity } from './assessment/entities/assessment-session.entity';
import { FlashcardConfigEntity } from './flashcard/entities/flashcard-config.entity';
import { CourseSettingsEntity } from './course-settings/entities/course-settings.entity';
import { SproutPlaylistEntity } from './sproutvideo/entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from './sproutvideo/entities/sprout-playlist-video.entity';
import { SyncMetadataEntity } from './sproutvideo/entities/sync-metadata.entity';
import { AssignmentPromptEntity } from './prompt/entities/assignment-prompt.entity';
import { StudentResetEntity } from './prompt/entities/student-reset.entity';

const isProduction = process.env.NODE_ENV === 'production';
const webRoot = join(__dirname, '..', '..', 'web');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(process.cwd(), '.env'), '.env'],
    }),
    ScheduleModule.forRoot(),
    ...(isProduction
      ? [
          ServeStaticModule.forRoot({
            rootPath: webRoot,
            exclude: ['/api*'],
            serveRoot: '/',
            renderPath: '*',
          }),
        ]
      : []),
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        ssl:
          config.get('NODE_ENV') === 'production'
            ? { rejectUnauthorized: false }
            : false,
        entities: [
          PromptConfigEntity,
          BlockedAttemptEntity,
          AssessmentSessionEntity,
          FlashcardConfigEntity,
          CourseSettingsEntity,
          SproutPlaylistEntity,
          SproutPlaylistVideoEntity,
          SyncMetadataEntity,
          AssignmentPromptEntity,
          StudentResetEntity,
        ],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        migrationsRun: false,
      }),
      inject: [ConfigService],
    }),
    DataModule,
    CanvasModule,
    SproutVideoModule,
    FlashcardModule,
    LtiModule,
    DebugModule,
    SubmissionModule,
    CourseSettingsModule,
    PromptModule,
    QuizModule,
  ],
  providers: [RoutingLogMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RoutingLogMiddleware).forRoutes('*');
  }
}
