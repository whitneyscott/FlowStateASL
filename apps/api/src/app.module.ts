import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { RoutingLogMiddleware } from './common/routing-log.middleware';
import { DataModule } from './data/data.module';
import { CanvasModule } from './canvas/canvas.module';
import { SproutVideoModule } from './sproutvideo/sproutvideo.module';
import { FlashcardModule } from './flashcard/flashcard.module';
import { LtiModule } from './lti/lti.module';
import { SubmissionModule } from './submission/submission.module';
import { PromptConfigEntity } from './assessment/entities/prompt-config.entity';
import { BlockedAttemptEntity } from './assessment/entities/blocked-attempt.entity';
import { AssessmentSessionEntity } from './assessment/entities/assessment-session.entity';
import { FlashcardConfigEntity } from './flashcard/entities/flashcard-config.entity';

const isProduction = process.env.NODE_ENV === 'production';
const webRoot = join(__dirname, '..', '..', 'web');

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    SubmissionModule,
  ],
  providers: [RoutingLogMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RoutingLogMiddleware).forRoutes('*');
  }
}
