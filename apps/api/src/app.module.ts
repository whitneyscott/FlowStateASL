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
import { HealthModule } from './health/health.module';
import { AuthStateModule } from './auth-state/auth-state.module';
import { AuthSessionEntity } from './auth-state/entities/auth-session.entity';
import { BearerAuthMiddleware } from './common/middleware/bearer-auth.middleware';
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
            exclude: ['/api/{*rest}'],
            renderPath: '{*any}',
          }),
        ]
      : []),
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const dbPoolMax = Number.parseInt(config.get<string>('DB_POOL_MAX') ?? '20', 10);
        const dbConnectTimeout = Number.parseInt(config.get<string>('DB_CONNECT_TIMEOUT_MS') ?? '10000', 10);
        return {
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
            AuthSessionEntity,
          ],
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
          migrationsRun: false,
          retryAttempts: 2,
          retryDelay: 1500,
          extra: {
            max: Number.isFinite(dbPoolMax) ? dbPoolMax : 20,
            connectionTimeoutMillis: Number.isFinite(dbConnectTimeout) ? dbConnectTimeout : 10000,
          },
        };
      },
      inject: [ConfigService],
    }),
    DataModule,
    CanvasModule,
    SproutVideoModule,
    FlashcardModule,
    LtiModule,
    DebugModule,
    HealthModule,
    AuthStateModule,
    SubmissionModule,
    CourseSettingsModule,
    PromptModule,
  ],
  providers: [BearerAuthMiddleware, RoutingLogMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BearerAuthMiddleware, RoutingLogMiddleware).forRoutes('/{*rest}');
  }
}
