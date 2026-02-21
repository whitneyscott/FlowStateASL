import { Module } from '@nestjs/common';
import { SproutVideoService } from './sproutvideo.service';

@Module({
  providers: [SproutVideoService],
  exports: [SproutVideoService],
})
export class SproutVideoModule {}
