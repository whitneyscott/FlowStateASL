import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanvasModule } from '../canvas/canvas.module';
import { LtiModule } from '../lti/lti.module';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';
import { FlashcardController } from './flashcard.controller';
import { FlashcardService } from './flashcard.service';
import { FlashcardConfigEntity } from './entities/flashcard-config.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlashcardConfigEntity]),
    SproutVideoModule,
    CanvasModule,
    LtiModule,
  ],
  controllers: [FlashcardController],
  providers: [FlashcardService],
})
export class FlashcardModule {}
