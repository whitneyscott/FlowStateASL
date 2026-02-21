import { Module } from '@nestjs/common';
import { CanvasModule } from '../canvas/canvas.module';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';
import { FlashcardController } from './flashcard.controller';
import { FlashcardService } from './flashcard.service';

@Module({
  imports: [SproutVideoModule, CanvasModule],
  controllers: [FlashcardController],
  providers: [FlashcardService],
})
export class FlashcardModule {}
