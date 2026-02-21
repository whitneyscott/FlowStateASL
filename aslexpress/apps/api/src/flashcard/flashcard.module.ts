import { Module } from '@nestjs/common';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';
import { FlashcardController } from './flashcard.controller';
import { FlashcardService } from './flashcard.service';

@Module({
  imports: [SproutVideoModule],
  controllers: [FlashcardController],
  providers: [FlashcardService],
})
export class FlashcardModule {}
